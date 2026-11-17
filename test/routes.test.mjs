import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { createRoutes } from '../lib/routes.mjs'

const VERSION = '0.3.1-test'
const AUDIT = [{ kind: 'exec', at: '2026-01-01T00:00:00.000Z', command: 'hostname' }]

function makeStatus(overrides = {}) {
  return {
    state: 'running',
    version: VERSION,
    startedAt: '2026-01-01T00:00:00.000Z',
    uptimeSec: 5,
    pid: 1234,
    listen: { host: '127.0.0.1', port: 18790 },
    addresses: [{ iface: 'Ethernet', address: '192.168.1.10', family: 'IPv4' }],
    role: 'both',
    peerUrl: '',
    toolsMode: 'auto',
    tools: { mode: 'auto', registered: ['pc_ping', 'pc_exec'] },
    secret: { source: 'file', fingerprint: 'abcdef12' },
    shell: { exe: '/bin/bash', kind: 'bash' },
    discovery: { enabled: true, port: 18791, running: true },
    tunnel: { enabled: false, running: false },
    lastError: '',
    ...overrides,
  }
}

function makeRuntime(overrides = {}) {
  const calls = []
  let state = 'running'
  const runtime = {
    publicConfig() {
      calls.push({ op: 'publicConfig' })
      return { role: 'both', listenHost: '127.0.0.1', listenPort: 18790, toolsMode: 'auto', ...overrides.config }
    },
    status() {
      calls.push({ op: 'status' })
      return makeStatus({ state, ...overrides.status })
    },
    async auditTail(limit) {
      calls.push({ op: 'auditTail', limit })
      return overrides.audit || AUDIT
    },
    async applyPatch(patch) {
      calls.push({ op: 'applyPatch', patch })
      if (overrides.applyPatchError) throw overrides.applyPatchError
      return overrides.applyPatchResult
    },
    async setEnabled(enabled) {
      calls.push({ op: 'setEnabled', enabled })
      if (overrides.setEnabledError) throw overrides.setEnabledError
      state = enabled ? 'running' : 'disabled'
      return makeStatus({ state, ...overrides.status })
    },
    async clearPair() {
      calls.push({ op: 'clearPair' })
      if (overrides.clearPairError) throw overrides.clearPairError
      return makeStatus({ state, ...overrides.status })
    },
    async cleanup() {
      calls.push({ op: 'cleanup' })
      if (overrides.cleanupError) throw overrides.cleanupError
      return overrides.cleanupResult || { removed: ['secret', 'settings.json'], failed: [] }
    },
    async start() {
      calls.push({ op: 'start' })
      state = 'running'
    },
    async stop() {
      calls.push({ op: 'stop' })
      state = 'stopped'
    },
    async restart() {
      calls.push({ op: 'restart' })
      state = 'running'
    },
    async discover() {
      calls.push({ op: 'discover' })
      return overrides.devices || [
        { name: 'peer-pc', host: '192.168.1.20', port: 18790, platform: 'win32', version: VERSION, address: '192.168.1.20', lastSeen: 1 },
        { name: 'peer-tablet', host: '192.168.1.21', port: 18790, platform: 'android', version: VERSION, address: '192.168.1.21', lastSeen: 2 },
      ]
    },
    async testPeer(url) {
      calls.push({ op: 'testPeer', url })
      if (overrides.testPeerError) throw overrides.testPeerError
      return overrides.testResult || { ok: true, host: 'peer-pc', shell: 'bash' }
    },
    async createPairCode() {
      calls.push({ op: 'createPairCode' })
      return { code: '042317', expiresAt: 1799999999000 }
    },
    async acceptPair({ url, code }) {
      calls.push({ op: 'acceptPair', url, code })
      if (overrides.acceptPairError) throw overrides.acceptPairError
      return { ok: true, secret: 's3cret', peer: { host: 'peer-pc', port: 18790 } }
    },
    async rotateSecret() {
      calls.push({ op: 'rotateSecret' })
      if (overrides.rotateError) throw overrides.rotateError
    },
  }
  return { runtime, calls }
}

async function startRoutes(t, overrides = {}) {
  const { runtime, calls } = makeRuntime(overrides)
  const routes = createRoutes({ runtime, version: VERSION })
  const server = createServer((req, res) => {
    void routes.handle(req, res)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  )
  const { port } = server.address()
  return { base: `http://127.0.0.1:${port}/pc-bridge`, calls }
}

async function getJson(url, init) {
  const response = await fetch(url, init)
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { response, body }
}

function postJson(body, extra = {}) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    ...extra,
  }
}

