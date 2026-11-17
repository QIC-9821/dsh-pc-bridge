import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const DEFAULT_WINDOWS_CLI = 'C:\\Program Files\\Tailscale\\tailscale.exe'

export function defaultTailscaleCli(platform = process.platform) {
  if (platform !== 'win32') return 'tailscale'
  return String(process.env.TAILSCALE_CLI || '').trim() || DEFAULT_WINDOWS_CLI
}

function pickAddress(self) {
  const list = Array.isArray(self?.TailscaleIPs) ? self.TailscaleIPs : []
  const v4 = list.find((ip) => typeof ip === 'string' && ip.includes('.'))
  if (v4) return v4
  return list.length > 0 ? String(list[0]) : ''
}

/**
 * Parse `tailscale status --json`. Kept separate so it can be tested without a
 * tailnet, and so a version that adds fields only degrades gracefully.
 */
export function parseTailscaleStatus(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json
  const self = data?.Self || {}
  const peers = data?.Peer && typeof data.Peer === 'object' ? Object.keys(data.Peer).length : 0
  return {
    backendState: String(data?.BackendState || self.BackendState || 'Unknown'),
    online: Boolean(self.Online),
    ipv4: pickAddress(self),
    dnsName: String(self.DNSName || '').replace(/\.$/, ''),
    hostName: String(self.HostName || ''),
    peers,
    magicDns: String(data?.MagicDNSSuffix || ''),
  }
}

export function createTailscaleClient({
  platform = process.platform,
  cli = '',
  exec = execFileAsync,
  exists = existsSync,
  timeoutMs = 8000,
} = {}) {
  const target = String(cli || '').trim() || defaultTailscaleCli(platform)

  async function run(args) {
    const result = await exec(target, args, {
      timeout: timeoutMs,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    })
    const stdout = typeof result === 'string' ? result : String(result?.stdout || '')
    return stdout
  }

  async function getStatus() {
    if (platform === 'win32' && !exists(target)) {
      return { supported: true, installed: false, cli: target, backendState: 'NotInstalled', online: false, ipv4: '', dnsName: '', hostName: '', peers: 0, magicDns: '' }
    }
    try {
      const text = await run(['status', '--json'])
      return { supported: true, installed: true, cli: target, ...parseTailscaleStatus(text) }
    } catch (error) {
      const code = String(error?.code || '')
      if (code === 'ENOENT') {
        return { supported: true, installed: false, cli: target, backendState: 'NotInstalled', online: false, ipv4: '', dnsName: '', hostName: '', peers: 0, magicDns: '' }
      }
      return {
        supported: true,
        installed: true,
        cli: target,
        backendState: 'Unknown',
        online: false,
        ipv4: '',
        dnsName: '',
        hostName: '',
        peers: 0,
        magicDns: '',
        error: String(error?.message || error),
      }
    }
  }

  return { cli: target, getStatus }
}
