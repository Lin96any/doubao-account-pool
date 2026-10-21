import assert from 'node:assert/strict'
import test from 'node:test'
import { isDoubaoDailyQuotaExhausted, doubaoDailyQuotaError } from '../dist-electron/doubao-quota-state.js'
import { diagnoseRequest, requestPhase } from '../dist-electron/request-diagnostics.js'
import { extractDoubaoFailureMessage } from '../dist-electron/doubao-page-state.js'

const actualReply = '今日视频生成免费次数用完了，你明天再来找我继续吧。'
test('recognizes the actual exhausted reply and supported daily free quota variants', () => {
  for (const text of [actualReply, '今日视频生成免费次数已用完。', '今日免费生成次数已用完，明天再来吧。',
    '今日生成次数已用完。', '免费生成次数已用完，请明天再试。', '今天的视频生成免费次数已经用完',
    '今日视频生成免费次数用完，生成额度未扣除。', '今天的视频生成免费次数已耗尽，明天再试。']) {
    assert.equal(isDoubaoDailyQuotaExhausted(text), true, text)
    assert.equal(isDoubaoDailyQuotaExhausted(extractDoubaoFailureMessage(text)), true, 'DOM extraction: ' + text)
  }
})
test('never confuses provider quota, content rejection or congestion with daily generation exhaustion', () => {
  for (const text of ['去水印今日免费次数已用完', '解析次数已用完', '生成内容中疑似包含侵权 / 违规内容，生成额度未扣除。',
    '服务繁忙，稍后再试', '剩余额度不足', '本次使用 Seedance 2.0 Mini 生成，预计等待 5 分钟', 'API Token调用次数已耗尽']) {
    assert.equal(isDoubaoDailyQuotaExhausted(text), false, text)
  }
})
test('shows a precise account-level failure without hiding the original reply', () => {
  const error = diagnoseRequest(`豆包返回失败：${actualReply}，已退回预扣额度`)
  assert.equal(error.stage, 'account')
  assert.equal(error.code, 'doubao_daily_quota_exhausted')
  assert.equal(error.title, '豆包今日免费次数已用完')
  assert.ok(error.detail.includes(actualReply))
  assert.equal(error.retryable, false)
  assert.equal(requestPhase({ status: 'failed', message: actualReply, error }), error.title)
  assert.equal(doubaoDailyQuotaError(actualReply).detail, actualReply)
})
