import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createBridgeServer } from '../lib/server.mjs'

const shell = { exe: 'bash', args: ['-lc'], kind: 'bash' }
const headers = { 'x-pc-secret': 's3cret', 'content-type': 'application/json' }

async function startBridge(t, overrides = {}) {
  const calls = []
  const bridge = createBridgeServer({
    secret: 's3cret',
    shell,
    listenHost: '127.0.0.1',
    listenPort: 0,
    exec: async (command, options) => {
      calls.push({ command, options })
      return {
        ok: true,
        exitCode: 0,
        stdout: `ran:${command}`,
        stderr: '',
        durationMs: 1,
        timedOut: false,
        truncated: false,
      }
    },
    ...overrides,
  })
  const address = await bridge.start()
  t.after(() => bridge.close())
  return { bridge, calls, url: `http://127.0.0.1:${address.port}` }
}

test('ping requires the shared secret', async (t) => {
  const { url } = await startBridge(t)

  const unauthorized = await fetch(`${url}/ping`)
  assert.equal(unauthorized.status, 401)
  assert.equal((await unauthorized.json()).ok, false)

  const ok = await fetch(`${url}/ping`, { headers })
  assert.equal(ok.status, 200)
  const pong = await ok.json()
  assert.equal(pong.ok, true)
  assert.equal(pong.shell, 'bash')
  assert.equal(typeof pong.host, 'string')
})

test('exec runs the injected executor and clamps timeoutSec', async (t) => {
  const { url, calls } = await startBridge(t)
  const response = await fetch(`${url}/exec`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ cmd: 'hostname', timeoutSec: 999999 }),
  })
  const body = await response.json()
  assert.equal(response.status, 200)
  assert.equal(body.stdout, 'ran:hostname')
  assert.equal(body.exitCode, 0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.timeoutMs, 600000)
})

test('exec uses the default timeout when timeoutSec is absent', async (t) => {
  const { url, calls } = await startBridge(t)
  await fetch(`${url}/exec`, { method: 'POST', headers, body: JSON.stringify({ cmd: 'echo hi' }) })
  assert.equal(calls[0].options.timeoutMs, 30000)
})

test('exec rejects a missing command and oversized commands', async (t) => {
  const { url } = await startBridge(t)

  const missing = await fetch(`${url}/exec`, { method: 'POST', headers, body: '{}' })
  assert.equal(missing.status, 400)

  const huge = await fetch(`${url}/exec`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ cmd: 'a'.repeat(9000) }),
  })
  assert.equal(huge.status, 413)
})

test('exec rejects invalid json and unknown routes', async (t) => {
  const { url } = await startBridge(t)

  const invalid = await fetch(`${url}/exec`, { method: 'POST', headers, body: 'not json' })
  assert.equal(invalid.status, 400)

  const unknown = await fetch(`${url}/nope`, { headers })
  assert.equal(unknown.status, 404)
})

test('GET /exec is not a route', async (t) => {
  const { url } = await startBridge(t)
  const response = await fetch(`${url}/exec`, { headers })
  assert.equal(response.status, 404)
})

test('health is reachable without the shared secret', async (t) => {
  const { url } = await startBridge(t, { version: '0.3.0' })
  const response = await fetch(`${url}/health`)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.name, 'dsh-pc-bridge')
  assert.equal(body.version, '0.3.0')
  assert.equal(body.platform, process.platform)
  assert.deepEqual([...body.capabilities].sort(), ['exec', 'file', 'pair', 'ping'])
  assert.equal(typeof body.time, 'string')
})

test('pair hands the code to onPair and returns the shared secret', async (t) => {
  const seen = []
  const { url } = await startBridge(t, {
    onPair: async (entry) => {
      seen.push(entry)
      if (entry.code !== '123456') throw new Error('配对码不正确')
      return { ok: true, secret: 'paired-secret' }
    },
  })

  const accepted = await fetch(`${url}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: '123456', name: 'pc', platform: 'win32' }),
  })
  assert.equal(accepted.status, 200)
  const body = await accepted.json()
  assert.equal(body.ok, true)
  assert.equal(body.secret, 'paired-secret')
  assert.equal(typeof body.host, 'string')
  assert.ok(body.port > 0)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].code, '123456')
  assert.equal(seen[0].name, 'pc')
  assert.match(seen[0].ip, /127\.0\.0\.1/)

  const rejected = await fetch(`${url}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: '000000' }),
  })
  assert.equal(rejected.status, 401)
  assert.equal((await rejected.json()).ok, false)
})

test('pair requires a code, a hook and a small valid json body', async (t) => {
  const { url } = await startBridge(t)

  const noHook = await fetch(`${url}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: '123456' }),
  })
  assert.equal(noHook.status, 401)

  const missing = await fetch(`${url}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(missing.status, 400)

  const invalid = await fetch(`${url}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json',
  })
  assert.equal(invalid.status, 400)

  const huge = await fetch(`${url}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'a'.repeat(5000) }),
  })
  assert.equal(huge.status, 413)
})

