import assert from 'node:assert/strict'
import test from 'node:test'
import { quotaAmount, quotaRuns } from '../dist-electron/quota-amount.js'

test('normalizes one-decimal amounts and counts whole runs using integer tenths', () => {
  assert.equal(quotaAmount(3.5), 3.5)
  assert.equal(quotaAmount(10 - 9.9), 0.1)
  assert.equal(quotaRuns(6.3, 2.1), 3)
  assert.equal(quotaRuns(10, 3.5), 2)
  assert.equal(quotaRuns(3, 3.5), 0)
  assert.equal(quotaAmount(Number.NaN), 0)
})
