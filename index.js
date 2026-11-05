import { join } from 'node:path'

import { normalizeConfig } from './lib/config.mjs'
import { createBridgeServer } from './lib/server.mjs'
import { resolveSecret } from './lib/secret.mjs'
import { resolveShell } from './lib/shell.mjs'
import { createLogger, ensureDir, rotateLog } from './lib/state.mjs'
import { pcToolSpecs } from './lib/tool.mjs'
import { createTunnelSupervisor } from './lib/tunnel.mjs'

export const name = 'dsh-pc-bridge'

let z = null
try {
  const mod = await import('@deepseek-ai/schemastery')
  z = mod?.default ?? mod ?? null
} catch {
  z = null
}

const field = (schema) => (typeof schema?.extra === 'function' ? schema.extra('volatile', true) : schema)

export const Config = z
  ? z.object({
      role: field(z.string().default('both')),
      listenHost: field(z.string().default('127.0.0.1')),
      listenPort: field(z.natural().default(18790)),
      secretFile: field(z.string().default('')),
      secretEnv: field(z.string().default('DSH_PC_BRIDGE_SECRET')),
      peerUrl: field(z.string().default('')),
      defaultTimeoutMs: field(z.natural().default(30000)),
      maxTimeoutMs: field(z.natural().default(600000)),
      maxOutputBytes: field(z.natural().default(2097152)),
      shellPath: field(z.string().default('')),
      cwd: field(z.string().default('')),
      tunnelEnabled: field(z.boolean().default(false)),
      sshHost: field(z.string().default('')),
      sshUser: field(z.string().default('')),
      sshKeyPath: field(z.string().default('')),
      tunnelRemotePort: field(z.natural().default(18790)),
      tunnelLocalPort: field(z.natural().default(18790)),
    })
  : undefined

export const inject = ['tools']

export async function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config, process.env)
  await ensureDir(cfg.stateDir).catch(() => {})
  await rotateLog(join(cfg.stateDir, 'bridge.log')).catch(() => {})

  const logger = createLogger({ dir: cfg.stateDir, tag: 'pc-bridge' })

  const { secret, source } = await resolveSecret({
    envName: cfg.secretEnv,
    secretFile: cfg.secretFile,
    stateDir: cfg.stateDir,
    create: cfg.role !== 'client',
    logger,
  })
  if (!secret) logger.warn(`no bridge secret (${source}); pc tools will refuse to run commands`)

  const shell = resolveShell({ shellPath: cfg.shellPath })
  logger.info(`ready: role=${cfg.role} secret=${source} shell=${shell.exe} (${shell.kind})`)

  let server = null
  if (cfg.role !== 'client') {
    server = createBridgeServer({
      secret,
      shell,
      listenHost: cfg.listenHost,
      listenPort: cfg.listenPort,
      defaultTimeoutMs: cfg.defaultTimeoutMs,
      maxTimeoutMs: cfg.maxTimeoutMs,
      maxOutputBytes: cfg.maxOutputBytes,
      cwd: cfg.cwd,
      logger,
    })
    try {
      const address = await server.start()
      logger.info(`listening on http://${cfg.listenHost}:${address.port}`)
    } catch (error) {
      logger.error(`listen failed (port in use?): ${error?.message || error}`)
      server = null
    }
  }

  const tunnel = cfg.tunnelEnabled ? createTunnelSupervisor({ cfg, logger }) : null
  tunnel?.start()

  const baseUrl = cfg.peerUrl || `http://127.0.0.1:${cfg.listenPort}`
  const disposers = []
  if (typeof ctx?.tools?.register === 'function') {
    for (const spec of pcToolSpecs({
      baseUrl,
      secret,
      defaultTimeoutMs: cfg.defaultTimeoutMs,
      maxTimeoutMs: cfg.maxTimeoutMs,
    })) {
      try {
        disposers.push(ctx.tools.register(spec))
      } catch (error) {
        logger.warn(`tool ${spec.name} registration failed: ${error?.message || error}`)
      }
    }
  }

  const dispose = async () => {
    tunnel?.stop()
    for (const disposer of disposers.reverse()) {
      try {
        disposer?.()
      } catch {
        // teardown must not throw
      }
    }
    if (server) await server.close().catch(() => {})
  }

  ctx.effect?.(() => () => dispose(), 'dsh-pc-bridge: teardown')
  return dispose
}
