import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createBridgeServer } from '../lib/server.mjs'
import { createPeerDirectory } from '../lib/peer-directory.mjs'
import { readPeerRecords } from '../lib/peer-memory.mjs'

const shell = { exe: 'bash', args: ['-lc'], kind: 'bash' }
const headers = { 'x-pc-secret': 's3cret', 'content-type': 'application/json' }

async function startBridge(t, { rememberPeer = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pcbridge-peers-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const patches = []
  let cfg = {
    stateDir: dir,
    listenPort: 18790,
    rememberPeer,
    peerUrl: '',
    peerHistory: {},
  }
  const peers = createPeerDirectory({
    getConfig: () => cfg,
    applyPatch: async (patch) => {
      patches.push(patch)
      cfg = { ...cfg, ...patch }
    },
  })
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
    peers,
  })
  const address = await bridge.start()
  t.after(() => bridge.close())
  return { url: `http://127.0.0.1:${address.port}`, patches, peers, dir }
}

test('peer routes require the shared secret', async (t) => {
  const { url } = await startBridge(t)
  assert.equal((await fetch(`${url}/peers`)).status, 401)
  assert.equal(
    (await fetch(`${url}/peers/use`, { method: 'POST', headers, body: '{"mode":"hotspot"}' })).status,
    404,
  )
})

test('an authenticated caller is remembered, then listed', async (t) => {
  const { url, dir } = await startBridge(t)
  const pong = await fetch(`${url}/ping`, { headers })
  assert.equal(pong.status, 200)

  // Loopback callers are not written to the address book.
  assert.deepEqual(readPeerRecords(dir), {})

  const list = await (await fetch(`${url}/peers`, { headers })).json()
  assert.equal(list.ok, true)
  assert.equal(list.rememberPeer, true)
  assert.equal(list.listenPort, 18790)
  assert.deepEqual(list.records, {})
})

test('remembering stays off until rememberPeer is enabled', async (t) => {
  const { url, dir } = await startBridge(t, { rememberPeer: false })
  await fetch(`${url}/ping`, { headers })
  assert.deepEqual(readPeerRecords(dir), {})
})

test('use points the bridge at a remembered address and drops that kind', async (t) => {
  const { url, dir, patches } = await startBridge(t)

  // Simulate entries written by a previous session.
  const { rememberPeerRecord } = await import('../lib/peer-memory.mjs')
  rememberPeerRecord(dir, '192.168.137.50')
  rememberPeerRecord(dir, '10.0.0.5')

  const used = await fetch(`${url}/peers/use`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ mode: 'hotspot' }),
  })
  assert.equal(used.status, 200)
  const body = await used.json()
  assert.equal(body.ok, true)
  assert.equal(body.peerUrl, 'http://192.168.137.50:18790')
  assert.equal(patches.length, 1)
  assert.equal(patches[0].peerUrl, 'http://192.168.137.50:18790')
  assert.equal(patches[0].remoteMode, 'off')
  assert.equal(patches[0].connectionMode, 'hotspot')

  const deleted = await fetch(`${url}/peers/delete`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ mode: 'hotspot' }),
  })
  assert.equal(deleted.status, 200)
  const after = await deleted.json()
  assert.equal(after.removed, true)
  assert.equal(after.records.hotspot, undefined)
  assert.equal(after.records.lan.host, '10.0.0.5')
})

test('a tailnet address switches the bridge into tailscale mode', async (t) => {
  const { url, dir, patches } = await startBridge(t)
  const { rememberPeerRecord } = await import('../lib/peer-memory.mjs')
  rememberPeerRecord(dir, '100.107.191.27')

  const used = await fetch(`${url}/peers/use`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ mode: 'tailnet' }),
  })
  assert.equal(used.status, 200)
  assert.equal(patches[0].remoteMode, 'tailscale')
  assert.equal(patches[0].peerUrl, 'http://100.107.191.27:18790')
})

test('an empty mode and an unknown kind are refused', async (t) => {
  const { url, patches } = await startBridge(t)
  const empty = await fetch(`${url}/peers/use`, {
    method: 'POST',
    headers,
    body: '{"mode":""}',
  })
  assert.equal(empty.status, 400)
  const unknown = await fetch(`${url}/peers/use`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ mode: 'bogus' }),
  })
  assert.equal(unknown.status, 404)
  assert.equal(patches.length, 0)
})
