import { createServer as createHttpServer } from 'node:http'
import { hostname, userInfo } from 'node:os'

import { runShellCommand } from './exec.mjs'
import { secretsEqual } from './secret.mjs'

const MAX_BODY_BYTES = 64 * 1024
const MAX_COMMAND_BYTES = 8 * 1024

function safeUser() {
  try {
    return userInfo().username
  } catch {
    return 'unknown'
  }
}

function send(res, status, payload) {
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        const error = new Error('request body too large')
        error.statusCode = 413
        reject(error)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Loopback HTTP bridge: POST /exec, GET|POST /ping, shared-secret auth.
 * `exec` is injectable so tests do not need to spawn shells.
 */
export function createBridgeServer({
  secret,
  shell,
  listenHost = '127.0.0.1',
  listenPort = 18790,
  defaultTimeoutMs = 30000,
  maxTimeoutMs = 600000,
  maxOutputBytes = 2 * 1024 * 1024,
  cwd,
  exec,
  logger,
} = {}) {
  if (!secret) throw new Error('pc-bridge: a non-empty secret is required')
  const runExec = typeof exec === 'function'
    ? exec
    : (command, options) => runShellCommand(command, { ...options, cwd })
  let started = false

  const server = createHttpServer((req, res) => {
    void handle(req, res)
  })

  async function handle(req, res) {
    try {
      const url = new URL(req.url || '/', `http://${listenHost}`)

      if (!secretsEqual(req.headers['x-pc-secret'], secret)) {
        send(res, 401, { ok: false, error: 'unauthorized' })
        return
      }

      if (url.pathname === '/ping' && (req.method === 'GET' || req.method === 'POST')) {
        send(res, 200, {
          ok: true,
          host: hostname(),
          user: safeUser(),
          shell: shell?.kind || 'unknown',
          pid: process.pid,
          now: new Date().toISOString(),
        })
        return
      }

      if (url.pathname === '/exec' && req.method === 'POST') {
        let payload
        try {
          payload = JSON.parse((await readBody(req, MAX_BODY_BYTES)) || '{}')
        } catch (error) {
          const tooLarge = error?.statusCode === 413
          send(res, tooLarge ? 413 : 400, {
            ok: false,
            error: tooLarge ? 'request body too large' : 'invalid json',
          })
          return
        }

        const command = typeof payload?.cmd === 'string'
          ? payload.cmd
          : (typeof payload?.command === 'string' ? payload.command : '')
        if (!command.trim()) {
          send(res, 400, { ok: false, error: 'missing cmd' })
          return
        }
        if (Buffer.byteLength(command) > MAX_COMMAND_BYTES) {
          send(res, 413, { ok: false, error: 'command too large' })
          return
        }

        const requested = Number(payload?.timeoutSec)
        const timeoutMs = Number.isFinite(requested) && requested > 0
          ? Math.min(Math.max(requested, 1) * 1000, maxTimeoutMs)
          : defaultTimeoutMs

        const result = await runExec(command, { shell, timeoutMs, maxOutputBytes })
        send(res, 200, result)
        return
      }

      send(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      logger?.error?.(`request failed: ${error?.message || error}`)
      if (!res.headersSent) send(res, 500, { ok: false, error: String(error?.message || error) })
      else res.end()
    }
  }

  return {
    server,
    async start() {
      if (started) return server.address()
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.removeListener('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.removeListener('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(listenPort, listenHost)
      })
      started = true
      return server.address()
    },
    async close() {
      if (!started) return
      started = false
      await new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    },
  }
}
