import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeConfig } from '../lib/config.mjs'

test('defaults land under DSH_HOME', () => {
  const cfg = normalizeConfig({}, { DSH_HOME: 'C:\\data\\dsh' })
  assert.equal(cfg.role, 'both')
  assert.equal(cfg.listenHost, '127.0.0.1')
  assert.equal(cfg.listenPort, 18790)
  assert.equal(cfg.tunnelEnabled, false)
  assert.equal(cfg.tunnelRemotePort, 18790)
  assert.ok(cfg.secretFile.endsWith('secret'))
  assert.ok(cfg.stateDir.endsWith('pc-bridge'))
})

test('volatile config references are unwrapped', () => {
  const ref = (value) => ({ get: () => value })
  const cfg = normalizeConfig(
    {
      role: ref('host'),
      listenPort: ref(19001),
      tunnelEnabled: ref(true),
      secretFile: ref('C:/x/secret'),
      sshHost: ref('example.com'),
      maxTimeoutMs: ref(120000),
    },
    { DSH_HOME: 'C:\\data\\dsh' },
  )
  assert.equal(cfg.role, 'host')
  assert.equal(cfg.listenPort, 19001)
  assert.equal(cfg.tunnelEnabled, true)
  assert.equal(cfg.secretFile, 'C:/x/secret')
  assert.equal(cfg.sshHost, 'example.com')
  assert.equal(cfg.maxTimeoutMs, 120000)
})

test('a root volatile reference map is unwrapped', () => {
  const cfg = normalizeConfig({ get: () => ({ listenPort: 19002, sshUser: 'root' }) }, {})
  assert.equal(cfg.listenPort, 19002)
  assert.equal(cfg.sshUser, 'root')
})
