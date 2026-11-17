const PREFIX = '/pc-bridge'
const API = '/api/'
const MAX_BODY_BYTES = 64 * 1024
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

function send(res, status, value) {
  if (res.headersSent) {
    res.end()
    return
  }
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': body.length })
  res.end(body)
}

function tooLarge() {
  const error = new Error('request body too large')
  error.statusCode = 413
  return error
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) {
      req.resume()
      reject(tooLarge())
      return
    }

    let size = 0
    let settled = false
    const chunks = []

    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        settled = true
        // Drain instead of destroying the socket: the client still needs to
        // read the 413 response off this connection.
        req.resume()
        reject(tooLarge())
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

async function readJson(req) {
  const text = await readBody(req)
  if (!text.trim()) return {}
  return JSON.parse(text)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Settings UI API for dsh-pc-bridge. Mounted by index.js with
 * `webServer.register({ kind: 'prefix', path: '/pc-bridge', handler })`, so the
 * handler sees the full request path and strips the prefix itself. No extra
 * authentication: the DSH web server already gates the session.
 */
export function createRoutes({ runtime, version = '' } = {}) {
  if (!runtime) throw new Error('createRoutes: runtime is required')

  async function stateBody() {
    return {
      ok: true,
      version,
      config: runtime.publicConfig(),
      status: await runtime.status(),
      audit: await runtime.auditTail(20),
    }
  }

  async function handle(req, res) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'cache-control': 'no-store',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type',
        'content-length': 0,
      })
      res.end()
      return
    }

    let url
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1')
    } catch {
      send(res, 400, { ok: false, error: 'invalid url' })
      return
    }

    const rawPath = url.pathname || '/'
    if (rawPath !== PREFIX && !rawPath.startsWith(`${PREFIX}/`)) {
      send(res, 404, { ok: false, error: 'not found' })
      return
    }
    const path = rawPath.slice(PREFIX.length) || '/'
    if (!path.startsWith(API)) {
      send(res, 404, { ok: false, error: 'not found' })
      return
    }
    const action = path.slice(API.length).replace(/\/+$/, '')

    let parsed
    async function body() {
      if (parsed === undefined) parsed = await readJson(req)
      return parsed
    }

    try {
      if (action === 'state' && req.method === 'GET') {
        send(res, 200, await stateBody())
        return
      }

      if (action === 'config' && req.method === 'POST') {
        const payload = await body()
        const patch = payload?.patch
        if (patch !== undefined && !isPlainObject(patch)) {
          send(res, 400, { ok: false, error: 'patch 必须是对象' })
          return
        }
        const applied = await runtime.applyPatch(patch || {})
        // 0.3.1: applyPatch may report non-fatal problems (for example an old
        // secret file that could not be removed after a path migration).
        const warnings = Array.isArray(applied?.warnings) ? applied.warnings.map(String) : []
        send(res, 200, {
          ok: true,
          status: applied?.status && typeof applied.status === 'object'
            ? applied.status
            : await runtime.status(),
          config: runtime.publicConfig(),
          warnings,
        })
        return
      }

      if (action === 'enabled' && req.method === 'POST') {
        const payload = await body()
        if (typeof payload?.enabled !== 'boolean') {
          send(res, 400, { ok: false, error: 'enabled 必须是布尔值' })
          return
        }
        const next = await runtime.setEnabled(payload.enabled)
        send(res, 200, {
          ok: true,
          status: next && typeof next === 'object' ? next : await runtime.status(),
          config: runtime.publicConfig(),
        })
        return
      }

      if (action === 'pair/clear' && req.method === 'POST') {
        const next = await runtime.clearPair()
        send(res, 200, {
          ok: true,
          status: next && typeof next === 'object' ? next : await runtime.status(),
          config: runtime.publicConfig(),
        })
        return
      }

      if (action === 'cleanup' && req.method === 'POST') {
        const payload = await body()
        if (payload?.confirm !== true) {
          send(res, 400, { ok: false, error: '需要 confirm: true 才会删除本机数据' })
          return
        }
        const result = await runtime.cleanup()
        send(res, 200, {
          ok: true,
          removed: Array.isArray(result?.removed) ? result.removed.map(String) : [],
          failed: Array.isArray(result?.failed) ? result.failed.map(String) : [],
        })
        return
      }

      if (action === 'start' && req.method === 'POST') {
        await runtime.start()
        send(res, 200, { ok: true, status: await runtime.status() })
        return
      }

      if (action === 'stop' && req.method === 'POST') {
        await runtime.stop()
        send(res, 200, { ok: true, status: await runtime.status() })
        return
      }

      if (action === 'restart' && req.method === 'POST') {
        await runtime.restart()
        send(res, 200, { ok: true, status: await runtime.status() })
        return
      }

      if (action === 'discover' && req.method === 'GET') {
        const devices = await runtime.discover()
        send(res, 200, { ok: true, devices: Array.isArray(devices) ? devices : [] })
        return
      }

      if (action === 'test' && req.method === 'POST') {
        const payload = await body()
        const url = typeof payload?.url === 'string' ? payload.url.trim() : ''
        const result = await runtime.testPeer(url)
        send(res, 200, { ok: true, result })
        return
      }

      if (action === 'pair/new' && req.method === 'POST') {
        const pair = await runtime.createPairCode()
        send(res, 200, { ok: true, code: pair?.code, expiresAt: pair?.expiresAt })
        return
      }

      if (action === 'pair/accept' && req.method === 'POST') {
        const payload = await body()
        const url = typeof payload?.url === 'string' ? payload.url.trim() : ''
        const code = String(payload?.code ?? '').trim()
        if (!url) {
          send(res, 400, { ok: false, error: '缺少对端地址' })
          return
        }
        if (!code) {
          send(res, 400, { ok: false, error: '缺少配对码' })
          return
        }
        const result = await runtime.acceptPair({ url, code })
        send(res, 200, {
          ok: true,
          status: await runtime.status(),
          peer: result?.peer ?? null,
        })
        return
      }

      if (action === 'secret/rotate' && req.method === 'POST') {
        await runtime.rotateSecret()
        send(res, 200, { ok: true, status: await runtime.status() })
        return
      }

      if (action === 'audit' && req.method === 'GET') {
        const raw = Number(url.searchParams.get('limit'))
        const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.trunc(raw), 200) : 20
        const entries = await runtime.auditTail(limit)
        send(res, 200, { ok: true, entries: Array.isArray(entries) ? entries : [] })
        return
      }

      send(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      const tooBig = error?.statusCode === 413
      const badJson = error instanceof SyntaxError
      if (tooBig) {
        send(res, 413, { ok: false, error: 'request body too large' })
        return
      }
      if (badJson) {
        send(res, 400, { ok: false, error: 'invalid json' })
        return
      }
      const status = Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 600
        ? error.statusCode
        : 500
      send(res, status, { ok: false, error: String(error?.message || error) })
    }
  }

  return { handle, stateBody }
}
