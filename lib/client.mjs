export function normalizeBaseUrl(url) {
  return String(url || 'http://127.0.0.1:18790').replace(/\/+$/, '')
}

/**
 * One JSON request. Network failures are returned as objects (never thrown) so
 * a tool call can explain what went wrong instead of surfacing a stack trace.
 */
export async function requestJson(baseUrl, path, secret, body = {}, timeoutMs = 30000) {
  const target = `${normalizeBaseUrl(baseUrl)}${path}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs))
  try {
    const response = await fetch(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pc-secret': String(secret || ''),
        accept: 'application/json',
      },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    })
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

export async function callPing(baseUrl, secret, { timeoutMs = 8000 } = {}) {
  if (!secret) return { ok: false, error: 'bridge secret is not configured (secretEnv or secretFile)' }
  return requestJson(baseUrl, '/ping', secret, {}, timeoutMs)
}

export async function callExec(baseUrl, secret, { command, timeoutSec } = {}, {
  defaultTimeoutMs = 30000,
  maxTimeoutMs = 600000,
} = {}) {
  if (!secret) return { ok: false, error: 'bridge secret is not configured (secretEnv or secretFile)' }
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
