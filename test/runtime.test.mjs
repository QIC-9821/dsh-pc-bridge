import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'

import { createBridgeRuntime, describeTransport } from '../lib/runtime.mjs'

const OFFLINE_TAILSCALE = Object.freeze({
  supported: true, installed: true, backendState: 'Stopped', online: false,
  ipv4: '', dnsName: '', hostName: '', peers: 0, magicDns: '',
})

const IDLE_WARP = Object.freeze({
  supported: true, installed: false, cli: '', state: 'unknown', mode: '', tunnel: false,
})

function localIPv4() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return ''
}

function fakeClients({ tailscale = OFFLINE_TAILSCALE, warp = IDLE_WARP } = {}) {
  let warpState = { ...warp }
  return {
    tailscale: () => ({ getStatus: async () => ({ ...tailscale }) }),
    warp: () => ({
      getStatus: async () => ({ ...warpState }),
      ensureCoexist: async () => ({ ...warpState, changed: false }),
      restoreTunnel: async () => ({ ...warpState, changed: false }),
    }),
  }
}

async function withRuntime(t, { overrides = {}, ctx, clients } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'pc-bridge-rt-'))
  const runtime = createBridgeRuntime({
    ctx,
    env: { DSH_HOME: home },
    version: '0.3.0-test',
    config: { listenPort: 0, discoveryEnabled: false, ...overrides },
    clients: { ...fakeClients(), ...clients },
  })
  t.after(async () => {
    await runtime.stop().catch(() => {})
    await rm(home, { recursive: true, force: true })
  })
  return { runtime, home }
}

function toolsCtx() {
  const registered = []
  const disposed = []
  return {
    registered,
    disposed,
    ctx: {
      tools: {
        register(spec) {
          registered.push(spec.name)
          return () => disposed.push(spec.name)
        },
      },
    },
  }
}

test('start binds a random port and serves an unauthenticated health probe', async (t) => {
  const { runtime } = await withRuntime(t)
  const status = await runtime.start()
  assert.equal(status.state, 'running')
  assert.ok(status.listen.port > 0)
  assert.equal(status.version, '0.3.0-test')
  assert.equal(status.tools.mode, 'auto')
  assert.deepEqual(status.tools.registered, [])
  assert.equal(status.secret.fingerprint.length, 8)
  assert.ok(status.shell.exe.length > 0)
  assert.equal(status.discovery.running, false)

  const response = await fetch(`http://127.0.0.1:${status.listen.port}/health`)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.name, 'dsh-pc-bridge')
  assert.equal(body.version, '0.3.0-test')
  assert.ok(body.capabilities.includes('exec'))
  assert.equal(typeof body.time, 'string')

  await runtime.stop()
  assert.equal(runtime.status().state, 'stopped')
  await assert.rejects(fetch(`http://127.0.0.1:${status.listen.port}/health`))
})

test('toolsMode off registers nothing', async (t) => {
  const { runtime } = await withRuntime(t, { overrides: { toolsMode: 'off' } })
  const status = await runtime.start()
  assert.equal(status.tools.mode, 'off')
  assert.deepEqual(status.tools.registered, [])
  await runtime.stop()
})

test('toolsMode always registers both tools and stop disposes them in reverse', async (t) => {
  const { ctx, registered, disposed } = toolsCtx()
  const { runtime } = await withRuntime(t, { overrides: { toolsMode: 'always' }, ctx })
  const status = await runtime.start()
  assert.equal(status.tools.mode, 'always')
  assert.deepEqual(status.tools.registered.sort(), ['pc_exec', 'pc_ping'])
  assert.deepEqual(registered.sort(), ['pc_exec', 'pc_ping'])

  await runtime.stop()
  assert.deepEqual(runtime.status().tools.registered, [])
  assert.deepEqual(disposed, ['pc_exec', 'pc_ping'])
})

