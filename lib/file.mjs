import { createHash } from 'node:crypto'
import { mkdir, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** Bounds shared with the client so both sides clamp the same values. */
export const FILE_LIMITS = Object.freeze({
  chunkBytesMin: 65536,
  chunkBytesMax: 16777216,
  maxBytesMin: 1048576,
  maxBytesMax: 4294967296,
})

const DEFAULT_CHUNK_BYTES = 1048576
const DEFAULT_MAX_BYTES = 67108864
const MAX_PATH_LENGTH = 4096
const STALE_PART_AGE_MS = 60 * 60 * 1000
const UPLOAD_ID_PATTERN = /^[0-9a-fA-F]{8,64}$/
const HASH_BLOCK_BYTES = 1024 * 1024

function fail(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

/** Map a filesystem error onto one of the status codes the HTTP layer knows. */
function fromSystem(error) {
  if (error?.statusCode) return error
  const code = error?.code
  const statusCode = code === 'ENOENT'
    ? 404
    : (code === 'EACCES' || code === 'EPERM' ? 403 : 400)
  return fail(statusCode, String(error?.message || error))
}

function toOffset(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0
}

function toLimit(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.trunc(number) : DEFAULT_MAX_BYTES
}

function toPositiveInt(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback
}

function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

function baseCwd(cwd) {
  const text = expandHome(String(cwd ?? '').trim())
  if (!text) return process.cwd()
  return isAbsolute(text) ? resolve(text) : resolve(process.cwd(), text)
}

function foldCase(text) {
  return process.platform === 'win32' ? text.toLowerCase() : text
}

function isInside(target, root) {
  const left = foldCase(target)
  const right = foldCase(root)
  if (left === right) return true
  return left.startsWith(right.endsWith(sep) ? right : `${right}${sep}`)
}

function typeOf(info) {
  if (info.isFile()) return 'file'
  if (info.isDirectory()) return 'dir'
  return 'other'
}

async function resolveRoots(roots, cwd) {
  if (!Array.isArray(roots) || roots.length === 0) return []
  const out = []
  for (const root of roots) {
    const text = expandHome(String(root ?? '').trim())
    if (!text) continue
    const absolute = isAbsolute(text) ? resolve(text) : resolve(cwd, text)
    try {
      out.push(await realpath(absolute))
    } catch {
      out.push(absolute)
    }
  }
  return out
}

/**
 * Resolve a path that may not exist yet: walk up to the deepest ancestor that
 * can be realpath'd, then re-append the missing tail. This keeps roots honest
 * when a symlinked directory sits on the way to a file that is about to appear.
 */
async function realTarget(absolute) {
  const tail = []
  let current = absolute
  for (;;) {
    try {
      const real = await realpath(current)
      return tail.length > 0 ? join(real, ...tail.reverse()) : real
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
      const parent = dirname(current)
      if (parent === current) return absolute
      tail.push(basename(current))
      current = parent
    }
  }
}

/**
 * Resolve a request path to an absolute real location and enforce fileRoots.
 * A missing target resolves through the real path of its closest existing
 * ancestor, so a symlinked directory cannot be used to escape the roots.
 */
async function resolveTarget(rawPath, { cwd, roots = [] } = {}) {
  const base = baseCwd(cwd)
  const text = expandHome(String(rawPath ?? '').trim())
  if (!text) throw fail(400, 'invalid path')
  if (text.includes('\0') || text.length > MAX_PATH_LENGTH) throw fail(400, 'invalid path')
  const absolute = isAbsolute(text) ? resolve(text) : resolve(base, text)
  if (absolute.length > MAX_PATH_LENGTH) throw fail(400, 'invalid path')

  const target = await realTarget(absolute)

  const allowed = await resolveRoots(roots, base)
  if (allowed.length > 0 && !allowed.some((root) => isInside(target, root))) {
    throw fail(403, 'path outside fileRoots')
  }
  return target
}

function decodeBase64(value) {
  if (value === undefined || value === null) return Buffer.alloc(0)
  if (typeof value !== 'string') throw fail(400, 'invalid base64 data')
  if (value === '') return Buffer.alloc(0)
  // Strict base64: no whitespace, padding only at the end, length % 4 === 0.
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw fail(400, 'invalid base64 data')
  }
  const buffer = Buffer.from(value, 'base64')
  if (buffer.toString('base64') !== value) throw fail(400, 'invalid base64 data')
  return buffer
}

/** Stream a file through the hash so large uploads never land in memory. */
async function sha256File(file) {
  const handle = await open(file, 'r')
  try {
    const hash = createHash('sha256')
    const block = Buffer.allocUnsafe(HASH_BLOCK_BYTES)
    let position = 0
    for (;;) {
      const { bytesRead } = await handle.read(block, 0, block.length, position)
      if (!bytesRead) break
      hash.update(block.subarray(0, bytesRead))
      position += bytesRead
    }
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

async function writeAll(handle, buffer) {
  let written = 0
  while (written < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, written, buffer.length - written)
    if (!bytesWritten) break
    written += bytesWritten
  }
  return written
}

async function ensureParent(target, createDirs) {
  if (!createDirs) return
  await mkdir(dirname(target), { recursive: true })
}

/** Drop leftover part files of the same target that are older than an hour. */
async function cleanupStaleParts(target) {
  const dir = dirname(target)
  const prefix = `${basename(target)}.pcbridge-`
  const cutoff = Date.now() - STALE_PART_AGE_MS
  let names
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.part')) continue
    const file = join(dir, name)
    try {
      const info = await stat(file)
      if (!info.isFile() || info.mtimeMs >= cutoff) continue
      await rm(file, { force: true })
    } catch {
      // best effort: a locked or vanished part is ignored on purpose
    }
  }
}

/** Move a finished part onto its target, retrying once over a locked file. */
async function commitPart(part, target) {
  try {
    await rename(part, target)
    return
  } catch (error) {
    const code = error?.code
    if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') throw fromSystem(error)
  }
  // Windows cannot replace some files in place; drop the target first.
  try {
    await rm(target, { force: true })
  } catch {
    // the retry below reports the real verdict
  }
  try {
    await rename(part, target)
  } catch {
    try {
      await rm(part, { force: true })
    } catch {
      // ignore: the part is already gone
    }
    throw fail(409, 'target is locked')
  }
}

/**
 * Stat one path inside the allowed roots. A missing target is not an error:
 * it comes back with exists:false so a client can decide to create it.
 */
export async function fileStat(rawPath, { cwd, roots = [] } = {}) {
  try {
    const target = await resolveTarget(rawPath, { cwd, roots })
    let info
    try {
      info = await stat(target)
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        return { ok: true, path: target, exists: false, type: 'other', size: 0, mtimeMs: 0, mode: 0 }
      }
      throw error
    }
    return {
      ok: true,
      path: target,
      exists: true,
      type: typeOf(info),
      size: info.size,
      mtimeMs: info.mtimeMs,
      mode: info.mode,
    }
  } catch (error) {
    throw fromSystem(error)
  }
}

