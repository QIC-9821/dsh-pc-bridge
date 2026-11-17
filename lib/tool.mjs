import { callExec, callPing } from './client.mjs'

function textRender(_args, value) {
  return [{
    type: 'text',
    text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  }]
}

const output = {
  schema: { type: 'object', additionalProperties: true },
  render: textRender,
}

/**
 * A per-call peer lets one side reach several bridges: the default peerUrl is
 * a fixed address, while a tablet's LAN address can change with the network.
 * Only absolute http(s) URLs are accepted, so a typo cannot turn into a
 * relative request against the local host.
 */
export function resolvePeer(peer, fallback) {
  const text = String(peer || '').trim()
  if (!text) return { ok: true, url: fallback }
  let url
  try {
    url = new URL(text)
  } catch {
    return { ok: false, error: `peer is not a valid URL: ${text}` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `peer must be http or https: ${text}` }
  }
  return { ok: true, url: url.toString().replace(/\/+$/, '') }
}

export function pcToolSpecs({
  baseUrl,
  secret,
  defaultTimeoutMs = 30000,
  maxTimeoutMs = 600000,
} = {}) {
  return [
    {
      name: 'pc_ping',
      description: [
        'Ping a dsh-pc-bridge peer (this machine\'s configured peer by default) and report which shell it will use.',
        'Pass `peer` to reach another bridge, e.g. the tablet at a changed LAN address.',
        'Returns ok, host, user, shell kind and time, or a network error with the URL it tried.',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          peer: { type: 'string', description: 'Optional http(s) bridge URL; defaults to the configured peerUrl.' },
        },
        additionalProperties: false,
      },
      timeoutMs: 15000,
      output,
      async execute(args) {
        const target = resolvePeer(args?.peer, baseUrl)
        if (!target.ok) return { ok: false, error: target.error }
        return callPing(target.url, secret)
      },
    },
    {
      name: 'pc_exec',
      description: [
        'Run a shell command through a dsh-pc-bridge peer and return stdout/stderr/exitCode.',
        'Shells: Git Bash on Windows, /bin/bash on POSIX, Termux bash or /system/bin/sh on Android.',
        'Prefer short, explicit commands; the default timeout is 30 seconds, and output is truncated when huge.',
        'Pass `peer` to run on another bridge (for example a tablet whose LAN address changed).',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run on the peer.' },
          timeoutSec: { type: 'number', description: 'Optional timeout in seconds (clamped by the bridge config).' },
          peer: { type: 'string', description: 'Optional http(s) bridge URL; defaults to the configured peerUrl.' },
        },
        required: ['command'],
        additionalProperties: false,
      },
      timeoutMs: 660000,
      output,
      async execute(args) {
        const target = resolvePeer(args?.peer, baseUrl)
        if (!target.ok) return { ok: false, error: target.error }
        return callExec(
          target.url,
          secret,
          { command: args?.command, timeoutSec: args?.timeoutSec },
          { defaultTimeoutMs, maxTimeoutMs },
        )
      },
    },
  ]
}
