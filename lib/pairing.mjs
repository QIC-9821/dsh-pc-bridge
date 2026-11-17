import { randomInt, timingSafeEqual } from 'node:crypto'

const CODE_LENGTH = 6
const DEFAULT_TTL_SEC = 300
const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_LOCKOUT_MS = 600000

/** Constant-time compare for codes; different lengths are never equal. */
function codesEqual(left, right) {
  const a = Buffer.from(String(left ?? ''), 'utf8')
  const b = Buffer.from(String(right ?? ''), 'utf8')
  if (a.length === 0 || a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function positiveInt(value, fallback) {
  const parsed = Math.floor(Number(value))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * In-memory pairing service.
 *
 * - `create()` keeps exactly one pending code, six digits with leading zeros.
 * - `verify(code, ip)` is single use: a successful verification drops the code.
 * - Wrong codes are counted per IP; the attempt that reaches `maxAttempts`
 *   already reports `locked`, and later attempts stay locked for `lockoutMs`.
 *   A lock only affects that IP, never other IPs.
 * - `remaining()` is the whole seconds left on the pending code (0 when none).
 */
export function createPairingService({
  ttlSec = DEFAULT_TTL_SEC,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  lockoutMs = DEFAULT_LOCKOUT_MS,
  now = Date.now,
} = {}) {
  const ttlMs = positiveInt(ttlSec, DEFAULT_TTL_SEC) * 1000
  const attemptsAllowed = positiveInt(maxAttempts, DEFAULT_MAX_ATTEMPTS)
  const lockMs = Math.max(0, Math.floor(Number(lockoutMs) || 0))
  const clock = typeof now === 'function' ? now : Date.now

  let pending = null
  const ipState = new Map()

  function stateFor(ip) {
    const key = String(ip ?? 'unknown')
    let state = ipState.get(key)
    if (!state) {
      state = { failures: 0, lockedUntil: 0 }
      ipState.set(key, state)
    }
    return state
  }

  function fail(state, at) {
    state.failures += 1
    if (state.failures >= attemptsAllowed) {
      state.failures = 0
      state.lockedUntil = at + lockMs
      return { ok: false, error: 'locked', retryAfterMs: state.lockedUntil - at }
    }
    return { ok: false, error: 'invalid' }
  }

  function create() {
    const code = String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0')
    pending = { code, expiresAt: clock() + ttlMs }
    return { code, expiresAt: pending.expiresAt }
  }

  function verify(code, ip) {
    const at = clock()
    const state = stateFor(ip)

    if (state.lockedUntil > at) {
      return { ok: false, error: 'locked', retryAfterMs: state.lockedUntil - at }
    }
    if (state.lockedUntil) {
      state.lockedUntil = 0
      state.failures = 0
    }

    if (!pending) {
      return fail(state, at)
    }
    if (!codesEqual(code, pending.code)) {
      return fail(state, at)
    }
    if (pending.expiresAt <= at) {
      return { ok: false, error: 'expired' }
    }

    pending = null
    state.failures = 0
    return { ok: true }
  }

  function clear() {
    pending = null
    ipState.clear()
  }

  function remaining() {
    if (!pending) return 0
    const left = pending.expiresAt - clock()
    return left > 0 ? Math.ceil(left / 1000) : 0
  }

  return { create, verify, clear, remaining }
}
