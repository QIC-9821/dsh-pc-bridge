import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
}

export async function rotateLog(file, maxBytes = 1024 * 1024) {
  try {
    const info = await stat(file)
    if (info.size > maxBytes) await rename(file, `${file}.1`)
  } catch {
    // no log yet
  }
}

export function createLogger({ dir, tag = 'pc-bridge' }) {
  const file = join(dir, 'bridge.log')
  const write = (level, message) => {
    const line = `${new Date().toISOString()} [${tag}] ${level} ${message}\n`
    try {
      if (level === 'error') console.error(line.trimEnd())
      else if (level === 'warn') console.warn(line.trimEnd())
      else console.log(line.trimEnd())
    } catch {
      // console may be unavailable in a packaged app
    }
    void appendFile(file, line).catch(() => {})
  }
  return {
    file,
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
  }
}
