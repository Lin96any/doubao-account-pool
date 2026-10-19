import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'
import Database from 'better-sqlite3'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-isolated-db-'))
app.setPath('userData', profile)
app.whenReady().then(async () => {
  app.dock?.hide()
  let exitCode = 0
  try {
  const file = path.join(profile, 'doubao-manager.sqlite3')
  const legacy = new Database(file)
  legacy.exec(`CREATE TABLE api_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE, source TEXT NOT NULL DEFAULT 'local',
    model TEXT NOT NULL, account_id INTEGER, status TEXT NOT NULL, message TEXT NOT NULL DEFAULT '', prompt TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`)
  legacy.close()
  const { AppDatabase } = await import('../dist-electron/database.js')
  const database = new AppDatabase()
  const settings = database.updateSettings({ apiServiceEnabled: false, executorEnabled: false, watermarkApiToken: 'fixture-A' })
  assert.equal(database.getWatermarkStatus().usage, null)
  database.recordWatermarkResponse(settings, { checkedAt: new Date().toISOString(), usage: { totalLimit: 100, usedCount: 12, remainingCount: 88 }, error: null })
  assert.equal(database.getWatermarkStatus().usage.remainingCount, 88)
  database.updateSettings({ watermarkApiToken: 'fixture-B' })
  assert.equal(database.getWatermarkStatus().usage, null)
  database.updateSettings({ watermarkApiToken: 'fixture-A' })
  assert.equal(database.getWatermarkStatus().usage.remainingCount, 88)

  const account = database.createAccount({ remark: 'isolated fixture' })
  const failure = { stage: 'watermark', code: 'quota_exhausted', title: '去水印次数已耗尽', detail: '次数已耗尽', suggestion: '补充次数后恢复结果', retryable: false }
  database.createApiRequest({ requestId: 'isolated-failure', model: 'seedance_2_0_mini', accountId: account.id, status: 'running', prompt: 'fixture' })
  database.updateApiRequest({ requestId: 'isolated-failure', status: 'failed', message: '次数已耗尽', error: failure, doubaoThreadUrl: 'https://www.doubao.com/thread/fixture' })
  assert.deepEqual(database.getApiRequest('isolated-failure').error, failure)
  database.updateApiRequest({ requestId: 'isolated-failure', status: 'running', message: '恢复结果' })
  assert.equal(database.getApiRequest('isolated-failure').error, null)
  for (let index = 0; index < 103; index++) {
    const requestId = `isolated-success-${index}`
    database.createApiRequest({ requestId, model: 'seedance_2_0_mini', status: 'running', prompt: 'fixture' })
    database.updateApiRequest({ requestId, status: 'success', cleanVideoUrl: 'https://example.invalid/video.mp4' })
  }
  const start = new Date(); start.setHours(0, 0, 0, 0)
  const end = new Date(start); end.setDate(end.getDate() + 1)
  assert.equal(database.getRequestStats(start.toISOString(), end.toISOString()).todaySuccess, 103)
  assert.equal(database.listApiRequests(100).length, 100)
  const inspect = new Database(file, { readonly: true })
  const scopes = inspect.prepare('SELECT scope, value FROM service_state').all()
  assert.equal(JSON.stringify(scopes).includes('fixture-A'), false)
  const tokenTime = inspect.prepare("SELECT updated_at FROM settings WHERE key='watermarkApiToken'").get().updated_at
  database.updateSettings({ outputDir: path.join(profile, 'output') })
  assert.equal(inspect.prepare("SELECT updated_at FROM settings WHERE key='watermarkApiToken'").get().updated_at, tokenTime)
  inspect.close()
  const { waitForSubmissionStarted } = await import('../dist-electron/executor.js')
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { sandbox: true } })
  const check = async (html) => {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    return waitForSubmissionStarted(win, 'seedance_2_0_mini', '新对话', '用户的原始提示词', 1)
  }
  const promiseOnly = await check('<p>已生成代码</p><p>正在渲染，请等待成片输出。</p><textarea></textarea>')
  assert.equal(promiseOnly.confirmed || promiseOnly.pending, false)
  const nativeTask = await check('<div class="video-task">视频生成中</div><textarea></textarea>')
  assert.equal(nativeTask.pending, true)
  const formal = await check('<p>本次使用 Seedance 2.0 Mini 生成，预计等待 10 分钟。视频生成好后，我会主动发送给你。</p><textarea></textarea>')
  assert.equal(formal.confirmed, true)
  const manualInput = await check('<p>正在渲染，请等待成片输出。</p><textarea>手动输入中的文字</textarea><button aria-label="停止回答">停止</button>')
  assert.equal(manualInput.hasDraft, true)
  assert.equal(manualInput.responding, true)
  win.destroy()
  console.log('ISOLATED_DATABASE_OK')
} catch (error) {
  console.error(error)
  exitCode = 1
} finally {
  fs.rmSync(profile, { recursive: true, force: true })
}
  app.exit(exitCode)
})
