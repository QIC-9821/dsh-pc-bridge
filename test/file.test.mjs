import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fileList, fileRead, fileStat, fileWrite } from '../lib/file.mjs'

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')
const UPLOAD = '0123456789abcdef'

async function workdir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pc-bridge-file-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('fileStat reports a missing path without throwing', async (t) => {
  const dir = await workdir(t)
  const info = await fileStat(join(dir, 'nope.txt'), { cwd: dir })
  assert.equal(info.ok, true)
  assert.equal(info.exists, false)
  assert.equal(info.type, 'other')
  assert.equal(info.size, 0)
})

test('fileStat resolves relative paths against cwd', async (t) => {
  const dir = await workdir(t)
  await writeFile(join(dir, 'a.txt'), 'hello', 'utf8')
  const info = await fileStat('a.txt', { cwd: dir })
  assert.equal(info.exists, true)
  assert.equal(info.type, 'file')
  assert.equal(info.size, 5)
  assert.equal(info.path, join(dir, 'a.txt'))
})

test('fileWrite creates a file in one final chunk', async (t) => {
  const dir = await workdir(t)
  const target = join(dir, 'one.txt')
  const payload = Buffer.from('hello bridge', 'utf8')
  const result = await fileWrite({
    path: target,
    uploadId: UPLOAD,
    data: payload.toString('base64'),
    final: true,
    cwd: dir,
  })
  assert.equal(result.ok, true)
  assert.equal(result.finalized, true)
  assert.equal(result.size, payload.length)
  assert.equal(result.sha256, sha256(payload))
  assert.equal(await readFile(target, 'utf8'), 'hello bridge')
})

test('fileWrite assembles multiple chunks and hides the part file', async (t) => {
  const dir = await workdir(t)
  const target = join(dir, 'multi.bin')
  const first = Buffer.alloc(1024, 1)
  const second = Buffer.alloc(1024, 2)

  await fileWrite({ path: target, uploadId: UPLOAD, offset: 0, data: first.toString('base64'), cwd: dir })
  const partial = await fileStat(target, { cwd: dir })
  assert.equal(partial.exists, false, 'target must not exist before the final chunk')

  const done = await fileWrite({
    path: target,
    uploadId: UPLOAD,
    offset: first.length,
    data: second.toString('base64'),
    final: true,
    expectedSha256: sha256(Buffer.concat([first, second])),
    cwd: dir,
  })
  assert.equal(done.finalized, true)
  assert.equal(done.size, 2048)
  assert.deepEqual(await readFile(target), Buffer.concat([first, second]))
  const parts = await fileList(dir, { cwd: dir })
  assert.equal(parts.entries.some((entry) => entry.name.includes('.pcbridge-')), false)
})

test('fileWrite rejects a stale offset', async (t) => {
  const dir = await workdir(t)
  const target = join(dir, 'stale.bin')
  await assert.rejects(
    fileWrite({ path: target, uploadId: UPLOAD, offset: 64, data: 'YQ==', cwd: dir }),
    (error) => error.statusCode === 409,
  )
})

test('fileWrite rejects a bad chunk hash and a bad expected hash', async (t) => {
  const dir = await workdir(t)
  const target = join(dir, 'hash.bin')
  await assert.rejects(
    fileWrite({ path: target, uploadId: UPLOAD, data: 'YQ==', chunkSha256: 'deadbeef', cwd: dir }),
    (error) => error.statusCode === 400,
  )

  await assert.rejects(
    fileWrite({
      path: target,
      uploadId: UPLOAD,
      data: 'YQ==',
      final: true,
      expectedSha256: 'deadbeef',
      cwd: dir,
    }),
    (error) => error.statusCode === 400,
  )
  assert.equal((await fileStat(target, { cwd: dir })).exists, false)
})

test('fileWrite appends to an existing file', async (t) => {
  const dir = await workdir(t)
  const target = join(dir, 'append.txt')
  await writeFile(target, 'one', 'utf8')
  const result = await fileWrite({
    path: target,
    uploadId: UPLOAD,
    offset: 3,
    data: Buffer.from('-two').toString('base64'),
    append: true,
    final: true,
    cwd: dir,
  })
  assert.equal(result.finalized, true)
  assert.equal(await readFile(target, 'utf8'), 'one-two')
  assert.equal(result.size, 7)
})

test('fileWrite refuses a path outside fileRoots', async (t) => {
  const dir = await workdir(t)
  const allowed = join(dir, 'allowed')
  const blocked = join(dir, 'blocked')
  await mkdir(allowed)
  await mkdir(blocked)
  await writeFile(join(blocked, 'secret.txt'), 'x', 'utf8')

  await assert.rejects(
    fileRead(join(blocked, 'secret.txt'), { cwd: dir, roots: [allowed] }),
    (error) => error.statusCode === 403,
  )
  await assert.rejects(
    fileWrite({ path: join(blocked, 'new.txt'), uploadId: UPLOAD, data: 'YQ==', final: true, cwd: dir, roots: [allowed] }),
    (error) => error.statusCode === 403,
  )
})

test('fileRead returns chunks with offsets and eof', async (t) => {
  const dir = await workdir(t)
  const target = join(dir, 'read.bin')
  const payload = Buffer.alloc(3000)
  for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251
  await writeFile(target, payload)

  const first = await fileRead(target, { cwd: dir, offset: 0, maxBytes: 1000 })
  assert.equal(first.bytes, 1000)
  assert.equal(first.eof, false)
  assert.equal(first.encoding, 'base64')
  assert.equal(first.sha256, sha256(payload.subarray(0, 1000)))

  const last = await fileRead(target, { cwd: dir, offset: 2000, maxBytes: 1000 })
  assert.equal(last.bytes, 1000)
  assert.equal(last.eof, true)

  const past = await fileRead(target, { cwd: dir, offset: 9000, maxBytes: 1000 })
  assert.equal(past.bytes, 0)
  assert.equal(past.eof, true)
  assert.equal(past.data, '')
})

test('fileRead rejects a directory and a missing file', async (t) => {
  const dir = await workdir(t)
  await assert.rejects(fileRead(dir, { cwd: dir }), (error) => error.statusCode === 400)
  await assert.rejects(fileRead(join(dir, 'gone.txt'), { cwd: dir }), (error) => error.statusCode === 404)
})

test('fileList sorts entries, honours limit and reports truncation', async (t) => {
  const dir = await workdir(t)
  await writeFile(join(dir, 'b.txt'), 'bb', 'utf8')
  await writeFile(join(dir, 'A.txt'), 'a', 'utf8')
  await mkdir(join(dir, 'sub'))

  const all = await fileList(dir, { cwd: dir })
  assert.deepEqual(all.entries.map((entry) => entry.name), ['A.txt', 'b.txt', 'sub'])
  assert.equal(all.truncated, false)
  const dirEntry = all.entries.find((entry) => entry.name === 'sub')
  assert.equal(dirEntry.type, 'dir')

  const page = await fileList(dir, { cwd: dir, limit: 1 })
  assert.equal(page.entries.length, 1)
  assert.equal(page.truncated, true)

  const file = await fileList(join(dir, 'b.txt'), { cwd: dir })
  assert.equal(file.type, 'file')
  assert.deepEqual(file.entries, [])
})
