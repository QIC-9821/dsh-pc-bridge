import test from 'node:test'
import assert from 'node:assert/strict'

import { BACKOFF_SECONDS, buildTunnelArgs } from '../lib/tunnel.mjs'

test('buildTunnelArgs keeps the forward-safe option ordering', () => {
  const args = buildTunnelArgs({
    sshHost: '203.0.113.10',
    sshUser: 'dsh',
    sshKeyPath: 'C:/Users/me/.ssh/id_ed25519',
    remotePort: 18790,
    localPort: 18790,
  })
  assert.deepEqual(args, [
    '-N', '-T',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'BatchMode=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-i', 'C:/Users/me/.ssh/id_ed25519',
    '-R', '127.0.0.1:18790:127.0.0.1:18790',
    'dsh@203.0.113.10',
  ])
})

test('buildTunnelArgs omits -i and the user when not provided', () => {
  const args = buildTunnelArgs({ sshHost: 'example.com', sshUser: '' })
  assert.equal(args.includes('-i'), false)
  assert.equal(args[args.length - 1], 'example.com')
})

test('buildTunnelArgs rejects a missing host', () => {
  assert.throws(() => buildTunnelArgs({}), /sshHost/)
})

test('backoff is bounded and monotonic', () => {
  assert.deepEqual([...BACKOFF_SECONDS], [5, 10, 30, 60])
})
