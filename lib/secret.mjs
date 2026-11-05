import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Constant-time compare that also rejects empty values. */
export function secretsEqual(left, right) {
  const a = Buffer.from(String(left ?? ''))
  const b = Buffer.from(String(right ?? ''))
  if (a.length === 0 || a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Secret priority: environment variable, then secret file. Only a host role
 * creates a missing file; a client-only install must never invent a secret.
 */
export async function resolveSecret({
  envName = 'DSH_PC_BRIDGE_SECRET',
  secretFile = '',
  stateDir = '',
  create = false,
  logger,
} = {}) {
  const fromEnv = String(process.env[envName] || '').trim()
  if (fromEnv) return { secret: fromEnv, source: `env:${envName}`, created: false }

  const file = String(secretFile || (stateDir ? `${stateDir.replace(/[\\/]+$/, '')}/secret` : '')).trim()
  if (file) {
    try {
      const value = (await readFile(file, 'utf8')).trim()
      if (value) return { secret: value, source: `file:${file}`, created: false }
    } catch {
      // missing or unreadable: maybe create below
    }
    if (create) {
      const value = randomBytes(32).toString('hex')
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, `${value}\n`, { encoding: 'utf8', mode: 0o600 })
      logger?.info?.(`generated bridge secret at ${file}`)
      return { secret: value, source: `file:${file}`, created: true }
    }
  }
  return { secret: '', source: 'none', created: false }
}
