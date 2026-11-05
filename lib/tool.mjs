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
        'Ping the dsh-pc-bridge peer configured for this machine (loopback by default).',
        'Returns ok, host, user, shell kind and time, or a network error with the URL it tried.',
        'Use it to check whether the PC bridge is reachable before running a command.',
      ].join('\n'),
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      timeoutMs: 15000,
      output,
      async execute() {
        return callPing(baseUrl, secret)
      },
    },
    {
      name: 'pc_exec',
      description: [
        'Run a shell command through the dsh-pc-bridge peer and return stdout/stderr/exitCode.',
        'The bridge uses Git Bash on Windows (PowerShell only when Git Bash is absent), and /bin/bash on POSIX.',
        'Prefer short, explicit commands; the default timeout is 30 seconds, and output is truncated when huge.',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run on the peer.' },
          timeoutSec: { type: 'number', description: 'Optional timeout in seconds (clamped by the bridge config).' },
        },
        required: ['command'],
        additionalProperties: false,
      },
      timeoutMs: 660000,
      output,
      async execute(args) {
        return callExec(
          baseUrl,
          secret,
          { command: args?.command, timeoutSec: args?.timeoutSec },
          { defaultTimeoutMs, maxTimeoutMs },
        )
      },
    },
  ]
}
