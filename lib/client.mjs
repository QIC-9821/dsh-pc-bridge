import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, rename, rm, stat as fsStat } from 'node:fs/promises'

const NO_SECRET = 'bridge secret is not configured (secretEnv or secretFile)'

export function normalizeBaseUrl(url) {
  return String(url || 'http://127.0.0.1:18790').replace(/\/+$/, '')
}

function queryString(query) {
  if (!query || typeof query !== 'object') return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    params.set(key, String(value))
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

/**
 * One JSON request, with an explicit method and query string. Network failures
 * are returned as objects (never thrown) so a tool call can explain what went
 * wrong instead of surfacing a stack trace.
 */
export async function requestJsonWith(baseUrl, path, secret, {
  method = 'POST',
  query,
  body = {},
  timeoutMs = 30000,
} = {}) {
  const target = `${normalizeBaseUrl(baseUrl)}${path}${queryString(query)}`
  const verb = String(method || 'POST').toUpperCase()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs))
  try {
    const headers = {
      'x-pc-secret': String(secret || ''),
      accept: 'application/json',
    }
    const init = { method: verb, headers, signal: controller.signal }
    if (verb !== 'GET' && verb !== 'HEAD') {
      headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body ?? {})
    }
    const response = await fetch(target, init)
    const text = await response.text()
    let data
    try {
      data = JSON.parse(text)
    } catch {
      data = { raw: text }
    }
    if (!response.ok) {
      return {
        ok: false,
        httpStatus: response.status,
        ...(data && typeof data === 'object' ? data : { raw: text }),
      }
    }
    return data && typeof data === 'object' ? data : { ok: true, data }
  } catch (error) {
    return {
      ok: false,
      reason: error?.name === 'AbortError' ? 'timeout' : 'network',
      error: String(error?.message || error),
      url: target,
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function requestJson(baseUrl, path, secret, body = {}, timeoutMs = 30000) {
  return requestJsonWith(baseUrl, path, secret, { method: 'POST', body, timeoutMs })
}

export async function callPing(baseUrl, secret, { timeoutMs = 8000 } = {}) {
  if (!secret) return { ok: false, error: NO_SECRET }
  return requestJson(baseUrl, '/ping', secret, {}, timeoutMs)
}

export async function callExec(baseUrl, secret, { command, timeoutSec } = {}, {
  defaultTimeoutMs = 30000,
  maxTimeoutMs = 600000,
} = {}) {
  if (!secret) return { ok: false, error: NO_SECRET }
  const cmd = String(command || '').trim()
  if (!cmd) return { ok: false, error: 'command is empty' }

  const requested = Number(timeoutSec)
  const maxSec = Math.max(1, Math.floor(maxTimeoutMs / 1000))
  const effectiveSec = Number.isFinite(requested) && requested > 0
    ? Math.min(Math.max(Math.trunc(requested), 1), maxSec)
    : Math.max(1, Math.floor(defaultTimeoutMs / 1000))

  return requestJson(
    baseUrl,
    '/exec',
    secret,
    { cmd, timeoutSec: effectiveSec },
    effectiveSec * 1000 + 5000,
  )
}

export async function callFileStat(baseUrl, secret, { path, timeoutMs = 15000 } = {}) {
  if (!secret) return { ok: false, error: NO_SECRET }
  return requestJsonWith(baseUrl, '/file/stat', secret, {
    method: 'GET',
    query: { path },
    timeoutMs,
  })
}

export async function callFileList(baseUrl, secret, { path, limit, timeoutMs = 15000 } = {}) {
  if (!secret) return { ok: false, error: NO_SECRET }
  return requestJsonWith(baseUrl, '/file/list', secret, {
    method: 'GET',
    query: { path, limit },
    timeoutMs,
  })
}

export async function callFileRead(baseUrl, secret, { path, offset = 0, maxBytes, timeoutMs = 120000 } = {}) {
  if (!secret) return { ok: false, error: NO_SECRET }
  return requestJsonWith(baseUrl, '/file/read', secret, {
    method: 'GET',
    query: { path, offset, maxBytes },
    timeoutMs,
  })
}

export async function callFileWrite(baseUrl, secret, payload, { timeoutMs = 180000 } = {}) {
  if (!secret) return { ok: false, error: NO_SECRET }
  return requestJsonWith(baseUrl, '/file/write', secret, {
    method: 'POST',
    body: payload ?? {},
    timeoutMs,
  })
}

/**
 * Clamp a user supplied number into [min, max]; anything not finite falls back
 * to the default so a typo cannot turn into a zero byte chunk.
 */
function clampInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(Math.max(Math.trunc(number), min), max)
}

function describeFailure(result, fallback) {
  if (result?.error) return String(result.error)
  if (result?.reason) return `${result.reason} error`
  if (result?.httpStatus) return `HTTP ${result.httpStatus}`
  return fallback
}

async function sha256File(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

/**
 * Copy one file from the peer into a local path. The body is written to a
 * `.part` file first and only renamed into place after every chunk matches its
 * published sha256, so a failed transfer never leaves a half file behind.
 */
export async function pullFile(baseUrl, secret, {
  path,
  dest,
  overwrite = false,
  chunkBytes = 1048576,
  maxBytes = 67108864,
  onProgress,
} = {}) {
  if (!secret) return { ok: false, error: NO_SECRET }
  const remotePath = String(path || '').trim()
  if (!remotePath) return { ok: false, error: 'path is empty' }
  const destPath = String(dest || '').trim()
  if (!destPath) return { ok: false, error: 'dest is empty' }

  const chunk = clampInt(chunkBytes, 1048576)
  const limit = clampInt(maxBytes, 67108864)

  const statResult = await callFileStat(baseUrl, secret, { path: remotePath })
  if (!statResult.ok) {
    return { ok: false, error: `查询远端文件失败：${describeFailure(statResult, 'file/stat failed')}` }
  }
  if (!statResult.exists) return { ok: false, error: `远端路径不存在：${remotePath}` }
  if (statResult.type !== 'file') return { ok: false, error: `远端路径不是普通文件：${remotePath}` }
  const total = Number(statResult.size) || 0
  if (total > limit) return { ok: false, error: `远端文件过大：${total} 字节（上限 ${limit}）` }

  let destExists = false
  try {
    await fsStat(destPath)
    destExists = true
  } catch {
    destExists = false
  }
  if (destExists && !overwrite) return { ok: false, error: 'dest 已存在（overwrite:true 可覆盖）' }

  const partPath = `${destPath}.pcbridge.part`
  try {
    const handle = await open(partPath, 'w')
    try {
      let offset = 0
      let done = 0
      for (;;) {
        const response = await callFileRead(baseUrl, secret, {
          path: remotePath,
          offset,
          maxBytes: chunk,
        })
        if (!response.ok) {
          throw new Error(`读取远端文件失败：${describeFailure(response, 'file/read failed')}`)
        }
        const buffer = Buffer.from(String(response.data || ''), 'base64')
        const digest = createHash('sha256').update(buffer).digest('hex')
        if (digest !== response.sha256) throw new Error('chunk sha256 mismatch')
        if (buffer.length > 0) {
          await handle.write(buffer)
          offset += buffer.length
          done += buffer.length
          onProgress?.({ done, total })
        }
        if (response.eof) break
        if (buffer.length === 0) throw new Error('远端在 eof 之前返回了空块')
      }
      if (done !== total) {
        throw new Error(`文件大小不一致：期望 ${total} 字节，实际 ${done} 字节`)
      }
    } finally {
      await handle.close()
    }
    await rename(partPath, destPath)
    return { ok: true, path: remotePath, size: total, dest: destPath }
  } catch (error) {
    await rm(partPath, { force: true }).catch(() => {})
    return { ok: false, error: String(error?.message || error) }
  }
}

/**
 * Copy one local file to the peer. Chunks carry their own sha256 and the last
 * one carries the whole file hash, so the peer can reject a transfer that
 * arrived incomplete or corrupted.
 */
export async function pushFile(baseUrl, secret, {
  path,
  source,
  chunkBytes = 1048576,
  maxBytes = 67108864,
  onProgress,
} = {}) {
  if (!secret) return { ok: false, error: NO_SECRET }
  const remotePath = String(path || '').trim()
  if (!remotePath) return { ok: false, error: 'path is empty' }
  const sourcePath = String(source || '').trim()
  if (!sourcePath) return { ok: false, error: 'source is empty' }

  const chunk = clampInt(chunkBytes, 1048576)
  const limit = clampInt(maxBytes, 67108864)

  try {
    let info
    try {
      info = await fsStat(sourcePath)
    } catch {
      return { ok: false, error: `源文件不存在：${sourcePath}` }
    }
    if (!info.isFile()) return { ok: false, error: `源路径不是普通文件：${sourcePath}` }
    const total = info.size
    if (total > limit) return { ok: false, error: `源文件过大：${total} 字节（上限 ${limit}）` }

    const expectedSha256 = await sha256File(sourcePath)
    const uploadId = randomBytes(8).toString('hex')
    const handle = await open(sourcePath, 'r')
    try {
      const buffer = Buffer.allocUnsafe(chunk)
      let offset = 0
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, chunk, offset)
        const slice = buffer.subarray(0, bytesRead)
        const final = offset + bytesRead >= total
        const payload = {
          path: remotePath,
          uploadId,
          offset,
          data: slice.toString('base64'),
          final,
          append: false,
          createDirs: false,
          chunkSha256: createHash('sha256').update(slice).digest('hex'),
        }
        if (final) payload.expectedSha256 = expectedSha256
        const response = await callFileWrite(baseUrl, secret, payload)
        if (!response.ok) {
          return { ok: false, error: `写入远端文件失败：${describeFailure(response, 'file/write failed')}` }
        }
        offset += bytesRead
        onProgress?.({ done: offset, total })
        if (final) break
        if (bytesRead === 0) return { ok: false, error: '本地源文件在读取过程中被截断' }
      }
    } finally {
      await handle.close()
    }
    return { ok: true, path: remotePath, size: total, sha256: expectedSha256 }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
}
