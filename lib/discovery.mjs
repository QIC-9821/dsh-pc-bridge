import dgram from 'node:dgram'
import os from 'node:os'

const MAGIC_PAYLOAD = 'DSHBRIDGE/1'
const RESPONSE_MAGIC = 'dsh-bridge'
const BROADCAST_ADDRESS = '255.255.255.255'
const LOOPBACK_ADDRESS = '127.0.0.1'

function addressScore(address) {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part))) return -1
  if (parts[0] === 127) return 0
  if (parts[0] === 169 && parts[1] === 254) return 1 // link-local: usable but rare
  if (parts[0] === 10) return 4
  if (parts[0] === 192 && parts[1] === 168) return 4
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return 4
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return 2 // CGNAT / Tailscale
  return 3
}

/**
 * Best-effort LAN IPv4 address, used when the caller passes no `host`.
 * Site-local addresses win over CGNAT/Tailscale ones so a plain LAN peer can
 * connect to the advertised address.
 */
function bestIPv4() {
  let best = ''
  let bestScore = -1
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (!entry || entry.family !== 'IPv4' || entry.internal) continue
      const score = addressScore(entry.address)
      if (score > bestScore) {
        best = entry.address
        bestScore = score
      }
    }
  }
  return best || LOOPBACK_ADDRESS
}

function warn(logger, message) {
  logger?.warn?.(message)
}

function validPort(value, fallback = 0) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65535) return fallback
  return port
}

/**
 * Answers `DSHBRIDGE/1` datagrams with one JSON peer description.
 *
 * `port: 0` binds a random free port; `start()` resolves the actual one.
 * The responder is reusable: `stop()` releases the socket, a later `start()`
 * opens a fresh one.
 */
export function createDiscoveryResponder({ port = 0, info = {}, logger } = {}) {
  const name = String(info.name || os.hostname())
  const host = String(info.host || bestIPv4())
  const bridgePort = validPort(info.port, 0)
  const platform = String(info.platform || process.platform)
  const version = String(info.version || '')
  const bindPort = validPort(port, 0)

  let socket = null
  let actualPort = 0
  let startPromise = null

  function reply(sock, message, remote) {
    if (message.toString('utf8') !== MAGIC_PAYLOAD) return
    const payload = Buffer.from(
      JSON.stringify({
        magic: RESPONSE_MAGIC,
        name,
        host,
        port: bridgePort,
        platform,
        version,
        ts: Date.now(),
      }),
      'utf8',
    )
    try {
      sock.send(payload, remote.port, remote.address, error => {
        if (error) warn(logger, `discovery: reply to ${remote.address}:${remote.port} failed (${error.message})`)
      })
    } catch (error) {
      warn(logger, `discovery: reply to ${remote.address}:${remote.port} failed (${error?.message || error})`)
    }
  }

  function start() {
    if (socket) return Promise.resolve({ port: actualPort })
    if (startPromise) return startPromise

    startPromise = new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4')
      socket = sock
      let settled = false

      sock.on('message', (message, remote) => reply(sock, message, remote))
      sock.on('error', error => {
        if (!settled) {
          settled = true
          startPromise = null
          socket = null
          try {
            sock.close()
          } catch {
            // already closed
          }
          reject(error)
          return
        }
        warn(logger, `discovery: socket error (${error?.message || error})`)
      })
      sock.bind({ address: '0.0.0.0', port: bindPort }, () => {
        if (settled) return
        settled = true
        startPromise = null
        actualPort = sock.address().port
        logger?.info?.(`discovery responder listening on 0.0.0.0:${actualPort}`)
        resolve({ port: actualPort })
      })
    })
    return startPromise
  }

  function stop() {
    const sock = socket
    socket = null
    actualPort = 0
    startPromise = null
    if (!sock) return Promise.resolve()
    return new Promise(resolve => {
      try {
        sock.close(() => resolve())
      } catch {
        resolve()
      }
    })
  }

  return {
    start,
    stop,
    get port() {
      return actualPort
    },
  }
}

/**
 * Broadcasts `DSHBRIDGE/1` to the LAN and loopback, then collects replies for
 * `timeoutMs`. Replies are deduplicated by the reported host + bridge port, so
 * a peer reached through both routes is listed once.
 */
export function scanPeers({ port, timeoutMs = 1200, logger } = {}) {
  const targetPort = Number(port)
  const waitMs = Math.max(0, Math.floor(Number(timeoutMs) || 0))

  return new Promise((resolve, reject) => {
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      reject(new Error(`discovery: invalid discovery port ${port}`))
      return
    }

    const socket = dgram.createSocket('udp4')
    const peers = new Map()
    let timer = null
    let finished = false

    function finish() {
      if (finished) return
      finished = true
      if (timer) clearTimeout(timer)
      try {
        socket.close()
      } catch {
        // already closed
      }
      resolve([...peers.values()].sort((left, right) => right.lastSeen - left.lastSeen))
    }

    socket.on('message', (message, remote) => {
      let data
      try {
        data = JSON.parse(message.toString('utf8'))
      } catch {
        return
      }
      if (!data || data.magic !== RESPONSE_MAGIC) return

      const peerPort = Number(data.port)
      if (!Number.isInteger(peerPort) || peerPort < 1 || peerPort > 65535) return

      const reportedHost = String(data.host || '').trim() || remote.address
      const key = `${reportedHost}|${peerPort}`
      peers.set(key, {
        name: String(data.name || '').trim(),
        host: reportedHost,
        port: peerPort,
        platform: String(data.platform || ''),
        version: String(data.version || ''),
        address: remote.address,
        lastSeen: Date.now(),
      })
    })
    socket.on('error', error => {
      warn(logger, `discovery: scan socket error (${error?.message || error})`)
      finish()
    })

    socket.bind({ address: '0.0.0.0', port: 0 }, () => {
      if (finished) return
      timer = setTimeout(finish, waitMs)

      const payload = Buffer.from(MAGIC_PAYLOAD, 'utf8')
      function send(address) {
        try {
          socket.send(payload, targetPort, address, error => {
            if (error) warn(logger, `discovery: scan send to ${address}:${targetPort} failed (${error.message})`)
          })
        } catch (error) {
          warn(logger, `discovery: scan send to ${address}:${targetPort} failed (${error?.message || error})`)
        }
      }

      try {
        socket.setBroadcast(true)
      } catch (error) {
        warn(logger, `discovery: could not enable broadcast (${error?.message || error})`)
      }
      send(BROADCAST_ADDRESS)
      send(LOOPBACK_ADDRESS)
    })
  })
}