test('toolsMode auto needs a peer url or a remote mode', async (t) => {
  const idle = await withRuntime(t, { overrides: { toolsMode: 'auto' }, ctx: toolsCtx().ctx })
  assert.deepEqual((await idle.runtime.start()).tools.registered, [])
  await idle.runtime.stop()

  const active = await withRuntime(t, {
    overrides: { toolsMode: 'auto', peerUrl: 'http://127.0.0.1:18790' },
    ctx: toolsCtx().ctx,
  })
  const status = await active.runtime.start()
  assert.deepEqual(status.tools.registered.sort(), ['pc_exec', 'pc_ping'])
  await active.runtime.stop()
})

test('applyPatch persists settings and restart re-reads them', async (t) => {
  const { ctx } = toolsCtx()
  const { runtime, home } = await withRuntime(t, { overrides: { toolsMode: 'off' }, ctx })
  await runtime.start()
  assert.deepEqual(runtime.status().tools.registered, [])

  const { status, warnings } = await runtime.applyPatch({ toolsMode: 'always' })
  assert.deepEqual(warnings, [])
  assert.equal(status.state, 'running')
  assert.equal(status.tools.mode, 'always')
  assert.deepEqual(status.tools.registered.sort(), ['pc_exec', 'pc_ping'])
  assert.ok(status.listen.port > 0)

  const stored = JSON.parse(await readFile(join(home, 'pc-bridge', 'settings.json'), 'utf8'))
  assert.equal(stored.toolsMode, 'always')

  await assert.rejects(runtime.applyPatch({ listenPort: 70000 }), /listenPort/)
  assert.equal(runtime.status().state, 'running')
  await runtime.stop()
})

test('fileToolsEnabled registers the file tools on its own switch', async (t) => {
  const { ctx, registered } = toolsCtx()
  const { runtime } = await withRuntime(t, {
    overrides: {
      toolsMode: 'off',
      peerUrl: 'http://127.0.0.1:18790',
      fileToolsEnabled: true,
    },
    ctx,
  })
  const status = await runtime.start()
  assert.equal(status.tools.mode, 'off')
  assert.equal(status.files.toolsEnabled, true)
  assert.deepEqual(status.tools.registered.sort(), ['pc_file_list', 'pc_file_read', 'pc_file_write'])
  assert.deepEqual(registered.sort(), ['pc_file_list', 'pc_file_read', 'pc_file_write'])
  await runtime.stop()
})

test('toggling fileToolsEnabled keeps the listener and only changes the registry', async (t) => {
  const { runtime } = await withRuntime(t, { overrides: { toolsMode: 'always' }, ctx: toolsCtx().ctx })
  const started = await runtime.start()
  const port = started.listen.port
  assert.deepEqual(started.tools.registered.sort(), ['pc_exec', 'pc_ping'])
  assert.equal(started.files.toolsEnabled, false)

  const enabled = await runtime.applyPatch({ fileToolsEnabled: true })
  assert.deepEqual(enabled.warnings, [])
  assert.equal(enabled.status.listen.port, port, 'the listener must not restart for a registry-only change')
  assert.deepEqual(enabled.status.tools.registered.sort(), [
    'pc_exec',
    'pc_file_list',
    'pc_file_read',
    'pc_file_write',
    'pc_ping',
  ])

  const disabled = await runtime.applyPatch({ fileToolsEnabled: false })
  assert.equal(disabled.status.listen.port, port)
  assert.deepEqual(disabled.status.tools.registered.sort(), ['pc_exec', 'pc_ping'])
  await runtime.stop()
})

test('status reports the file channel defaults', async (t) => {
  const { runtime } = await withRuntime(t)
  const status = await runtime.start()
  assert.deepEqual(status.files, {
    enabled: true,
    toolsEnabled: false,
    roots: [],
    chunkBytes: 1048576,
    maxBytes: 67108864,
  })
  await runtime.stop()
})

