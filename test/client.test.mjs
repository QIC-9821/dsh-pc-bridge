import test from 'node:test'
import assert from 'node:assert/strict'

import { callExec, callPing, requestJson } from '../lib/client.mjs'
import { createBridgeServer } from '../lib/server.mjs'

const shell = { exe: 'bash', args: ['-lc'], kind: 'bash' }

async function startBridge(t) {
  const bridge = createBridgeServer({
    secret: 's3cret',
    shell,
    listenHost: '127.0.0.1',
    listenPort: 0,
    exec: async (command) => ({
      ok: true,
      exitCode: 0,
      stdout: `ran:${command}`,
      stderr: '',
      durationMs: 1,
      timedOut: false,
      truncated: false,
    }),
  })
  const address = await bridge.start()
  t.after(() => bridge.close())
  return `http://127.0.0.1:${address.port}`
}

test('callPing succeeds with the right secret and reports 401 otherwise', async (t) => {
  const url = await startBridge(t)

  const ok = await callPing(url, 's3cret')
  assert.equal(ok.ok, true)
  assert.equal(ok.shell, 'bash')

  const bad = await callPing(url, 'wrong')
  assert.equal(bad.ok, false)
  assert.equal(bad.httpStatus, 401)
})

test('callExec returns stdout and an explicit network error when unreachable', async (t) => {
  const url = await startBridge(t)

  const ok = await callExec(url, 's3cret', { command: 'hostname' })
  assert.equal(ok.ok, true)
  assert.equal(ok.stdout, 'ran:hostname')

  const offline = await callExec('http://127.0.0.1:9', 's3cret', { command: 'hostname' })
  assert.equal(offline.ok, false)
  assert.equal(offline.reason, 'network')
})

test('missing secret is refused before any network call', async () => {
  const ping = await callPing('http://127.0.0.1:1', '')
  assert.equal(ping.ok, false)
  assert.match(ping.error, /secret/)

  const exec = await callExec('http://127.0.0.1:1', '', { command: 'x' })
  assert.equal(exec.ok, false)
  assert.match(exec.error, /secret/)
})

test('requestJson surfaces a non-JSON error body as raw text', async (t) => {
  const url = await startBridge(t)
  const result = await requestJson(url, '/nope', 's3cret', {}, 5000)
  assert.equal(result.ok, false)
  assert.equal(result.httpStatus, 404)
})