test('GET /api/state returns version, config, status and the audit tail', async (t) => {
  const { base, calls } = await startRoutes(t)

  const { response, body } = await getJson(`${base}/api/state`)

  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.version, VERSION)
  assert.equal(body.config.listenHost, '127.0.0.1')
  assert.equal(body.status.state, 'running')
  assert.deepEqual(body.audit, AUDIT)
  assert.ok(calls.some((call) => call.op === 'auditTail' && call.limit === 20))
})

test('POST /api/config forwards the patch and returns status plus config', async (t) => {
  const { base, calls } = await startRoutes(t)

  const { response, body } = await getJson(
    `${base}/api/config`,
    postJson({ patch: { toolsMode: 'off', listenPort: 18795 } }),
  )

  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  const applied = calls.find((call) => call.op === 'applyPatch')
  assert.deepEqual(applied.patch, { toolsMode: 'off', listenPort: 18795 })
  assert.ok(body.status)
  assert.ok(body.config)
})

test('POST /api/config accepts a missing patch', async (t) => {
  const { base, calls } = await startRoutes(t)

  const { response } = await getJson(`${base}/api/config`, postJson({}))

  assert.equal(response.status, 200)
  assert.deepEqual(calls.find((call) => call.op === 'applyPatch').patch, {})
})

test('POST /api/config rejects a non-object patch with 400', async (t) => {
  const { base } = await startRoutes(t)

  const { response, body } = await getJson(`${base}/api/config`, postJson({ patch: [] }))

  assert.equal(response.status, 400)
  assert.equal(body.ok, false)
})

test('POST /api/config passes warnings through and prefers the returned status', async (t) => {
  const { base } = await startRoutes(t, {
    applyPatchResult: {
      status: makeStatus({ state: 'disabled' }),
      warnings: ['旧密钥文件删除失败：EBUSY'],
    },
  })

  const { response, body } = await getJson(
    `${base}/api/config`,
    postJson({ patch: { secretFile: 'D:/keys/bridge.secret' } }),
  )

  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.deepEqual(body.warnings, ['旧密钥文件删除失败：EBUSY'])
  assert.equal(body.status.state, 'disabled')
  assert.ok(body.config)
})

test('POST /api/config defaults warnings to an empty array', async (t) => {
  const { base } = await startRoutes(t)

  const { response, body } = await getJson(`${base}/api/config`, postJson({ patch: { toolsMode: 'off' } }))

  assert.equal(response.status, 200)
  assert.deepEqual(body.warnings, [])
  assert.equal(body.status.state, 'running')
})

test('POST /api/enabled toggles the master switch and returns status plus config', async (t) => {
  const { base, calls } = await startRoutes(t)

  const disabled = await getJson(`${base}/api/enabled`, postJson({ enabled: false }))
  assert.equal(disabled.response.status, 200)
  assert.equal(disabled.body.ok, true)
  assert.equal(disabled.body.status.state, 'disabled')
  assert.ok(disabled.body.config)
  assert.deepEqual(calls.find((call) => call.op === 'setEnabled'), { op: 'setEnabled', enabled: false })

  const enabled = await getJson(`${base}/api/enabled`, postJson({ enabled: true }))
  assert.equal(enabled.response.status, 200)
  assert.equal(enabled.body.ok, true)
  assert.equal(enabled.body.status.state, 'running')
})

test('POST /api/enabled rejects a missing or non-boolean flag', async (t) => {
  const { base, calls } = await startRoutes(t)

  const missing = await getJson(`${base}/api/enabled`, postJson({}))
  assert.equal(missing.response.status, 400)
  assert.equal(missing.body.ok, false)

  const wrong = await getJson(`${base}/api/enabled`, postJson({ enabled: 'false' }))
  assert.equal(wrong.response.status, 400)
  assert.equal(wrong.body.error, 'enabled 必须是布尔值')

  assert.equal(calls.filter((call) => call.op === 'setEnabled').length, 0)
})

test('POST /api/pair/clear forgets the peer and returns the new status', async (t) => {
  const { base, calls } = await startRoutes(t)

  const { response, body } = await getJson(`${base}/api/pair/clear`, postJson({}))

  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.ok(body.status)
  assert.ok(body.config)
  assert.ok(calls.some((call) => call.op === 'clearPair'))
})

