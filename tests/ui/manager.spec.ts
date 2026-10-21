import { expect, test, type Page } from '@playwright/test';

async function installFixture(page: Page) {
  await page.addInitScript(() => {
    const now = new Date().toISOString();
    const generationDepleted = new URLSearchParams(location.search).has('generation-depleted');
    const accounts = [10, 8, 6, 3, 0].map((remaining, index) => ({
      id: index + 1, name: `账号 ${String(index + 1).padStart(3, '0')}`, remark: index === 0 ? '主号' : index === 2 ? '动画制作' : '',
      partition: `persist:doubao_account_${String(index + 1).padStart(3, '0')}`, loginStatus: 'logged_in', currentStatus: index === 2 ? 'busy' : 'idle',
      dailyQuotaLimit: 10, quotaRemaining: remaining, quotaUsedToday: 10 - remaining, lastUsedAt: now, createdAt: now, updatedAt: now,
      dailyQuotaExhausted: generationDepleted && index === 0, availableQuota: generationDepleted && index === 0 ? 0 : remaining,
      quotaExhaustedReason: generationDepleted && index === 0 ? '今日视频生成免费次数用完了，你明天再来找我继续吧。' : null,
      quotaDate: '2026-10-20', nextQuotaResetAt: '2026-10-20T16:00:00.000Z', runningTaskCount: index === 2 ? 2 : 0, queuedTaskCount: index === 2 ? 1 : 0, maxConcurrentTasks: 3
    }));
    let settings: any = {
      apiServiceEnabled: true, apiPort: 17888, apiKey: 'fixture-key', executorEnabled: true, showExecutorWindow: false, autoCloseExecutorWindow: true,
      doubaoChatUrl: 'https://www.doubao.com/chat', defaultModel: 'seedance_2_0_mini', dailyQuotaLimit: 10, miniCost: 2, fastCost: 3,
      dailyResetTime: '00:00', generationTimeoutSeconds: 900, maxConcurrentAccounts: 5, maxConcurrentTasksPerAccount: 3, retryCount: 1, autoRemoveWatermark: true,
      watermarkApiUrl: 'https://example.invalid/parse', watermarkApiToken: 'fixture-only', outputDir: ''
    };
    const base = { model: 'seedance_2_0_mini', aspectRatio: '16:9', source: 'infinite-canvas', referenceImagePath: null, removeWatermark: true, callbackUrl: null,
      doubaoThreadUrl: null, rawVideoUrl: null, cleanVideoUrl: null, outputVideoPath: null, quotaRefunded: false, createdAt: now, updatedAt: now, finishedAt: null, error: null };
    const requests: any[] = [
      { ...base, id: 4, requestId: 'doubao-ui-confirmation', accountId: 3, accountName: '账号 003', accountPartition: accounts[2].partition, status: 'running',
        message: '尚未确认视频启动，60 秒后补发“确认生成”', prompt: '人物设定：同一位女性，温暖二维水彩风格。\n0—2 秒：从办公桌前起身。\n2—5 秒：在走廊缓慢走动。\n5—10 秒：窗边舒展双臂。\n旁白原字保留，16:9，10秒。' },
      { ...base, id: 3, requestId: 'doubao-ui-watermark', accountId: 4, accountName: '账号 004', accountPartition: accounts[3].partition, status: 'failed',
        message: '去水印次数已耗尽：API Token调用次数已耗尽', prompt: '完整提示词示例：傍晚，女性靠在沙发上，镜头缓慢拉远。'.repeat(20),
        error: { stage: 'watermark', code: 'quota_exhausted', title: '去水印次数已耗尽', detail: 'API Token调用次数已耗尽', suggestion: '补充去水印次数后恢复结果，无需重新生成视频。', retryable: false } },
      { ...base, id: 2, requestId: 'doubao-ui-sharing', accountId: 2, accountName: '账号 002', accountPartition: accounts[1].partition, status: 'failed',
        message: '视频已生成，但未提取到豆包分享链接，无法获取去水印视频', prompt: '视频已经生成，等待同步分享资源。' },
      { ...base, id: 1, requestId: 'doubao-ui-success', accountId: 1, accountName: '账号 001', accountPartition: accounts[0].partition, status: 'success',
        message: '视频生成完成，去水印 MP4 地址已验证', prompt: '一条完成的动画任务。', cleanVideoUrl: 'https://example.invalid/result.mp4' }
    ];
    if (generationDepleted) requests.unshift({ ...base, id: 5, requestId: 'doubao-ui-generation-quota', accountId: 1,
      accountName: '账号 001', accountPartition: accounts[0].partition, status: 'failed', prompt: '既有失败任务，不重新生成',
      message: '豆包今日免费次数已用完；本任务指定了账号，不自动换号',
      error: { stage: 'account', code: 'doubao_daily_quota_exhausted', title: '豆包今日免费次数已用完', detail: accounts[0].quotaExhaustedReason,
        suggestion: '使用其他账号或明天重试', retryable: false } });
    const listeners: Array<() => void> = [];
    const fixture: any = { accounts, requests, listeners, saved: 0, recovered: 0, restarts: 0, settings: () => settings };
    (window as any).__fixture = fixture;
    const unknown = new URLSearchParams(location.search).has('unknown');
    const depleted = new URLSearchParams(location.search).has('depleted');
    (window as any).doubaoManager = {
      accounts: { list: async () => structuredClone(accounts), detectAll: async () => structuredClone(accounts), detectLogin: async () => accounts[0], open: async () => {}, create: async () => accounts[0],
        update: async (input: any) => Object.assign(accounts.find(a => a.id === input.id)!, input), resetQuota: async () => accounts[0], resetAllQuotas: async () => accounts, relogin: async () => true, delete: async () => true },
      settings: { get: async () => ({ ...settings }), update: async (input: any) => { settings = { ...settings, ...input }; fixture.saved++; return { ...settings }; } },
      apiServer: { status: async () => ({ version: '0.1.75', enabled: true, running: true, port: 17888, url: 'http://127.0.0.1:17888', message: '运行中' }), restart: async () => { fixture.restarts++; } },
      watermark: { status: async () => ({ configured: true, usage: unknown ? null : { remainingCount: depleted ? 0 : 468, usedCount: depleted ? 1000 : 532, totalLimit: 1000 },
        checkedAt: unknown ? null : now, usageUpdatedAt: unknown ? null : now, error: depleted ? requests[1].error : null }) },
      apiRequests: { list: async () => structuredClone(requests), todaySuccessCount: async () => 8, stats: async () => ({ todaySuccess: 8, todayFailed: 2, running: 1, queued: 0 }), clear: async () => true,
        recover: async (id: string) => { fixture.recovered++; requests.find(r => r.requestId === id).status = 'running'; return true; }, stop: async () => ({ stopped: true }) },
      operationLogs: { list: async () => [
        { id: 1, requestId: requests[1].requestId, accountId: 4, accountName: '账号 004', accountPartition: accounts[3].partition, action: '复制分享地址', status: 'success', message: '已取得当前视频分享地址', targetUrl: null, createdAt: now },
        { id: 2, requestId: requests[1].requestId, accountId: 4, accountName: '账号 004', accountPartition: accounts[3].partition, action: '去水印解析', status: 'failed', message: 'API Token调用次数已耗尽', targetUrl: null, createdAt: now }
      ], clear: async () => true },
      events: { onDataChanged: (listener: () => void) => { listeners.push(listener); return () => {}; } }
    };
  });
}