test('auditTail returns newest first and skips torn lines', async (t) => {
  const { runtime, home } = await withRuntime(t)
  await runtime.start()
  await runtime.recordAudit({ kind: 'custom', note: 'a' })
  await runtime.recordAudit({ kind: 'custom', note: 'b' })
  await appendFile(join(home, 'pc-bridge', 'audit.jsonl'), 'garbage line\n', 'utf8')

  const entries = await runtime.auditTail(3)
  assert.equal(entries.length, 3)
  assert.equal(entries[0].note, 'b')
  assert.equal(entries[1].note, 'a')
  assert.equal(entries[2].kind, 'start')
  assert.match(entries[0].at, /^\d{4}-\d{2}-\d{2}T/)
  await runtime.stop()
})

test('publicConfig hides the secret and exposes source/fingerprint/settingsPath', async (t) => {
  const { runtime } = await withRuntime(t)
  await runtime.start()
  const full = runtime.getConfig()
  assert.ok(full.secret.length > 0)

  const published = runtime.publicConfig()
  assert.equal('secret' in published, false)
  assert.equal(typeof published.secretFingerprint, 'string')
  assert.equal(published.secretFingerprint.length, 8)
  assert.ok(published.secretSource.length > 0)
  assert.ok(published.settingsPath.endsWith('settings.json'))
  await runtime.stop()
})

test('a client role runs without opening a listen socket', async (t) => {
  const { runtime } = await withRuntime(t, { overrides: { role: 'client' } })
  const status = await runtime.start()
  assert.equal(status.state, 'running')
  assert.equal(status.listen.port, 0)
  assert.deepEqual(status.tools.registered, [])
  await runtime.stop()
})

test('acceptPair refuses a peer url that is not http(s)', async (t) => {
  const { runtime } = await withRuntime(t)
  await runtime.start()
  await assert.rejects(runtime.acceptPair({ url: 'ftp://pc', code: '123456' }), /http\(s\)/)
  await runtime.stop()
})

test('testPeer reports a missing peer address', async (t) => {
  const { runtime } = await withRuntime(t)
  await runtime.start()
  assert.deepEqual(await runtime.testPeer(''), { ok: false, error: '没有配置对端地址' })
  await runtime.stop()
})

test('enabled=false starts nothing, registers no tools and reports disabled', async (t) => {
  const { ctx, registered } = toolsCtx()
  const { runtime } = await withRuntime(t, {
    overrides: { enabled: false, toolsMode: 'always' },
    ctx,
  })
  const status = await runtime.start()
  assert.equal(status.state, 'disabled')
  assert.equal(status.enabled, false)
  assert.equal(status.listen.port, 0)
  assert.deepEqual(status.tools.registered, [])
  assert.deepEqual(registered, [])

  const entries = await runtime.auditTail(5)
  assert.ok(entries.some((entry) => entry.kind === 'start' && entry.disabled === true))

  await runtime.stop()
  assert.equal(runtime.status().state, 'stopped')
})

test('setEnabled persists the switch and rebuilds the listener and tools', async (t) => {
  const { ctx, registered } = toolsCtx()
  const { runtime, home } = await withRuntime(t, { overrides: { toolsMode: 'always' }, ctx })
  const first = await runtime.start()
  assert.equal(first.state, 'running')
  assert.deepEqual(registered.sort(), ['pc_exec', 'pc_ping'])

  const off = await runtime.setEnabled(false)
  assert.equal(off.state, 'disabled')
  assert.equal(off.enabled, false)
  assert.deepEqual(off.tools.registered, [])
  let stored = JSON.parse(await readFile(join(home, 'pc-bridge', 'settings.json'), 'utf8'))
  assert.equal(stored.enabled, false)

  const on = await runtime.setEnabled(true)
  assert.equal(on.state, 'running')
  assert.equal(on.enabled, true)
  assert.deepEqual(on.tools.registered.sort(), ['pc_exec', 'pc_ping'])
  stored = JSON.parse(await readFile(join(home, 'pc-bridge', 'settings.json'), 'utf8'))
  assert.equal(stored.enabled, true)

  await assert.rejects(runtime.setEnabled('yes'), /enabled/)
  await runtime.stop()
})

