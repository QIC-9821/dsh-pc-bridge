import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { PEER_ADDRESS_MODES, normalizeHost } from './peer-memory.mjs'

/**
 * A settings file is the user-facing subset of the bridge config: it lives
 * next to the state directory, never contains the shared secret, and wins
 * over the plugin config (a UI change must survive a host restart).
 */
const STRING_KEYS = Object.freeze([
  'listenHost',
  'shellPath',
  'cwd',
  'sshHost',
  'sshUser',
  'sshKeyPath',
  // 0.3.1: the secret file itself moves into the settings layer, and a paired
  // peer is remembered so the settings page can show who this bridge talks to.
  'secretFile',
  'peerName',
  'peerPlatform',
  'peerTransport',
  'peerPairedAt',
  'peerFingerprint',
  // 0.4.0: the WARP mode we replaced when switching to DNS-only, so "restore"
  // puts back what the user actually had (warp+doh / warp+dot / tunnel_only).
  'warpPreviousMode',
  // 0.6.0: which kind of connection is in use (hotspot / lan / tailnet / …).
  'connectionMode',
])

const NUMBER_KEYS = Object.freeze({
  listenPort: [0, 65535],
  defaultTimeoutMs: [1000, 3600000],
  maxTimeoutMs: [10000, 3600000],
  maxOutputBytes: [65536, 67108864],
  tunnelRemotePort: [1, 65535],
  tunnelLocalPort: [1, 65535],
  discoveryPort: [1, 65535],
  pairTtlSec: [30, 3600],
  auditKeep: [1, 50],
  // 0.5.0: one transfer block and the per-transfer ceiling.
  fileChunkBytes: [65536, 16777216],
  fileMaxBytes: [1048576, 4294967296],
})

const BOOLEAN_KEYS = Object.freeze([
  'tunnelEnabled',
  'discoveryEnabled',
  'enabled',
  'purgeOnUninstall',
  // 0.4.0: keep WARP's DNS protection while leaving Tailscale's route alone.
  'warpCoexist',
  // 0.5.0: the server side may read/write files, and this host may register
  // the pc_file_* tools.
  'fileEnabled',
  'fileToolsEnabled',
  // 0.6.0: the server remembers who called in, so a new network only has to be
  // picked from a list instead of typed again.
  'rememberPeer',
])

const ENUM_KEYS = Object.freeze({
  role: ['host', 'client', 'both'],
  toolsMode: ['auto', 'always', 'off'],
  remoteMode: ['off', 'tailscale', 'ssh'],
})

// Secret fields are deliberately absent: the secret only lives in its own
// file (or the environment), never in settings.json.
const WHITELIST = Object.freeze([
  ...STRING_KEYS,
  ...Object.keys(NUMBER_KEYS),
  ...BOOLEAN_KEYS,
  ...Object.keys(ENUM_KEYS),
  'peerUrl',
  'pairings',
  'fileRoots',
  'peerHistory',
])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function unwrapRef(value) {
  let current = value
  for (let i = 0; i < 4; i += 1) {
    if (current === null || typeof current !== 'object') return current
    if (typeof current.get === 'function') {
      try {
        current = current.get()
      } catch {
        return undefined
      }
      continue
    }
    if ('get' in current) {
      current = current.get
      continue
    }
    if ('value' in current) {
      current = current.value
      continue
    }
    return current
  }
  return current
}

function dshHome(env) {
  const home = String(env?.DSH_HOME || '').trim()
  return home ? resolve(home) : join(homedir(), '.dsh')
}

export function settingsPath(env = process.env) {
  return join(dshHome(env), 'pc-bridge', 'settings.json')
}

export async function readSettings(env = process.env) {
  try {
    const text = await readFile(settingsPath(env), 'utf8')
    const data = JSON.parse(text)
    return isPlainObject(data) ? data : {}
  } catch {
    // missing file, unreadable file, or broken json: behave like defaults
    return {}
  }
}

function toInteger(key, value, [min, max]) {
  const number = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(number)) throw new Error(`${key} 必须是数字`)
  if (!Number.isInteger(number)) throw new Error(`${key} 必须是整数`)
  if (number < min || number > max) throw new Error(`${key} 必须在 ${min} 到 ${max} 之间`)
  return number
}

function toBoolean(key, value) {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`${key} 必须是布尔值`)
}

function toString(key, value) {
  if (typeof value !== 'string') throw new Error(`${key} 必须是字符串`)
  const text = value.trim()
  if (key === 'listenHost' && !text) throw new Error('listenHost 不能为空')
  return text
}

function toPeerUrl(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  let url
  try {
    url = new URL(text)
  } catch {
    throw new Error('peerUrl 必须是 http(s) 绝对地址')
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
    throw new Error('peerUrl 必须是 http(s) 绝对地址')
  }
  return url.toString().replace(/\/+$/, '')
}

const PAIRINGS_LIMIT = 10

function toIsoString(value) {
  if (value === undefined || value === null) return ''
  const text = String(value).trim()
  if (!text) return ''
  const time = Date.parse(text)
  // A hand-edited file may hold junk; keep the device, drop only the timestamp.
  return Number.isNaN(time) ? '' : new Date(time).toISOString()
}

