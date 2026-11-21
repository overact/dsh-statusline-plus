import { existsSync } from 'node:fs'
import { readFile, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { installHostModules, uiRequire } from './ui-fixture.mjs'
import { root, excerpt } from './verification.mjs'
import { PROVIDER_PRESETS } from '../lib/provider-presets.js'

// README and docs images. The real components render inside a neutral wireframe
// of the DSH window, so every capture shows where a piece lives; a detail panel
// is captured together with the chip that opens it. Public demo data only:
// every request is answered here, and the network is blocked.
const FILES = ['overview', 'quota-panel', 'peak-panel', 'cost-panel', 'subagents-panel', 'model-quota-bar', 'settings', 'settings-quota', 'settings-sources']
// Captures an earlier layout of this script wrote; removed so docs/images holds only what README uses.
const RETIRED = ['bottom-bar', 'header-quotas']
const NOW = '2026-10-09T03:00:00Z' // 11:00 Beijing on a weekday: inside a peak window

const WIREFRAME_CSS = `
  :root{--dsw-alias-label-primary:#222;--dsw-alias-label-secondary:#626870;--dsw-alias-label-tertiary:#899099;--dsw-alias-bg-overlay:#fff;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f6f7f9;--dsw-alias-border-l1:#e5e7eb;--dsw-alias-border-l2:#cdd1d7;--dsw-alias-brand-primary:#4d6bfe;--dsw-alias-state-business-primary:#4d6bfe;--dsw-alias-state-success-primary:#22c55e;--dsw-alias-state-warn-primary:#d97706;--dsw-alias-state-warn-label:#eab308;--dsw-alias-state-error-primary:#d92d20;--dsw-alias-interactive-bg-hover:#0000000d}
  *{box-sizing:border-box}
  body{font:14px Arial,sans-serif;background:#fff;color:#222;margin:0;padding:32px}
  #stage{width:1000px}
  .wf-win{position:relative;width:1000px;height:470px;display:grid;grid-template-columns:176px 1fr;border:1px solid #d9dde3;border-radius:12px;overflow:hidden;background:#fff;box-shadow:0 1px 2px #0000000a}
  .wf-side{display:flex;flex-direction:column;gap:6px;padding:14px 12px 10px;background:#f6f7f9;border-right:1px solid #e5e7eb}
  .wf-brand{display:flex;align-items:center;gap:8px;margin-bottom:12px;font-weight:600;color:#3a3f45}
  .wf-logo{width:18px;height:18px;border-radius:5px;background:#4d6bfe}
  .wf-item{height:28px;border-radius:7px;display:flex;align-items:center;padding:0 10px}
  .wf-item.active{background:#e8ebf0}
  .wf-bar{height:7px;border-radius:4px;background:#d7dbe1}
  .wf-foot{margin-top:auto;display:flex;align-items:center;gap:2px;padding-top:8px;border-top:1px solid #e5e7eb}
  .wf-foot .dsh-sidebar-footer-action{width:30px;height:30px;border:0;background:transparent;border-radius:7px;display:inline-flex;align-items:center;justify-content:center;color:#626870;cursor:pointer;padding:0}
  .wf-ghost{width:16px;height:16px;border-radius:50%;border:2px solid #c9ced6;margin:0 7px}
  .wf-main{display:flex;flex-direction:column;min-width:0}
  .wf-head{display:flex;align-items:center;justify-content:space-between;gap:12px;height:52px;padding:0 16px;border-bottom:1px solid #eceef1}
  .wf-title{font-weight:600;color:#3a3f45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
  .wf-head .slp-header-group{flex:none;flex-wrap:nowrap}
  .wf-chat{flex:1;display:flex;flex-direction:column;gap:10px;padding:22px 28px;overflow:hidden}
  .wf-user{align-self:flex-end;width:46%;padding:12px 14px;border-radius:12px;background:#f1f3f6;display:flex;flex-direction:column;gap:7px}
  .wf-reply{width:78%;display:flex;flex-direction:column;gap:9px;padding:6px 2px}
  .wf-composer{margin:0 20px;border:1px solid #dfe3e8;border-radius:14px;padding:12px 12px 8px;background:#fff}
  .wf-input{color:#a3a9b1;height:34px}
  .wf-tools{display:flex;align-items:center;justify-content:space-between}
  .wf-model{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 8px;border:0;border-radius:8px;background:0 0;font:13px Arial,sans-serif;color:#3a3f45}
  .wf-send{width:28px;height:28px;border-radius:50%;background:#4d6bfe}
  .wf-dock{padding:8px 20px 12px}
  .wf-dock .slp-subhead{display:none}
  .wf-dock .slp-preview{padding:4px 2px;border:0;background:transparent}
  .wf-callout{position:absolute;border:2px solid #4d6bfe;border-radius:10px;pointer-events:none}
  .wf-num{position:absolute;width:22px;height:22px;border-radius:50%;background:#4d6bfe;color:#fff;font:bold 13px/22px Arial,sans-serif;text-align:center;box-shadow:0 0 0 3px #fff}
  .wf-legend{display:grid;grid-template-columns:1fr 1fr;gap:8px 24px;margin-top:16px;font-size:13px;color:#3a3f45}
  .wf-legend span{display:flex;align-items:center;gap:8px}
  .wf-legend b{flex:none;width:20px;height:20px;border-radius:50%;background:#4d6bfe;color:#fff;font-size:12px;line-height:20px;text-align:center}
  body:not(.wf-annotated) .wf-callout,body:not(.wf-annotated) .wf-num{display:none}
  .wf-picker-scene{position:relative;width:520px;height:292px}
  .wf-picker-scene .wf-composer{position:absolute;left:0;right:0;bottom:0;margin:0}
  .wf-menu{position:absolute;left:12px;bottom:92px;width:320px;padding:6px;border:1px solid #e1e4e9;border-radius:12px;background:#fff;box-shadow:0 8px 24px #0000001a}
  .wf-menu-head{padding:6px 8px 4px;font-size:12px;color:#899099}
  .wf-menu .wf-model{display:flex;width:100%;height:36px;padding:5px 8px;text-align:left}
  .wf-menu .wf-model[data-selected]{background:#f1f3f6}
  .slp-mq-amount{margin-left:auto}
  /* The Host's MenuSurface paints the floating surface; the fixture's stand-in is a bare div. */
  .slp-anchored{background:#fff;border:1px solid #e1e4e9;border-radius:12px;box-shadow:0 8px 24px #0000001f}
  .wf-settings{width:680px}
`

let browser
try {
  const { chromium } = uiRequire('playwright')
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined)
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
  const page = await browser.newPage({ viewport: { width: 1100, height: 820 }, deviceScaleFactor: 2, timezoneId: 'Asia/Shanghai' })
  await page.clock.install({ time: new Date(NOW) })
  await page.clock.pauseAt(new Date(NOW))
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route(/^https?:/, route => route.abort())
  await page.setContent(`<!doctype html><html lang="en"><head><style>${WIREFRAME_CSS}</style></head><body><div id="stage"></div></body></html>`)
  for (const name of ['react', 'react-dom']) {
    await page.addScriptTag({ path: join(dirname(uiRequire.resolve(name + '/package.json')), 'umd', name + '.development.js') })
  }
  await installHostModules(page)
  await page.evaluate(() => {
    window.__ModuleLoader__ = { load(spec) { window.slpDemo = spec.factory(window.slpHostModule) } }
  })
  const source = await readFile(join(root, 'lib/client.js'), 'utf8')
  if (!source.includes('return module.exports')) throw new Error('Client factory format changed')
  await page.addScriptTag({ content: source.replace('return module.exports',
    'return Object.assign({}, module.exports, {LayoutPreview, SettingsPage, QuotaLine, DeepseekPeakChip, PeakFooterDot, RestartFooterButton, ModelQuotaLabel})') })
  await page.evaluate(providers => {
    const { React, ReactDOM, slpDemo: demo } = window
    const h = React.createElement
    // Every route the demo components ask for, answered with sample data.
    const reply = data => ({ status: 200, ok: true, json: async () => data })
    const windows = (used, reset) => ({ ok: true, data: { style: 'windows', chipWindows: 2, fetchedAt: Date.now(),
      windows: [{ id: '5h', label: '5h', minutes: 300, usedPercent: used, remainingPercent: 100 - used, resetInSec: reset }] } })
    const routes = {
      '/statusline/api/peak-schedule': { ok: false },
      '/statusline/api/restart': { ok: true, data: { soft: true, full: true, unit: 'dsh.service',
        update: { available: true, latest: '0.2.3', installed: '0.2.2', helper: true } } },
      '/statusline/api/claude-quota': windows(34, 3600),
      '/statusline/api/codex-quota': windows(62, 7200),
      '/statusline/api/antigravity-quota': windows(88, 1800),
      '/statusline/api/provider-quota': { ok: true, data: { style: 'balance', remaining: 51.43, currency: 'CNY', fetchedAt: Date.now() } },
    }
    window.fetch = async url => {
      const path = String(url).split('?')[0]
      if (path in routes) return reply(routes[path])
      throw new Error('Unexpected demo request: ' + url)
    }
    const config = { enabled: true, showGit: true, showCwd: true, showContext: true, showTps: true, showCost: true, showActivity: true, showTools: true,
      componentOrder: ['git', 'context', 'tps', 'cost', 'activity', 'tools'], quotaAuto: true, quotaOnStep: true, quotaPercentMode: 'used',
      showQuota: true, modelQuotaBar: true, modelQuotaRows: true, showClaudeQuota: true, showCodexQuota: true, showAntigravityQuota: true, showOpenCodeQuota: true,
      hideBottomOnNarrow: false, showDeepseekPeak: true, showPeakDot: true, deepseekPeakCountdown: true, showRestartButton: true,
      providers, cacheTtlMs: 60000, fetchTimeoutMs: 10000 }
    const cleanups = []
    const scope = { getSnapshot: () => ({ writable: true, value: config }), subscribe: () => () => {}, mutate: () => { throw new Error('Demo must not change settings') } }
    demo.apply({ configForms: { get: () => scope }, get: () => ({ inject() {} }), effect(fn) { const cleanup = fn(); if (cleanup) cleanups.push(cleanup) } })

    const bar = width => h('div', { className: 'wf-bar', style: { width } })
    const sideItem = (width, active) => h('div', { className: 'wf-item' + (active ? ' active' : '') }, bar(width))
    const composer = model => h('div', { className: 'wf-composer' },
      h('div', { className: 'wf-input' }, 'Ask anything…'),
      h('div', { className: 'wf-tools' }, model, h('span', { className: 'wf-send' })))
    const modelButton = (props, extra) => h('button', Object.assign({ type: 'button', className: 'wf-model' }, extra),
      h(demo.ModelQuotaLabel, props))
    const now = Date.now()
    function Window() {
      return h('div', { className: 'wf-win', id: 'wf-win' },
        h('aside', { className: 'wf-side' },
          h('div', { className: 'wf-brand' }, h('span', { className: 'wf-logo' }), 'DSH'),
          sideItem('80%', true), sideItem('64%'), sideItem('72%'), sideItem('50%'), sideItem('68%'),
          h('div', { className: 'wf-foot', id: 'wf-foot' }, h('span', { className: 'wf-ghost' }),
            h(demo.PeakFooterDot), h(demo.RestartFooterButton))),
        h('main', { className: 'wf-main' },
          h('div', { className: 'wf-head', id: 'wf-head' },
            h('span', { className: 'wf-title' }, 'Refactor the parser'),
            h('div', { className: 'slp-header-group', id: 'wf-chips' },
              h('span', { id: 'wf-quotas', style: { display: 'inline-flex', gap: '6px' } },
                h(demo.QuotaLine, { provider: { id: 'deepseek-official', label: 'DeepSeek' }, now, ttlMs: 60000, refresh() {},
                  data: { style: 'balance', isAvailable: true, fetchedAt: now, balances: [{ currency: 'CNY', remaining: 12.34, granted: 2.34, toppedUp: 10 }] } }),
                h(demo.QuotaLine, { provider: { id: 'kimi-code', label: 'Kimi Code' }, now, ttlMs: 60000, refresh() {},
                  data: { style: 'windows', fetchedAt: now, windows: [
                    { label: '5h', usedPercent: 32, resetInSec: 7200 }, { label: 'Weekly', usedPercent: 18, resetInSec: 259200 },
                  ] } })),
              h('span', { id: 'wf-peak' }, h(demo.DeepseekPeakChip, { enabled: true, countdown: true })))),
          h('div', { className: 'wf-chat' },
            h('div', { className: 'wf-user' }, bar('92%'), bar('60%')),
            h('div', { className: 'wf-reply' }, bar('96%'), bar('88%'), bar('92%'), bar('54%')),
            h('div', { className: 'wf-reply' }, bar('90%'), bar('70%'))),
          composer(h('span', { className: 'wf-model' }, 'DeepSeek V4 Flash')),
          h('div', { className: 'wf-dock', id: 'wf-dock' }, h(demo.LayoutPreview, { config }))))
    }
    // The composer of an empty session, with the model picker open: the button
    // and every row carry their own subscription's rail, a balance its amount.
    const pickerRow = (id, provider, model, name, selected) => modelButton(
      { provider: { id: provider, name: provider }, model: { id: model, name }, placement: 'option', selected: !!selected },
      { id, 'data-selected': selected ? '' : undefined })
    function Picker() {
      return h('div', { className: 'wf-picker-scene', id: 'wf-picker' },
        h('div', { className: 'wf-menu' }, h('div', { className: 'wf-menu-head' }, 'Model'),
          pickerRow('mq-claude', 'claude', 'claude-opus-4-5', 'Claude Opus 4.5', true),
          pickerRow('mq-codex', 'codex', 'gpt-5.2-codex', 'GPT-5.2 Codex'),
          pickerRow('mq-antigravity', 'antigravity', 'gemini-3-pro', 'Gemini 3 Pro'),
          pickerRow('mq-deepseek', 'deepseek', 'deepseek-v4-flash', 'DeepSeek V4 Flash')),
        composer(modelButton({ provider: { id: 'claude', name: 'Claude' }, model: { id: 'claude-opus-4-5', name: 'Claude Opus 4.5' }, placement: 'trigger', selected: true },
          { id: 'mq-trigger' })))
    }
    const stage = ReactDOM.createRoot(document.getElementById('stage'))
    window.renderScene = name => {
      document.body.classList.toggle('wf-annotated', name === 'overview')
      stage.render(name === 'picker' ? h(Picker) : name === 'settings' ? h('div', { className: 'wf-settings' }, h(demo.SettingsPage)) : h(Window))
    }
    window.closeDemo = () => { stage.unmount(); cleanups.reverse().forEach(fn => fn()) }
    window.renderScene('window')
  }, PROVIDER_PRESETS)

  const folder = join(root, 'docs/images')
  await mkdir(folder, { recursive: true })
  const pad = 14
  // The union of several elements' boxes, padded, as a page clip.
  const clipAround = async selectors => {
    const boxes = []
    for (const selector of selectors) {
      const box = await page.locator(selector).first().boundingBox()
      if (!box) throw new Error('Nothing to capture at ' + selector)
      boxes.push(box)
    }
    const x = Math.max(0, Math.min(...boxes.map(b => b.x)) - pad), y = Math.max(0, Math.min(...boxes.map(b => b.y)) - pad)
    return { x, y, width: Math.max(...boxes.map(b => b.x + b.width)) + pad - x, height: Math.max(...boxes.map(b => b.y + b.height)) + pad - y }
  }

  // Overview: the window with numbered callouts and a legend under it.
  await page.locator('#wf-dock .slp-cost-trigger').waitFor()
  await page.locator('#wf-foot .slp-rs-btn[data-update="true"]').waitFor()
  await page.locator('.slp-peak-trigger[data-peak="peak"]').waitFor()
  if (await page.locator('#wf-quotas .slp-quota-trigger').count() !== 2) throw new Error('Demo header is incomplete')
  await page.evaluate(() => {
    const win = document.getElementById('wf-win'), origin = win.getBoundingClientRect()
    const marks = [['#wf-quotas', 'Account balances and subscription quotas'], ['#wf-peak', 'DeepSeek peak / off-peak, with countdown'],
      ['#wf-dock .slp-row', 'Git, context, speed, API reference cost, subagents, tools'], ['#wf-foot .slp-peak-foot, #wf-foot .slp-rs-btn', 'Peak dot; reload, restart and DSH update']]
    marks.forEach(([selector, text], index) => {
      const rects = Array.from(document.querySelectorAll(selector)).map(node => node.getBoundingClientRect())
      const left = Math.min(...rects.map(r => r.left)) - origin.left - 5, top = Math.min(...rects.map(r => r.top)) - origin.top - 5
      const right = Math.max(...rects.map(r => r.right)) - origin.left + 5, bottom = Math.max(...rects.map(r => r.bottom)) - origin.top + 5
      win.insertAdjacentHTML('beforeend', `<div class="wf-callout" style="left:${left}px;top:${top}px;width:${right - left}px;height:${bottom - top}px"></div>`
        + `<div class="wf-num" style="left:${left - 11}px;top:${top - 11}px">${index + 1}</div>`)
      window.legend = (window.legend || '') + `<span><b>${index + 1}</b>${text}</span>`
    })
    document.getElementById('stage').insertAdjacentHTML('beforeend', `<div class="wf-legend" id="wf-legend">${window.legend}</div>`)
  })
  await page.evaluate(() => document.body.classList.add('wf-annotated'))
  await page.screenshot({ path: join(folder, 'overview.png'), clip: await clipAround(['#wf-win', '#wf-legend']), animations: 'disabled' })
  await page.evaluate(() => { document.body.classList.remove('wf-annotated'); document.getElementById('wf-legend').remove() })

  // Each detail panel with the chip that opens it and the strip it sits in.
  for (const [trigger, panel, context, file] of [
    ['#wf-quotas .slp-quota-trigger', '.slp-panel[role="dialog"]', '#wf-head', 'quota-panel.png'],
    ['#wf-peak .slp-peak-trigger', '.slp-peak-panel', '#wf-head', 'peak-panel.png'],
    ['#wf-dock .slp-cost-trigger', '.slp-cost-panel', '#wf-dock', 'cost-panel.png'],
    ['#wf-dock .slp-activity .slp-activity-trigger', '.slp-subagent-panel', '#wf-dock', 'subagents-panel.png'],
  ]) {
    await page.locator(trigger).first().click()
    await page.locator(panel).first().waitFor()
    await page.waitForFunction(selector => {
      const box = document.querySelector(selector)?.getBoundingClientRect()
      return box && box.top >= 0 && box.bottom <= innerHeight && box.width > 0
    }, panel)
    if (file === 'cost-panel.png' && await page.locator(panel + ' tbody tr').count() !== 3) throw new Error('Demo cost breakdown is incomplete')
    await page.screenshot({ path: join(folder, file), clip: await clipAround([context, panel]), animations: 'disabled' })
    await page.locator(trigger).first().click()
    await page.locator(panel).first().waitFor({ state: 'detached' })
  }

  // The model seat: the empty-session composer with the picker open.
  await page.evaluate(() => window.renderScene('picker'))
  for (const id of ['mq-trigger', 'mq-claude', 'mq-codex', 'mq-antigravity']) {
    await page.waitForFunction(id => { const node = document.getElementById(id); return !!node && getComputedStyle(node).backgroundImage.includes('linear-gradient') }, id)
  }
  await page.waitForFunction(() => document.querySelector('#mq-deepseek .slp-mq-amount')?.textContent === '¥51.43')
  await page.screenshot({ path: join(folder, 'model-quota-bar.png'), clip: await clipAround(['#wf-picker']), animations: 'disabled' })

  // Settings: the bottom-row section, then the quota sections.
  // A viewport taller than the page, so element boxes and clips share one origin.
  await page.setViewportSize({ width: 1100, height: 2400 })
  await page.evaluate(() => window.renderScene('settings'))
  await page.locator('.slp-order-list').waitFor()
  const section = name => `section.slp-settings-group[aria-label="${name}"]`
  await page.locator(section('Bottom status line')).screenshot({ path: join(folder, 'settings.png'), animations: 'disabled' })
  await page.locator(section('Quota and peak hours')).screenshot({ path: join(folder, 'settings-quota.png'), animations: 'disabled' })
  await page.locator(section('Quota sources and accounts') + ' details[data-source="deepseek"] > summary').click()
  await page.evaluate(() => scrollTo(0, 0))
  await page.locator(section('Quota sources and accounts')).screenshot({ path: join(folder, 'settings-sources.png'), animations: 'disabled' })
  await page.evaluate(() => window.closeDemo())

  await Promise.all(RETIRED.map(name => rm(join(folder, name + '.png'), { force: true })))
  if (errors.length) throw new Error(errors.join('; '))
  console.log(JSON.stringify({ ok: true, files: FILES.map(name => `docs/images/${name}.png`), data: 'public demo only' }))
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: excerpt(error.message) })); process.exitCode = 1
} finally { await browser?.close() }
