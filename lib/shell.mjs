import { existsSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

export const GIT_BASH_CANDIDATES = Object.freeze([
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
])

export function findOnPath(name, env = process.env, exists = existsSync) {
  const path = String(env.PATH || env.Path || '')
  for (const dir of path.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (exists(candidate)) return candidate
  }
  return ''
}

function kindFor(exe) {
  const lower = String(exe || '').toLowerCase()
  if (lower.includes('powershell') || lower === 'pwsh') return 'powershell'
  if (lower.endsWith('bash') || lower.endsWith('bash.exe')) return 'bash'
  if (lower.endsWith('sh') || lower.endsWith('sh.exe')) return 'sh'
  return 'custom'
}

function defaultArgsFor(exe) {
  const kind = kindFor(exe)
  if (kind === 'powershell') return ['-NoProfile', '-NonInteractive', '-Command']
  if (kind === 'sh') return ['-c']
  return ['-lc']
}

/**
 * Pick an executable + argv prefix that turns a command string into argv.
 * Windows prefers Git Bash when present (a real POSIX shell), then PowerShell.
 * The existence check is repeated before every execution in exec.mjs, because
 * a shell can disappear from under a long-running process.
 */
export function resolveShell({
  platform = process.platform,
  shellPath = '',
  shellArgs = null,
  env = process.env,
  exists = existsSync,
} = {}) {
  if (shellPath) {
    return {
      exe: shellPath,
      args: Array.isArray(shellArgs) && shellArgs.length > 0 ? shellArgs.map(String) : defaultArgsFor(shellPath),
      kind: kindFor(shellPath),
    }
  }

  if (platform === 'win32') {
    const bash = [...GIT_BASH_CANDIDATES, findOnPath('bash.exe', env, exists)].find(
      (candidate) => candidate && exists(candidate),
    )
    if (bash) return { exe: bash, args: ['-lc'], kind: 'bash' }
    return { exe: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command'], kind: 'powershell' }
  }

  if (exists('/bin/bash')) return { exe: '/bin/bash', args: ['-lc'], kind: 'bash' }
  if (exists('/bin/sh')) return { exe: '/bin/sh', args: ['-c'], kind: 'sh' }
  return { exe: 'bash', args: ['-lc'], kind: 'bash' }
}

export function isShellAvailable(shell, { exists = existsSync } = {}) {
  if (!shell?.exe) return false
  return isAbsolute(shell.exe) ? exists(shell.exe) : true
}

export function shellInvocation(shell, command) {
  return { exe: shell.exe, args: [...(shell.args || []), String(command)] }
}
