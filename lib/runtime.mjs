import { createHash, randomBytes } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, hostname, networkInterfaces } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { callPing } from './client.mjs'
import { normalizeConfig } from './config.mjs'
import { resolveSecret } from './secret.mjs'
import { createBridgeServer } from './server.mjs'
import {
  mergeConfig,
  normalizePairings,
  normalizeSettings,
  readSettings,
  settingsPath,
  writeSettings,
} from './settings.mjs'
import { resolveShell } from './shell.mjs'
import { createLogger, ensureDir, rotateLog } from './state.mjs'
import { pcToolSpecs } from './tool.mjs'
import { createTunnelSupervisor } from './tunnel.mjs'

const AUDIT_MAX_BYTES = 1024 * 1024
const PAIR_TIMEOUT_MS = 5000
const PEER_PING_TIMEOUT_MS = 3000

// pairing.mjs and discovery.mjs are separate deliverables in the same release
// window; loading them lazily keeps the runtime usable (and testable) while
// they are still landing on disk.
let pairingModule
let discoveryModule

async function loadPairing(logger) {
  if (pairingModule !== undefined) return pairingModule
  try {
    pairingModule = await import('./pairing.mjs')
  } catch (error) {
    logger?.warn?.(`pairing module unavailable: ${error?.message || error}`)
    pairingModule = null
  }
  return pairingModule
}

async function loadDiscovery(logger) {
  if (discoveryModule !== undefined) return discoveryModule
  try {
    discoveryModule = await import('./discovery.mjs')
  } catch (error) {
    logger?.warn?.(`discovery module unavailable: ${error?.message || error}`)
    discoveryModule = null
  }
  return discoveryModule
}

function fingerprint(secret) {
  if (!secret) return ''
  return createHash('sha256').update(String(secret)).digest('hex').slice(0, 8)
}

function errorText(error) {
  return String(error?.message || error)
}

function formatList(addresses) {
  const out = []
  for (const [iface, entries] of Object.entries(addresses || {})) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' && entry.family !== 4) continue
      out.push({ iface, address: entry.address, family: 'IPv4', internal: Boolean(entry.internal) })
    }
  }
  out.sort((left, right) => Number(left.internal) - Number(right.internal))
  return out.map(({ iface, address, family }) => ({ iface, address, family }))
}

function normalizePeerUrl(url) {
  const text = String(url || '').trim()
  if (!text) throw new Error('没有配置对端地址')
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    throw new Error('对端地址必须是 http(s) 绝对地址')
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) {
    throw new Error('对端地址必须是 http(s) 绝对地址')
  }
  return parsed.toString().replace(/\/+$/, '')
}

function expandHomePath(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return text
}

/**
 * Settings store secretFile as the user typed it ('' means "the default
 * location"), so resolve it the same way normalizeConfig does before comparing.
 */
function resolveSecretFile(value, stateDir) {
  const text = expandHomePath(value)
  if (!text) return stateDir ? join(stateDir, 'secret') : ''
  return isAbsolute(text) ? resolve(text) : resolve(stateDir, text)
}

/**
 * Classify how a bridge is reachable: the local machine, a Tailscale tailnet,
 * the same LAN, or something routed by hand.
 */
export function describeTransport(addressOrUrl) {
  let text = String(addressOrUrl ?? '').trim()
  if (!text) return 'custom'
  let host = text
  try {
    host = new URL(text.includes('://') ? text : `http://${text}`).hostname
  } catch {
    // Not a URL at all (bare IPv6 such as ::1): fall back to the host part.
    host = text.split('/')[0]
  }
  host = host.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '')
  if (host.startsWith('::ffff:')) host = host.slice(7)
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') {
    return 'local'
  }
  if (host.endsWith('.ts.net')) return 'tailscale'
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const first = Number(v4[1])
    const second = Number(v4[2])
    if (first === 100 && second >= 64 && second <= 127) return 'tailscale'
    if (first === 10) return 'lan'
    if (first === 172 && second >= 16 && second <= 31) return 'lan'
    if (first === 192 && second === 168) return 'lan'
    return 'custom'
  }
  if (host.endsWith('.local')) return 'lan'
  return 'custom'
}

