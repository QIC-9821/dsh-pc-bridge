import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveSecret, secretsEqual } from '../lib/secret.mjs'

test('secretsEqual is length-safe and rejects empty values', () => {
  assert.equal(secretsEqual('abc', 'abc'), true)
  assert.equal(secretsEqual('abc', 'abd'), false)
  assert.equal(secretsEqual('abc', 'abcd'), false)
  assert.equal(secretsEqual('', ''), false)
  assert.equal(secretsEqual(undefined, 'x'), false)
})

test('environment wins over a file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pc-bridge-secret-'))
  process.env.DSH_PC_BRIDGE_TEST_SECRET = 'from-env'
  try {
    const resolved = await resolveSecret({ envName: 'DSH_PC_BRIDGE_TEST_SECRET', stateDir: dir })
    assert.equal(resolved.secret, 'from-env')
    assert.match(resolved.source, /^env:/)
  } finally {
    delete process.env.DSH_PC_BRIDGE_TEST_SECRET
  }
})

test('host role creates a secret file, client role never does', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pc-bridge-secret-create-'))

  const client = await resolveSecret({ stateDir: dir, create: false })
  assert.equal(client.secret, '')

  const host = await resolveSecret({ stateDir: dir, create: true })
  assert.equal(host.secret.length, 64)
  const file = join(dir, 'secret')
  assert.equal((await readFile(file, 'utf8')).trim(), host.secret)

  const again = await resolveSecret({ stateDir: dir, create: true })
  assert.equal(again.secret, host.secret)
})