/**
 * Pairings are a small, newest-first history of devices that accepted our
 * code. Entries that carry no address are dropped, a repeated address keeps
 * the newest entry, and the list is capped at ten.
 */
export function normalizePairings(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const out = []
  for (const entry of value) {
    if (!isPlainObject(entry)) continue
    const address = String(entry.address ?? '').trim()
    if (!address) continue
    if (seen.has(address)) continue
    seen.add(address)
    out.push({
      name: typeof entry.name === 'string' ? entry.name.trim() : '',
      platform: typeof entry.platform === 'string' ? entry.platform.trim() : '',
      address,
      transport: typeof entry.transport === 'string' ? entry.transport.trim() : '',
      pairedAt: toIsoString(entry.pairedAt),
    })
    if (out.length >= PAIRINGS_LIMIT) break
  }
  return out
}

const FILE_ROOTS_LIMIT = 20

/**
 * File roots are the directories a peer may read/write when file transfer is
 * on. Accept an array (settings.json) or one comma / semicolon / newline
 * separated string (the settings UI), drop blanks, expand a leading home
 * marker, and keep the first twenty distinct entries. An empty list means the
 * caller does not restrict paths at all.
 */
export function normalizeFileRoots(value) {
  let items = []
  if (Array.isArray(value)) items = value
  else if (typeof value === 'string') items = value.split(/[,;\r\n]+/)
  const seen = new Set()
  const out = []
  for (const item of items) {
    let text = String(item ?? '').trim()
    if (!text) continue
    if (text === '~') text = homedir()
    else if (text.startsWith('~/') || text.startsWith('~\\')) text = join(homedir(), text.slice(2))
    // Windows paths compare case-insensitively; other platforms stay literal.
    const key = process.platform === 'win32' ? text.toLowerCase() : text
    if (seen.has(key)) continue
    seen.add(key)
    out.push(text)
    if (out.length >= FILE_ROOTS_LIMIT) break
  }
  return out
}

/**
 * The address chips: at most two hosts per network kind, newest first. A
 * settings patch may carry the whole map or one entry; anything unreadable is
 * dropped instead of failing the save.
 */
function normalizePeerHistorySetting(value) {
  if (!isPlainObject(value)) return {}
  const out = {}
  for (const mode of PEER_ADDRESS_MODES) {
    const list = Array.isArray(value[mode]) ? value[mode] : []
    const cleaned = list.map((item) => normalizeHost(item)).filter(Boolean)
    if (cleaned.length) out[mode] = [...new Set(cleaned)].slice(0, 2)
  }
  return out
}

/**
 * Validate and coerce one settings patch. Unknown keys (including the secret
 * fields) are dropped silently, so a UI may post a wider config object.
 */
export function normalizeSettings(patch) {
  if (!isPlainObject(patch)) throw new Error('设置必须是对象')
  const out = {}
  for (const key of WHITELIST) {
    if (!(key in patch)) continue
    const value = patch[key]
    if (value === undefined || value === null) continue
    if (key === 'peerUrl') {
      out.peerUrl = toPeerUrl(value)
      continue
    }
    if (key === 'pairings') {
      out.pairings = normalizePairings(value)
      continue
    }
    if (key === 'fileRoots') {
      out.fileRoots = normalizeFileRoots(value)
      continue
    }
    if (key === 'peerHistory') {
      out.peerHistory = normalizePeerHistorySetting(value)
      continue
    }
    if (STRING_KEYS.includes(key)) {
      out[key] = toString(key, value)
      continue
    }
    if (key in NUMBER_KEYS) {
      out[key] = toInteger(key, value, NUMBER_KEYS[key])
      continue
    }
    if (BOOLEAN_KEYS.includes(key)) {
      out[key] = toBoolean(key, value)
      continue
    }
    const allowed = ENUM_KEYS[key]
    const text = String(value).trim()
    if (!allowed.includes(text)) throw new Error(`${key} 只能是 ${allowed.join('、')}`)
    out[key] = text
  }
  return out
}

/** Atomic write: a temp file in the same directory, then a rename. */
export async function writeSettings(patch, env = process.env) {
  const normalized = normalizeSettings(patch)
  const file = settingsPath(env)
  const current = await readSettings(env)
  const settings = { ...current, ...normalized }
  const text = `${JSON.stringify(settings, null, 2)}\n`
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
  await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 })
  try {
    await rename(tmp, file)
  } catch (error) {
    // Windows refuses a rename over an existing file in some states.
    await rm(file, { force: true }).catch(() => {})
    try {
      await rename(tmp, file)
    } catch (retryError) {
      await rm(tmp, { force: true }).catch(() => {})
      throw retryError
    }
  }
  try {
    await chmod(file, 0o600)
  } catch {
    // chmod is a no-op on Windows
  }
  return { settings, path: file }
}

/**
 * Shallow merge for normalizeConfig: settings.json is the newer, user-owned
 * layer and therefore wins over the plugin config.
 */
export function mergeConfig(patchConfig, settings) {
  const base = unwrapRef(patchConfig)
  const over = unwrapRef(settings)
  return {
    ...(isPlainObject(base) ? base : {}),
    ...(isPlainObject(over) ? over : {}),
  }
}
