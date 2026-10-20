import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { randomUUID, createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// This is opt-in: it spends real generation credits and provider parse calls.
assert.equal(process.env.DOUBAO_LIVE_TEST, '1', 'Set DOUBAO_LIVE_TEST=1 only for an authorized real regression')
const sourceIds = process.argv.slice(2)
assert.equal(sourceIds.length, 3, 'Pass three existing source request IDs; repeat one to check identical prompts')
assert.ok(sourceIds.every(id => /^doubao-[a-f0-9]+$/.test(id)))
const db = process.env.DOUBAO_TEST_DB || path.join(os.homedir(), 'Library/Application Support/doubao-account-manager/doubao-manager.sqlite3')
const query = sql => JSON.parse(execFileSync('sqlite3', ['-readonly', '-json', db, sql], { encoding: 'utf8' }) || '[]')
const settings = Object.fromEntries(query("SELECT key,value FROM settings WHERE key IN ('apiKey','apiPort','miniCost','fastCost','generationTimeoutSeconds','executorEnabled','maxConcurrentAccounts','maxConcurrentTasksPerAccount')").map(row => [row.key, JSON.parse(row.value)]))
const endpoint = `http://127.0.0.1:${settings.apiPort}`
const api = async (route, body) => {
  const response = await fetch(endpoint + route, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) })
  const result = await response.json()
  assert.ok(response.ok, `HTTP ${response.status}: ${JSON.stringify(result)}`)
  return result
}
assert.equal((await api('/health')).api.version, '0.1.74')
assert.equal(settings.executorEnabled, true)
assert.ok((settings.maxConcurrentTasksPerAccount ?? 3) >= 3 && settings.maxConcurrentAccounts >= 3)
assert.equal(query("SELECT COUNT(*) AS count FROM api_requests WHERE status IN ('accepted','running')")[0].count, 0, 'Do not interfere with current work')
const originals = query(`SELECT request_id,model,aspect_ratio,prompt,reference_image_path FROM api_requests WHERE request_id IN (${sourceIds.map(id => `'${id}'`).join(',')})`)
const sources = sourceIds.map(id => originals.find(row => row.request_id === id))
assert.ok(sources.every(Boolean), 'All original prompts must already exist')
assert.ok(sources.every(row => !row.reference_image_path || existsSync(row.reference_image_path)), 'Do not silently omit missing reference images')
const cost = sources.reduce((sum, row) => sum + (row.model === 'seedance_2_0_mini' ? settings.miniCost : settings.fastCost), 0)
const account = (await api('/api/accounts')).accounts.filter(item => item.loginStatus === 'logged_in' && item.currentStatus === 'idle' && item.quotaRemaining >= cost)
  .sort((a, b) => b.quotaRemaining - a.quotaRemaining || a.id - b.id)[0]
