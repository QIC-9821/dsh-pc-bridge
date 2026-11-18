#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

import {
  callExec,
  callFileList,
  callFileStat,
  callPing,
  pullFile,
  pushFile,
} from '../lib/client.mjs'

const USAGE = [
  'pcctl — talk to a dsh-pc-bridge',
  '',
  '  pcctl ping [--url URL] [--peer URL]',
  '  pcctl exec [--timeout SEC] [--url URL] -- "command"',
  '  pcctl file list <path> [--limit N] [--peer URL]',
  '  pcctl file stat <path> [--peer URL]',
  '  pcctl file get <path> --out <local path> [--overwrite] [--peer URL]',
  '  pcctl file put <local path> <remote path> [--peer URL]',
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

/**
 * Print the JSON result and pick an exit code: 0 on success, 7 when the peer
 * could not be reached, 1 for everything else. The stderr line keeps a failed
 * transfer readable without parsing JSON.
 */
function printResult(result) {
  console.log(JSON.stringify(result))
  if (result?.ok) return 0
  if (result?.error) console.error(`pcctl: ${result.error}`)
  if (result?.reason === 'network' || result?.reason === 'timeout') return 7
  return 1
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      timeout: { type: 'string' },
      url: { type: 'string' },
      peer: { type: 'string' },
      out: { type: 'string' },
      limit: { type: 'string' },
      overwrite: { type: 'boolean' },
      'secret-file': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })

  const [command, ...rest] = positionals
  if (!command || values.help) {
    console.log(USAGE)
    process.exit(command ? 0 : 2)
  }

  const baseUrl = values.peer || values.url || process.env.PC_BRIDGE_URL || 'http://127.0.0.1:18790'
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

  if (command === 'file') {
    const [action, ...fileArgs] = rest
    if (action !== 'list' && action !== 'stat' && action !== 'get' && action !== 'put') {
      console.error('pcctl: file needs list|stat|get|put, e.g. pcctl file list /tmp')
      process.exit(2)
    }

    if (action === 'list') {
      const remotePath = fileArgs[0]
      if (!remotePath) {
        console.error('pcctl: file list needs a remote directory path')
        process.exit(2)
      }
      const limit = Number(values.limit)
      const result = await callFileList(baseUrl, secret, {
        path: remotePath,
        limit: Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : undefined,
      })
      process.exit(printResult(result))
    }

    if (action === 'stat') {
      const remotePath = fileArgs[0]
      if (!remotePath) {
        console.error('pcctl: file stat needs a remote path')
        process.exit(2)
      }
      process.exit(printResult(await callFileStat(baseUrl, secret, { path: remotePath })))
    }

    if (action === 'get') {
      const remotePath = fileArgs[0]
      if (!remotePath || !values.out) {
        console.error('pcctl: file get needs <remote path> and --out <local path>')
        process.exit(2)
      }
      const result = await pullFile(baseUrl, secret, {
        path: remotePath,
        dest: values.out,
        overwrite: Boolean(values.overwrite),
      })
      process.exit(printResult(result))
    }

    if (action === 'put') {
      const source = fileArgs[0]
      const remotePath = fileArgs[1]
      if (!source || !remotePath) {
        console.error('pcctl: file put needs <local path> <remote path>')
        process.exit(2)
      }
      process.exit(printResult(await pushFile(baseUrl, secret, {
        path: remotePath,
        source,
      })))
    }
  }

  console.error(`pcctl: unknown command ${command}`)
  process.exit(2)
}

main(process.argv.slice(2)).catch((error) => {
  console.error('pcctl:', error?.message || error)
  process.exit(1)
})