test.beforeEach(async ({ page }) => { await installFixture(page); });

test('shows compact separate balances, correct per-account capacity and current stage', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '账号管理' })).toBeVisible();
  await expect(page.locator('.balance-row').nth(1).locator('.balance-value')).toContainText('468');
  await expect(page.locator('.capacity')).toHaveText('Mini 13 次/Fast 8 次');
  await expect(page.getByText('等待启动确认', { exact: true })).toBeVisible();
  await expect(page.locator('.account-task-count').nth(2)).toContainText('执行 2/3');
  await expect(page.locator('.account-task-count').nth(2)).toContainText('排队 1');
  await expect(page.locator('.balance-row').first()).toContainText('下次 10/21 00:00');
  const used = page.getByRole('progressbar', { name: '账号已用额度', exact: true });
  await expect(used.first()).toHaveAttribute('aria-valuenow', '0');
  await expect(used.first().locator('span')).toHaveAttribute('style', 'width: 0%;');
  await expect(used.last()).toHaveAttribute('aria-valuenow', '10');
  await expect(used.last().locator('span')).toHaveAttribute('style', 'width: 100%;');
  expect(await used.first().locator('span').evaluate(el => getComputedStyle(el).backgroundColor)).toBe(await used.last().locator('span').evaluate(el => getComputedStyle(el).backgroundColor));
  await expect(page.locator('.service-balances')).toHaveCSS('border-radius', '0px');
  await page.screenshot({ path: 'test-results/accounts-desktop.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('filters watermark failures and restores an existing result from live detail drawer', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '接口日志' }).click();
  await page.getByLabel('问题分类').selectOption('quota_exhausted');
  await expect(page.locator('.logs-table tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: '详情', exact: true }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByRole('heading', { name: '去水印次数已耗尽' })).toBeVisible();
  await expect(drawer.getByText('补充去水印次数后恢复结果，无需重新生成视频。')).toBeVisible();
  await page.screenshot({ path: 'test-results/error-drawer-desktop.png', fullPage: true });
  await drawer.getByRole('button', { name: '恢复结果', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__fixture.recovered)).toBe(1);
  await expect(drawer.locator('.failure-detail')).toHaveCount(0);
});

test('preserves unsaved token edits across automatic refresh and saves without API restart', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '配置管理' }).click();
  const token = page.getByLabel('接口 Token');
  await expect(page.getByLabel('单账号并发上限')).toHaveValue('3');
  await expect(page.getByLabel('总任务并发上限')).toHaveValue('5');
  await expect(page.getByLabel('每日重置时间（北京时间）')).toHaveAttribute('readonly', '');
  await token.fill('new-fixture-value');
  await page.evaluate(() => (window as any).__fixture.listeners.forEach((listener: () => void) => listener()));
  await page.waitForTimeout(100);
  await expect(token).toHaveValue('new-fixture-value');
  await expect(page.getByText('有未保存的修改', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '保存配置' }).click();
  await expect(page.getByText('配置已保存', { exact: true }).first()).toBeVisible();
  expect(await page.evaluate(() => (window as any).__fixture.restarts)).toBe(0);
});