test('POST /api/cleanup requires confirm true and reports removed files', async (t) => {
  const { base, calls } = await startRoutes(t)

  const missing = await getJson(`${base}/api/cleanup`, postJson({}))
  assert.equal(missing.response.status, 400)
  assert.equal(missing.body.ok, false)
  assert.equal(calls.filter((call) => call.op === 'cleanup').length, 0)

  const refused = await getJson(`${base}/api/cleanup`, postJson({ confirm: false }))
  assert.equal(refused.response.status, 400)
  assert.equal(calls.filter((call) => call.op === 'cleanup').length, 0)

  const done = await getJson(`${base}/api/cleanup`, postJson({ confirm: true }))
  assert.equal(done.response.status, 200)
  assert.equal(done.body.ok, true)
  assert.deepEqual(done.body.removed, ['secret', 'settings.json'])
  assert.deepEqual(done.body.failed, [])
  assert.equal(calls.filter((call) => call.op === 'cleanup').length, 1)
})

test('cleanup reports partial failures in the failed list', async (t) => {
  const { base } = await startRoutes(t, {
    cleanupResult: { removed: ['secret'], failed: ['audit.jsonl: EPERM'] },
  })

  const { response, body } = await getJson(`${base}/api/cleanup`, postJson({ confirm: true }))

  assert.equal(response.status, 200)
  assert.deepEqual(body.removed, ['secret'])
  assert.deepEqual(body.failed, ['audit.jsonl: EPERM'])
})

test('start, stop and restart flip the reported state', async (t) => {
  const { base, calls } = await startRoutes(t)

  const stopped = await getJson(`${base}/api/stop`, postJson({}))
  assert.equal(stopped.response.status, 200)
  assert.equal(stopped.body.ok, true)
  assert.equal(stopped.body.status.state, 'stopped')

  const started = await getJson(`${base}/api/start`, postJson({}))
  assert.equal(started.response.status, 200)
  assert.equal(started.body.status.state, 'running')

  const restarted = await getJson(`${base}/api/restart`, postJson({}))
  assert.equal(restarted.response.status, 200)
  assert.equal(restarted.body.status.state, 'running')

  assert.deepEqual(
    calls.filter((call) => ['start', 'stop', 'restart'].includes(call.op)).map((call) => call.op),
    ['stop', 'start', 'restart'],
  )
})

test('GET /api/discover returns the scanned devices', async (t) => {
  const { base } = await startRoutes(t)

  const { response, body } = await getJson(`${base}/api/discover`)

  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.devices.length, 2)
  assert.equal(body.devices[0].name, 'peer-pc')
})

test('POST /api/test passes the url through and returns the result', async (t) => {
  const { base, calls } = await startRoutes(t)

  const { response, body } = await getJson(
    `${base}/api/test`,
    postJson({ url: 'http://192.168.1.20:18790' }),
  )

  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.result.host, 'peer-pc')
  assert.equal(calls.find((call) => call.op === 'testPeer').url, 'http://192.168.1.20:18790')
})

test('POST /api/test falls back to the configured peer when url is absent', async (t) => {
  const { base, calls } = await startRoutes(t)

  await getJson(`${base}/api/test`, postJson({}))

  assert.equal(calls.find((call) => call.op === 'testPeer').url, '')
})

test('POST /api/pair/new returns the pairing code and expiry', async (t) => {
  const { base } = await startRoutes(t)

  const { response, body } = await getJson(`${base}/api/pair/new`, postJson({}))

  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.code, '042317')
  assert.equal(typeof body.expiresAt, 'number')
})

test('POST /api/pair/accept returns status and peer info', async (t) => {
  const { base, calls } = await startRoutes(t)

  const { response, body } = await getJson(
    `${base}/api/pair/accept`,
    postJson({ url: 'http://192.168.1.20:18790', code: ' 042317 ' }),
  )

  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.ok(body.status)
  assert.equal(body.peer.host, 'peer-pc')
  const accepted = calls.find((call) => call.op === 'acceptPair')
  assert.equal(accepted.url, 'http://192.168.1.20:18790')
  assert.equal(accepted.code, '042317')
})

