import test from 'node:test'
import assert from 'node:assert/strict'

import { isShellAvailable, resolveShell, shellInvocation } from '../lib/shell.mjs'

test('explicit shellPath wins and gets bash-like args', () => {
  const shell = resolveShell({ platform: 'win32', shellPath: 'C:/tools/bash.exe', exists: () => true })
  assert.equal(shell.exe, 'C:/tools/bash.exe')
  assert.deepEqual(shell.args, ['-lc'])
  assert.equal(shell.kind, 'bash')
})

test('explicit powershell shellPath gets powershell args', () => {
  const shell = resolveShell({ platform: 'win32', shellPath: 'pwsh', exists: () => true })
  assert.equal(shell.kind, 'powershell')
  assert.deepEqual(shell.args, ['-NoProfile', '-NonInteractive', '-Command'])
})

test('Windows falls back to PowerShell when no bash exists', () => {
  const shell = resolveShell({ platform: 'win32', env: { PATH: '' }, exists: () => false })
  assert.equal(shell.exe, 'powershell.exe')
  assert.equal(shell.kind, 'powershell')
  assert.deepEqual(shell.args, ['-NoProfile', '-NonInteractive', '-Command'])
})

test('Windows prefers Git Bash when it exists', () => {
  const target = 'C:\\Program Files\\Git\\bin\\bash.exe'
  const shell = resolveShell({ platform: 'win32', env: { PATH: '' }, exists: (p) => p === target })
  assert.equal(shell.exe, target)
  assert.deepEqual(shell.args, ['-lc'])
})

test('POSIX prefers /bin/bash, then /bin/sh', () => {
  const bash = resolveShell({ platform: 'linux', exists: (p) => p === '/bin/bash' })
  assert.equal(bash.exe, '/bin/bash')
  assert.deepEqual(bash.args, ['-lc'])

  const sh = resolveShell({ platform: 'linux', exists: (p) => p === '/bin/sh' })
  assert.equal(sh.exe, '/bin/sh')
  assert.deepEqual(sh.args, ['-c'])
})

test('shellInvocation appends the command as one argv item', () => {
  const invocation = shellInvocation({ exe: 'bash', args: ['-lc'] }, 'echo "a b"')
  assert.deepEqual(invocation, { exe: 'bash', args: ['-lc', 'echo "a b"'] })
})

test('isShellAvailable checks absolute executables only', () => {
  assert.equal(isShellAvailable({ exe: '/nope/bash', args: [] }, { exists: () => false }), false)
  assert.equal(isShellAvailable({ exe: '/bin/bash', args: [] }, { exists: () => true }), true)
  assert.equal(isShellAvailable({ exe: 'powershell.exe', args: [] }, { exists: () => false }), true)
})

test('Android uses Termux bash when PREFIX points at one', () => {
  const shell = resolveShell({
    platform: 'android',
    env: { PREFIX: '/data/data/com.termux/files/usr' },
    exists: (p) => p === '/data/data/com.termux/files/usr/bin/bash',
  })
  assert.equal(shell.exe, '/data/data/com.termux/files/usr/bin/bash')
  assert.deepEqual(shell.args, ['-lc'])
})

test('Android falls back to /system/bin/sh', () => {
  const shell = resolveShell({ platform: 'android', env: {}, exists: (p) => p === '/system/bin/sh' })
  assert.equal(shell.exe, '/system/bin/sh')
  assert.deepEqual(shell.args, ['-c'])
  assert.equal(shell.kind, 'sh')
})