/**
 * Owns every long-lived piece of the bridge: secret, shell, HTTP server,
 * discovery responder, tunnel, tool registration and the audit log. The host
 * plugin only creates it, starts it and tears it down; a settings page drives
 * it through status/applyPatch/pair/rotate calls.
 */
export function createBridgeRuntime({
  ctx,
  config = {},
  env = process.env,
  version = '',
  logger: givenLogger,
} = {}) {
  let logger = givenLogger || null
  let cfg = null
  let state = 'stopped'
  let startedAt = null
  let startedAtMs = 0
  let lastError = null
  let server = null
  let actualPort = 0
  let tunnel = null
  let discovery = null
  let pairing = null
  let secret = ''
  let secretSource = 'none'
  let shell = null
  let toolDisposers = []
  let registered = []
  let auditPath = ''
  let running = false
  let connected = null
  let lastPeerCheckAt = null
  let peerCheckGeneration = 0

  async function loadConfig() {
    const settings = await readSettings(env)
    cfg = normalizeConfig(mergeConfig(config, settings), env)
    auditPath = join(cfg.stateDir, 'audit.jsonl')
    if (!logger) logger = createLogger({ dir: cfg.stateDir, tag: 'pc-bridge' })
    return cfg
  }

  async function recordAudit(entry = {}) {
    if (!auditPath) return
    try {
      await rotateAudit()
      const line = `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`
      await appendFile(auditPath, line, 'utf8')
    } catch (error) {
      logger?.warn?.(`audit write failed: ${errorText(error)}`)
    }
  }

  async function rotateAudit() {
    if (!cfg) return
    let info
    try {
      info = await stat(auditPath)
    } catch {
      return
    }
    if (info.size <= AUDIT_MAX_BYTES) return
    const keep = Math.max(1, cfg.auditKeep)
    for (let i = keep - 1; i >= 1; i -= 1) {
      const from = `${auditPath}.${i}`
      const to = `${auditPath}.${i + 1}`
      try {
        await rm(to, { force: true })
        await rename(from, to)
      } catch {
        // a missing generation is fine
      }
    }
    try {
      await rm(`${auditPath}.1`, { force: true })
      await rename(auditPath, `${auditPath}.1`)
    } catch {
      // keep appending to the oversized file rather than lose entries
    }
  }

  async function auditTail(limit = 20) {
    if (!auditPath) return []
    let text = ''
    try {
      text = await readFile(auditPath, 'utf8')
    } catch {
      return []
    }
    const requested = Math.trunc(Number(limit))
    const want = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 500) : 20
    const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
    const out = []
    for (let i = lines.length - 1; i >= 0 && out.length < want; i -= 1) {
      try {
        out.push(JSON.parse(lines[i]))
      } catch {
        // skip a torn or hand-edited line
      }
    }
    return out
  }

  function unregisterTools() {
    while (toolDisposers.length > 0) {
      const disposer = toolDisposers.pop()
      try {
        disposer?.()
      } catch {
        // a host may already have dropped the tool
      }
    }
    registered = []
  }

  function registerTools() {
    unregisterTools()
    if (!cfg || cfg.enabled === false) return
    const mode = cfg.toolsMode
    const wanted = mode === 'always'
      || (mode === 'auto' && (Boolean(cfg.peerUrl) || cfg.remoteMode !== 'off'))
    if (!wanted) return
    const register = ctx?.tools?.register
    if (typeof register !== 'function') return
    const baseUrl = cfg.peerUrl || `http://127.0.0.1:${actualPort || cfg.listenPort}`
    const specs = pcToolSpecs({
      baseUrl,
      secret,
      defaultTimeoutMs: cfg.defaultTimeoutMs,
      maxTimeoutMs: cfg.maxTimeoutMs,
    })
    for (const spec of specs) {
      try {
        const disposer = register.call(ctx.tools, spec)
        toolDisposers.push(disposer)
        registered.push(spec.name)
      } catch (error) {
        logger?.warn?.(`tool registration failed for ${spec.name}: ${errorText(error)}`)
      }
    }
  }

  function noteError(prefix, error) {
    lastError = `${prefix}: ${errorText(error)}`
    logger?.error?.(lastError)
  }

  function withStatus(error, statusCode) {
    error.statusCode = statusCode
    return error
  }

  /**
   * One background health probe, fired from a successful start. The generation
   * counter makes a late answer from a previous listen socket harmless.
   */
  async function checkPeer(generation) {
    const target = cfg?.peerUrl || ''
    if (!target || !secret) {
      if (generation === peerCheckGeneration) connected = null
      return
    }
    let ok = false
    try {
      const result = await callPing(target, secret, { timeoutMs: PEER_PING_TIMEOUT_MS })
      ok = Boolean(result?.ok)
    } catch {
      ok = false
    }
    if (generation !== peerCheckGeneration) return
    connected = ok
    lastPeerCheckAt = new Date().toISOString()
  }

  function schedulePeerCheck() {
    peerCheckGeneration += 1
    if (state !== 'running' || cfg?.enabled === false || !cfg?.peerUrl) return
    const generation = peerCheckGeneration
    void checkPeer(generation)
  }

  async function handlePair({ code, ip, name, platform } = {}) {
    if (!pairing) throw withStatus(new Error('配对服务未开启'), 503)
    const verdict = pairing.verify(code, ip)
    if (!verdict?.ok) {
      if (verdict?.error === 'locked') throw withStatus(new Error('尝试次数过多，请稍后再试'), 429)
      if (verdict?.error === 'expired' || verdict?.reason === 'expired') {
        throw withStatus(new Error('配对码已过期'), 401)
      }
      throw withStatus(new Error('配对码不正确'), 401)
    }
    await recordAudit({ kind: 'pair', action: 'accept', ip, ok: true })
    // Remember who paired with us, newest first, de-duplicated by address.
    try {
      if (cfg) {
        const next = normalizePairings([
          {
            name: name ?? '',
            platform: platform ?? '',
            address: ip,
            transport: describeTransport(ip),
            pairedAt: new Date().toISOString(),
          },
          ...(Array.isArray(cfg.pairings) ? cfg.pairings : []),
        ])
        await writeSettings({ pairings: next }, env)
        cfg = Object.freeze({ ...cfg, pairings: next })
      }
    } catch (error) {
      // A history write must not fail a successful pairing.
      logger?.warn?.(`pairing history not saved: ${errorText(error)}`)
    }
    return { ok: true, secret }
  }

  function handleExec(entry = {}) {
    return recordAudit({
      kind: 'exec',
      ip: entry.ip,
      command: entry.command,
      ok: entry.result?.ok,
      exitCode: entry.result?.exitCode,
      ms: entry.ms,
    })
  }

  async function doStart() {
    if (running) return
    running = true
    lastError = null
    try {
      await loadConfig()
      await ensureDir(cfg.stateDir).catch(() => {})

      if (cfg.enabled === false) {
        // Switch off: keep the plugin (and its settings page) alive, but do
        // not touch the secret, the listen socket, discovery or the tools.
        state = 'disabled'
        connected = null
        peerCheckGeneration += 1
        await recordAudit({ kind: 'start', disabled: true })
        logger?.info?.('disabled in settings; bridge not started')
        return
      }

      await rotateLog(join(cfg.stateDir, 'bridge.log')).catch(() => {})

      const fromEnv = String(env?.[cfg.secretEnv] ?? process.env[cfg.secretEnv] ?? '').trim()
      const resolved = cfg.secret
        ? { secret: cfg.secret, source: 'config' }
        : fromEnv
          ? { secret: fromEnv, source: `env:${cfg.secretEnv}` }
          : await resolveSecret({
            envName: cfg.secretEnv,
            secretFile: cfg.secretFile,
            stateDir: cfg.stateDir,
            create: cfg.role !== 'client',
            logger,
          })
      secret = resolved.secret
      secretSource = resolved.source

      shell = resolveShell({ shellPath: cfg.shellPath })

      const pairingMod = await loadPairing(logger)
      pairing = null
      if (typeof pairingMod?.createPairingService === 'function') {
        try {
          pairing = pairingMod.createPairingService({ ttlSec: cfg.pairTtlSec })
        } catch (error) {
          logger?.warn?.(`pairing service unavailable: ${errorText(error)}`)
        }
      }

      server = null
      actualPort = 0
      if (cfg.role !== 'client') {
        try {
          server = createBridgeServer({
            secret,
            shell,
            listenHost: cfg.listenHost,
            listenPort: cfg.listenPort,
            defaultTimeoutMs: cfg.defaultTimeoutMs,
            maxTimeoutMs: cfg.maxTimeoutMs,
            maxOutputBytes: cfg.maxOutputBytes,
            cwd: cfg.cwd,
            version,
            onPair: handlePair,
            onExec: handleExec,
            logger,
          })
          const address = await server.start()
          actualPort = typeof address?.port === 'number' ? address.port : cfg.listenPort
          logger?.info?.(`listening on ${cfg.listenHost}:${actualPort}`)
        } catch (error) {
          server = null
          noteError('listen failed', error)
        }
      }

      discovery = null
      if (cfg.discoveryEnabled && cfg.role !== 'client') {
        const discoveryMod = await loadDiscovery(logger)
        if (typeof discoveryMod?.createDiscoveryResponder !== 'function') {
          logger?.warn?.('discovery enabled but lib/discovery.mjs is unavailable')
        } else {
          try {
            discovery = discoveryMod.createDiscoveryResponder({
              port: cfg.discoveryPort,
              logger,
              info: {
                name: hostname(),
                port: actualPort || cfg.listenPort,
                platform: process.platform,
                version,
              },
            })
            await discovery.start()
            logger?.info?.(`discovery responder on udp ${cfg.discoveryPort}`)
          } catch (error) {
            discovery = null
            logger?.warn?.(`discovery failed: ${errorText(error)}`)
          }
        }
      }

      tunnel = null
      if (cfg.tunnelEnabled) {
        try {
          tunnel = createTunnelSupervisor({ cfg, logger })
          tunnel.start()
        } catch (error) {
          tunnel = null
          noteError('tunnel failed', error)
        }
      }

      registerTools()
      state = cfg.role === 'client' || server ? 'running' : 'error'
      startedAtMs = Date.now()
      startedAt = new Date(startedAtMs).toISOString()
      logger?.info?.(`started role=${cfg.role} port=${actualPort || cfg.listenPort} tools=${cfg.toolsMode}`)
      // Never block start() on the peer: a slow LAN must not delay the host.
      schedulePeerCheck()
    } catch (error) {
      state = 'error'
      noteError('start failed', error)
    } finally {
      running = false
    }
  }

  async function doStop() {
    unregisterTools()
    try {
      tunnel?.stop()
    } catch {
      // ignore a tunnel that is already gone
    }
    tunnel = null
    try {
      await discovery?.stop?.()
    } catch {
      // ignore a responder that is already gone
    }
    discovery = null
    try {
      if (server) await server.close()
    } catch {
      // close() on an unstarted server is a no-op
    }
    server = null
    actualPort = 0
    state = 'stopped'
    startedAt = null
    startedAtMs = 0
    connected = null
    peerCheckGeneration += 1
  }

  async function start() {
    await doStart()
    // A disabled start is already recorded by doStart().
    if (state !== 'disabled') {
      await recordAudit({ kind: 'start', role: cfg?.role, port: actualPort || cfg?.listenPort, state })
    }
    return status()
  }

  async function stop() {
    await recordAudit({ kind: 'stop' })
    await doStop()
    return status()
  }

  async function restart() {
    await recordAudit({ kind: 'restart' })
    await doStop()
    await doStart()
    if (state !== 'disabled') {
      await recordAudit({ kind: 'start', role: cfg?.role, port: actualPort || cfg?.listenPort, state })
    }
    return status()
  }

  function addresses() {
    try {
      return formatList(networkInterfaces())
    } catch {
      return []
    }
  }

  function status() {
    const port = actualPort || cfg?.listenPort || 0
    return {
      state,
      version,
      startedAt,
      uptimeSec: startedAtMs ? Math.max(0, Math.round((Date.now() - startedAtMs) / 1000)) : 0,
      pid: process.pid,
      listen: { host: cfg?.listenHost || '127.0.0.1', port },
      addresses: addresses(),
      role: cfg?.role || 'both',
      enabled: cfg ? cfg.enabled !== false : true,
      peerUrl: cfg?.peerUrl || '',
      peer: {
        url: cfg?.peerUrl || '',
        name: cfg?.peerName || '',
        platform: cfg?.peerPlatform || '',
        transport: cfg?.peerTransport || '',
        pairedAt: cfg?.peerPairedAt || '',
      },
      pairingsCount: Array.isArray(cfg?.pairings) ? cfg.pairings.length : 0,
      connected,
      lastPeerCheckAt,
      toolsMode: cfg?.toolsMode || 'auto',
      tools: { mode: cfg?.toolsMode || 'auto', registered: [...registered] },
      secret: { source: secretSource, fingerprint: fingerprint(secret) },
      shell: { exe: shell?.exe || '', kind: shell?.kind || 'unknown' },
      discovery: {
        enabled: Boolean(cfg?.discoveryEnabled),
        port: discovery?.port || cfg?.discoveryPort || 0,
        running: Boolean(discovery),
      },
      tunnel: { enabled: Boolean(cfg?.tunnelEnabled), running: Boolean(tunnel) },
      lastError,
    }
  }

  function getConfig() {
    // The effective secret lives outside the normalized config (it comes from
    // the environment or the secret file), but internal callers still need it.
    return { ...(cfg || {}), secret }
  }

  function publicConfig() {
    const base = { ...(cfg || {}) }
    delete base.secret
    return {
      ...base,
      peer: {
        url: cfg?.peerUrl || '',
        name: cfg?.peerName || '',
        platform: cfg?.peerPlatform || '',
        transport: cfg?.peerTransport || '',
        pairedAt: cfg?.peerPairedAt || '',
      },
      secretSource,
      secretFingerprint: fingerprint(secret),
      settingsPath: cfg ? settingsPath(env) : '',
    }
  }

  /** True when the user asked dispose() to wipe local data on uninstall. */
  function isPurgeOnUninstall() {
    return cfg ? cfg.purgeOnUninstall === true : false
  }

  async function moveSecretFile(target, extraPatch = {}) {
    if (!String(secretSource).startsWith('file:')) {
      throw withStatus(
        new Error('当前密钥来自插件配置或环境变量，无法迁移密钥文件；请先清空 secret/secretEnv'),
        409,
      )
    }
    if (!cfg) await loadConfig()
    const oldPath = cfg.secretFile
    if (!target) throw withStatus(new Error('secretFile 不能为空'), 400)
    if (target === oldPath) {
      return { ok: true, moved: false, from: oldPath, to: target, warnings: [] }
    }
    let content = ''
    try {
      content = await readFile(oldPath, 'utf8')
    } catch {
      // The secret may not exist yet (first start never wrote it): mint one.
    }
    if (!content.trim()) content = `${randomBytes(32).toString('hex')}\n`
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, { encoding: 'utf8', mode: 0o600 })
    const verify = await readFile(target, 'utf8')
    if (verify !== content) throw withStatus(new Error('新密钥文件写入校验失败'), 500)
    await writeSettings({ ...extraPatch, secretFile: target }, env)
    await recordAudit({ kind: 'secret', action: 'migrate', from: oldPath, to: target, ok: true })
    const nextStatus = await restart()
    const warnings = []
    try {
      await rm(oldPath, { force: true })
    } catch (error) {
      // Windows may hold the old file briefly; a stale secret is harmless
      // once settings point at the new one, so never fail the migration.
      warnings.push(`旧密钥文件删除失败：${errorText(error)}`)
    }
    return { ok: true, moved: true, from: oldPath, to: target, warnings, status: nextStatus }
  }

  /**
   * Migrate the live secret to a new file path. Only meaningful when the
   * secret actually comes from a file; config/env secrets are read-only.
   */
  async function migrateSecret(nextSecretFile, extraPatch = {}) {
    if (!cfg) await loadConfig()
    const target = resolveSecretFile(nextSecretFile, cfg?.stateDir || '')
    return moveSecretFile(target, extraPatch)
  }

  async function applyPatch(patch) {
    const normalized = normalizeSettings(patch)
    if (!cfg) await loadConfig()
    const hasSecretFile = Object.prototype.hasOwnProperty.call(normalized, 'secretFile')
    const warnings = []
    if (hasSecretFile) {
      const target = resolveSecretFile(normalized.secretFile, cfg?.stateDir || '')
      if (cfg && target !== cfg.secretFile) {
        // Migrate and write the remaining patch fields in a single settings
        // write, then restart once.
        const { secretFile: _ignored, ...rest } = normalized
        const migrated = await migrateSecret(target, rest)
        warnings.push(...(migrated.warnings || []))
        return { status: migrated.status || status(), warnings }
      }
    }
    await writeSettings(normalized, env)
    await recordAudit({ kind: 'config', keys: Object.keys(normalized) })
    return { status: await restart(), warnings }
  }

  async function setEnabled(value) {
    if (typeof value !== 'boolean') throw withStatus(new Error('enabled 必须是布尔值'), 400)
    await writeSettings({ enabled: value }, env)
    await recordAudit({ kind: 'config', keys: ['enabled'], enabled: value })
    if (value) return restart()
    await doStop()
    // Re-read so status() reports enabled=false and the latest settings.
    await loadConfig().catch(() => {})
    state = 'disabled'
    return status()
  }

  async function clearPair() {
    await writeSettings(
      { peerUrl: '', peerName: '', peerPlatform: '', peerTransport: '', peerPairedAt: '', peerFingerprint: '' },
      env,
    )
    await recordAudit({ kind: 'pair', action: 'cleared', ok: true })
    return restart()
  }

  function createPairCode() {
    if (!pairing) throw withStatus(new Error('配对服务未开启'), 503)
    return pairing.create()
  }

  async function acceptPair({ url, code } = {}) {
    let base
    try {
      base = normalizePeerUrl(url)
    } catch (error) {
      throw withStatus(error, 400)
    }
    if (!cfg) await loadConfig()
    if (secretSource === 'config' || String(secretSource).startsWith('env:')) {
      throw withStatus(
        new Error('当前密钥来自插件配置或环境变量，配对写入的文件不会生效；请先清空 secret/secretEnv'),
        409,
      )
    }
    const body = JSON.stringify({
      code: String(code ?? '').trim(),
      name: hostname(),
      platform: process.platform,
    })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PAIR_TIMEOUT_MS)
    timer.unref?.()
    let response
    let data = null
    try {
      response = await fetch(`${base}/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body,
        signal: controller.signal,
      })
      const text = await response.text()
      try {
        data = JSON.parse(text)
      } catch {
        data = null
      }
    } catch (error) {
      const aborted = error?.name === 'AbortError'
      throw withStatus(
        new Error(aborted ? '连接对端超时' : `无法连接对端：${errorText(error)}`),
        aborted ? 504 : 502,
      )
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok || !data?.ok || !data?.secret) {
      const status = response.status === 401 ? 401 : 502
      throw withStatus(
        new Error(data?.error ? String(data.error) : `配对失败（HTTP ${response.status}）`),
        status,
      )
    }
    const nextSecret = String(data.secret).trim()
    await mkdir(dirname(cfg.secretFile), { recursive: true })
    await writeFile(cfg.secretFile, `${nextSecret}\n`, { encoding: 'utf8', mode: 0o600 })
    // Remember the peer in one settings write so restart() only runs once.
    await writeSettings(
      {
        peerUrl: base,
        peerName: String(data.name ?? data.host ?? '').trim(),
        peerPlatform: String(data.platform ?? '').trim(),
        peerTransport: describeTransport(base),
        peerPairedAt: new Date().toISOString(),
        peerFingerprint: fingerprint(nextSecret),
      },
      env,
    )
    await recordAudit({ kind: 'pair', action: 'accepted', url: base, ok: true })
    await restart()
    return {
      ok: true,
      secret: nextSecret,
      peer: { url: base, host: data.host ?? '', port: data.port ?? 0 },
    }
  }

  async function testPeer(url) {
    const raw = String(url || cfg?.peerUrl || '').trim()
    if (!raw) return { ok: false, error: '没有配置对端地址' }
    let target
    try {
      target = normalizePeerUrl(raw)
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
    return callPing(target, secret)
  }

  async function discover() {
    const discoveryMod = await loadDiscovery(logger)
    if (typeof discoveryMod?.scanPeers !== 'function') return []
    return discoveryMod.scanPeers({ port: cfg?.discoveryPort || 18791, logger })
  }

  async function rotateSecret() {
    if (secretSource === 'config' || String(secretSource).startsWith('env:')) {
      throw withStatus(
        new Error('当前密钥来自插件配置或环境变量，无法重置；请先清空 secret/secretEnv'),
        409,
      )
    }
    if (!cfg) await loadConfig()
    const next = randomBytes(32).toString('hex')
    await mkdir(dirname(cfg.secretFile), { recursive: true })
    await writeFile(cfg.secretFile, `${next}\n`, { encoding: 'utf8', mode: 0o600 })
    await recordAudit({ kind: 'secret', action: 'rotate', ok: true })
    await restart()
    return status()
  }

  /**
   * Delete the local data this plugin owns: the secret file, settings.json,
   * every audit generation and the log. The directory itself stays.
   */
  async function cleanup() {
    await doStop()
    if (!cfg) await loadConfig()
    const removed = []
    const failed = []
    const targets = []
    if (cfg && String(secretSource).startsWith('file:')) {
      targets.push({ label: 'secret', path: cfg.secretFile })
    }
    const stateDir = cfg?.stateDir || ''
    if (stateDir) {
      targets.push({ label: 'settings.json', path: join(stateDir, 'settings.json') })
      let entries = []
      try {
        entries = await readdir(stateDir)
      } catch (error) {
        if (error?.code !== 'ENOENT') failed.push(`${stateDir}: ${errorText(error)}`)
      }
      for (const entry of entries) {
        if (entry === 'audit.jsonl' || entry.startsWith('audit.jsonl.')) {
          targets.push({ label: entry, path: join(stateDir, entry) })
        } else if (entry === 'bridge.log' || entry.startsWith('bridge.log.')) {
          targets.push({ label: entry, path: join(stateDir, entry) })
        }
      }
    }
    for (const target of targets) {
      try {
        await rm(target.path, { force: true })
        removed.push(target.label)
      } catch (error) {
        failed.push(`${target.label}: ${errorText(error)}`)
      }
    }
    secret = ''
    secretSource = 'none'
    auditPath = ''
    state = 'stopped'
    return { removed, failed }
  }

  return {
    start,
    stop,
    restart,
    status,
    getConfig,
    publicConfig,
    applyPatch,
    setEnabled,
    clearPair,
    cleanup,
    isPurgeOnUninstall,
    migrateSecret,
    recordAudit,
    auditTail,
    createPairCode,
    acceptPair,
    testPeer,
    discover,
    rotateSecret,
    get config() {
      return getConfig()
    },
    get registered() {
      return [...registered]
    },
  }
}
