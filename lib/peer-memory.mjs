import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Peer address memory.
 *
 * A server-mode node remembers where authenticated clients came from, one
 * address per network kind. The records are plain local state (`peers.json`),
 * never sent to a model, so keeping them costs no tokens.
 */

/** Network kinds we keep an address for, most specific first. */
export const PEER_ADDRESS_MODES = Object.freeze(['hotspot', 'lan', 'tailnet', 'other'])

/** Same address updates at most this often; a new address is written at once. */
export const REMEMBER_THROTTLE_MS = 10 * 60 * 1000

/** Hosts of well-known phone/laptop hotspots. */
const HOTSPOT_PREFIXES = Object.freeze([
  '192.168.137.', // Windows 移动热点
  '192.168.43.', // Android 热点
  '172.20.10.', // iPhone 个人热点
])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeHost(raw) {
  let host = String(raw || '').trim().toLowerCase()
  if (!host) return ''
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  // `::ffff:192.168.1.2` and `fe80::1%eth0` arrive from socket.remoteAddress.
  if (host.startsWith('::ffff:')) host = host.slice('::ffff:'.length)
  const zone = host.indexOf('%')
  if (zone > 0) host = host.slice(0, zone)
  return host
}

export function hostForUrl(host) {
  const value = normalizeHost(host)
  return value.includes(':') ? `[${value}]` : value
}

/** Return one of PEER_ADDRESS_MODES, 'local' for this machine, or ''. */
export function classifyHost(raw) {
  const host = normalizeHost(raw)
  if (!host) return ''
  if (host === 'localhost' || host === '::1') return 'local'
  if (host.endsWith('.ts.net') || host.endsWith('.tailscale.net')) return 'tailnet'
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!match) return 'other'
  const [a, b] = [Number(match[1]), Number(match[2])]
  if (a === 0 || a === 127) return 'local'
  for (const prefix of HOTSPOT_PREFIXES) {
    if (host.startsWith(prefix)) return 'hotspot'
  }
  if (a === 10) return 'lan'
  if (a === 172 && b >= 16 && b <= 31) return 'lan'
  if (a === 192 && b === 168) return 'lan'
  if (a === 100 && b >= 64 && b <= 127) return 'tailnet'
  return 'other'
}

/** Classify the host part of a URL; '' when it is not an address we track. */
export function classifyUrl(rawUrl) {
  const text = String(rawUrl || '').trim()
  if (!text) return ''
  try {
    const url = new URL(text.includes('://') ? text : `http://${text}`)
    return classifyHost(url.hostname)
  } catch {
    return ''
  }
}

export function peersFile(stateDir) {
  return join(String(stateDir || '.'), 'peers.json')
}

export function sanitizeRecords(raw) {
  const out = {}
  if (!isPlainObject(raw)) return out
  for (const mode of PEER_ADDRESS_MODES) {
    const record = raw[mode]
    if (!isPlainObject(record)) continue
    const host = normalizeHost(record.host)
    if (!host) continue
    const count = Number(record.count)
    out[mode] = {
      host,
      at: typeof record.at === 'string' ? record.at : '',
      count: Number.isFinite(count) && count > 0 ? Math.trunc(count) : 1,
    }
  }
  return out
}

/** Never throws: a corrupt file means "nothing remembered yet". */
export function readPeerRecords(stateDir) {
  try {
    const parsed = JSON.parse(readFileSync(peersFile(stateDir), 'utf8'))
    return sanitizeRecords(parsed?.records)
  } catch {
    return {}
  }
}

export function writePeerRecords(stateDir, records) {
  const file = peersFile(stateDir)
  mkdirSync(dirname(file), { recursive: true })
  const body = { version: 1, records: sanitizeRecords(records) }
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
  return body.records
}

/**
 * Remember `host`. Returns the stored record, or null when the host is
 * loopback (nobody to remember) or the same address was written recently.
 */
export function rememberPeerRecord(stateDir, host, { now = Date.now(), minIntervalMs = REMEMBER_THROTTLE_MS } = {}) {
  const mode = classifyHost(host)
  const value = normalizeHost(host)
  if (!mode || mode === 'local' || !value) return null
  const records = readPeerRecords(stateDir)
  const current = records[mode]
  const at = new Date(now).toISOString()
  if (current && current.host === value) {
    const previous = Date.parse(current.at || '')
    if (Number.isFinite(previous) && now - previous < minIntervalMs) return null
    records[mode] = { host: value, at, count: (current.count || 1) + 1 }
  } else {
    records[mode] = { host: value, at, count: 1 }
  }
  writePeerRecords(stateDir, records)
  return records[mode]
}

export function deletePeerRecord(stateDir, mode) {
  if (!PEER_ADDRESS_MODES.includes(mode)) return false
  const records = readPeerRecords(stateDir)
  if (!records[mode]) return false
  delete records[mode]
  writePeerRecords(stateDir, records)
  return true
}

/**
 * Address chips per connection kind: most recent first, at most `max`.
 * A new host replaces the oldest entry; the same host moves to the front.
 */
export function addPeerHistory(history, host, max = 2) {
  const out = {}
  if (isPlainObject(history)) {
    for (const mode of PEER_ADDRESS_MODES) {
      const list = Array.isArray(history[mode]) ? history[mode] : []
      const cleaned = list.map((item) => normalizeHost(item)).filter(Boolean)
      if (cleaned.length) out[mode] = [...new Set(cleaned)].slice(0, max)
    }
  }
  const mode = classifyHost(host)
  const value = normalizeHost(host)
  if (!mode || mode === 'local' || !value) return out
  const previous = out[mode] || []
  out[mode] = [value, ...previous.filter((item) => item !== value)].slice(0, max)
  return out
}