test('clearPair forgets the peer metadata and restarts', async (t) => {
  const { runtime, home } = await withRuntime(t)
  await runtime.start()
  await runtime.applyPatch({
    peerUrl: 'http://127.0.0.1:1',
    peerName: '客厅电脑',
    peerPlatform: 'linux',
    peerTransport: 'local',
    peerPairedAt: '2026-11-17T10:00:00.000Z',
    peerFingerprint: 'abcd1234',
  })
  const paired = runtime.status()
  assert.equal(paired.peer.url, 'http://127.0.0.1:1')
  assert.equal(paired.peer.name, '客厅电脑')
  assert.equal(paired.peer.transport, 'local')

  const cleared = await runtime.clearPair()
  assert.equal(cleared.state, 'running')
  assert.equal(cleared.peerUrl, '')
  assert.equal(cleared.peer.url, '')
  assert.equal(cleared.peer.name, '')
  assert.equal(cleared.peer.platform, '')
  assert.equal(cleared.peer.transport, '')
  assert.equal(cleared.peer.pairedAt, '')

  const stored = JSON.parse(await readFile(join(home, 'pc-bridge', 'settings.json'), 'utf8'))
  assert.equal(stored.peerUrl, '')
  assert.equal(stored.peerName, '')
  assert.equal(stored.peerTransport, '')
  assert.equal(stored.peerFingerprint, '')
  await runtime.stop()
})

