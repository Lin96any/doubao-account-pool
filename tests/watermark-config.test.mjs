import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import { resolveCleanVideoUrl } from '../dist-electron/watermark.js'

async function fixture(t, handle) {
  let root
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/video.mp4')) {
      res.writeHead(206, { 'content-type': 'video/mp4' }); res.end(Buffer.from('00000018667479706d703432', 'hex'))
    } else handle(req, res, root)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  root = `http://127.0.0.1:${server.address().port}`
  return root
}
const success = (res, root) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ code: 200, data: { url: `${root}/video.mp4`, usage: { remainingCount: 91 } } })) }

test('a task holding an old snapshot uses the saved endpoint and token for its first parse', async t => {
  const seen = []
  const root = await fixture(t, (req, res, root) => { seen.push([req.url.split('?')[0], req.headers.authorization]); success(res, root) })
  const old = { watermarkApiUrl: `${root}/old`, watermarkApiToken: '' }
  const saved = { watermarkApiUrl: `${root}/new`, watermarkApiToken: 'fixture-new' }
  await resolveCleanVideoUrl(old, 'https://www.doubao.com/thread/fixture', undefined, { getSettings: () => saved })
  assert.deepEqual(seen, [['/new', 'fixture-new']])
})

test('an in-flight old-token exhaustion switches once to the saved config without treating new quota as depleted', async t => {
  const seen = [], retries = [], events = []; let saved
  const root = await fixture(t, (req, res, root) => {
    seen.push([req.url.split('?')[0], req.headers.authorization])
    if (seen.length === 1) {
      saved = { watermarkApiUrl: `${root}/new`, watermarkApiToken: 'fixture-new' }
      res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: 403, message: 'API Token调用次数已耗尽', data: { usage: { remainingCount: 0 } } }))
    } else success(res, root)
  })
  const old = { watermarkApiUrl: `${root}/old`, watermarkApiToken: 'fixture-old' }; saved = old
  await resolveCleanVideoUrl(old, 'https://www.doubao.com/thread/fixture', retry => retries.push(retry), {
    getSettings: () => saved, onProviderResponse: (settings, event) => events.push({ token: settings.watermarkApiToken, event })
  })
  assert.deepEqual(seen, [['/old', 'fixture-old'], ['/new', 'fixture-new']])
  assert.equal(retries[0].configurationChanged, true); assert.equal(retries[0].delayMs, 0)
  assert.equal(events[0].token, 'fixture-old'); assert.equal(events[0].event.usage.remainingCount, 0)
  assert.equal(events[1].token, 'fixture-new'); assert.equal(events[1].event.usage.remainingCount, 91)
})

test('a saved change during retry backoff is read by the next attempt', async t => {
  const seen = []; let saved
  const root = await fixture(t, (req, res, root) => {
    seen.push(req.headers.authorization)
    if (seen.length === 1) { res.writeHead(503); res.end(JSON.stringify({ message: '服务器内部错误' })) }
    else success(res, root)
  })
  const old = { watermarkApiUrl: `${root}/parse`, watermarkApiToken: 'fixture-old' }; saved = old
  await resolveCleanVideoUrl(old, 'https://www.doubao.com/thread/fixture', () => { saved = { ...old, watermarkApiToken: 'fixture-new' } }, { maxAttempts: 2, getSettings: () => saved })
  assert.deepEqual(seen, ['fixture-old', 'fixture-new'])
})

test('an already successful old request is not resubmitted after a config change', async t => {
  let saved, calls = 0
  const root = await fixture(t, (_req, res, root) => { calls++; saved = { ...saved, watermarkApiToken: 'fixture-new' }; success(res, root) })
  saved = { watermarkApiUrl: `${root}/parse`, watermarkApiToken: 'fixture-old' }
  await resolveCleanVideoUrl(saved, 'https://www.doubao.com/thread/fixture', undefined, { getSettings: () => saved })
  assert.equal(calls, 1)
})

test('repeated config changes stay bounded and do not blame the new token for an old request failure', async t => {
  let saved, calls = 0
  const root = await fixture(t, (_req, res) => {
    calls++; saved = { ...saved, watermarkApiToken: `fixture-next-${calls}` }
    res.writeHead(403); res.end(JSON.stringify({ message: 'API Token调用次数已耗尽' }))
  })
  saved = { watermarkApiUrl: `${root}/parse`, watermarkApiToken: 'fixture-old' }
  await assert.rejects(resolveCleanVideoUrl(saved, 'https://www.doubao.com/thread/fixture', undefined, { maxAttempts: 3, getSettings: () => saved }), error => error.info.code === 'configuration_changed')
  assert.equal(calls, 3)
})
