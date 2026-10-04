import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { artifacts, excerpt, redact, root } from './verification.mjs'
import { mountFixture, uiRequire } from './ui-fixture.mjs'

function options(args) {
  const opts = { panel: 'all', live: false, session: null, service: 'dsh-web', output: null }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--live') opts.live = true
    else if (['--panel', '--session', '--service', '--output'].includes(arg)) {
      const value = args[++i]
      if (!value || value.startsWith('--')) throw new Error(arg + ' requires a value')
      opts[arg.slice(2)] = value
    } else throw new Error('Unknown option: ' + arg)
  }
  if (!['all', 'cost', 'subagents'].includes(opts.panel)) throw new Error('--panel must be cost, subagents or all')
  if (opts.live && !opts.session) throw new Error('--live requires an explicitly selected --session ID')
  return opts
}

function authUrl(service) {
  const provided = process.env.DSH_AUTH_URL
  const journal = provided ? '' : execFileSync('journalctl', ['--user', '-u', service, '--grep', 'https?://(127\\.0\\.0\\.1|localhost):[0-9]+/?\\?token=', '-n', '1', '--no-pager'], { encoding: 'utf8', timeout: 5000 })
  const value = provided || journal.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/?\?token=[A-Za-z0-9_-]+/g)?.at(-1)
  if (!value) throw new Error('No local DSH login URL found; provide DSH_AUTH_URL in the environment')
  if (!['localhost', '127.0.0.1'].includes(new URL(value).hostname)) throw new Error('Live verification accepts only a local DSH URL')
  return value
}

