import test from 'node:test'
import assert from 'node:assert/strict'

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
