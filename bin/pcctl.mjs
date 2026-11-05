#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

import { callExec, callPing } from '../lib/client.mjs'

const USAGE = [
  'pcctl — talk to a dsh-pc-bridge',
  '',
  '  pcctl ping [--url URL]',
  '  pcctl exec [--timeout SEC] [--url URL] -- "command"',
  '',
  'Environment: PC_BRIDGE_URL, PC_BRIDGE_SECRET, PC_BRIDGE_SECRET_FILE',
].join('\n')

async function resolveSecret(secretFile) {
  const fromEnv = String(process.env.PC_BRIDGE_SECRET || '').trim()
  if (fromEnv) return fromEnv
  const file = secretFile || process.env.PC_BRIDGE_SECRET_FILE || ''
  if (!file) return ''
  try {
    return (await readFile(file, 'utf8')).trim()
  } catch {
    return ''
  }
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      timeout: { type: 'string' },
      url: { type: 'string' },
      'secret-file': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })

  const [command, ...rest] = positionals
  if (!command || values.help) {
    console.log(USAGE)
    process.exit(command ? 0 : 2)
  }

  const baseUrl = values.url || process.env.PC_BRIDGE_URL || 'http://127.0.0.1:18790'
  const secret = await resolveSecret(values['secret-file'])
  if (!secret) {
    console.error('pcctl: no secret (set PC_BRIDGE_SECRET or PC_BRIDGE_SECRET_FILE)')
    process.exit(2)
  }

  if (command === 'ping') {
    const result = await callPing(baseUrl, secret)
    console.log(JSON.stringify(result))
    process.exit(result.ok ? 0 : 7)
  }

  if (command === 'exec') {
    const cmd = rest.join(' ').trim()
    if (!cmd) {
      console.error('pcctl: exec needs a command, e.g. pcctl exec "hostname"')
      process.exit(2)
    }
    const timeoutSec = values.timeout ? Number(values.timeout) : undefined
    const result = await callExec(baseUrl, secret, { command: cmd, timeoutSec })
    if (typeof result.stdout === 'string' && result.stdout) process.stdout.write(result.stdout)
    if (typeof result.stderr === 'string' && result.stderr) process.stderr.write(result.stderr)

    if (result.reason === 'network' || result.reason === 'timeout') {
      if (!result.stdout && !result.stderr) console.error(JSON.stringify(result))
      process.exit(7)
    }
    if (result.ok === false && !Number.isInteger(result.exitCode)) {
      if (!result.stdout && !result.stderr) console.error(JSON.stringify(result))
      process.exit(1)
    }
    process.exit(Number.isInteger(result.exitCode) ? result.exitCode : 0)
  }

  console.error(`pcctl: unknown command ${command}`)
  process.exit(2)
}

main(process.argv.slice(2)).catch((error) => {
  console.error('pcctl:', error?.message || error)
  process.exit(1)
})