test('keeps unknown balance distinct from zero and fits a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?unknown');
  await expect(page.getByText('尚未同步', { exact: true })).toBeVisible();
  await expect(page.locator('.balance-row').nth(1).locator('.balance-value')).toContainText('—');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/accounts-mobile.png', fullPage: true });
  await page.goto('/?depleted');
  await expect(page.locator('.service-alert')).toContainText('补充去水印次数后恢复结果');
  await expect(page.locator('.balance-row').nth(1).locator('.balance-value')).toContainText('0');
});

test('shows provider-exhausted accounts unavailable without falsifying local spending', async ({ page }) => {
  await page.goto('/?generation-depleted');
  const row = page.locator('.accounts-table tbody tr').first();
  await expect(row).toContainText('今日次数已用完');
  await expect(row).toContainText('今日免费次数已用完');
  await expect(row).toContainText('Mini 0 次');
  await expect(row).toContainText('Fast 0 次');
  await expect(row).not.toContainText('剩余 10');
  await expect(page.locator('.balance-row').first().locator('.balance-value')).toContainText('17');
  await expect(page.getByRole('progressbar', { name: '账号池已用或不可用额度' })).toHaveAttribute('aria-valuenow', '33');
  await expect(page.getByRole('progressbar', { name: '豆包今日免费次数已用完', exact: true }).locator('span')).toHaveAttribute('style', 'width: 100%;');
  expect(await page.evaluate(() => (window as any).__fixture.accounts[0].quotaUsedToday)).toBe(0);
  await page.screenshot({ path: 'test-results/provider-quota-desktop.png', fullPage: true });
  await page.getByLabel('状态筛选').selectOption('exhausted');
  await expect(page.locator('.accounts-table tbody tr')).toHaveCount(2);
  await page.getByRole('button', { name: '接口日志' }).click();
  await page.getByLabel('问题分类').selectOption('account');
  await expect(page.locator('.logs-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.logs-table tbody tr')).toContainText('豆包今日免费次数已用完');
  await page.getByRole('button', { name: '详情', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('今日视频生成免费次数用完了');
});