async function mountLive(page, session) {
  await page.addInitScript(() => {
    let loader
    Object.defineProperty(window, '__ModuleLoader__', { configurable: true, get: () => loader, set(value) {
      loader = value; let create = value.create
      Object.defineProperty(value, 'create', { configurable: true, get: () => (...args) => {
        const result = create.apply(value, args); window.slpModules = result; return result
      }, set(fn) { create = fn } })
    } })
  })
  await page.goto(authUrl(session.service), { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.slpModules?.entries.loader && window.__ModuleLoader__.mode === 'live', null, { timeout: 30000 })
  await page.waitForFunction(() => !window.slpModules.entries.state.getSnapshot().syncing && window.slpModules.entries.loader.ctx.sessions.list.getSnapshot().phase === 'ready', null, { timeout: 30000 })
  return page.evaluate(async id => {
    const ctx = window.slpModules.entries.loader.ctx
    await ctx.sessions.refresh()
    if (!ctx.sessions.list.getSnapshot().ids.includes(id)) throw new Error('Selected session was not found')
    await ctx.sessions.refreshProjections(id)
    const list = ctx.sessions.list.getSnapshot(), values = list.projectionsBySession[id]?.values || list.byId[id]?.projectionValues || {}
    const ui = ctx.uiWorkspace || ctx.get('uiWorkspace')
    if (typeof ui?.openSession !== 'function') throw new Error('Native session navigation is unavailable')
    ui.openSession(id)
    return { hasCosts: !!values.statuslineMetrics?.session?.pricedMessages,
      subagents: Array.isArray(values.subagentCatalog) ? values.subagentCatalog.length : 0 }
  }, session.session)
}

async function geometry(page, panel, maxWidth) {
  // Wait for the final animation frame and the native responsive layout.
  await panel.evaluate(node => new Promise(resolveDone => {
    const animations = node.getAnimations(); Promise.all(animations.map(animation => animation.finished.catch(() => {}))).then(resolveDone)
  }))
  await page.waitForFunction(selector => {
    const node = document.querySelector(selector), box = node?.getBoundingClientRect()
    return box && box.left >= 0 && box.right <= innerWidth && node.contains(document.elementFromPoint(box.left + 8, box.top + 18))
  }, await panel.getAttribute('class').then(classes => '.' + classes.split(' ').join('.')))
  const box = await panel.boundingBox()
  if (!box || box.width > maxWidth + 2 || box.height > 360) throw new Error('Panel is no longer compact')
  return { width: Math.round(box.width), height: Math.round(box.height) }
}

async function verifyCost(page, folder, live) {
  const trigger = page.locator('.slp-cost-trigger').first()
  await trigger.waitFor(); await trigger.click()
  const panel = page.locator('.slp-cost-panel').first()
  await panel.waitFor()
  if (!/\d\.\d{2}/.test(await trigger.textContent())) throw new Error('Missing two-decimal reference amount')
  const rows = panel.locator('tbody tr')
  const rowCount = await rows.count()
  if (rowCount < 3) throw new Error('Missing Input/Cache/Output breakdown')
  const tokens = await panel.locator('.slp-cost-tokens').allTextContents()
  if (tokens.length < 3 || tokens.some(text => !/^\d+(?:\.\d+)?[KM]$/.test(text))) throw new Error('Missing compact token counts; an older Host may need reloading')
  const proportions = await panel.locator('.slp-cost-bar').evaluateAll(bars => bars.map(bar => [...bar.children].reduce((sum, child) => sum + parseFloat(child.style.width), 0)))
  if (proportions.some(total => total !== 0 && Math.abs(total - 100) > 0.01)) throw new Error('Cost bar proportions do not sum to 100%')
  if (!live) {
    if (tokens.join('|') !== '12K|1M|0.2K') throw new Error('Token formatting differs from settled counts')
    const text = (await rows.allInnerTexts()).join(' ')
    if (!['Input', 'Cache', 'Output', '$2.00', '$3.00', '$5.00', '20%', '30%', '50%'].every(value => text.includes(value))) throw new Error('Missing component fees or shares')
  }
  await page.setViewportSize({ width: 390, height: 844 })
  const size = await geometry(page, panel, 250)
  const screenshot = join(folder, 'cost.png')
  await panel.screenshot({ path: screenshot, animations: 'disabled' })
  await trigger.click()
  return { panel: 'cost', ...size, rows: rowCount, screenshot: relative(root, screenshot) }
}

async function verifySubagents(page, folder, live, count) {
  if (live && count === 0) return { panel: 'subagents', skipped: 'Selected session has no subagents' }
  const trigger = page.locator('.slp-activity .slp-activity-trigger').first()
  await trigger.waitFor(); await trigger.click()
  const panel = page.locator('.slp-subagent-panel').first()
  await panel.waitFor()
  const size = await geometry(page, panel, 280)
  const model = panel.locator('.slp-subagent-model').first(), effort = panel.locator('.slp-subagent-effort').first()
  if (await effort.count()) {
    const m = await model.boundingBox(), e = await effort.boundingBox()
    if (m && e && e.x - m.x - m.width > 10) throw new Error('Reasoning effort is too far from the model')
  }
  const screenshot = join(folder, 'subagents.png')
  await panel.screenshot({ path: screenshot, animations: 'disabled' }); await trigger.click()
  if (!live) {
    const expect = label => page.waitForFunction(value => document.querySelector('.slp-activity .slp-activity-trigger')?.textContent === value, label)
    await expect('Subagents 0/2')
    await page.evaluate(() => window.setChildRunning(0, false)); await expect('Subagents 1/2')
    await page.clock.runFor(15000); await expect('Subagents 1/2')
    await page.evaluate(() => window.setChildRunning(1, false)); await expect('Subagents 2/2')
    await page.clock.runFor(5000)
    await page.waitForFunction(() => document.querySelector('.slp-activity .slp-activity-trigger')?.style.opacity === '0.5')
    await page.clock.runFor(10000)
    await page.waitForFunction(() => !document.querySelector('.slp-activity .slp-activity-trigger'))
    await page.evaluate(() => window.setChildRunning(0, true)); await expect('Subagents 1/2')
  }
  return { panel: 'subagents', ...size, lifecycle: live ? 'read-only snapshot' : 'progress/expiry/resumption passed', screenshot: relative(root, screenshot) }
}

let browser, folder
try {
  const opts = options(process.argv.slice(2)), errors = [], started = performance.now()
  folder = opts.output ? resolve(root, opts.output) : await artifacts('output/playwright/ui')
  await mkdir(folder, { recursive: true })
  let chromium
  try { ({ chromium } = uiRequire('playwright')) } catch { throw new Error('UI dependencies are missing; run npm run ui:install') }
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined)
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  page.setDefaultTimeout(8000)
  page.on('pageerror', error => errors.push(redact(error.message)))
  let network = 0
  page.on('request', request => { if (/^https?:/.test(request.url())) network++ })
  const data = opts.live ? await mountLive(page, opts) : (await mountFixture(page), { hasCosts: true, subagents: 2 })
  const checks = []
  if (opts.panel !== 'subagents') {
    if (!data.hasCosts) throw new Error('Selected session has no priced usage')
    checks.push(await verifyCost(page, folder, opts.live))
  }
  if (opts.panel !== 'cost') checks.push(await verifySubagents(page, folder, opts.live, data.subagents))
  if (!opts.live) await page.evaluate(() => window.slpFixtureRoot.unmount())
  if (errors.length || !opts.live && network) throw new Error(errors.join('; ') || 'Offline fixture made a network request')
  if (opts.live && await page.evaluate(() => window.slpModules.entries.state.getSnapshot().failures.length)) throw new Error('Native module loader reported failures')
  const report = { ok: true, mode: opts.live ? 'live' : 'fixture', durationMs: Math.round(performance.now() - started), checks, errors: 0 }
  await writeFile(join(folder, 'ui-report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} catch (error) {
  const report = { ok: false, error: excerpt(error.message) }
  if (folder) await writeFile(join(folder, 'ui-report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report)); process.exitCode = 1
} finally { await browser?.close() }
