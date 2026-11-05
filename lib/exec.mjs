import { spawn } from 'node:child_process'

import { isShellAvailable, resolveShell, shellInvocation } from './shell.mjs'

function killTree(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      return
    } catch {
      // fall through
    }
  }
  try {
    child.kill('SIGTERM')
  } catch {
    // already gone
  }
}

/**
 * Run one command through a shell, bounded by time and output size.
 * A cached shell whose executable vanished is re-resolved once before failing.
 */
export function runShellCommand(command, {
  shell,
  cwd,
  timeoutMs = 30000,
  maxBytes = 2 * 1024 * 1024,
  env,
  resolve = resolveShell,
} = {}) {
  return new Promise((resolvePromise) => {
    const started = Date.now()
    let activeShell = shell
    if (!activeShell || !isShellAvailable(activeShell)) {
      activeShell = resolve({ shellPath: activeShell?.exe || '' })
    }
    if (!activeShell?.exe) {
      resolvePromise({
        ok: false,
        exitCode: -1,
        stdout: '',
        stderr: 'no shell available',
        durationMs: 0,
        timedOut: false,
        truncated: false,
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let settled = false
    let timer = null

    const finish = (code, signal, errorMessage = '') => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      const finalCode = Number.isInteger(code) ? code : -1
      resolvePromise({
        ok: !timedOut && finalCode === 0,
        exitCode: finalCode,
        signal: signal || null,
        stdout,
        stderr: errorMessage && !stderr ? errorMessage : stderr,
        durationMs: Date.now() - started,
        timedOut,
        truncated,
      })
    }

    const { exe, args } = shellInvocation(activeShell, command)
    let child
    try {
      child = spawn(exe, args, {
        cwd,
        env: { ...process.env, ...(env || {}) },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish(-1, null, String(error?.message || error))
      return
    }

    const take = (chunk, which) => {
      const text = chunk.toString('utf8')
      if (which === 'out') {
        const room = maxBytes - stdout.length
        if (room <= 0) {
          truncated = true
          return
        }
        stdout += room >= text.length ? text : text.slice(0, room)
        if (room < text.length) truncated = true
        return
      }
      const room = maxBytes - stderr.length
      if (room > 0) stderr += room >= text.length ? text : text.slice(0, room)
    }

    child.stdout?.on('data', (chunk) => take(chunk, 'out'))
    child.stderr?.on('data', (chunk) => take(chunk, 'err'))
    child.on('error', (error) => finish(-1, null, String(error?.message || error)))
    child.on('close', (code, signal) => finish(code, signal))

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        killTree(child)
      }, Math.max(250, timeoutMs))
      timer.unref?.()
    }
  })
}
