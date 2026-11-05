import test from 'node:test'
import assert from 'node:assert/strict'

import { runShellCommand } from '../lib/exec.mjs'
import { isShellAvailable, resolveShell } from '../lib/shell.mjs'

const shell = resolveShell()
const available = isShellAvailable(shell)

test('runs a harmless command through the host shell', { skip: !available && 'no shell available' }, async () => {
  const result = await runShellCommand('echo pc-bridge-check', { shell, timeoutMs: 20000 })
  assert.equal(result.ok, true, JSON.stringify({ stderr: result.stderr, exitCode: result.exitCode }))
  assert.match(result.stdout, /pc-bridge-check/)
})

test('times out and kills the command tree', { skip: !available && 'no shell available' }, async () => {
  const result = await runShellCommand('sleep 10', { shell, timeoutMs: 500 })
  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
})

test('a missing explicit shell is re-resolved instead of throwing', async () => {
  const result = await runShellCommand('echo hi', {
    shell: { exe: 'C:/definitely/missing/bash.exe', args: ['-lc'], kind: 'bash' },
    timeoutMs: 20000,
    resolve: () => resolveShell(),
  })
  assert.equal(result.ok, true, result.stderr)
  assert.match(result.stdout, /hi/)
})
