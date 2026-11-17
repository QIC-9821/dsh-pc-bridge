import assert from 'node:assert/strict'
import test from 'node:test'

import { createTailscaleClient, parseTailscaleStatus } from '../lib/tailscale.mjs'

const SAMPLE = JSON.stringify({
  BackendState: 'Running',
  MagicDNSSuffix: 'tail92bb91.ts.net',
  Self: {
    ID: 'self',
    HostName: 'QIC',
    DNSName: 'qic.tail92bb91.ts.net.',
    OS: 'windows',
    Online: true,
    TailscaleIPs: ['100.106.119.62', 'fd7a:115c:a1e0::f84b:773f'],
  },
  Peer: {
    'peer-1': { HostName: 'gt-pro', Online: true },
    'peer-2': { HostName: 'phone', Online: false },
  },
})

test('parseTailscaleStatus extracts the tailnet facts', () => {
  const status = parseTailscaleStatus(SAMPLE)
  assert.equal(status.online, true)
  assert.equal(status.ipv4, '100.106.119.62')
  assert.equal(status.dnsName, 'qic.tail92bb91.ts.net')
  assert.equal(status.hostName, 'QIC')
  assert.equal(status.peers, 2)
  assert.equal(status.magicDns, 'tail92bb91.ts.net')
  assert.equal(status.backendState, 'Running')
})

test('parseTailscaleStatus tolerates a logged-out payload', () => {
  const status = parseTailscaleStatus(JSON.stringify({ BackendState: 'NeedsLogin', Self: {} }))
  assert.equal(status.online, false)
  assert.equal(status.ipv4, '')
  assert.equal(status.peers, 0)
  assert.equal(status.backendState, 'NeedsLogin')
})

test('getStatus runs tailscale status --json', async () => {
  const calls = []
  const client = createTailscaleClient({
    platform: 'win32',
    cli: 'C:\\fake\\tailscale.exe',
    exists: () => true,
    exec: async (_file, args) => {
      calls.push(args.join(' '))
      return { stdout: SAMPLE }
    },
  })

  const status = await client.getStatus()
  assert.equal(status.installed, true)
  assert.equal(status.ipv4, '100.106.119.62')
  assert.deepEqual(calls, ['status --json'])
})

test('getStatus reports not-installed without spawning on Windows', async () => {
  let spawned = 0
  const client = createTailscaleClient({
    platform: 'win32',
    cli: 'C:\\fake\\tailscale.exe',
    exists: () => false,
    exec: async () => {
      spawned += 1
      return { stdout: '{}' }
    },
  })

  const status = await client.getStatus()
  assert.equal(status.installed, false)
  assert.equal(status.online, false)
  assert.equal(spawned, 0)
})

test('getStatus turns a CLI failure into a readable error', async () => {
  const client = createTailscaleClient({
    platform: 'linux',
    cli: 'tailscale',
    exec: async () => {
      throw new Error('tailscale: command not found')
    },
  })

  const status = await client.getStatus()
  assert.equal(status.installed, true)
  assert.equal(status.online, false)
  assert.match(status.error, /command not found/)
})
