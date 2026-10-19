import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import { classifyWatermarkFailure, diagnoseRequest } from '../dist-electron/request-diagnostics.js'
import { extractWatermarkUsage, mergeWatermarkStatus, watermarkScope } from '../dist-electron/watermark-state.js'
import { resolveCleanVideoUrl, WatermarkError } from '../dist-electron/watermark.js'

test('uses provider usage only, preserves zero and leaves missing counts unknown', () => {
  assert.deepEqual(extractWatermarkUsage({ data: { usage: { totalLimit: '100', usedCount: '100', remainingCount: '0' } } }), { totalLimit: 100, usedCount: 100, remainingCount: 0 })
  assert.equal(extractWatermarkUsage({ total: 100, used: 6 }), null)
  assert.deepEqual(extractWatermarkUsage({ usage: { remainingCount: '12', totalLimit: '', usedCount: -1 } }), { totalLimit: null, usedCount: null, remainingCount: 12 })
})

test('separates quota exhaustion, disabled tokens, ambiguous 403, and temporary failures', () => {
  const cases = [
    ['API Token调用次数已耗尽', 403, 'quota_exhausted', false],
    ['无效的API Token', 403, 'token_invalid', false],
    ['API Token已被禁用', 403, 'token_disabled', false],
    ['Forbidden', 403, 'access_denied', false],
    ['Too many requests', 429, 'rate_limited', true],
    ['未找到资源或获取失败', 404, 'resource_pending', true],
    ['服务器内部错误', 500, 'service_unavailable', true],
    ['fetch failed', undefined, 'network_error', true],
    ['平台暂不支持', 400, 'unsupported_platform', false]
  ]
  for (const [message, status, code, retryable] of cases) {
    const info = classifyWatermarkFailure(message, status)
    assert.equal(info.code, code, message)
    assert.equal(info.retryable, retryable, message)
    assert.equal(info.detail, message)
  }
  assert.equal(diagnoseRequest('视频已生成，但未提取到豆包分享链接，无法获取去水印视频').stage, 'sharing')
})

test('keeps balance freshness separate from a failed request and isolates token scopes', () => {
  const event = { checkedAt: '2026-10-19T09:00:00.000Z', usage: { remainingCount: 32, usedCount: 68, totalLimit: 100 }, error: null }
  const state = mergeWatermarkStatus(null, event)
  const next = mergeWatermarkStatus(state, { checkedAt: '2026-10-19T10:00:00.000Z', usage: null, error: classifyWatermarkFailure('fetch failed') })
  assert.equal(next.usage.remainingCount, 32)
  assert.equal(next.usageUpdatedAt, event.checkedAt)
  assert.equal(mergeWatermarkStatus(next, event), next)
  assert.notEqual(watermarkScope({ watermarkApiUrl: 'https://example.com/parse', watermarkApiToken: 'a' }), watermarkScope({ watermarkApiUrl: 'https://example.com/parse', watermarkApiToken: 'b' }))
})

test('captures real-shaped provider usage and never retries depleted or invalid credentials', async (t) => {
  let calls = 0
  const server = http.createServer((req, res) => {
    calls++
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ code: 403, message: 'API Token调用次数已耗尽', data: { usage: { totalLimit: '100', usedCount: '100', remainingCount: '0' } } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const events = []
  const settings = { watermarkApiUrl: `http://127.0.0.1:${server.address().port}/parse`, watermarkApiToken: 'test-only' }
  await assert.rejects(resolveCleanVideoUrl(settings, 'https://www.doubao.com/thread/test', undefined, { onProviderResponse: (_, event) => events.push(event) }), error => error instanceof WatermarkError && error.info.code === 'quota_exhausted')
  assert.equal(calls, 1)
  assert.equal(events[0].usage.remainingCount, 0)
})

test('records successful provider usage only with a verified video result', async (t) => {
  let root
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/video.mp4')) {
      res.writeHead(206, { 'content-type': 'video/mp4' })
      res.end(Buffer.from('00000018667479706d703432', 'hex'))
    } else {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ code: 200, data: { url: `${root}/video.mp4`, usage: { totalLimit: 100, usedCount: 9, remainingCount: 91 } } }))
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  root = `http://127.0.0.1:${server.address().port}`
  const events = []
  assert.equal(await resolveCleanVideoUrl({ watermarkApiUrl: `${root}/parse?existing=1`, watermarkApiToken: 'test-only' }, 'https://www.doubao.com/thread/test', undefined, { onProviderResponse: (_, event) => events.push(event) }), `${root}/video.mp4`)
  assert.equal(events[0].usage.remainingCount, 91)
  assert.equal(events[0].error, null)
})
