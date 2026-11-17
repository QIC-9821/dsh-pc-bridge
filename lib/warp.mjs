import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * WARP modes that carry a full tunnel. Tailscale's control connection and
 * DERP relay lose their route inside such a tunnel, so the two products cannot
 * run their tunnels side by side on one machine.
 */
export const TUNNEL_MODES = Object.freeze(['warp', 'warp+doh', 'warp+dot', 'proxy', 'tunnel_only'])

/** The mode that keeps WARP's DNS protection but leaves the routing table alone. */
export const COEXIST_MODE = 'doh'

const DEFAULT_WINDOWS_CLI = 'C:\\Program Files\\Cloudflare\\Cloudflare WARP\\warp-cli.exe'
const MODE_ALIASES = Object.freeze({
  warp: 'warp',
  doh: 'doh',
  'warp+doh': 'warp+doh',
  dot: 'dot',
  'warp+dot': 'warp+dot',
  proxy: 'proxy',
  tunnelonly: 'tunnel_only',
  tunnel_only: 'tunnel_only',
  // `warp-cli settings` prints human-readable names, not the CLI verbs.
  dnsoverhttps: 'doh',
  dnsovertls: 'dot',
  warpproxy: 'proxy',
  warpwithdnsoverhttps: 'warp+doh',
  warpwithdnsovertls: 'warp+dot',
  warpplusdoh: 'warp+doh',
  warpplusdot: 'warp+dot',
  warptunnelonly: 'tunnel_only',
})

export function defaultWarpCli(platform = process.platform) {
  if (platform !== 'win32') return ''
  return String(process.env.WARP_CLI || '').trim() || DEFAULT_WINDOWS_CLI
}

export function normalizeWarpMode(raw) {
  const key = String(raw || '').trim().toLowerCase()
  return MODE_ALIASES[key] || key
}

/**
 * `warp-cli status` prints a "Status update:" line (sometimes more than once
 * while reconnecting); the last one is the current state.
 */
export function parseWarpStatus(text) {
  const matches = String(text || '').match(/Status update:\s*([^\r\n]+)/gi) || []
  if (matches.length === 0) return 'unknown'
  const value = matches[matches.length - 1].split(':').slice(1).join(':').trim().toLowerCase()
  if (value.startsWith('connected')) return 'connected'
  if (value.startsWith('connecting')) return 'connecting'
  if (value.startsWith('disconnected')) return 'disconnected'
  return 'unknown'
}

export function parseWarpMode(text) {
  const match = /\(([^)]*)\)\s*Mode:\s*([^\r\n]+)/i.exec(String(text || ''))
  if (!match) return ''
  return normalizeWarpMode(match[2])
}

function execResult(result) {
  const stdout = typeof result === 'string' ? result : String(result?.stdout || '')
  const stderr = typeof result === 'string' ? '' : String(result?.stderr || '')
  return `${stdout}${stderr}`
}

/**
 * Wraps `warp-cli` so the runtime (and the tests) can ask about WARP and flip
 * it out of tunnel mode without each caller re-parsing CLI text.
 */
export function createWarpClient({
  platform = process.platform,
  cli = '',
  exec = execFileAsync,
  exists = existsSync,
  timeoutMs = 15000,
} = {}) {
  const target = String(cli || '').trim() || defaultWarpCli(platform)

  async function run(args) {
    if (!target) throw new Error('当前平台没有 WARP 客户端')
    const result = await exec(target, args, {
      timeout: timeoutMs,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 256 * 1024,
    })
    return execResult(result)
  }

  async function getStatus() {
    if (!target) return { supported: false, installed: false, cli: '', state: 'unknown', mode: '', tunnel: false }
    if (!exists(target)) {
      return { supported: false, installed: false, cli: target, state: 'unknown', mode: '', tunnel: false }
    }
    try {
      const [statusText, settingsText] = await Promise.all([run(['status']), run(['settings'])])
      const mode = parseWarpMode(settingsText)
      return {
        supported: true,
        installed: true,
        cli: target,
        state: parseWarpStatus(statusText),
        mode,
        tunnel: TUNNEL_MODES.includes(mode),
      }
    } catch (error) {
      return {
        supported: true,
        installed: true,
        cli: target,
        state: 'unknown',
        mode: '',
        tunnel: false,
        error: String(error?.message || error),
      }
    }
  }

  async function setMode(mode, { connect = true } = {}) {
    const next = normalizeWarpMode(mode)
    if (!MODES.includes(next)) throw new Error(`未知的 WARP 模式：${mode}`)
    await run(['mode', next])
    if (connect) await run(['connect'])
    return getStatus()
  }

  /**
   * Switch WARP to DNS-only mode when it is running a full tunnel. Returns the
   * fresh status plus whether anything actually changed.
   */
  async function ensureCoexist() {
    const before = await getStatus()
    if (!before.installed) return { ...before, changed: false }
    if (!before.tunnel) return { ...before, changed: false }
    const after = await setMode(COEXIST_MODE)
    return { ...after, changed: true, previousMode: before.mode }
  }

  async function restoreTunnel(preferredMode = '') {
    const status = await getStatus()
    if (!status.installed) return { ...status, changed: false }
    const preferred = normalizeWarpMode(preferredMode)
    const target = TUNNEL_MODES.includes(preferred) ? preferred : 'warp'
    if (status.mode === target && status.state === 'connected') {
      return { ...status, changed: false }
    }
    const after = await setMode(target)
    return { ...after, changed: true, previousMode: status.mode }
  }

  return { cli: target, getStatus, setMode, ensureCoexist, restoreTunnel }
}

const MODES = Object.freeze(['warp', 'doh', 'warp+doh', 'dot', 'warp+dot', 'proxy', 'tunnel_only'])
