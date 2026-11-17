import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  mergeConfig,
  normalizeSettings,
  readSettings,
  settingsPath,
  writeSettings,
} from '../lib/settings.mjs'

async function tempHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'pc-bridge-settings-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return { DSH_HOME: home }
}

test('settingsPath honours DSH_HOME and defaults to ~/.dsh', () => {
  const home = process.platform === 'win32' ? 'C:\\data\\dsh' : '/srv/dsh'
  assert.equal(settingsPath({ DSH_HOME: home }), join(home, 'pc-bridge', 'settings.json'))
  assert.equal(settingsPath({}), join(homedir(), '.dsh', 'pc-bridge', 'settings.json'))
})

test('readSettings returns {} for a missing or broken file', async (t) => {
  const env = await tempHome(t)
  assert.deepEqual(await readSettings(env), {})

  const file = settingsPath(env)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, 'not json', 'utf8')
  assert.deepEqual(await readSettings(env), {})
})

test('writeSettings persists a validated patch atomically', async (t) => {
  const env = await tempHome(t)
  const { settings, path } = await writeSettings(
    { role: 'host', listenPort: '19001', discoveryEnabled: 'false', toolsMode: 'off' },
    env,
  )
  assert.equal(settings.role, 'host')
  assert.equal(settings.listenPort, 19001)
  assert.equal(settings.discoveryEnabled, false)
  assert.equal(settings.toolsMode, 'off')

  const stored = JSON.parse(await readFile(path, 'utf8'))
  assert.deepEqual(stored, settings)
  // no temp files left behind
  assert.deepEqual(await readdir(dirname(path)), ['settings.json'])
  assert.deepEqual(await readSettings(env), settings)
})

test('writeSettings merges with the existing file', async (t) => {
  const env = await tempHome(t)
  await writeSettings({ role: 'both', listenPort: 19010 }, env)
  const { settings } = await writeSettings({ listenPort: 19011 }, env)
  assert.equal(settings.role, 'both')
  assert.equal(settings.listenPort, 19011)
})

test('normalizeSettings drops unknown keys and secret fields', () => {
  assert.deepEqual(
    normalizeSettings({
      secret: 'x',
      secretEnv: 'SOME_ENV',
      nope: 1,
      listenPort: 19000,
    }),
    { listenPort: 19000 },
  )
})

test('normalizeSettings accepts the 0.3.1 control and peer fields', () => {
  const out = normalizeSettings({
    enabled: 'false',
    purgeOnUninstall: true,
    secretFile: '  C:/secrets/bridge.key  ',
    peerUrl: 'http://192.168.1.9:18790/',
    peerName: ' 客厅PC ',
    peerPlatform: 'win32',
    peerTransport: 'lan',
    peerPairedAt: '2026-11-17T12:00:00.000Z',
    peerFingerprint: 'abc12345',
  })
  assert.deepEqual(out, {
    enabled: false,
    purgeOnUninstall: true,
    secretFile: 'C:/secrets/bridge.key',
    peerUrl: 'http://192.168.1.9:18790',
    peerName: '客厅PC',
    peerPlatform: 'win32',
    peerTransport: 'lan',
    peerPairedAt: '2026-11-17T12:00:00.000Z',
    peerFingerprint: 'abc12345',
  })
  assert.equal(normalizeSettings({ enabled: true }).enabled, true)
  assert.equal(normalizeSettings({ secretFile: '' }).secretFile, '')
})

test('normalizeSettings validates the new booleans and peer strings', () => {
  assert.throws(() => normalizeSettings({ enabled: 'yes' }), /enabled/)
  assert.throws(() => normalizeSettings({ purgeOnUninstall: 'sure' }), /purgeOnUninstall/)
  assert.throws(() => normalizeSettings({ peerName: 42 }), /peerName/)
  // null means "leave this field alone", not an error
  assert.deepEqual(normalizeSettings({ secretFile: null }), {})
})

test('normalizeSettings validates, de-duplicates and caps pairings', () => {
  const pairings = normalizeSettings({
    pairings: [
      { name: 'a', platform: 'win32', address: '192.168.1.5', transport: 'lan', pairedAt: '2026-11-17T10:00:00Z' },
      'nope',
      null,
      { address: '   ' },
      { address: '192.168.1.5', name: 'a-newer', transport: 'lan' },
      { address: '192.168.1.6', transport: 'lan', pairedAt: 'not a date' },
    ],
  }).pairings
  assert.equal(pairings.length, 2)
  assert.deepEqual(pairings[0], {
    name: 'a',
    platform: 'win32',
    address: '192.168.1.5',
    transport: 'lan',
    pairedAt: '2026-11-17T10:00:00.000Z',
  })
  assert.equal(pairings[1].address, '192.168.1.6')
  assert.equal(pairings[1].pairedAt, '')

  const many = normalizeSettings({
    pairings: Array.from({ length: 11 }, (_, index) => ({
      address: `10.0.0.${index + 1}`,
      transport: 'lan',
    })),
  }).pairings
  assert.equal(many.length, 10)
  assert.equal(many[0].address, '10.0.0.1')
  assert.equal(many[9].address, '10.0.0.10')
  assert.deepEqual(normalizeSettings({ pairings: 'nope' }).pairings, [])
})

test('normalizeSettings rejects invalid values with a Chinese message', () => {
  assert.throws(() => normalizeSettings({ listenPort: 70000 }), /listenPort/)
  assert.throws(() => normalizeSettings({ discoveryPort: 0 }), /discoveryPort/)
  assert.throws(() => normalizeSettings({ auditKeep: 0 }), /auditKeep/)
  assert.throws(() => normalizeSettings({ pairTtlSec: 10 }), /pairTtlSec/)
  assert.throws(() => normalizeSettings({ defaultTimeoutMs: 999 }), /defaultTimeoutMs/)
  assert.throws(() => normalizeSettings({ peerUrl: 'ftp://host' }), /peerUrl/)
  assert.throws(() => normalizeSettings({ peerUrl: 'not a url' }), /peerUrl/)
  assert.throws(() => normalizeSettings({ toolsMode: 'sometimes' }), /toolsMode/)
  assert.throws(() => normalizeSettings({ remoteMode: 'vpn' }), /remoteMode/)
  assert.throws(() => normalizeSettings({ role: 'server' }), /role/)
  assert.throws(() => normalizeSettings({ tunnelEnabled: 'yes' }), /tunnelEnabled/)
  assert.throws(() => normalizeSettings({ listenHost: '   ' }), /listenHost/)
  assert.throws(() => normalizeSettings(null), /对象/)
  assert.throws(() => normalizeSettings([]), /对象/)
})

test('normalizeSettings accepts empty peerUrl and https urls', () => {
  assert.equal(normalizeSettings({ peerUrl: '' }).peerUrl, '')
  assert.equal(normalizeSettings({ peerUrl: 'https://pc.example:18790/' }).peerUrl, 'https://pc.example:18790')
})

test('mergeConfig lets settings win over the plugin config', () => {
  const merged = mergeConfig(
    { role: 'both', listenPort: 18790, peerUrl: '' },
    { listenPort: 19020 },
  )
  assert.deepEqual(merged, { role: 'both', listenPort: 19020, peerUrl: '' })
  assert.deepEqual(mergeConfig(undefined, null), {})
})

test('mergeConfig unwraps volatile references on both layers', () => {
  const ref = (value) => ({ get: () => value })
  const merged = mergeConfig(
    { listenPort: ref(18790), role: 'both' },
    { listenPort: 19030 },
  )
  assert.equal(merged.listenPort, 19030)
  assert.equal(merged.role, 'both')
})
