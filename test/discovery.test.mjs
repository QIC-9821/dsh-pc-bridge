import test from 'node:test'
import assert from 'node:assert/strict'
import dgram from 'node:dgram'

import { createDiscoveryResponder, scanPeers } from '../lib/discovery.mjs'

const INFO = {
  name: 'pc-bridge-test',
  port: 18790,
  platform: 'test-os',
  version: '0.3.0-test',
}

function closeSocket(socket) {
  if (!socket) return Promise.resolve()
  return new Promise(resolve => {
    try {
      socket.close(() => resolve())
    } catch {
      resolve()
    }
  })
}

async function freeUdpPort() {
  const socket = dgram.createSocket('udp4')
  try {
    await new Promise((resolve, reject) => {
      socket.once('error', reject)
      socket.bind(0, '0.0.0.0', resolve)
    })
    return socket.address().port
  } finally {
    await closeSocket(socket)
  }
}

test('scanPeers finds a responder bound to a random port', async () => {
  const responder = createDiscoveryResponder({ port: 0, info: INFO })
  try {
    const { port } = await responder.start()
    assert.ok(Number.isInteger(port) && port > 0, 'expected a real bound port')
    assert.equal(responder.port, port)

    const peers = await scanPeers({ port, timeoutMs: 500 })
    const matches = peers.filter(peer => peer.name === INFO.name)
    assert.equal(matches.length, 1, `expected one deduplicated peer, got ${JSON.stringify(peers)}`)

    const peer = matches[0]
    assert.equal(peer.port, INFO.port)
    assert.equal(peer.platform, INFO.platform)
    assert.equal(peer.version, INFO.version)
    assert.ok(peer.host, 'host should be reported')
    assert.ok(peer.address, 'address should be the observed source')
    assert.ok(peer.lastSeen > 0)
  } finally {
    await responder.stop()
  }
})

test('start is idempotent and stop releases the port', async () => {
  const responder = createDiscoveryResponder({ port: 0, info: INFO })
  const first = await responder.start()
  const second = await responder.start()
  assert.equal(second.port, first.port)

  await responder.stop()
  assert.equal(responder.port, 0)

  const socket = dgram.createSocket('udp4')
  try {
    await new Promise((resolve, reject) => {
      socket.once('error', reject)
      socket.bind(first.port, '0.0.0.0', resolve)
    })
  } finally {
    await closeSocket(socket)
  }
})

test('scanPeers returns an empty list when nobody answers', async () => {
  const port = await freeUdpPort()
  const peers = await scanPeers({ port, timeoutMs: 300 })
  assert.deepEqual(peers, [])
})

test('the responder ignores unrelated datagrams', async () => {
  const responder = createDiscoveryResponder({ port: 0, info: INFO })
  const socket = dgram.createSocket('udp4')
  try {
    const { port } = await responder.start()
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(null), 300)
      socket.once('message', message => {
        clearTimeout(timer)
        resolve(message)
      })
      socket.once('error', error => {
        clearTimeout(timer)
        reject(error)
      })
      socket.send('HELLO', port, '127.0.0.1')
    })
    assert.equal(reply, null)
  } finally {
    await closeSocket(socket)
    await responder.stop()
  }
})
