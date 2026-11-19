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
 * End-to-end self test for the file channel: write, read back, stat, delete a
 * throwaway file in the OS temp directory. Runs in-process (no socket), so it
 * checks the file layer and the target path resolution, not the network.
 */
async function runFileSelfTest(runtime) {
  const started = Date.now()
  const cfg = runtime.getConfig?.() || {}
  const steps = []
  const { rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { randomBytes } = await import('node:crypto')
  const { fileRead, fileStat, fileWrite } = await import('./file.mjs')
  const target = join(tmpdir(), `dsh-pc-bridge-selftest-${randomBytes(4).toString('hex')}.txt`)
  const payload = Buffer.from(`dsh-pc-bridge file self test ${new Date().toISOString()}\n`, 'utf8')
  const base = {
    cwd: cfg.cwd,
    roots: Array.isArray(cfg.fileRoots) ? cfg.fileRoots : [],
    chunkBytes: cfg.fileChunkBytes,
    maxBytes: cfg.fileMaxBytes,
  }
  try {
    const written = await fileWrite({
      ...base,
      path: target,
      uploadId: randomBytes(8).toString('hex'),
      data: payload.toString('base64'),
      final: true,
    })
    steps.push({ step: 'write', ok: written.ok !== false, bytes: written.written })
    const read = await fileRead(target, { ...base, offset: 0, maxBytes: 65536 })
    const text = Buffer.from(read.data || '', 'base64').toString('utf8')
    steps.push({ step: 'read', ok: text === payload.toString('utf8'), bytes: read.bytes, sha256: read.sha256 })
    const info = await fileStat(target, { cwd: base.cwd, roots: base.roots })
    steps.push({ step: 'stat', ok: info.size === payload.length, size: info.size })
    await rm(target, { force: true })
    steps.push({ step: 'delete', ok: true })
    return { ok: steps.every((step) => step.ok), path: target, steps, ms: Date.now() - started }
  } catch (error) {
    await rm(target, { force: true }).catch(() => {})
    return { ok: false, error: String(error?.message || error), path: target, steps, ms: Date.now() - started }
  }
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

      // 0.6.0: remembered caller addresses (server side) and the "use it"
      // action that points this host at one of them.
      if (action === 'peers' && req.method === 'GET') {
        send(res, 200, { ok: true, ...runtime.peers.list() })
        return
      }

      if (action === 'peers/delete' && req.method === 'POST') {
        const payload = await body()
        const mode = String(payload?.mode || '').trim()
        if (!mode) {
          send(res, 400, { ok: false, error: 'mode 不能为空' })
          return
        }
        const removed = runtime.peers.remove(mode)
        send(res, 200, { ok: true, removed, ...runtime.peers.list() })
        return
      }

      if (action === 'peers/use' && req.method === 'POST') {
        const payload = await body()
        const mode = String(payload?.mode || '').trim()
        if (!mode) {
          send(res, 400, { ok: false, error: 'mode 不能为空' })
          return
        }
        const result = await runtime.peers.use(mode)
        if (!result?.ok) {
          send(res, 404, { ok: false, error: String(result?.error || '没有记住这个地址') })
          return
        }
        send(res, 200, { ok: true, ...result, status: await runtime.status() })
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

      if (action === 'ui-event' && req.method === 'POST') {
        const payload = await body()
        try {
          const stateDir = runtime.getConfig?.()?.stateDir
          if (stateDir) {
            const { appendFile } = await import('node:fs/promises')
            const { join } = await import('node:path')
            const line = JSON.stringify({
              at: new Date().toISOString(),
              event: String(payload?.event || '').slice(0, 120),
              detail: payload?.detail ?? null,
            })
            await appendFile(join(stateDir, 'ui-events.log'), line + '\n').catch(() => {})
          }
        } catch {
          /* diagnostics must never break the page */
        }
        send(res, 200, { ok: true })
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

      if (action === 'warp' && req.method === 'GET') {
        const current = await runtime.status()
        send(res, 200, {
          ok: true,
          warp: current.warp,
          tailscale: current.tailscale,
          remote: current.remote,
        })
        return
      }

      if (action === 'warp' && req.method === 'POST') {
        const payload = await body()
        const result = await runtime.warpAction(payload?.action)
        send(res, 200, {
          ok: true,
          warp: result?.warp ?? null,
          status: result?.status && typeof result.status === 'object'
            ? result.status
            : await runtime.status(),
        })
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

      if (action === 'file-test' && req.method === 'POST') {
        const result = await runFileSelfTest(runtime)
        send(res, 200, { ok: result.ok !== false, result })
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
