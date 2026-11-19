import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  addPeerHistory,
  classifyHost,
  classifyUrl,
  deletePeerRecord,
  hostForUrl,
  normalizeHost,
  peersFile,
  readPeerRecords,
  rememberPeerRecord,
  writePeerRecords,
} from '../lib/peer-memory.mjs'

test('classifyHost sorts each network kind', () => {
  assert.equal(classifyHost('192.168.137.50'), 'hotspot') // Windows 热点
  assert.equal(classifyHost('192.168.43.7'), 'hotspot') // Android 热点
  assert.equal(classifyHost('172.20.10.2'), 'hotspot') // iPhone 热点
  assert.equal(classifyHost('192.168.1.9'), 'lan')
  assert.equal(classifyHost('10.0.0.4'), 'lan')
  assert.equal(classifyHost('172.16.3.4'), 'lan')
  assert.equal(classifyHost('172.31.9.9'), 'lan')
  assert.equal(classifyHost('100.107.191.27'), 'tailnet')
  assert.equal(classifyHost('gt-pro.tail92bb91.ts.net'), 'tailnet')
  assert.equal(classifyHost('127.0.0.1'), 'local')
  assert.equal(classifyHost('::1'), 'local')
  assert.equal(classifyHost('::ffff:192.168.137.9'), 'hotspot')
  assert.equal(classifyHost('8.8.8.8'), 'other')
  assert.equal(classifyHost('some-host.lan'), 'other')
  assert.equal(classifyHost(''), '')
})

test('normalizeHost strips brackets, v4-mapped prefix and zones', () => {
  assert.equal(normalizeHost('[100.64.0.2]'), '100.64.0.2')
  assert.equal(normalizeHost('::FFFF:10.1.2.3'), '10.1.2.3')
  assert.equal(normalizeHost('fe80::1%eth0'), 'fe80::1')
  assert.equal(normalizeHost('  '), '')
  assert.equal(hostForUrl('fe80::1'), '[fe80::1]')
  assert.equal(hostForUrl('192.168.137.50'), '192.168.137.50')
})

test('classifyUrl reads the host out of a peerUrl', () => {
  assert.equal(classifyUrl('http://192.168.137.50:18792'), 'hotspot')
  assert.equal(classifyUrl('192.168.1.4:18792'), 'lan')
  assert.equal(classifyUrl('http://gt-pro.tail92bb91.ts.net:18792/'), 'tailnet')
  assert.equal(classifyUrl(''), '')
  assert.equal(classifyUrl('not a url'), '')
})

test('rememberPeerRecord writes one address per kind and throttles repeats', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memsync-peers-'))
  const first = rememberPeerRecord(dir, '192.168.137.50', { now: 1_000_000 })
  assert.equal(first.host, '192.168.137.50')
  assert.equal(first.count, 1)

  // Same address inside the throttle window: nothing is written.
  assert.equal(rememberPeerRecord(dir, '192.168.137.50', { now: 1_000_000 + 60_000 }), null)

  const later = rememberPeerRecord(dir, '192.168.137.50', { now: 1_000_000 + 11 * 60_000 })
  assert.equal(later.count, 2)

  rememberPeerRecord(dir, '10.0.0.5', { now: 2_000_000 })
  rememberPeerRecord(dir, '192.168.137.99', { now: 3_000_000 })

  const records = readPeerRecords(dir)
  assert.equal(records.hotspot.host, '192.168.137.99') // newest replaces the old one
  assert.equal(records.hotspot.count, 1)
  assert.equal(records.lan.host, '10.0.0.5')

  // Loopback is never remembered.
  assert.equal(rememberPeerRecord(dir, '127.0.0.1'), null)

  assert.equal(deletePeerRecord(dir, 'lan'), true)
  assert.equal(readPeerRecords(dir).lan, undefined)
  assert.equal(deletePeerRecord(dir, 'lan'), false)

  const body = JSON.parse(readFileSync(peersFile(dir), 'utf8'))
  assert.equal(body.version, 1)
  assert.deepEqual(Object.keys(body.records), ['hotspot'])
})

test('writePeerRecords drops unknown kinds and junk entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memsync-peers-'))
  writePeerRecords(dir, {
    hotspot: { host: '192.168.137.50', at: 'x', count: 3 },
    bogus: { host: '1.2.3.4' },
    lan: { host: '   ' },
  })
  const records = readPeerRecords(dir)
  assert.deepEqual(Object.keys(records), ['hotspot'])
  assert.equal(records.hotspot.count, 3)
})

test('addPeerHistory keeps at most two chips per kind, newest first', () => {
  let history = addPeerHistory({}, '192.168.137.50')
  history = addPeerHistory(history, '192.168.137.51')
  history = addPeerHistory(history, '192.168.137.52')
  assert.deepEqual(history.hotspot, ['192.168.137.52', '192.168.137.51'])

  // Re-using a chip moves it to the front instead of duplicating it.
  history = addPeerHistory(history, '192.168.137.51')
  assert.deepEqual(history.hotspot, ['192.168.137.51', '192.168.137.52'])

  history = addPeerHistory(history, '10.0.0.8')
  assert.deepEqual(history.lan, ['10.0.0.8'])

  // Loopback and blank hosts are not chips.
  assert.deepEqual(addPeerHistory(history, '127.0.0.1'), history)
  assert.deepEqual(addPeerHistory(history, ''), history)

  // A corrupt history is cleaned up rather than trusted.
  const cleaned = addPeerHistory({ hotspot: ['  A  ', 'a', 'b', 'c'], lan: 'nope' }, '')
  assert.deepEqual(cleaned.hotspot, ['a', 'b'])
  assert.equal(cleaned.lan, undefined)
})