/**
 * List a directory inside the allowed roots. A plain file is not an error:
 * it comes back with no entries and type:'file'.
 */
export async function fileList(rawPath, { cwd, roots = [], limit = 200 } = {}) {
  try {
    const target = await resolveTarget(rawPath, { cwd, roots })
    let info
    try {
      info = await stat(target)
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw fail(404, 'not found')
      throw error
    }

    const type = typeOf(info)
    if (type !== 'dir') {
      return { ok: true, path: target, type, entries: [], count: 0, truncated: false }
    }

    const dirents = await readdir(target, { withFileTypes: true })
    dirents.sort((left, right) => {
      const a = left.name.toLowerCase()
      const b = right.name.toLowerCase()
      if (a < b) return -1
      if (a > b) return 1
      return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    })

    const max = Number.isFinite(Number(limit))
      ? Math.min(Math.max(Math.trunc(Number(limit)), 1), 1000)
      : 200
    const selected = dirents.slice(0, max)
    const entries = []
    for (const dirent of selected) {
      try {
        const entry = await stat(join(target, dirent.name))
        entries.push({ name: dirent.name, type: typeOf(entry), size: entry.size, mtimeMs: entry.mtimeMs })
      } catch {
        entries.push({ name: dirent.name, type: 'other', size: 0, mtimeMs: 0 })
      }
    }
    return {
      ok: true,
      path: target,
      type,
      entries,
      count: entries.length,
      truncated: dirents.length > selected.length,
    }
  } catch (error) {
    throw fromSystem(error)
  }
}

/**
 * Read one chunk of a regular file as base64. The returned sha256 covers the
 * exact bytes in `data`, so a client can verify every chunk it reassembles.
 */
