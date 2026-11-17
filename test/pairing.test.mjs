import test from 'node:test'
import assert from 'node:assert/strict'

import { createPairingService } from '../lib/pairing.mjs'

function makeClock(start = 1_000_000) {
  let current = start
  return {
    now: () => current,
    advance(ms) {
      current += ms
    },
  }
}

test('create returns a six digit zero-padded code', () => {
  const clock = makeClock()
  const service = createPairingService({ ttlSec: 300, now: clock.now })
  let sawLeadingZero = false

  for (let i = 0; i < 500; i += 1) {
    const { code, expiresAt } = service.create()
    assert.match(code, /^\d{6}$/)
    assert.equal(typeof expiresAt, 'number')
    if (code.startsWith('0')) sawLeadingZero = true
  }
  // 500 draws: the chance of never hitting a leading zero is below 1e-22.
  assert.equal(sawLeadingZero, true)
})

test('the pending code expires after ttlSec', () => {
  const clock = makeClock()
  const service = createPairingService({ ttlSec: 10, now: clock.now })
  const { code } = service.create()

  clock.advance(9_000)
  assert.deepEqual(service.verify(code, '10.0.0.1'), { ok: true })

  const second = service.create()
  clock.advance(10_001)
  assert.deepEqual(service.verify(second.code, '10.0.0.2'), { ok: false, error: 'expired' })
})

test('a wrong code is rejected and does not invalidate the pending code', () => {
  const clock = makeClock()
  const service = createPairingService({ ttlSec: 300, maxAttempts: 5, now: clock.now })
  const { code } = service.create()

  assert.deepEqual(service.verify('000000' === code ? '999999' : '000000', '10.0.0.1'), {
    ok: false,
    error: 'invalid',
  })
  assert.deepEqual(service.verify(code, '10.0.0.1'), { ok: true })
})

test('verification is single use', () => {
  const clock = makeClock()
  const service = createPairingService({ ttlSec: 300, now: clock.now })
  const { code } = service.create()

  assert.deepEqual(service.verify(code, '10.0.0.1'), { ok: true })
  assert.deepEqual(service.verify(code, '10.0.0.1'), { ok: false, error: 'invalid' })
  assert.equal(service.remaining(), 0)
})

test('verify without a pending code reports invalid', () => {
  const service = createPairingService({ ttlSec: 300 })
  assert.deepEqual(service.verify('123456', '10.0.0.1'), { ok: false, error: 'invalid' })
})

test('maxAttempts failures lock the ip for lockoutMs', () => {
  const clock = makeClock()
  const service = createPairingService({ ttlSec: 300, maxAttempts: 3, lockoutMs: 60_000, now: clock.now })
  const { code } = service.create()
  const wrong = code === '111111' ? '222222' : '111111'

  for (let i = 0; i < 2; i += 1) {
    const result = service.verify(wrong, '10.0.0.9')
    assert.equal(result.ok, false)
    assert.equal(result.error, 'invalid')
  }

  const justLocked = service.verify(wrong, '10.0.0.9')
  assert.equal(justLocked.ok, false)
  assert.equal(justLocked.error, 'locked')
  assert.ok(justLocked.retryAfterMs > 0 && justLocked.retryAfterMs <= 60_000)

  const locked = service.verify(code, '10.0.0.9')
  assert.equal(locked.ok, false)
  assert.equal(locked.error, 'locked')
  assert.ok(locked.retryAfterMs > 0 && locked.retryAfterMs <= 60_000)

  clock.advance(59_999)
  assert.equal(service.verify(code, '10.0.0.9').error, 'locked')

  clock.advance(2)
  assert.deepEqual(service.verify(code, '10.0.0.9'), { ok: true })
})

test('one locked ip does not block another ip', () => {
  const clock = makeClock()
  const service = createPairingService({ ttlSec: 300, maxAttempts: 2, lockoutMs: 60_000, now: clock.now })
  const { code } = service.create()
  const wrong = code === '111111' ? '222222' : '111111'

  for (let i = 0; i < 2; i += 1) service.verify(wrong, '10.0.0.7')
  assert.equal(service.verify(wrong, '10.0.0.7').error, 'locked')

  assert.deepEqual(service.verify(code, '10.0.0.8'), { ok: true })
})

test('remaining counts down in whole seconds', () => {
  const clock = makeClock()
  const service = createPairingService({ ttlSec: 300, now: clock.now })
  service.create()

  assert.equal(service.remaining(), 300)
  clock.advance(1_000)
  assert.equal(service.remaining(), 299)
  clock.advance(150_400)
  assert.equal(service.remaining(), 149)
  clock.advance(200_000)
  assert.equal(service.remaining(), 0)
})

test('a newer create replaces the previous pending code', () => {
  const clock = makeClock()
  const service = createPairingService({ ttlSec: 300, now: clock.now })
  const first = service.create()
  clock.advance(1_000)
  const second = service.create()

  assert.notEqual(first.code, second.code)
  assert.equal(service.verify(first.code, '10.0.0.1').error, 'invalid')
  assert.deepEqual(service.verify(second.code, '10.0.0.1'), { ok: true })
})

test('clear drops the pending code and any lockout', () => {
  const clock = makeClock()
  const service = createPairingService({ ttlSec: 300, maxAttempts: 2, lockoutMs: 60_000, now: clock.now })
  const { code } = service.create()

  service.verify('nope00', '10.0.0.5')
  assert.equal(service.verify('nope11', '10.0.0.5').error, 'locked')
  assert.equal(service.verify(code, '10.0.0.5').error, 'locked')

  service.clear()
  assert.equal(service.remaining(), 0)
  assert.equal(service.verify(code, '10.0.0.5').error, 'invalid')
})
