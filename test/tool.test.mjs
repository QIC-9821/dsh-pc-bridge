import test from 'node:test'
import assert from 'node:assert/strict'

import { pcToolSpecs, resolvePeer } from '../lib/tool.mjs'

test('resolvePeer falls back to the configured url', () => {
  assert.deepEqual(resolvePeer('', 'http://127.0.0.1:18790'), { ok: true, url: 'http://127.0.0.1:18790' })
})

test('resolvePeer accepts http(s) and strips trailing slashes', () => {
  assert.deepEqual(resolvePeer('http://192.168.0.50:18790/', 'x'), {
    ok: true,
    url: 'http://192.168.0.50:18790',
  })
})

test('resolvePeer rejects other schemes and garbage', () => {
  assert.equal(resolvePeer('ftp://host', 'x').ok, false)
  assert.equal(resolvePeer('not a url', 'x').ok, false)
})

test('pc_exec and pc_ping expose the peer override', () => {
  const specs = pcToolSpecs({ baseUrl: 'http://127.0.0.1:18790', secret: 's' })
  const exec = specs.find((s) => s.name === 'pc_exec')
  const ping = specs.find((s) => s.name === 'pc_ping')
  assert.ok(exec.parameters.properties.peer)
  assert.ok(ping.parameters.properties.peer)
})

test('pc_exec refuses an invalid peer without network access', async () => {
  const specs = pcToolSpecs({ baseUrl: 'http://127.0.0.1:18790', secret: 's' })
  const exec = specs.find((s) => s.name === 'pc_exec')
  const result = await exec.execute({ command: 'echo hi', peer: 'ftp://nope' })
  assert.equal(result.ok, false)
  assert.match(result.error, /http or https/)
})
