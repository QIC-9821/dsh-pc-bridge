import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createBridgeServer } from '../lib/server.mjs'
import { pcFileToolSpecs, pcToolSpecs, resolvePeer } from '../lib/tool.mjs'

const shell = { exe: 'bash', args: ['-lc'], kind: 'bash' }

async function startFileBridge(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pc-bridge-tool-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const bridge = createBridgeServer({
    secret: 's3cret',
    shell,
    listenHost: '127.0.0.1',
    listenPort: 0,
    exec: async () => ({
      ok: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 0,
      timedOut: false,
      truncated: false,
    }),
    file: { roots: [dir], cwd: dir, chunkBytes: 65536, maxBytes: 1024 * 1024, ...options },
  })
  const address = await bridge.start()
  t.after(() => bridge.close())
  const baseUrl = `http://127.0.0.1:${address.port}`
  const specs = pcFileToolSpecs({ baseUrl, secret: 's3cret' })
  const tools = Object.fromEntries(specs.map((spec) => [spec.name, spec]))
  return { dir, baseUrl, tools }
}

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

test('pc_file_* provide the three file tools with a peer override', () => {
  const specs = pcFileToolSpecs({ baseUrl: 'http://127.0.0.1:18790', secret: 's' })
  assert.deepEqual(specs.map((spec) => spec.name).sort(), ['pc_file_list', 'pc_file_read', 'pc_file_write'])
  for (const spec of specs) {
    assert.equal(typeof spec.execute, 'function')
    assert.ok(spec.parameters.properties.peer)
  }
})

test('pc_file_write and pc_file_read complete a round trip', async (t) => {
  const { dir, tools } = await startFileBridge(t)
  const target = join(dir, 'round.txt')

  const written = await tools.pc_file_write.execute({ path: target, content: '你好 bridge' })
  assert.equal(written.ok, true)
  assert.equal(written.path, target)
  assert.equal(written.size, Buffer.byteLength('你好 bridge'))

  const read = await tools.pc_file_read.execute({ path: target })
  assert.equal(read.ok, true)
  assert.equal(read.encoding, 'utf8')
  assert.equal(read.content, '你好 bridge')
  assert.equal(read.eof, true)
})

test('pc_file_read pages a large file and can pull it to disk', async (t) => {
  const { dir, tools } = await startFileBridge(t)
  const target = join(dir, 'big.bin')
  const payload = Buffer.alloc(200000, 0)
  await writeFile(target, payload)

  const first = await tools.pc_file_read.execute({ path: target, maxBytes: 65536 })
  assert.equal(first.ok, true)
  assert.equal(first.bytes, 65536)
  assert.equal(first.truncated, true)
  assert.equal(first.nextOffset, 65536)
  assert.equal(first.encoding, 'base64')

  const dest = join(dir, 'pulled.bin')
  const pulled = await tools.pc_file_read.execute({ path: target, dest })
  assert.equal(pulled.ok, true)
  assert.deepEqual(await readFile(dest), payload)
})

test('pc_file_write can push a local file and pc_file_list sees it', async (t) => {
  const { dir, tools } = await startFileBridge(t)
  const source = join(dir, 'local.txt')
  await writeFile(source, 'from source', 'utf8')
  const target = join(dir, 'uploaded.txt')

  const pushed = await tools.pc_file_write.execute({ path: target, source })
  assert.equal(pushed.ok, true)
  assert.equal(await readFile(target, 'utf8'), 'from source')

  const listed = await tools.pc_file_list.execute({ path: dir })
  assert.equal(listed.ok, true)
  assert.equal(listed.entries.some((entry) => entry.name === 'uploaded.txt'), true)
})

test('file tools refuse an invalid peer and a path outside the roots', async (t) => {
  const { tools } = await startFileBridge(t)

  const badPeer = await tools.pc_file_list.execute({ path: '.', peer: 'ftp://nope' })
  assert.equal(badPeer.ok, false)

  const outside = await tools.pc_file_read.execute({ path: join(tmpdir(), 'not-allowed.txt') })
  assert.equal(outside.ok, false)
  assert.equal(outside.httpStatus, 403)
})