test('an accepted pairing remembers the device in pairings', async (t) => {
  const { runtime, home } = await withRuntime(t)
  const started = await runtime.start()
  const { code } = runtime.createPairCode()
  const response = await fetch(`http://127.0.0.1:${started.listen.port}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, name: '平板', platform: 'android' }),
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.ok(body.secret.length > 0)

  const status = runtime.status()
  assert.equal(status.pairingsCount, 1)
  const stored = JSON.parse(await readFile(join(home, 'pc-bridge', 'settings.json'), 'utf8'))
  assert.equal(stored.pairings.length, 1)
  assert.equal(stored.pairings[0].name, '平板')
  assert.equal(stored.pairings[0].platform, 'android')
  assert.equal(stored.pairings[0].transport, 'local')
  assert.match(stored.pairings[0].pairedAt, /^\d{4}-\d{2}-\d{2}T/)
  await runtime.stop()
})

test('acceptPair stores the peer metadata in one settings write', async (t) => {
  const { runtime, home } = await withRuntime(t)
  await runtime.start()
  const stub = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, secret: 'peer-secret-1234567890', host: 'peer-pc', port: 18790 }))
    })
  })
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => stub.close(resolve)))
  const url = `http://127.0.0.1:${stub.address().port}`

  const result = await runtime.acceptPair({ url, code: '123456' })
  assert.equal(result.ok, true)
  assert.equal(result.peer.url, url)

  const stored = JSON.parse(await readFile(join(home, 'pc-bridge', 'settings.json'), 'utf8'))
  assert.equal(stored.peerUrl, url)
  assert.equal(stored.peerName, 'peer-pc')
  assert.equal(stored.peerPlatform, '')
  assert.equal(stored.peerTransport, 'local')
  assert.match(stored.peerPairedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(stored.peerFingerprint.length, 8)

  const status = runtime.status()
  assert.equal(status.peer.url, url)
  assert.equal(status.peer.name, 'peer-pc')
  assert.equal(status.peer.transport, 'local')
  assert.equal(status.secret.source, `file:${join(home, 'pc-bridge', 'secret')}`)
  await runtime.stop()
})

test('describeTransport classifies local, tailscale, lan and custom peers', () => {
  assert.equal(describeTransport('127.0.0.1'), 'local')
  assert.equal(describeTransport('http://127.0.0.1:18790'), 'local')
  assert.equal(describeTransport('localhost:18790'), 'local')
  assert.equal(describeTransport('::1'), 'local')
  assert.equal(describeTransport('100.64.0.1'), 'tailscale')
  assert.equal(describeTransport('100.100.100.100:18790'), 'tailscale')
  assert.equal(describeTransport('http://pc.tail1234.ts.net:18790'), 'tailscale')
  assert.equal(describeTransport('10.1.2.3'), 'lan')
  assert.equal(describeTransport('172.20.5.5'), 'lan')
  assert.equal(describeTransport('192.168.1.20'), 'lan')
  assert.equal(describeTransport('http://printer.local'), 'lan')
  assert.equal(describeTransport('172.32.0.1'), 'custom')
  assert.equal(describeTransport('100.200.0.1'), 'custom')
  assert.equal(describeTransport('8.8.8.8'), 'custom')
  assert.equal(describeTransport(''), 'custom')
})

test('migrateSecret moves the file, rewrites settings and deletes the old one', async (t) => {
  const { runtime, home } = await withRuntime(t)
  await runtime.start()
  const dir = join(home, 'pc-bridge')
  const oldFile = join(dir, 'secret')
  const nextFile = join(dir, 'keys', 'bridge.key')
  const before = runtime.status()
  const original = await readFile(oldFile, 'utf8')

  const result = await runtime.migrateSecret(nextFile)
  assert.equal(result.ok, true)
  assert.equal(result.moved, true)
  assert.equal(result.from, oldFile)
  assert.equal(result.to, nextFile)
  assert.deepEqual(result.warnings, [])
  assert.equal(await readFile(nextFile, 'utf8'), original)
  await assert.rejects(readFile(oldFile, 'utf8'))

  const stored = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))
  assert.equal(stored.secretFile, nextFile)
  const after = runtime.status()
  assert.equal(after.state, 'running')
  assert.equal(after.secret.fingerprint, before.secret.fingerprint)

  const noop = await runtime.migrateSecret(nextFile)
  assert.equal(noop.ok, true)
  assert.equal(noop.moved, false)
  await runtime.stop()
})

test('migrateSecret treats a directory target as "put the secret inside it"', async (t) => {
  const { runtime, home } = await withRuntime(t)
  await runtime.start()
  const dir = join(home, 'pc-bridge', 'keys')
  await mkdir(dir, { recursive: true })

  const result = await runtime.migrateSecret(dir)
  assert.equal(result.ok, true)
  assert.equal(result.moved, true)
  assert.equal(result.to, join(dir, 'secret'))
  assert.match(String(runtime.status().secret.source), /keys[\\/]secret$/)
  await runtime.stop()
})

test('migrateSecret refuses a secret that comes from config or env', async (t) => {
  const { runtime, home } = await withRuntime(t, { overrides: { secret: 'fixed-secret' } })
  await runtime.start()
  await assert.rejects(runtime.migrateSecret(join(home, 'pc-bridge', 'other.key')), /插件配置|环境变量/)
  await runtime.stop()
})

test('cleanup deletes the secret, settings, audit and log but keeps the directory', async (t) => {
  const { runtime, home } = await withRuntime(t)
  await runtime.start()
  await runtime.applyPatch({ toolsMode: 'always' })
  await runtime.recordAudit({ kind: 'custom', note: 'before cleanup' })
  const dir = join(home, 'pc-bridge')
  const before = await readdir(dir)
  assert.ok(before.includes('secret'))
  assert.ok(before.includes('settings.json'))

  const result = await runtime.cleanup()
  assert.equal(runtime.status().state, 'stopped')
  assert.ok(result.removed.includes('secret'))
  assert.ok(result.removed.includes('settings.json'))
  assert.ok(result.removed.some((name) => name.startsWith('audit.jsonl')))
  assert.ok(result.removed.some((name) => name.startsWith('bridge.log')))
  assert.deepEqual(result.failed, [])
  assert.deepEqual(await readdir(dir), [])
  assert.deepEqual(await runtime.auditTail(5), [])
})