test('info requires the shared secret and reports limits', async (t) => {
  const { url } = await startBridge(t, { version: '0.3.0', maxOutputBytes: 1024 * 1024 })

  const denied = await fetch(`${url}/info`)
  assert.equal(denied.status, 401)

  const response = await fetch(`${url}/info`, { headers })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.version, '0.3.0')
  assert.equal(body.platform, process.platform)
  assert.equal(body.pid, process.pid)
  assert.equal(typeof body.host, 'string')
  assert.equal(typeof body.user, 'string')
  assert.equal(typeof body.cwd, 'string')
  assert.equal(typeof body.shell, 'string')
  assert.deepEqual(body.limits, {
    defaultTimeoutMs: 30000,
    maxTimeoutMs: 600000,
    maxOutputBytes: 1024 * 1024,
  })
  assert.equal(typeof body.now, 'string')
})

test('exec reports an audit entry through onExec', async (t) => {
  const audits = []
  const { url } = await startBridge(t, { onExec: (entry) => audits.push(entry) })

  const response = await fetch(`${url}/exec`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ cmd: 'echo hi' }),
  })
  assert.equal(response.status, 200)
  assert.equal(audits.length, 1)
  assert.equal(audits[0].command, 'echo hi')
  assert.match(audits[0].ip, /127\.0\.0\.1/)
  assert.equal(audits[0].result.stdout, 'ran:echo hi')
  assert.equal(typeof audits[0].ms, 'number')
})

test('a throwing onExec does not break exec', async (t) => {
  const { url } = await startBridge(t, {
    onExec: () => {
      throw new Error('audit is down')
    },
  })
  const response = await fetch(`${url}/exec`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ cmd: 'echo hi' }),
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).stdout, 'ran:echo hi')
})

test('file routes are closed when the file channel is disabled', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pc-bridge-srv-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { url } = await startBridge(t, { file: { enabled: false, cwd: dir } })

  const health = await (await fetch(`${url}/health`)).json()
  assert.deepEqual([...health.capabilities].sort(), ['exec', 'pair', 'ping'])

  const info = await (await fetch(`${url}/info`, { headers })).json()
  assert.equal(info.file.enabled, false)

  const stat = await fetch(`${url}/file/stat?path=${encodeURIComponent(join(dir, 'x.txt'))}`, { headers })
  assert.equal(stat.status, 404)
  const read = await fetch(`${url}/file/read?path=${encodeURIComponent(join(dir, 'x.txt'))}`, { headers })
  assert.equal(read.status, 404)
  const write = await fetch(`${url}/file/write`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ path: join(dir, 'x.txt'), uploadId: '0123456789abcdef', data: 'YQ==', final: true }),
  })
  assert.equal(write.status, 404)
})

test('file routes write, read and list with the shared secret', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pc-bridge-srv-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const audits = []
  const { url } = await startBridge(t, {
    file: { roots: [], cwd: dir, chunkBytes: 65536, maxBytes: 1024 * 1024 },
    onFile: (entry) => audits.push(entry),
  })
  const target = join(dir, 'hello.txt')
  const query = `?path=${encodeURIComponent(target)}`

  const denied = await fetch(`${url}/file/stat${query}`)
  assert.equal(denied.status, 401)

  const missing = await (await fetch(`${url}/file/stat${query}`, { headers })).json()
  assert.equal(missing.exists, false)

  const written = await fetch(`${url}/file/write`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      path: target,
      uploadId: '0123456789abcdef',
      data: Buffer.from('你好 bridge', 'utf8').toString('base64'),
      final: true,
    }),
  })
  const writeBody = await written.json()
  assert.equal(written.status, 200)
  assert.equal(writeBody.ok, true)
  assert.equal(writeBody.size, Buffer.byteLength('你好 bridge'))

  const read = await (await fetch(`${url}/file/read${query}&offset=0&maxBytes=64`, { headers })).json()
  assert.equal(Buffer.from(read.data, 'base64').toString('utf8'), '你好 bridge')
  assert.equal(read.eof, true)

  const list = await (await fetch(`${url}/file/list?path=${encodeURIComponent(dir)}`, { headers })).json()
  assert.equal(list.entries.some((entry) => entry.name === 'hello.txt'), true)

  const info = await (await fetch(`${url}/info`, { headers })).json()
  assert.equal(info.file.enabled, true)
  assert.equal(info.file.chunkBytes, 65536)

  assert.deepEqual(audits.map((entry) => entry.op).sort(), ['list', 'read', 'stat', 'write'])
  assert.equal(audits.every((entry) => typeof entry.ms === 'number'), true)
})

