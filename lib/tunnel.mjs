import { spawn } from 'node:child_process'

export const BACKOFF_SECONDS = Object.freeze([5, 10, 30, 60])

export function buildTunnelArgs({
  sshHost,
  sshUser = '',
  sshKeyPath = '',
  remotePort = 18790,
  localPort = 18790,
  extraArgs = [],
} = {}) {
  if (!sshHost) throw new Error('sshHost is required')
  const target = sshUser ? `${sshUser}@${sshHost}` : sshHost
  const args = [
    '-N', '-T',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'BatchMode=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new',
  ]
  if (sshKeyPath) args.push('-i', String(sshKeyPath))
  for (const extra of extraArgs) args.push(String(extra))
  args.push('-R', `127.0.0.1:${remotePort}:127.0.0.1:${localPort}`, target)
  return args
}

/**
 * Keeps `ssh -N -R ...` alive. A dead tunnel is restarted with backoff; when
 * the remote sshd still holds the port ("Address already in use") the remote
 * listener is cleared with fuser first.
 */
export function createTunnelSupervisor({ cfg, logger, spawnFn = spawn } = {}) {
  let child = null
  let timer = null
  let stopped = false
  let failures = 0

  const host = () => `${cfg.sshUser ? `${cfg.sshUser}@` : ''}${cfg.sshHost}`

  function args() {
    return buildTunnelArgs({
      sshHost: cfg.sshHost,
      sshUser: cfg.sshUser,
      sshKeyPath: cfg.sshKeyPath,
      remotePort: cfg.tunnelRemotePort,
      localPort: cfg.tunnelLocalPort,
    })
  }

  function cleanupRemotePort() {
    const sshArgs = [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      '-o', 'StrictHostKeyChecking=accept-new',
    ]
    if (cfg.sshKeyPath) sshArgs.push('-i', cfg.sshKeyPath)
    sshArgs.push(host(), `fuser -k ${cfg.tunnelRemotePort}/tcp >/dev/null 2>&1 || true`)
    try {
      const helper = spawnFn('ssh', sshArgs, { windowsHide: true, stdio: 'ignore' })
      helper.unref?.()
    } catch (error) {
      logger?.warn?.(`tunnel cleanup failed: ${error?.message || error}`)
    }
  }

  function schedule() {
    const delay = BACKOFF_SECONDS[Math.min(failures, BACKOFF_SECONDS.length - 1)]
    failures += 1
    logger?.warn?.(`tunnel restart in ${delay}s`)
    timer = setTimeout(start, delay * 1000)
    timer.unref?.()
  }

  function start() {
    if (stopped) return
    if (!cfg.sshHost) {
      logger?.warn?.('tunnel enabled but sshHost is empty')
      return
    }
    let cleaned = false
    try {
      child = spawnFn('ssh', args(), {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      })
    } catch (error) {
      logger?.error?.(`tunnel spawn failed: ${error?.message || error}`)
      schedule()
      return
    }

    child.stderr?.on('data', (chunk) => {
      const line = chunk.toString('utf8').trim()
      if (!line) return
      logger?.warn?.(`tunnel: ${line}`)
      if (!cleaned && /Address already in use/i.test(line)) {
        cleaned = true
        cleanupRemotePort()
      }
    })
    child.on('error', (error) => logger?.error?.(`tunnel spawn error: ${error?.message || error}`))
    child.on('spawn', () => logger?.info?.(`tunnel up (pid ${child?.pid})`))
    child.on('exit', (code, signal) => {
      child = null
      if (stopped) return
      logger?.warn?.(`tunnel exited code=${code ?? signal}`)
      schedule()
    })
  }

  return {
    args,
    start,
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      if (child) {
        try {
          child.kill('SIGTERM')
        } catch {
          // already gone
        }
        child = null
      }
    },
  }
}
