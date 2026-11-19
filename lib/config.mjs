import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { PEER_ADDRESS_MODES } from './peer-memory.mjs'
import { normalizeFileRoots } from './settings.mjs'

export const DEFAULTS = Object.freeze({
  role: 'both',
  listenHost: '127.0.0.1',
  listenPort: 18790,
  secretFile: '',
  secretEnv: 'DSH_PC_BRIDGE_SECRET',
  secret: '',
  peerUrl: '',
  defaultTimeoutMs: 30000,
  maxTimeoutMs: 600000,
  maxOutputBytes: 2097152,
  shellPath: '',
  cwd: '',
  tunnelEnabled: false,
  sshHost: '',
  sshUser: '',
  sshKeyPath: '',
  tunnelRemotePort: 18790,
  tunnelLocalPort: 18790,
  toolsMode: 'auto',
  discoveryEnabled: true,
  discoveryPort: 18791,
  pairTtlSec: 300,
  auditKeep: 5,
  remoteMode: 'off',
  warpCoexist: true,
  warpPreviousMode: '',
  enabled: true,
  purgeOnUninstall: false,
  peerName: '',
  peerPlatform: '',
  peerTransport: '',
  peerPairedAt: '',
  peerFingerprint: '',
  pairings: [],
  // 0.5.0: file transfer. fileEnabled gates the server side, fileToolsEnabled
  // only decides whether this host registers the pc_file_* tools, and an empty
  // fileRoots list means "no path restriction".
  fileEnabled: true,
  fileToolsEnabled: false,
  fileRoots: [],
  fileChunkBytes: 1048576,
  fileMaxBytes: 67108864,
  // 0.6.0: a server-side memory of the addresses that called in, so switching
  // networks does not mean typing an address again.
  rememberPeer: false,
  connectionMode: '',
  peerHistory: Object.freeze({}),
})

const TOOLS_MODES = Object.freeze(['auto', 'always', 'off'])
const REMOTE_MODES = Object.freeze(['off', 'tailscale', 'ssh'])
// How this host reaches the peer; shown in the status line and remembered with
// the address that was used at the time.
export const BRIDGE_CONNECTION_MODES = Object.freeze([
  'off',
  'hotspot',
  'lan',
  'tailnet',
  'other',
  'custom',
])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Hosts expose config fields marked `.extra('volatile', true)` as live
 * references (`{ get() }`) instead of raw scalars. Unwrap them so both a
 * plain object and a reference map normalize to the same values.
 */
function unwrapRef(value) {
  let current = value
  for (let i = 0; i < 4; i += 1) {
    if (current === null || typeof current !== 'object') return current
    // Live config references look like `{ get() }` (method) or `{ get value() }`
    // (accessor). Support both, plus a plain `{ value }` wrapper.
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

function toBool(value, fallback) {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 1) return true
  if (value === 'false' || value === 0) return false
  return fallback
}

function toInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const i = Math.trunc(n)
  return i >= min && i <= max ? i : fallback
}

function expandHome(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return text
}

function dshHome(env) {
  const home = String(env?.DSH_HOME || '').trim()
  return home ? resolve(home) : join(homedir(), '.dsh')
}

/** At most two remembered addresses per network kind, newest first. */
export function normalizePeerHistory(raw) {
  const src = isPlainObject(raw) ? raw : {}
  const out = {}
  for (const mode of PEER_ADDRESS_MODES) {
    const list = Array.isArray(src[mode]) ? src[mode] : []
    const cleaned = list
      .map((item) => String(item || '').trim().toLowerCase())
      .filter(Boolean)
    if (cleaned.length) out[mode] = [...new Set(cleaned)].slice(0, 2)
  }
  return Object.freeze(out)
}

