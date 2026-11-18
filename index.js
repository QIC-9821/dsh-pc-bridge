import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createRoutes } from './lib/routes.mjs'
import { createBridgeRuntime } from './lib/runtime.mjs'

export const name = 'dsh-pc-bridge'

// A profile that no longer depends on this package has uninstalled it; only
// then may purgeOnUninstall actually remove the local secret and history.
async function profileDroppedPlugin(env = process.env) {
  const dir = String(env?.DSH_PROFILE_DIR || '').trim()
  if (!dir) return false
  try {
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    const groups = [pkg?.dependencies, pkg?.devDependencies, pkg?.optionalDependencies]
    return groups.every((group) => !group || typeof group !== 'object' || !('dsh-pc-bridge' in group))
  } catch {
    // An unreadable profile is not proof of removal: keep the data.
    return false
  }
}

const VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version || '')
  } catch {
    return ''
  }
})()

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
      secret: field(z.string().default('')),
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
      toolsMode: field(z.string().default('auto')),
      discoveryEnabled: field(z.boolean().default(true)),
      discoveryPort: field(z.natural().default(18791)),
      pairTtlSec: field(z.natural().default(300)),
      auditKeep: field(z.natural().default(5)),
      remoteMode: field(z.string().default('off')),
      enabled: field(z.boolean().default(true)),
      purgeOnUninstall: field(z.boolean().default(false)),
      fileEnabled: field(z.boolean().default(true)),
      fileToolsEnabled: field(z.boolean().default(false)),
      fileRoots: field(z.array(z.string()).default([])),
      fileChunkBytes: field(z.natural().default(1048576)),
      fileMaxBytes: field(z.natural().default(67108864)),
    })
  : undefined

export const inject = ['tools']

export async function apply(ctx, config = {}) {
  const runtime = createBridgeRuntime({ ctx, config, env: process.env, version: VERSION })
  await runtime.start()

  const disposers = []

  const mountRoutes = (hostCtx) => {
    const webServer = hostCtx?.webServer ?? hostCtx?.get?.('webServer')
    if (!webServer || typeof webServer.register !== 'function') return
    try {
      const routes = createRoutes({ runtime, version: VERSION })
      disposers.push(webServer.register({ kind: 'prefix', path: '/pc-bridge', handler: routes.handle }))
    } catch (error) {
      console.warn(`[pc-bridge] web route registration failed: ${error?.message || error}`)
    }
  }

  // The web server may be instantiated on a later bundle row, so acquire it
  // lazily instead of reading ctx.webServer at apply time.
  if (typeof ctx?.inject === 'function') {
    disposers.push(ctx.inject(['webServer'], mountRoutes))
  } else {
    mountRoutes(ctx)
  }

  const dispose = async () => {
    for (const disposer of disposers.reverse()) {
      try {
        disposer?.()
      } catch {
        // teardown must not throw
      }
    }
    await runtime.stop()
    if (typeof runtime.isPurgeOnUninstall === 'function' && runtime.isPurgeOnUninstall()) {
      if (await profileDroppedPlugin(process.env)) {
        try {
          await runtime.cleanup()
        } catch (error) {
          console.warn(`[pc-bridge] cleanup on uninstall failed: ${error?.message || error}`)
        }
      }
    }
  }

  ctx.effect?.(() => () => dispose(), 'dsh-pc-bridge: teardown')
  return dispose
}
