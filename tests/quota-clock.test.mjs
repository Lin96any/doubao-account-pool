import assert from 'node:assert/strict'
import test from 'node:test'
import { quotaDate, nextQuotaReset, DailyQuotaTimer } from '../dist-electron/quota-clock.js'

test('uses Beijing midnight independently of the computer timezone', () => {
  const before = new Date('2026-10-20T15:59:59.999Z')
  const after = new Date('2026-10-20T16:00:00.000Z')
  assert.equal(quotaDate(before), '2026-10-20')
  assert.equal(quotaDate(after), '2026-10-21')
  assert.equal(nextQuotaReset(before), after.toISOString())
  assert.equal(nextQuotaReset(after), '2026-10-21T16:00:00.000Z')
})

test('checks at midnight, catches resume immediately and disposes its timer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let time = new Date('2026-10-20T15:59:59.000Z')
  let checks = 0
  const timer = new DailyQuotaTimer(() => checks++, () => time)
  timer.start()
  assert.equal(checks, 1)
  time = new Date('2026-10-20T16:00:00.000Z')
  t.mock.timers.tick(1000)
  assert.equal(checks, 2)
  time = new Date('2026-10-24T02:00:00.000Z')
  timer.refresh()
  assert.equal(checks, 3)
  timer.stop()
  t.mock.timers.tick(120000)
  assert.equal(checks, 3)
})
