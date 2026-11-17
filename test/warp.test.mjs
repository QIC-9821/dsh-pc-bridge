import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COEXIST_MODE,
  createWarpClient,
  normalizeWarpMode,
  parseWarpMode,
  parseWarpStatus,
} from '../lib/warp.mjs'

test('parseWarpStatus reads the last status line', () => {
  assert.equal(parseWarpStatus('Status update: Connecting\nStatus update: Connected\n'), 'connected')
  assert.equal(parseWarpStatus('Status update: Disconnected\nReason: x'), 'disconnected')
  assert.equal(parseWarpStatus('Status update: Connecting\nReason: Checking for a route'), 'connecting')
  assert.equal(parseWarpStatus(''), 'unknown')
  assert.equal(parseWarpStatus('some warning\n'), 'unknown')
})

test('parseWarpMode normalizes the CLI spelling', () => {
  assert.equal(parseWarpMode('(user set)\tMode: TunnelOnly\n'), 'tunnel_only')
  assert.equal(parseWarpMode('(api defaults)\tMode: Warp\n'), 'warp')
  assert.equal(parseWarpMode('(user set)\tMode: doh\n'), 'doh')
  assert.equal(parseWarpMode('(user set)\tMode: WarpPlusDoh\n'), 'warp+doh')
  assert.equal(parseWarpMode('nothing here'), '')
  assert.equal(normalizeWarpMode('TunnelOnly'), 'tunnel_only')
  // `warp-cli settings` prints these human-readable names on current builds.
  assert.equal(parseWarpMode('(user set)\tMode: DnsOverHttps\n'), 'doh')
  assert.equal(parseWarpMode('(user set)\tMode: DnsOverTls\n'), 'dot')
  assert.equal(parseWarpMode('(user set)\tMode: WarpWithDnsOverHttps\n'), 'warp+doh')
  assert.equal(parseWarpMode('(user set)\tMode: WarpWithDnsOverTls\n'), 'warp+dot')
  assert.equal(parseWarpMode('(user set)\tMode: WarpProxy\n'), 'proxy')
  assert.equal(parseWarpMode('(user set)\tMode: WarpTunnelOnly\n'), 'tunnel_only')
})

function fakeWarp({ mode = 'tunnel_only', state = 'connected' } = {}) {
  const calls = []
  const exec = async (_file, args) => {
    calls.push(args.join(' '))
    if (args[0] === 'status') return { stdout: `Status update: ${state}\n` }
    if (args[0] === 'settings') return { stdout: `(user set)\tMode: ${mode}\n` }
    if (args[0] === 'mode') {
      mode = args[1]
      return { stdout: 'Success\n' }
    }
    if (args[0] === 'connect') {
      state = 'connected'
      return { stdout: 'Success\n' }
    }
    return { stdout: '' }
  }
  return { calls, exec, mode: () => mode }
}

test('ensureCoexist switches a tunnel to DNS-only once', async () => {
  const fake = fakeWarp({ mode: 'tunnel_only' })
  const client = createWarpClient({
    platform: 'win32',
    cli: 'C:\\fake\\warp-cli.exe',
    exec: fake.exec,
    exists: () => true,
  })

  const status = await client.getStatus()
  assert.equal(status.installed, true)
  assert.equal(status.mode, 'tunnel_only')
  assert.equal(status.tunnel, true)

  const next = await client.ensureCoexist()
  assert.equal(next.changed, true)
  assert.equal(next.previousMode, 'tunnel_only')
  assert.equal(next.mode, COEXIST_MODE)
  assert.ok(fake.calls.includes('mode doh'))
})

test('ensureCoexist leaves an already DNS-only WARP alone', async () => {
  const fake = fakeWarp({ mode: 'doh' })
  const client = createWarpClient({
    platform: 'win32',
    cli: 'C:\\fake\\warp-cli.exe',
    exec: fake.exec,
    exists: () => true,
  })

  const next = await client.ensureCoexist()
  assert.equal(next.changed, false)
  assert.equal(next.mode, 'doh')
  assert.equal(fake.calls.filter((call) => call.startsWith('mode')).length, 0)
})

test('restoreTunnel goes back to warp mode and connects', async () => {
  const fake = fakeWarp({ mode: 'doh' })
  const client = createWarpClient({
    platform: 'win32',
    cli: 'C:\\fake\\warp-cli.exe',
    exec: fake.exec,
    exists: () => true,
  })

  const next = await client.restoreTunnel()
  assert.equal(next.changed, true)
  assert.equal(fake.mode(), 'warp')
  assert.ok(fake.calls.includes('connect'))
})

test('a missing WARP client reports installed:false and does not spawn', async () => {
  let spawned = 0
  const client = createWarpClient({
    platform: 'win32',
    cli: 'C:\\fake\\warp-cli.exe',
    exec: async () => {
      spawned += 1
      return { stdout: '' }
    },
    exists: () => false,
  })

  const status = await client.getStatus()
  assert.equal(status.installed, false)
  assert.equal(status.supported, false)
  assert.equal(spawned, 0)
})

test('ensureCoexist recognises the human-readable tunnel modes', async () => {
  const fake = fakeWarp({ mode: 'WarpWithDnsOverHttps' })
  const client = createWarpClient({
    platform: 'win32',
    cli: 'C:\\fake\\warp-cli.exe',
    exec: fake.exec,
    exists: () => true,
  })

  const before = await client.getStatus()
  assert.equal(before.mode, 'warp+doh')
  assert.equal(before.tunnel, true)

  const next = await client.ensureCoexist()
  assert.equal(next.changed, true)
  assert.equal(next.previousMode, 'warp+doh')
  assert.equal(next.mode, COEXIST_MODE)
  assert.ok(fake.calls.includes('mode doh'))
})

test('restoreTunnel puts back the recorded mode instead of always warp', async () => {
  const fake = fakeWarp({ mode: 'doh' })
  const client = createWarpClient({
    platform: 'win32',
    cli: 'C:\\fake\\warp-cli.exe',
    exec: fake.exec,
    exists: () => true,
  })

  const next = await client.restoreTunnel('warp+dot')
  assert.equal(next.changed, true)
  assert.equal(fake.mode(), 'warp+dot')
  assert.ok(fake.calls.includes('mode warp+dot'))
})

test('restoreTunnel reports no change when already on the target mode', async () => {
  const fake = fakeWarp({ mode: 'warp+dot', state: 'connected' })
  const client = createWarpClient({
    platform: 'win32',
    cli: 'C:\\fake\\warp-cli.exe',
    exec: fake.exec,
    exists: () => true,
  })

  const next = await client.restoreTunnel('warp+dot')
  assert.equal(next.changed, false)
  assert.equal(fake.calls.filter((call) => call.startsWith('mode')).length, 0)
})