export async function fileRead(rawPath, {
  cwd,
  roots = [],
  offset = 0,
  maxBytes = DEFAULT_CHUNK_BYTES,
  chunkBytes = DEFAULT_CHUNK_BYTES,
} = {}) {
  try {
    const target = await resolveTarget(rawPath, { cwd, roots })
    const chunk = toPositiveInt(chunkBytes, DEFAULT_CHUNK_BYTES)
    const requested = Number(maxBytes)
    const limit = Number.isFinite(requested)
      ? Math.min(Math.max(Math.trunc(requested), 1), chunk)
      : chunk
    const start = toOffset(offset)

    let info
    try {
      info = await stat(target)
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw fail(404, 'not found')
      throw error
    }
    if (!info.isFile()) throw fail(400, 'not a regular file')

    // Reading at or past EOF is not an error: report an empty final chunk.
    if (info.size > 0 && start >= info.size) {
      return {
        ok: true,
        path: target,
        size: info.size,
        mtimeMs: info.mtimeMs,
        offset: start,
        bytes: 0,
        eof: true,
        encoding: 'base64',
        data: '',
        sha256: '',
      }
    }

    const length = Math.min(limit, Math.max(info.size - start, 0))
    const block = Buffer.allocUnsafe(length)
    let filled = 0
    if (length > 0) {
      const handle = await open(target, 'r')
      try {
        while (filled < length) {
          const { bytesRead } = await handle.read(block, filled, length - filled, start + filled)
          if (!bytesRead) break
          filled += bytesRead
        }
      } finally {
        await handle.close()
      }
    }
    const data = block.subarray(0, filled)
    return {
      ok: true,
      path: target,
      size: info.size,
      mtimeMs: info.mtimeMs,
      offset: start,
      bytes: filled,
      eof: start + filled >= info.size,
      encoding: 'base64',
      data: data.toString('base64'),
      sha256: createHash('sha256').update(data).digest('hex'),
    }
  } catch (error) {
    throw fromSystem(error)
  }
}

/**
 * Write one upload chunk. `append=false` stages chunks in a sibling `.part`
 * file and renames it into place on the final chunk; `append=true` writes
 * straight into the target once the reported offset matches its current size.
 */
export async function fileWrite({
  path: rawPath,
  uploadId,
  offset = 0,
  data = '',
  final = false,
  append = false,
  createDirs = true,
  chunkSha256 = '',
  expectedSha256 = '',
  cwd,
  roots = [],
  chunkBytes = DEFAULT_CHUNK_BYTES,
  maxBytes = DEFAULT_MAX_BYTES,
  enabled = true,
} = {}) {
  try {
    void chunkBytes // accepted for client symmetry; maxBytes bounds the chunk
    if (enabled === false) throw fail(403, 'file transfer is disabled')

    const id = String(uploadId ?? '')
    if (!UPLOAD_ID_PATTERN.test(id)) throw fail(400, 'invalid uploadId')

    const payload = decodeBase64(data)
    const chunkDigest = String(chunkSha256 ?? '').trim().toLowerCase()
    if (chunkDigest) {
      const actual = createHash('sha256').update(payload).digest('hex')
      if (actual !== chunkDigest) throw fail(400, 'chunk sha256 mismatch')
    }

    const start = toOffset(offset)
    const limit = toLimit(maxBytes)
    // Reject before touching the disk so an oversized chunk leaves no part.
    if (start + payload.length > limit) throw fail(413, 'file too large')

    const target = await resolveTarget(rawPath, { cwd, roots })
    const written = payload.length

    if (append) {
      await ensureParent(target, createDirs)
      let size = 0
      try {
        const info = await stat(target)
        if (!info.isFile()) throw fail(400, 'not a regular file')
        size = info.size
      } catch (error) {
        if (error?.statusCode) throw error
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
      }
      if (size !== start) throw fail(409, 'offset mismatch')

      const handle = await open(target, 'a')
      try {
        await writeAll(handle, payload)
      } finally {
        await handle.close()
      }
      const after = await stat(target)
      if (!final) {
        return { ok: true, path: target, size: after.size, written, finalized: false, sha256: '' }
      }
      return {
        ok: true,
        path: target,
        size: after.size,
        written,
        finalized: true,
        sha256: await sha256File(target),
      }
    }

    const part = `${target}.pcbridge-${id}.part`
    let partSize = 0
    if (start === 0) {
      await ensureParent(target, createDirs)
      await cleanupStaleParts(target)
      const handle = await open(part, 'w')
      try {
        await writeAll(handle, payload)
      } finally {
        await handle.close()
      }
      partSize = payload.length
    } else {
      let info
      try {
        info = await stat(part)
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw fail(409, 'stale upload')
        throw error
      }
      if (!info.isFile() || info.size !== start) throw fail(409, 'stale upload')
      const handle = await open(part, 'a')
      try {
        await writeAll(handle, payload)
      } finally {
        await handle.close()
      }
      partSize = start + payload.length
    }

    if (!final) {
      return { ok: true, path: target, size: partSize, written, finalized: false, sha256: '' }
    }

    let digest = ''
    const expectedDigest = String(expectedSha256 ?? '').trim().toLowerCase()
    if (expectedDigest) {
      const actual = await sha256File(part)
      if (actual !== expectedDigest) {
        try {
          await rm(part, { force: true })
        } catch {
          // ignore: the part is invalid either way
        }
        throw fail(400, 'sha256 mismatch')
      }
      digest = actual
    }

    await commitPart(part, target)
    const info = await stat(target)
    if (!digest) digest = await sha256File(target)
    return { ok: true, path: target, size: info.size, written, finalized: true, sha256: digest }
  } catch (error) {
    throw fromSystem(error)
  }
}