test('POST /api/pair/accept rejects missing fields and runtime failures', async (t) => {
  const { base } = await startRoutes(t, { acceptPairError: new Error('配对码无效') })

  const missingUrl = await getJson(`${base}/api/pair/accept`, postJson({ code: '123456' }))
  assert.equal(missingUrl.response.status, 400)
  assert.equal(missingUrl.body.error, '缺少对端地址')

  const missingCode = await getJson(`${base}/api/pair/accept`, postJson({ url: 'http://x' }))
  assert.equal(missingCode.response.status, 400)
  assert.equal(missingCode.body.error, '缺少配对码')

  const failed = await getJson(
    `${base}/api/pair/accept`,
    postJson({ url: 'http://x', code: '000000' }),
  )
  assert.equal(failed.response.status, 500)
  assert.equal(failed.body.ok, false)
  assert.equal(failed.body.error, '配对码无效')
})

test('runtime errors carrying a statusCode surface with that status', async (t) => {
  const rejected = new Error('配对码不正确')
  rejected.statusCode = 401
  const { base } = await startRoutes(t, { acceptPairError: rejected })

  const failed = await getJson(
    `${base}/api/pair/accept`,
    postJson({ url: 'http://x', code: '000000' }),
  )
  assert.equal(failed.response.status, 401)
  assert.equal(failed.body.ok, false)
  assert.equal(failed.body.error, '配对码不正确')
})

test('POST /api/secret/rotate returns the new status', async (t) => {
  const { base, calls } = await startRoutes(t)

  const { response, body } = await getJson(`${base}/api/secret/rotate`, postJson({}))

  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.status.state, 'running')
  assert.ok(calls.some((call) => call.op === 'rotateSecret'))
})

test('GET /api/audit honours limit, defaults and clamps', async (t) => {
  const { base, calls } = await startRoutes(t)

  const limited = await getJson(`${base}/api/audit?limit=3`)
  assert.equal(limited.response.status, 200)
  assert.deepEqual(limited.body.entries, AUDIT)
  assert.equal(calls.find((call) => call.op === 'auditTail').limit, 3)

  await getJson(`${base}/api/audit?limit=nope`)
  assert.equal(calls.filter((call) => call.op === 'auditTail').at(-1).limit, 20)

  await getJson(`${base}/api/audit?limit=9999`)
  assert.equal(calls.filter((call) => call.op === 'auditTail').at(-1).limit, 200)
})

test('unknown api paths and method mismatches return 404', async (t) => {
  const { base } = await startRoutes(t)

  const unknown = await getJson(`${base}/api/nope`)
  assert.equal(unknown.response.status, 404)
  assert.equal(unknown.body.ok, false)

  const wrongMethod = await getJson(`${base}/api/start`)
  assert.equal(wrongMethod.response.status, 404)

  const noPrefix = await getJson(`${base.replace('/pc-bridge', '')}/api/state`)
  assert.equal(noPrefix.response.status, 404)
})

test('invalid json bodies return 400 without touching the runtime', async (t) => {
  const { base, calls } = await startRoutes(t)

  const { response, body } = await getJson(`${base}/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json',
  })

  assert.equal(response.status, 400)
  assert.equal(body.ok, false)
  assert.equal(body.error, 'invalid json')
  assert.equal(calls.length, 0)
})

test('bodies over 64 KiB are rejected with 413', async (t) => {
  const { base, calls } = await startRoutes(t)

  const { response, body } = await getJson(
    `${base}/api/config`,
    postJson({ patch: { peerUrl: 'x'.repeat(70 * 1024) } }),
  )

  assert.equal(response.status, 413)
  assert.equal(body.ok, false)
  assert.equal(body.error, 'request body too large')
  assert.equal(calls.length, 0)
})

test('OPTIONS answers 204 with no body', async (t) => {
  const { base } = await startRoutes(t)

  const response = await fetch(`${base}/api/state`, { method: 'OPTIONS' })

  assert.equal(response.status, 204)
  assert.equal(await response.text(), '')
})

test('runtime failures surface as a 500 json error', async (t) => {
  const { base } = await startRoutes(t, { applyPatchError: new Error('设置写入失败') })

  const { response, body } = await getJson(`${base}/api/config`, postJson({ patch: { toolsMode: 'off' } }))

  assert.equal(response.status, 500)
  assert.equal(body.ok, false)
  assert.equal(body.error, '设置写入失败')
})

test('a trailing service prefix path is stripped exactly once', async (t) => {
  const { base, calls } = await startRoutes(t)

  const { response } = await getJson(`${base}/api/state/`)

  assert.equal(response.status, 200)
  assert.ok(calls.some((call) => call.op === 'auditTail'))
})
