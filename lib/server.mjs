import { createServer as createHttpServer } from 'node:http'
import { hostname, userInfo } from 'node:os'

import { fileList, fileRead, fileStat, fileWrite } from './file.mjs'
import { runShellCommand } from './exec.mjs'
import { secretsEqual } from './secret.mjs'

const MAX_BODY_BYTES = 64 * 1024
const MAX_PAIR_BYTES = 4 * 1024
const MAX_COMMAND_BYTES = 8 * 1024

function toPositiveInt(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback
}

function queryNumber(value, fallback) {
  if (value === null || value === undefined) return fallback
  const text = String(value).trim()
  if (!text) return fallback
  const number = Number(text)
  return Number.isFinite(number) ? number : fallback
}

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
        // Do not destroy the socket here: the caller still has to flush a 413
        // response, and an immediate destroy makes the client see a reset.
        reject(error)
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
  version = '',
  exec,
  file,
  onPair,
  onExec,
  onFile,
  peers,
  logger,
} = {}) {
  if (!secret) throw new Error('pc-bridge: a non-empty secret is required')
  const runExec = typeof exec === 'function'
    ? exec
    : (command, options) => runShellCommand(command, { ...options, cwd })
  const fileEnabled = file ? file.enabled !== false : true
  const fileCwd = file?.cwd || cwd
  const fileRoots = Array.isArray(file?.roots) ? file.roots : []
  const fileChunkBytes = toPositiveInt(file?.chunkBytes, 1048576)
  const fileMaxBytes = toPositiveInt(file?.maxBytes, 67108864)
  let started = false

  async function fileRequest(req, res, { op, path, bytesOf, run }) {
    const startedAt = Date.now()
    let result
    let failure = null
    try {
      result = await run()
    } catch (error) {
      failure = error
    }
    const rawPath = typeof path === 'function' ? path() : path
    try {
      await onFile?.({
        op,
        path: rawPath,
        bytes: failure ? 0 : (bytesOf ? bytesOf(result) : 0),
        ip: req.socket?.remoteAddress,
        ms: Date.now() - startedAt,
        ok: !failure,
      })
    } catch (error) {
      logger?.warn?.(`file audit failed: ${error?.message || error}`)
    }
    if (failure) {
      send(res, failure?.statusCode || 500, { ok: false, error: String(failure?.message || failure) })
      return
    }
    send(res, 200, result)
  }

  const server = createHttpServer((req, res) => {
    void handle(req, res)
  })

  async function handle(req, res) {
    try {
      const url = new URL(req.url || '/', `http://${listenHost}`)

      // Unauthenticated: discovery and pairing need to work before the two
      // machines share a secret.
      if (url.pathname === '/health' && req.method === 'GET') {
        send(res, 200, {
          ok: true,
          name: 'dsh-pc-bridge',
          version,
          platform: process.platform,
          capabilities: fileEnabled ? ['ping', 'exec', 'pair', 'file'] : ['ping', 'exec', 'pair'],
          time: new Date().toISOString(),
        })
        return
      }

      if (url.pathname === '/pair' && req.method === 'POST') {
        let payload
        try {
          payload = JSON.parse((await readBody(req, MAX_PAIR_BYTES)) || '{}')
        } catch (error) {
          const tooLarge = error?.statusCode === 413
          send(res, tooLarge ? 413 : 400, {
            ok: false,
            error: tooLarge ? 'request body too large' : 'invalid json',
          })
          return
        }
        const code = String(payload?.code ?? '').trim()
        if (!code) {
          send(res, 400, { ok: false, error: 'missing code' })
          return
        }
        if (typeof onPair !== 'function') {
          send(res, 401, { ok: false, error: 'pairing is not enabled' })
          return
        }
        let verdict
        try {
          verdict = await onPair({
            code,
            ip: req.socket?.remoteAddress,
            name: payload?.name,
            platform: payload?.platform,
          })
        } catch (error) {
          send(res, 401, { ok: false, error: String(error?.message || error) })
          return
        }
        if (!verdict?.ok || !verdict?.secret) {
          send(res, 401, { ok: false, error: String(verdict?.error || 'pairing rejected') })
          return
        }
        send(res, 200, {
          ok: true,
          secret: verdict.secret,
          name: hostname(),
          platform: process.platform,
          host: hostname(),
          port: server.address()?.port ?? listenPort,
        })
        return
      }

      if (!secretsEqual(req.headers['x-pc-secret'], secret)) {
        send(res, 401, { ok: false, error: 'unauthorized' })
        return
      }

      // 0.6.0: remember the caller's address once it proves it knows the
      // secret, so a network switch can be answered from a list later.
      if (peers?.record) {
        try {
          peers.record(String(req.socket?.remoteAddress || ''))
        } catch (error) {
          logger?.warn?.(`remembering peer failed: ${error?.message || error}`)
        }
      }

      if (peers) {
        if (url.pathname === '/peers' && req.method === 'GET') {
          send(res, 200, { ok: true, ...peers.list() })
          return
        }
        if (url.pathname === '/peers/delete' && req.method === 'POST') {
          let payload = {}
          try {
            payload = JSON.parse((await readBody(req, MAX_BODY_BYTES)) || '{}') || {}
          } catch (error) {
            send(res, error?.statusCode === 413 ? 413 : 400, {
              ok: false,
              error: error?.statusCode === 413 ? 'request body too large' : 'invalid json',
            })
            return
          }
          const removed = peers.remove(String(payload?.mode || ''))
          send(res, 200, { ok: true, removed, ...peers.list() })
          return
        }
        if (url.pathname === '/peers/use' && req.method === 'POST') {
          let payload = {}
          try {
            payload = JSON.parse((await readBody(req, MAX_BODY_BYTES)) || '{}') || {}
          } catch (error) {
            send(res, error?.statusCode === 413 ? 413 : 400, {
              ok: false,
              error: error?.statusCode === 413 ? 'request body too large' : 'invalid json',
            })
            return
          }
          const mode = String(payload?.mode || '').trim()
          if (!mode) {
            send(res, 400, { ok: false, error: 'mode is required' })
            return
          }
          const result = await peers.use(mode)
          if (!result?.ok) {
            send(res, 404, { ok: false, error: String(result?.error || 'no remembered address') })
            return
          }
          send(res, 200, { ok: true, ...result })
          return
        }
      }

      if (!fileEnabled && (url.pathname === '/file' || url.pathname.startsWith('/file/'))) {
        send(res, 404, { ok: false, error: 'not found' })
        return
      }

      if (url.pathname === '/file/stat' && req.method === 'GET') {
        const rawPath = url.searchParams.get('path') || ''
        await fileRequest(req, res, {
          op: 'stat',
          path: rawPath,
          run: () => fileStat(rawPath, { cwd: fileCwd, roots: fileRoots }),
        })
        return
      }

      if (url.pathname === '/file/list' && req.method === 'GET') {
        const rawPath = url.searchParams.get('path') || ''
        const limit = queryNumber(url.searchParams.get('limit'), 200)
        await fileRequest(req, res, {
          op: 'list',
          path: rawPath,
          run: () => fileList(rawPath, { cwd: fileCwd, roots: fileRoots, limit }),
        })
        return
      }

      if (url.pathname === '/file/read' && req.method === 'GET') {
        const rawPath = url.searchParams.get('path') || ''
        const offset = queryNumber(url.searchParams.get('offset'), 0)
        const maxBytes = queryNumber(url.searchParams.get('maxBytes'), fileChunkBytes)
        await fileRequest(req, res, {
          op: 'read',
          path: rawPath,
          bytesOf: (result) => result.bytes,
          run: () => fileRead(rawPath, {
            cwd: fileCwd,
            roots: fileRoots,
            offset,
            maxBytes,
            chunkBytes: fileChunkBytes,
          }),
        })
        return
      }

      if (url.pathname === '/file/write' && req.method === 'POST') {
        const bodyLimit = Math.min(Math.ceil(fileChunkBytes * 4 / 3) + 16384, 64 * 1024 * 1024)
        let auditPath = ''
        await fileRequest(req, res, {
          op: 'write',
          path: () => auditPath,
          bytesOf: (result) => result.written,
          run: async () => {
            let payload
            try {
              payload = JSON.parse((await readBody(req, bodyLimit)) || '{}')
            } catch (error) {
              const tooLarge = error?.statusCode === 413
              const failure = new Error(tooLarge ? 'request body too large' : 'invalid json')
              failure.statusCode = tooLarge ? 413 : 400
              throw failure
            }
            auditPath = typeof payload?.path === 'string' ? payload.path : ''
            return fileWrite({
              ...payload,
              path: auditPath,
              cwd: fileCwd,
              roots: fileRoots,
              chunkBytes: fileChunkBytes,
              maxBytes: fileMaxBytes,
              enabled: fileEnabled,
            })
          },
        })
        return
      }

      if (url.pathname === '/info' && req.method === 'GET') {
        send(res, 200, {
          ok: true,
          host: hostname(),
          user: safeUser(),
          platform: process.platform,
          version,
          pid: process.pid,
          shell: shell?.kind || 'unknown',
          shellExe: shell?.exe || '',
          cwd: cwd || process.cwd(),
          limits: { defaultTimeoutMs, maxTimeoutMs, maxOutputBytes },
          file: { enabled: fileEnabled, roots: fileRoots, chunkBytes: fileChunkBytes, maxBytes: fileMaxBytes },
          now: new Date().toISOString(),
        })
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

        const startedAt = Date.now()
        const result = await runExec(command, { shell, timeoutMs, maxOutputBytes })
        // Audit before responding, but never let a broken audit sink the call.
        try {
          await onExec?.({ command, ip: req.socket?.remoteAddress, result, ms: Date.now() - startedAt })
        } catch (error) {
          logger?.warn?.(`exec audit failed: ${error?.message || error}`)
        }
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