export function normalizeConfig(raw = {}, env = process.env) {
  const input = unwrapRef(raw)
  const src = isPlainObject(input) ? input : {}
  const merged = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    const value = unwrapRef(src[key])
    if (value === undefined || value === null) continue
    if (typeof value === 'string' && value.trim() === '') continue
    merged[key] = value
  }

  const stateDir = join(dshHome(env), 'pc-bridge')
  const role = merged.role === 'host' || merged.role === 'client' ? merged.role : 'both'
  const secretFile = expandHome(String(merged.secretFile || ''))
  const cwd = expandHome(String(merged.cwd || ''))
  const sshKeyPath = expandHome(String(merged.sshKeyPath || ''))

  return Object.freeze({
    role,
    stateDir,
    listenHost: String(merged.listenHost || DEFAULTS.listenHost).trim() || DEFAULTS.listenHost,
    listenPort: toInt(merged.listenPort, DEFAULTS.listenPort, 0, 65535),
    secretFile: secretFile ? (isAbsolute(secretFile) ? secretFile : resolve(stateDir, secretFile)) : join(stateDir, 'secret'),
    secretEnv: String(merged.secretEnv || DEFAULTS.secretEnv).trim() || DEFAULTS.secretEnv,
    secret: String(merged.secret || '').trim(),
    peerUrl: String(merged.peerUrl || '').trim(),
    defaultTimeoutMs: toInt(merged.defaultTimeoutMs, DEFAULTS.defaultTimeoutMs, 1000, 3600000),
    maxTimeoutMs: toInt(merged.maxTimeoutMs, DEFAULTS.maxTimeoutMs, 10000, 3600000),
    maxOutputBytes: toInt(merged.maxOutputBytes, DEFAULTS.maxOutputBytes, 65536, 64 * 1024 * 1024),
    shellPath: expandHome(String(merged.shellPath || '')),
    cwd: cwd || process.cwd(),
    tunnelEnabled: toBool(merged.tunnelEnabled, DEFAULTS.tunnelEnabled),
    sshHost: String(merged.sshHost || '').trim(),
    sshUser: String(merged.sshUser || '').trim(),
    sshKeyPath,
    tunnelRemotePort: toInt(merged.tunnelRemotePort, DEFAULTS.tunnelRemotePort, 1, 65535),
    tunnelLocalPort: toInt(merged.tunnelLocalPort, DEFAULTS.tunnelLocalPort, 1, 65535),
    toolsMode: TOOLS_MODES.includes(merged.toolsMode) ? merged.toolsMode : 'auto',
    discoveryEnabled: toBool(merged.discoveryEnabled, DEFAULTS.discoveryEnabled),
    discoveryPort: toInt(merged.discoveryPort, DEFAULTS.discoveryPort, 1, 65535),
    pairTtlSec: toInt(merged.pairTtlSec, DEFAULTS.pairTtlSec, 30, 3600),
    auditKeep: toInt(merged.auditKeep, DEFAULTS.auditKeep, 1, 50),
    remoteMode: REMOTE_MODES.includes(merged.remoteMode) ? merged.remoteMode : 'off',
    warpCoexist: toBool(merged.warpCoexist, DEFAULTS.warpCoexist),
    warpPreviousMode: String(merged.warpPreviousMode || '').trim(),
    enabled: toBool(merged.enabled, DEFAULTS.enabled),
    purgeOnUninstall: toBool(merged.purgeOnUninstall, DEFAULTS.purgeOnUninstall),
    peerName: String(merged.peerName || '').trim(),
    peerPlatform: String(merged.peerPlatform || '').trim(),
    peerTransport: String(merged.peerTransport || '').trim(),
    peerPairedAt: String(merged.peerPairedAt || '').trim(),
    peerFingerprint: String(merged.peerFingerprint || '').trim(),
    pairings: normalizePairings(merged.pairings),
    fileEnabled: toBool(merged.fileEnabled, DEFAULTS.fileEnabled),
    fileToolsEnabled: toBool(merged.fileToolsEnabled, DEFAULTS.fileToolsEnabled),
    fileRoots: normalizeFileRoots(merged.fileRoots),
    fileChunkBytes: toInt(merged.fileChunkBytes, DEFAULTS.fileChunkBytes, 65536, 16777216),
    fileMaxBytes: toInt(merged.fileMaxBytes, DEFAULTS.fileMaxBytes, 1048576, 4294967296),
    rememberPeer: toBool(merged.rememberPeer, DEFAULTS.rememberPeer),
    connectionMode: BRIDGE_CONNECTION_MODES.includes(merged.connectionMode)
      ? merged.connectionMode
      : '',
    peerHistory: normalizePeerHistory(merged.peerHistory),
  })
}

function normalizePairings(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const entry of value) {
    if (!isPlainObject(entry)) continue
    const address = String(entry.address ?? '').trim()
    if (!address) continue
    out.push({
      name: String(entry.name ?? '').trim(),
      platform: String(entry.platform ?? '').trim(),
      address,
      transport: String(entry.transport ?? '').trim(),
      pairedAt: String(entry.pairedAt ?? '').trim(),
    })
    if (out.length >= 10) break
  }
  return out
}
