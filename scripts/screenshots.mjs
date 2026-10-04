import { existsSync } from 'node:fs'
import { readFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { uiRequire } from './ui-fixture.mjs'
import { root, excerpt } from './verification.mjs'

// Render the real components with public demo data, never a live account.
let browser
try {
  const { chromium } = uiRequire('playwright')
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined)
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
  const page = await browser.newPage({ viewport: { width: 960, height: 1100 }, deviceScaleFactor: 2 })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route(/^https?:/, route => route.abort())
  await page.setContent(`<!doctype html><html lang="en"><head><style>
    :root{--dsw-alias-label-primary:#222;--dsw-alias-label-secondary:#626870;--dsw-alias-label-tertiary:#899099;--dsw-alias-bg-overlay:#fff;--dsw-alias-bg-layer-2:#f6f7f9;--dsw-alias-border-l1:#e5e7eb;--dsw-alias-border-l2:#cdd1d7;--dsw-alias-state-success-primary:#22c55e;--dsw-alias-state-warn-label:#eab308}
    body{font:14px Arial,sans-serif;background:#fff;color:#222;margin:0;padding:24px}
    #root{max-width:900px;margin:440px auto 0}.slp-preview{background:#fff}
  </style></head><body><div id="root"></div></body></html>`)
  for (const name of ['react', 'react-dom']) {
    await page.addScriptTag({ path: join(dirname(uiRequire.resolve(name + '/package.json')), 'umd', name + '.development.js') })
  }
  await page.evaluate(() => {
    window.__ModuleLoader__ = { load(spec) { window.slpDemo = spec.factory(name => {
      if (name !== 'react') throw new Error('Unexpected demo dependency')
      return window.React
    }) } }
  })
  const source = await readFile(join(root, 'lib/client.js'), 'utf8')
  if (!source.includes('return module.exports')) throw new Error('Client factory format changed')
  await page.addScriptTag({ content: source.replace('return module.exports', 'return Object.assign({}, module.exports, {LayoutPreview, SettingsPage, ProviderQuotaLine, PeakPanel, deepseekPeakStatus})') })
  await page.evaluate(() => {
    const config = { enabled: true, showGit: true, showCwd: true, showContext: true, showTps: true, showCost: true, showActivity: true, showTools: true,
      componentOrder: ['git', 'context', 'tps', 'cost', 'activity', 'tools'], quotaAuto: true, quotaOnStep: true,
      showDeepseekPeak: true, showPeakDot: true, deepseekPeakCountdown: true, providers: [], cacheTtlMs: 60000, fetchTimeoutMs: 10000 }
    const cleanups = []
    const scope = { getSnapshot: () => ({ mode: 'host', writable: true, value: config }), subscribe: () => () => {}, mutate: () => { throw new Error('Demo must not change settings') } }
    window.slpDemo.apply({ configForms: { get: () => scope }, get: () => ({ inject() {} }), effect(fn) { const cleanup = fn(); if (cleanup) cleanups.push(cleanup) } })
    window.slpDemoConfig = config
    window.slpDemoRoot = window.ReactDOM.createRoot(document.getElementById('root'))
    window.renderDemo = settings => {
      document.getElementById('root').style.marginTop = settings ? '0' : '440px'
      window.slpDemoRoot.render(window.React.createElement(settings ? window.slpDemo.SettingsPage : window.slpDemo.LayoutPreview, { config }))
    }
    window.closeDemo = () => { window.slpDemoRoot.unmount(); cleanups.reverse().forEach(fn => fn()) }
    window.renderDemo(false)
  })
  const folder = join(root, 'docs/images')
  await mkdir(folder, { recursive: true })
  await page.locator('.slp-preview .slp-cost-trigger').waitFor()
  await page.locator('.slp-preview').screenshot({ path: join(folder, 'bottom-bar.png') })
  for (const [trigger, panel, file] of [
    ['.slp-cost-trigger', '.slp-cost-panel', 'cost-panel.png'],
    ['.slp-activity .slp-activity-trigger', '.slp-subagent-panel', 'subagents-panel.png'],
  ]) {
    await page.locator(trigger).click()
    const node = page.locator(panel)
    await node.waitFor()
    await page.waitForFunction(selector => {
      const box = document.querySelector(selector)?.getBoundingClientRect()
      return box && box.top >= 0 && box.bottom <= innerHeight
    }, panel)
    if (file === 'cost-panel.png' && await node.locator('tbody tr').count() !== 3) throw new Error('Demo cost breakdown is incomplete')
    await node.screenshot({ path: join(folder, file), animations: 'disabled' })
    await page.locator(trigger).click()
  }
  await page.evaluate(() => window.renderDemo(true))
  await page.locator('.slp-order-list').waitFor()
  const box = await page.locator('.slp-set').boundingBox()
  await page.screenshot({ path: join(folder, 'settings.png'), clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 950) } })
  await page.evaluate(() => {
    const now = Date.parse('2026-10-09T03:00:00Z')
    window.slpDemoRoot.render(window.React.createElement(window.slpDemo.ProviderQuotaLine, {
      provider: { id: 'deepseek-official', label: 'DeepSeek' }, ttlMs: 60000, now, refresh() {},
      data: { style: 'balance', isAvailable: true, fetchedAt: now, balances: [
        { currency: 'CNY', remaining: 12.34, granted: 2.34, toppedUp: 10 },
        { currency: 'USD', remaining: 0.42, granted: 0.12, toppedUp: 0.3 },
      ] },
    }))
  })
  await page.locator('.slp-quota-trigger').click()
  await page.locator('.slp-panel[role="dialog"]').screenshot({ path: join(folder, 'quota-panel.png'), animations: 'disabled' })
  await page.evaluate(() => {
    const now = Date.parse('2026-10-09T03:00:00Z')
    window.slpDemoRoot.render(window.React.createElement(window.slpDemo.PeakPanel, { now, status: window.slpDemo.deepseekPeakStatus(now),
      compact: true, countdown: true, style: { position: 'relative', inset: 'auto', transform: 'none' } }))
  })
  await page.locator('.slp-peak-panel').screenshot({ path: join(folder, 'peak-panel.png') })
  await page.evaluate(() => window.closeDemo())
  if (errors.length) throw new Error(errors.join('; '))
  console.log(JSON.stringify({ ok: true, files: ['bottom-bar', 'cost-panel', 'subagents-panel', 'settings', 'quota-panel', 'peak-panel'].map(name => `docs/images/${name}.png`), data: 'public demo only' }))
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: excerpt(error.message) })); process.exitCode = 1
} finally { await browser?.close() }