assert.ok(account, 'No idle single account has enough real local credits for the whole regression')
const callbackKey = `/callback/${randomUUID()}`
const callbacks = new Map()
const server = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== callbackKey) { res.writeHead(404).end(); return }
  let text = ''
  for await (const part of req) { text += part; if (text.length > 1000000) { res.writeHead(413).end(); return } }
  try { const data = JSON.parse(text); callbacks.set(data.requestId, data); res.writeHead(204).end() }
  catch { res.writeHead(400).end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const callbackUrl = `http://127.0.0.1:${server.address().port}${callbackKey}`
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const tasks = []
let maxAcceptedInFlight = 0
try {
  for (const source of sources) {
    const task = await api('/api/generate', { accountId: account.id, source: 'system-test', model: source.model, aspectRatio: source.aspect_ratio,
      prompt: source.prompt, referenceImagePath: source.reference_image_path, callbackUrl })
    tasks.push(task)
  }
  console.log(JSON.stringify({ accountId: account.id, cost, requestIds: tasks.map(item => item.requestId) }))
  const ids = tasks.map(task => `'${task.requestId}'`).join(',')
  const deadline = Date.now() + 40 * 60000
  let result = [], lastLog = 0
  while (Date.now() < deadline) {
    result = await Promise.all(tasks.map(task => api(`/api/requests/${task.requestId}`)))
    const snapshots = query(`SELECT status,generation_accepted_at FROM api_requests WHERE request_id IN (${ids})`)
    maxAcceptedInFlight = Math.max(maxAcceptedInFlight, snapshots.filter(row => row.generation_accepted_at && ['accepted','running'].includes(row.status)).length)
    if (Date.now() - lastLog >= 15000) {
      lastLog = Date.now()
      console.log(JSON.stringify({ maxAcceptedInFlight, tasks: result.map(item => ({ requestId: item.requestId, status: item.status, message: item.message })) }))
    }
    if (result.every(item => ['success','failed','stopped'].includes(item.status))) break
    await sleep(5000)
  }
  for (let count = 0; count < 10 && result.some(item => callbacks.get(item.requestId)?.status !== item.status); count++) await sleep(500)
  const records = query(`SELECT request_id,account_id,prompt,source_conversation_url,doubao_thread_url,quota_cost,quota_date,generation_accepted_at,quota_refunded FROM api_requests WHERE request_id IN (${ids}) ORDER BY id`)
  const starts = query(`SELECT request_id,MIN(created_at) AS time FROM operation_logs WHERE request_id IN (${ids}) AND message='正在打开豆包执行窗口' GROUP BY request_id`)
  const sends = query(`SELECT request_id,MIN(created_at) AS time FROM operation_logs WHERE request_id IN (${ids}) AND message='已触发本任务发送，正在独立等待豆包受理确认' GROUP BY request_id`)
  const spread = rows => rows.length === 3 ? Math.max(...rows.map(row => Date.parse(row.time))) - Math.min(...rows.map(row => Date.parse(row.time))) : null
  const checks = []
  for (const item of result) {
    const record = records.find(row => row.request_id === item.requestId)
    let videoVerified = false
    if (item.status === 'success' && item.cleanVideoUrl) {
      const response = await fetch(item.cleanVideoUrl, { headers: { Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(20000) })
      const reader = response.body.getReader()
      const { value } = await reader.read()
      await reader.cancel()
      videoVerified = response.ok && (response.headers.get('content-type') || '').startsWith('video/') && Buffer.from(value || []).subarray(0, 64).includes(Buffer.from('ftyp'))
    }
    const callback = callbacks.get(item.requestId)
    checks.push({ requestId: item.requestId, status: item.status, sourcePromptMatches: createHash('sha256').update(record.prompt).digest('hex') === createHash('sha256').update(sources[checks.length].prompt).digest('hex'),
      accountMatches: record.account_id === account.id, accepted: Boolean(record.generation_accepted_at), videoVerified,
      quotaRefunded: Boolean(record.quota_refunded),
      callbackMatches: callback?.status === item.status && callback?.cleanVideoUrl === item.cleanVideoUrl, message: item.message })
  }
  const report = { version: '0.1.74', accountId: account.id, maxAcceptedInFlight, checks,
    submissionStartSpreadMs: spread(starts), sendTriggerSpreadMs: spread(sends),
    distinctConversations: new Set(records.map(row => row.source_conversation_url).filter(Boolean)).size,
    distinctShareUrls: new Set(records.map(row => row.doubao_thread_url).filter(url => /^https:\/\/(?:www\.)?doubao\.com\/(?:thread|share)\//.test(url || ''))).size,
    beforeBalance: account.quotaRemaining, afterBalance: query(`SELECT quota_remaining FROM accounts WHERE id=${account.id}`)[0].quota_remaining }
  mkdirSync('release', { recursive: true })
  const reportPath = `release/live-concurrency-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.json`
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ reportPath, ...report }))
  assert.ok(checks.every(item => item.status === 'success' && item.sourcePromptMatches && item.accountMatches && item.accepted && item.videoVerified && item.callbackMatches), 'Not all tasks finished with matching verified videos and callbacks')
  assert.equal(report.distinctConversations, 3, 'Conversation binding must be unique even with duplicate prompts')
  assert.equal(report.distinctShareUrls, 3, 'Each task must share its own video')
  assert.ok(report.submissionStartSpreadMs !== null && report.submissionStartSpreadMs < 3000, 'Three windows must start independently, without waiting for another acknowledgement')
  assert.ok(report.sendTriggerSpreadMs !== null && report.sendTriggerSpreadMs < 30000, 'All three initial sends must happen together rather than serial acknowledgement waits')
  assert.equal(maxAcceptedInFlight, 3, 'Three-way real generation overlap was not observed; do not claim it was verified')
  assert.ok(checks.every(item => !item.quotaRefunded), 'Successful videos must retain their actual debit')
  assert.equal(report.afterBalance, report.beforeBalance - cost, 'Each successful task must debit only its own stored cost')
} finally {
  await new Promise(resolve => server.close(resolve))
}