test('remoteMode tailscale binds the tailnet address when Tailscale is online', async (t) => {
  // Use a real local address in place of the tailnet one: resolveBindHost is
  // only allowed to pick an address this machine actually owns.
  const tailnetIp = localIPv4()
  const online = { ...OFFLINE_TAILSCALE, online: true, ipv4: tailnetIp, backendState: 'Running' }
  const { runtime } = await withRuntime(t, {
    overrides: { remoteMode: 'tailscale', listenHost: '127.0.0.1', toolsMode: 'off' },
    clients: fakeClients({ tailscale: online }),
  })
  const status = await runtime.start()
  assert.equal(status.listen.configuredHost, '127.0.0.1')
  assert.equal(status.remote.mode, 'tailscale')
  if (tailnetIp) {
    assert.equal(status.listen.host, tailnetIp)
    assert.equal(status.listen.widened, false)
    assert.equal(status.remote.url, `http://${tailnetIp}:${status.listen.port}`)
  } else {
    assert.equal(status.listen.host, '0.0.0.0')
    assert.equal(status.listen.widened, true)
  }
  assert.equal(runtime.publicConfig().warpCoexist, true)
  await runtime.stop()
})

test('remoteMode tailscale falls back to 0.0.0.0 when Tailscale is offline', async (t) => {
  const { runtime } = await withRuntime(t, {
    overrides: { remoteMode: 'tailscale', listenHost: '127.0.0.1', toolsMode: 'off' },
  })
  const status = await runtime.start()
  assert.equal(status.listen.host, '0.0.0.0')
  assert.equal(status.listen.widened, true)
  assert.equal(status.remote.url, '')
  await runtime.stop()
})

test('local mode keeps listening on loopback', async (t) => {
  const { runtime } = await withRuntime(t, { overrides: { toolsMode: 'off' } })
  const status = await runtime.start()
  assert.equal(status.listen.host, '127.0.0.1')
  assert.equal(status.remote.mode, 'off')
  assert.equal(status.remote.url, '')
  await runtime.stop()
})

test('a WARP failure keeps installed=true and surfaces as an error', async (t) => {
  const failing = {
    warp: () => ({
      getStatus: async () => ({ supported: true, installed: true, state: 'connected', mode: 'warp', tunnel: true }),
      ensureCoexist: async () => {
        throw new Error('Switch Locked')
      },
      restoreTunnel: async () => {
        throw new Error('Switch Locked')
      },
    }),
  }
  const { runtime } = await withRuntime(t, { overrides: { toolsMode: 'off' }, clients: failing })
  await runtime.start()
  await assert.rejects(runtime.warpAction('dns-only'), /Switch Locked/)
  const status = runtime.status()
  assert.equal(status.warp.installed, true)
  assert.match(status.warp.error, /Switch Locked/)
  await runtime.stop()
})

test('stopping clears the pending network check', async (t) => {
  let probes = 0
  const counting = {
    warp: () => ({
      getStatus: async () => {
        probes += 1
        return { ...IDLE_WARP }
      },
      ensureCoexist: async () => ({ ...IDLE_WARP, changed: false }),
      restoreTunnel: async () => ({ ...IDLE_WARP, changed: false }),
    }),
  }
  const { runtime } = await withRuntime(t, { overrides: { toolsMode: 'off' }, clients: counting })
  await runtime.start()
  await runtime.stop()
  const afterStop = probes
  await new Promise((resolve) => setTimeout(resolve, 900))
  assert.equal(probes, afterStop)
})
