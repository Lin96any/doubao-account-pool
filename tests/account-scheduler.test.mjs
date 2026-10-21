import assert from 'node:assert/strict'
import test from 'node:test'

import { AccountTaskScheduler } from '../dist-electron/account-scheduler.js'

const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve))

test('runs different accounts concurrently', async () => {
  const gates = new Map([[1, deferred()], [2, deferred()]])
  const started = []
  const scheduler = new AccountTaskScheduler(
    () => 2,
    async (item) => {
      started.push(item.key)
      await gates.get(item.accountId).promise
    },
  )

  scheduler.enqueue({ key: 'one', accountId: 1 })
  scheduler.enqueue({ key: 'two', accountId: 2 })
  await nextTurn()
  assert.deepEqual(started.sort(), ['one', 'two'])

  gates.get(1).resolve()
  gates.get(2).resolve()
})

test('keeps tasks for the same account sequential', async () => {
  const firstGate = deferred()
  const started = []
  const scheduler = new AccountTaskScheduler(
    () => 2,
    async (item) => {
      started.push(item.key)
      if (item.key === 'first') await firstGate.promise
    },
  )

  scheduler.enqueue({ key: 'first', accountId: 1 })
  scheduler.enqueue({ key: 'second', accountId: 1 })
  await nextTurn()
  assert.deepEqual(started, ['first'])

  firstGate.resolve()
  await nextTurn()
  assert.deepEqual(started, ['first', 'second'])
})

test('honors the configured concurrency limit', async () => {
  const firstGate = deferred()
  const started = []
  const scheduler = new AccountTaskScheduler(
    () => 1,
    async (item) => {
      started.push(item.key)
      if (item.key === 'first') await firstGate.promise
    },
  )

  scheduler.enqueue({ key: 'first', accountId: 1 })
  scheduler.enqueue({ key: 'second', accountId: 2 })
  await nextTurn()
  assert.deepEqual(started, ['first'])

  firstGate.resolve()
  await nextTurn()
  assert.deepEqual(started, ['first', 'second'])
})

test('removes a cancelled pending task without running it', async () => {
  const firstGate = deferred()
  const started = []
  const scheduler = new AccountTaskScheduler(
    () => 1,
    async (item) => {
      started.push(item.key)
      if (item.key === 'first') await firstGate.promise
    },
  )

  scheduler.enqueue({ key: 'first', accountId: 1 })
  scheduler.enqueue({ key: 'cancelled', accountId: 2 })
  await nextTurn()
  assert.equal(scheduler.isActive('first'), true)
  assert.equal(scheduler.cancel('cancelled'), true)

  firstGate.resolve()
  await nextTurn()
  assert.deepEqual(started, ['first'])
  assert.equal(scheduler.cancel('cancelled'), false)
})

test('releases concurrency immediately when an active task is cancelled', async () => {
  const firstGate = deferred()
  const started = []
  const scheduler = new AccountTaskScheduler(
    () => 1,
    async (item) => {
      started.push(item.key)
      if (item.key === 'first') await firstGate.promise
    },
  )

  scheduler.enqueue({ key: 'first', accountId: 1 })
  scheduler.enqueue({ key: 'second', accountId: 2 })
  await nextTurn()
  assert.equal(scheduler.cancel('first'), true)
  await nextTurn()
  assert.deepEqual(started, ['first', 'second'])

  firstGate.resolve()
})

test('pending reassignment respects the destination account cap', async () => {
  const gates = { a: deferred(), b: deferred() }, started = []
  const scheduler = new AccountTaskScheduler(() => 2, async item => {
    started.push(`${item.key}:${item.accountId}`)
    if (gates[item.key]) await gates[item.key].promise
  })
  scheduler.enqueue({ key: 'a', accountId: 1 }); scheduler.enqueue({ key: 'b', accountId: 2 })
  scheduler.enqueue({ key: 'moved', accountId: 1 }); scheduler.reassignPending('moved', 2)
  gates.a.resolve(); await nextTurn()
  assert.deepEqual(started, ['a:1', 'b:2'])
  gates.b.resolve(); await nextTurn()
  assert.deepEqual(started, ['a:1', 'b:2', 'moved:2'])
})

test('an active reassignment releases the old lease before retrying under the destination cap', async () => {
  const gate = deferred(), started = []
  const scheduler = new AccountTaskScheduler(() => 2, async item => {
    started.push(`${item.key}:${item.accountId}`)
    if (item.key === 'busy') await gate.promise
    else if (item.accountId === 1) { item.accountId = 2; return 'retry' }
  })
  scheduler.enqueue({ key: 'busy', accountId: 2 }); scheduler.enqueue({ key: 'moving', accountId: 1 })
  await nextTurn(); assert.deepEqual(started, ['busy:2', 'moving:1'])
  gate.resolve(); await nextTurn(); assert.deepEqual(started, ['busy:2', 'moving:1', 'moving:2'])
})
