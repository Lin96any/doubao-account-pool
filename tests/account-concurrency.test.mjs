import assert from 'node:assert/strict'
import test from 'node:test'
import { AccountTaskScheduler } from '../dist-electron/account-scheduler.js'
import { isDoubaoConcurrencyLimitReply } from '../dist-electron/doubao-page-state.js'

const gate = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const turn = () => new Promise(done => setImmediate(done))

test('runs three jobs on one account while keeping the fourth queued', async () => {
  const waiting = [gate(), gate(), gate(), gate()]
  const started = []
  const scheduler = new AccountTaskScheduler(() => 5, async item => { started.push(item.index); await waiting[item.index].promise }, undefined, () => 3)
  for (let index = 0; index < 4; index++) scheduler.enqueue({ key: String(index), accountId: 1, index })
  await turn()
  assert.deepEqual(started, [0, 1, 2])
  waiting[1].resolve()
  await turn()
  assert.deepEqual(started, [0, 1, 2, 3])
  waiting.forEach(item => item.resolve())
})

test('enforces five total jobs across accounts, even with three slots per account', async () => {
  const wait = gate()
  const started = []
  const scheduler = new AccountTaskScheduler(() => 5, async item => { started.push(item); await wait.promise }, undefined, () => 3)
  for (let index = 0; index < 8; index++) scheduler.enqueue({ key: String(index), accountId: index < 4 ? 1 : 2 })
  await turn()
  assert.equal(started.length, 5)
  assert.equal(started.filter(item => item.accountId === 1).length, 3)
  wait.resolve()
})

test('old cancelled workers cannot release a new execution using the same key', async () => {
  const old = gate(), replacement = gate()
  let starts = 0
  const scheduler = new AccountTaskScheduler(() => 2, async () => { starts++; await (starts === 1 ? old.promise : replacement.promise) }, undefined, () => 1)
  scheduler.enqueue({ key: 'same', accountId: 1 })
  await turn()
  scheduler.cancel('same')
  scheduler.enqueue({ key: 'same', accountId: 1 })
  await turn()
  old.resolve()
  await turn()
  assert.equal(scheduler.isActive('same'), true)
  assert.equal(starts, 2)
  replacement.resolve()
})

test('retries blocked work only after eligibility changes and wake is requested', async () => {
  let ready = true, starts = 0
  const scheduler = new AccountTaskScheduler(() => 3, async () => { starts++; if (starts === 1) { ready = false; return 'retry' } }, undefined, () => 3, () => ready)
  scheduler.enqueue({ key: 'retry', accountId: 1 })
  await turn()
  assert.equal(starts, 1)
  await turn()
  assert.equal(starts, 1)
  ready = true
  scheduler.wake()
  await turn()
  assert.equal(starts, 2)
})

test('all three independent jobs reach send-trigger before any acknowledgement finishes', async () => {
  const acknowledgement = gate()
  const sends = []
  const scheduler = new AccountTaskScheduler(() => 5, async item => { sends.push(item.key); await acknowledgement.promise }, undefined, () => 3)
  for (let index = 0; index < 3; index++) scheduler.enqueue({ key: String(index), accountId: 1 })
  await turn()
  assert.deepEqual(sends, ['0', '1', '2'])
  acknowledgement.resolve()
})

test('recognizes explicit provider concurrency limits, not ordinary pending replies', () => {
  assert.equal(isDoubaoConcurrencyLimitReply('当前同时生成任务数量已达上限，请等待已有任务完成后再试'), true)
  assert.equal(isDoubaoConcurrencyLimitReply('已有视频任务，请等待任务结束后再提交'), true)
  assert.equal(isDoubaoConcurrencyLimitReply('本次使用 Seedance 2.0 Mini 生成，预计等待 5 分钟'), false)
  assert.equal(isDoubaoConcurrencyLimitReply('视频生成中，完成后主动发送'), false)
})
