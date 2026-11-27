import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { artifacts, excerpt, redact, root } from './verification.mjs'
import { mountChipFixture, mountFixture, mountModelBarFixture, mountResponsiveFixture, uiRequire } from './ui-fixture.mjs'

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
  if (!['all', 'cost', 'subagents', 'chip', 'modelbar', 'responsive', 'restart', 'reset'].includes(opts.panel)) throw new Error('--panel must be cost, subagents, chip, modelbar, responsive, restart, reset or all')
  if (opts.live && ['responsive', 'restart', 'reset'].includes(opts.panel)) throw new Error('Responsive, restart and reset verification use fixture state and are offline only')
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

// A clipping or masking ancestor keeps the box measurable but stops it hit-testing.
async function assertPanelVisible(page, panel) {
  await panel.waitFor()
  await page.waitForFunction(node => {
    const box = node.getBoundingClientRect()
    return [0.1, 0.5, 0.9].every(y => node.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height * y)))
  }, await panel.elementHandle(), { timeout: 5000 }).catch(() => { throw new Error('Quota panel is clipped by the header title cluster') })
}

async function verifyChip(page, folder) {
  const chip = page.locator('.slp-chip-fade').first()
  await chip.waitFor()
  const fontSize = await chip.evaluate(node => parseFloat(getComputedStyle(node).fontSize))
  // The header inherits 14px; every quota chip reads at the shared 13px metric.
  if (fontSize !== 13) throw new Error('Unavailable chip is not at the 13px chip metric: ' + fontSize)
  const durations = await chip.evaluate(node => node.getAnimations().map(animation => animation.effect.getTiming().duration))
  if (!durations.includes(10000)) throw new Error('Unavailable chip has no 10 s fade: ' + JSON.stringify(durations))
  if ((await chip.innerText()).trim() !== 'Subscription not found') throw new Error('Unavailable chip text changed')
  const screenshot = join(folder, 'chip.png')
  // The fade is the assertion above; a finished-animation screenshot would be blank.
  await chip.screenshot({ path: screenshot })
  // Past the deadline the status leaves the tree; a merely transparent chip would
  // still hold a slot in the header.
  await page.clock.runFor(10000)
  await chip.waitFor({ state: 'detached', timeout: 2000 })
  return { panel: 'chip', fontSize, fadeMs: 10000, screenshot: relative(root, screenshot) }
}

async function verifyModelBar(page, folder) {
  const trigger = page.locator('#mq-trigger')
  const gradient = node => getComputedStyle(node).backgroundImage
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#mq-trigger')).backgroundImage.includes('linear-gradient'))
  const size = await trigger.evaluate(node => getComputedStyle(node).backgroundSize)
  if (!/3px/.test(size)) throw new Error('Rail is not 3px tall: ' + size)
  // The Host's hover rule sets the `background` shorthand, which clears a
  // stylesheet-written background-image; the inline rail must survive it.
  await trigger.hover()
  if (!(await trigger.evaluate(gradient)).includes('linear-gradient')) throw new Error('Hovering the model button cleared its rail')
  // A picker row paints its own subscription, and a healthy balance shows the
  // amount instead of inventing a ratio.
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#mq-row-claude')).backgroundImage.includes('linear-gradient'))
  await page.waitForFunction(() => document.querySelector('#mq-row-deepseek .slp-mq-amount')?.textContent === '¥51.43')
  if ((await page.locator('#mq-row-deepseek').evaluate(gradient)) !== 'none') throw new Error('A healthy balance must not paint a proportion')
  // Wheel scrolling moves the row under a stationary pointer without firing
  // `mousemove`; the Host's own highlight would stay on the old row. The label
  // re-dispatches the Host's event, so the fixture's active row must follow.
  const box = await page.locator('#mq-scroll').boundingBox()
  if (!box) throw new Error('The model-menu scroll fixture is not visible')
  const x = box.x + box.width / 2, y = box.y + 20
  await page.mouse.move(x, y)
  const before = await page.locator('#mq-scroll [data-active="true"]').getAttribute('data-scroll-row')
  // The fixture runs on Playwright's fake clock, where the native wheel scroll
  // does not advance. Dispatch the wheel intent and move the real scroll
  // container; the bridge then follows.
  await page.evaluate(({ x, y }) => {
    const scroller = document.querySelector('#mq-scroll')
    scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, clientX: x, clientY: y, deltaY: 70 }))
    scroller.scrollTop = 70
  }, { x, y })
  await page.clock.runFor(50)
  await page.waitForFunction(({ x, y }) => {
    const scroller = document.querySelector('#mq-scroll')
    const row = document.elementFromPoint(x, y)?.closest?.('[data-scroll-row]')
    return row && row.getAttribute('data-active') === 'true'
  }, { x, y }, { timeout: 2000 })
  const after = await page.locator('#mq-scroll [data-active="true"]').getAttribute('data-scroll-row')
  if (after === before) throw new Error('The active row did not follow the scroll under the pointer')
  await page.mouse.move(0, 0)
  const screenshot = join(folder, 'modelbar.png')
  await page.screenshot({ path: screenshot, clip: { x: 0, y: 0, width: 380, height: 260 } })
  // Starting the conversation drops the button rail and keeps the picker rows.
  await page.evaluate(() => window.setComposerStarted(true))
  await page.waitForFunction(() => !getComputedStyle(document.querySelector('#mq-trigger')).backgroundImage.includes('linear-gradient'))
  if (!(await page.locator('#mq-row-claude').evaluate(gradient)).includes('linear-gradient')) throw new Error('Starting a conversation removed the picker rows')
  return { panel: 'modelbar', rail: '3px', hover: 'kept', balance: '¥51.43', started: 'button cleared, rows kept', scroll: 'active row follows the wheel', screenshot: relative(root, screenshot) }
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
  if (!live) {
    // An external child has no Session at all: its mode and running state must
    // come from the parent's settlement fold, never from a session lookup.
    const external = await panel.locator('.slp-activity-item', { hasText: 'External worker' }).innerText()
    if (!external.includes('External task')) throw new Error('External child mode is not labelled')
    if (external.includes('Status unknown')) throw new Error('External child running state is unknown')
    if (external.includes('—')) throw new Error('External child has no elapsed time')
  }
  const screenshot = join(folder, 'subagents.png')
  await panel.screenshot({ path: screenshot, animations: 'disabled' }); await trigger.click()
  if (!live) {
    const expect = label => page.waitForFunction(value => document.querySelector('.slp-activity .slp-activity-trigger')?.textContent === value, label)
    await expect('Subagents 0/3')
    await page.evaluate(() => window.setChildRunning(0, false)); await expect('Subagents 1/3')
    await page.clock.runFor(15000); await expect('Subagents 1/3')
    await page.evaluate(() => window.setChildRunning(1, false)); await expect('Subagents 2/3')
    await page.evaluate(() => window.setChildSettled(true)); await expect('Subagents 3/3')
    await page.clock.runFor(5000)
    await page.waitForFunction(() => document.querySelector('.slp-activity .slp-activity-trigger')?.style.opacity === '0.6')
    await page.clock.runFor(10000)
    await page.waitForFunction(() => !document.querySelector('.slp-activity .slp-activity-trigger'))
    await page.evaluate(() => window.setChildRunning(0, true)); await expect('Subagents 2/3')
  }
  return { panel: 'subagents', ...size, lifecycle: live ? 'read-only snapshot' : 'progress/expiry/resumption passed', screenshot: relative(root, screenshot) }
}

async function verifyRestart(page, folder) {
  await mountResponsiveFixture(page, { overrides: { enabled: true, showRestartButton: true } })
  // Simulate the other footer plugin's normalising rule: it forces every icon
  // button's colour to the grey label token. The green update arrow must keep
  // its own colour because it is a child badge, not the button's currentColor.
  await page.addStyleTag({ content: '#fixture-footer .slp-rs-btn{color:#61666b !important}#fixture-footer .slp-rs-btn>svg{width:18px !important;height:18px !important}' })
  const button = page.locator('#fixture-footer .slp-rs-btn')
  await button.waitFor()
  if (await button.getAttribute('data-update') !== 'true') throw new Error('The DSH update marker is missing')
  const badge = button.locator('.slp-rs-update-badge')
  await badge.waitFor()
  const colors = await page.evaluate(() => {
    const badge = document.querySelector('#fixture-footer .slp-rs-update-badge')
    const button = document.querySelector('#fixture-footer .slp-rs-btn')
    return { badge: getComputedStyle(badge).color, button: getComputedStyle(button).color }
  })
  const green = colors.badge.match(/\d+/g).map(Number)
  if (!(green.length >= 3 && green[1] > green[0] && green[1] > green[2])) throw new Error('Update arrow is not green: ' + colors.badge)
  if (colors.badge === colors.button) throw new Error('The footer colour override recoloured the badge')
  const buttonShot = join(folder, 'restart-button.png')
  await button.screenshot({ path: buttonShot })
  await button.click()
  const dialog = page.locator('dialog.slp-rs-dialog').first()
  await dialog.waitFor()
  await dialog.locator('button[data-variant="update"]').click()
  const progress = page.locator('.slp-rs-progress')
  await progress.waitFor()
  await page.clock.runFor(350)
  await progress.locator('.slp-rs-step[data-step="stop"][data-state="active"]').waitFor()
  const spin = await progress.locator('.slp-rs-step[data-step="stop"] .slp-rs-step-dot').evaluate(node => getComputedStyle(node).animationName)
  if (spin !== 'slp-rs-spin') throw new Error('Active update step is not animated: ' + spin)
  for (const [phase, step] of [['installing', 'install'], ['reconciling', 'reconcile'], ['starting', 'start']]) {
    await page.evaluate(phase => { window.slpRestart.job.phase = phase }, phase)
    await page.clock.runFor(300)
    await progress.locator(`.slp-rs-step[data-step="${step}"][data-state="active"]`).waitFor()
  }
  await page.clock.runFor(1100)
  const elapsed = await progress.locator('.slp-rs-elapsed').textContent()
  if (!/(elapsed|\u5df2\u7528\u65f6)/.test(elapsed)) throw new Error('Update progress has no elapsed line: ' + elapsed)
  await page.evaluate(() => {
    window.slpRestart.pid = 2
    window.slpRestart.hostVersion = '0.2.2-rc.1'
    window.slpRestart.job = { ...window.slpRestart.job, phase: 'rolled-back', error: 'unhealthy', previousVersion: '0.2.2-rc.1', logPath: '/fixture/statusline-host-update.log' }
  })
  await page.clock.runFor(300)
  await page.locator('.slp-rs-progress[data-state="rolled-back"]').waitFor()
  const rolled = await progress.textContent()
  if (!/roll(ed)? back|\u56de\u6ede/i.test(rolled)) throw new Error('Rollback was not explained: ' + rolled)
  if (await progress.locator('.slp-rs-actions button').count() < 2) throw new Error('Rollback has no retry/log/dismiss actions')
  const screenshot = join(folder, 'restart-progress.png')
  await page.screenshot({ path: screenshot })
  await progress.locator('.slp-rs-actions button').last().click()
  if (await page.locator('.slp-rs-progress').count()) throw new Error('Dismiss did not close the progress panel')
  return { panel: 'restart', lifecycle: 'green arrow badge, animated stop/install/reconcile/start steps, elapsed line, rollback actions passed', screenshot: relative(root, screenshot) }
}

// The sentence and scope's own line boxes, not the paragraph (which spans the
// float), so a post link sharing their last line can be told from one below it.
function measurePostLine() {
  const line = document.querySelector('.slp-reset-section .slp-reset-line')
  const link = line.querySelector('.slp-reset-link'), main = line.querySelector('.slp-reset-main')
  const lineRect = line.getBoundingClientRect(), linkRect = link.getBoundingClientRect()
  const range = document.createRange(); range.selectNodeContents(main)
  const rects = [...range.getClientRects()].filter(rect => rect.width > 0)
  const lastTop = rects.reduce((top, rect) => Math.max(top, rect.top), -Infinity)
  const last = rects.filter(rect => Math.abs(rect.top - lastTop) < 1)
  return { lineRight: lineRect.right, lineBottom: lineRect.bottom, linkLeft: linkRect.left, linkRight: linkRect.right, linkTop: linkRect.top,
    lastTop, lastRight: last.reduce((right, rect) => Math.max(right, rect.right), 0), lastBottom: last.reduce((bottom, rect) => Math.max(bottom, rect.bottom), 0),
    lines: new Set(rects.map(rect => Math.round(rect.top))).size }
}

// Reset drawer: waits for its own chip to load, slides down out of it at
// exactly the chip's width in the Host's menu material, one sentence in at
// most two lines, holds while hovered, leaves after resetAlertSeconds, shows
// once per page load until "Got it", and every details panel keeps listing it.
// Without its own chip it slides out of the chip the header has; with no chip
// at all it never shows.
async function verifyReset(page, folder) {
  const notice = (id, kind = 'codex') => ({ id, kind, type: 'direct_reset', phase: 'announced', at: null,
    window: { precision: 'approximate', from: Date.now() + 3600000, through: Date.now() + 3600000 },
    scope: 'Plus / Pro', url: 'https://aihot.news/codex-reset', postUrl: 'https://x.com/fixture/status/1' })
  const codex = { model: { provider: 'codex', model: 'gpt-5-codex' }, overrides: { quotaAuto: true, showCodexQuota: true } }
  // Each mount loads a fresh copy of the plugin into the same document; dispose
  // the previous one first, or its drawer host keeps polling and showing.
  const show = async (options, item, delayMs = 0) => {
    await page.evaluate(delay => { try { window.disposeResponsiveFixture?.() } catch (error) { /* already unmounted */ } window.slpResetNotices = []; window.slpQuotaDelayMs = delay }, delayMs)
    await mountResponsiveFixture(page, { ...options, overrides: { resetAlerts: 'on', resetAlertKinds: ['codex', 'antigravity'], resetAlertSeconds: 10, ...options.overrides } })
    await page.evaluate(value => { window.slpFixtureRoot.unmount(); window.slpResetNotices = Array.isArray(value) ? value : [value]; window.remountResponsiveFixture() }, item)
  }
  const drawer = page.locator('.slp-reset-drawer')
  // The drawer's readiness check runs on the fake clock.
  const appear = async (limitMs = 5000) => {
    for (let spent = 0; spent <= limitMs && !await drawer.count(); spent += 250) await page.clock.runFor(250)
    await drawer.waitFor()
  }
  // CSS animations run on real time, not Playwright's fake clock: settle them before measuring.
  const settle = () => page.evaluate(() => document.querySelectorAll('.slp-reset-sheet').forEach(sheet => sheet.getAnimations().forEach(animation => animation.finish())))
  // The page first: no drawer while its chip is still loading.
  await show(codex, notice('fixture-anchored'), 1500)
  await page.clock.runFor(1000)
  if (await drawer.count()) throw new Error('Reset drawer appeared before its quota chip had loaded')
  if (await page.locator('[data-slp-reset-kind="codex"]').getAttribute('data-slp-quota-ready') !== 'false') throw new Error('Codex chip should still be loading')
  await appear()
  await page.mouse.move(2, 840)
  // The sheet starts fully inside its clipped frame and slides down out of it.
  const motion = await page.evaluate(() => {
    const frame = document.querySelector('.slp-reset-drawer'), sheet = frame.querySelector('.slp-reset-sheet')
    return { overflow: getComputedStyle(frame).overflow, names: sheet.getAnimations().map(animation => animation.animationName), material: sheet.dataset.menuMaterial }
  })
  if (motion.overflow !== 'hidden' || !motion.names.includes('slp-drawer-in')) throw new Error('Reset drawer does not slide out of a clipped frame: ' + JSON.stringify(motion))
  if (motion.material !== 'translucent') throw new Error('Reset drawer is not on the Host menu material: ' + JSON.stringify(motion))
  const midShot = join(folder, 'reset-drawer-sliding.png')
  await page.clock.runFor(90)
  await page.screenshot({ path: midShot, clip: { x: 0, y: 0, width: page.viewportSize().width, height: 160 } })
  await settle()
  const text = (await drawer.innerText()).replace(/\s+/g, ' ')
  if (!/^Codex resets around (today|tomorrow) \d\d:\d\d ↗ Got it$/.test(text.trim())) throw new Error('Reset drawer text: ' + text)
  // The subscription in its colour, the time phrase in bold.
  const styled = await drawer.evaluate(node => ({ name: node.querySelector('.slp-reset-name')?.textContent, nameColour: getComputedStyle(node.querySelector('.slp-reset-name')).color,
    text: getComputedStyle(node.querySelector('.slp-reset-src')).color, time: node.querySelector('b.slp-reset-time')?.textContent, weight: getComputedStyle(node.querySelector('.slp-reset-time')).fontWeight }))
  if (styled.name !== 'Codex' || styled.nameColour === styled.text || !/^around /.test(styled.time || '') || Number(styled.weight) < 600) throw new Error('Reset drawer emphasis: ' + JSON.stringify(styled))
  const hrefs = await drawer.locator('a').evaluateAll(links => links.map(link => link.href + '|' + link.target + '|' + link.rel))
  if (hrefs.join() !== 'https://aihot.news/codex-reset|_blank|noopener noreferrer') throw new Error('Reset drawer links: ' + hrefs.join())
  const kinds = await page.evaluate(() => window.slpResponsive.resetRequests || [])
  if (!kinds.length || !kinds.every(url => url.endsWith('kinds=codex%2Cantigravity'))) throw new Error('Reset notices asked for: ' + kinds.join())
  if (await drawer.count() !== 1) throw new Error('Two mounted hosts rendered two drawers')
  const placed = await page.evaluate(() => {
    const chip = document.querySelector('[data-slp-reset-kind="codex"]').getBoundingClientRect()
    const frame = document.querySelector('.slp-reset-drawer'), sheet = frame.querySelector('.slp-reset-sheet').getBoundingClientRect()
    return { gap: sheet.top - chip.bottom, left: Math.round(sheet.left - chip.left), width: Math.round(sheet.width), chipWidth: Math.round(chip.width), height: Math.round(sheet.height) }
  })
  if (Math.abs(placed.gap - 2) > 1 || Math.abs(placed.left) > 1) throw new Error('Reset drawer is not on the Codex chip: ' + JSON.stringify(placed))
  // One line within 1.5x the chip when it fits; otherwise only "Got it" moves
  // down, and the sentence wraps only when it alone is wider than the cap.
  const layout = await drawer.evaluate(node => {
    const text = node.querySelector('.slp-reset-text'), ack = node.querySelector('.slp-reset-ack').getBoundingClientRect()
    const range = document.createRange(); range.selectNodeContents(text)
    const tops = new Set([...range.getClientRects()].map(rect => Math.round(rect.top)))
    const sheet = node.querySelector('.slp-reset-sheet').getBoundingClientRect(), padRight = parseFloat(getComputedStyle(node.querySelector('.slp-reset-sheet')).paddingRight)
    const probe = text.cloneNode(true); probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap'; node.querySelector('.slp-reset-sheet').appendChild(probe)
    const natural = probe.getBoundingClientRect().width; probe.remove()
    return { textLines: tops.size, ackOnFirst: Math.abs(ack.top - range.getClientRects()[0].top) < 6, natural: Math.round(natural), ackRight: Math.round(sheet.right - padRight - ack.right) }
  })
  const cap = Math.floor(placed.chipWidth * 1.5)
  if (placed.width < placed.chipWidth - 1 || placed.width > cap + 1) throw new Error('Reset drawer width outside chip..1.5x chip: ' + JSON.stringify({ placed, cap }))
  if (layout.natural + 16 <= cap && layout.textLines !== 1) throw new Error('Sentence wrapped although it fits the cap: ' + JSON.stringify({ layout, cap }))
  if (Math.abs(layout.ackRight) > 1) throw new Error('"Got it" is not at the right edge: ' + JSON.stringify(layout))
  if (layout.textLines === 1 && !layout.ackOnFirst && placed.height > 46) throw new Error('Reset drawer layout: ' + JSON.stringify({ layout, placed }))
  const screenshot = join(folder, 'reset-drawer.png')
  await page.screenshot({ path: screenshot, clip: { x: 0, y: 0, width: page.viewportSize().width, height: 160 } })
  // Hovering holds it past its deadline; leaving resumes the time left.
  await drawer.hover()
  await page.clock.runFor(12000)
  if (!await drawer.isVisible()) throw new Error('Reset drawer left while hovered')
  await page.mouse.move(2, 840)
  await page.clock.runFor(7000)
  if (!await drawer.isVisible()) throw new Error('Reset drawer did not resume with its remaining time')
  await page.clock.runFor(3500)
  await drawer.waitFor({ state: 'detached', timeout: 2000 })
  // Collapsed without "Got it": not again on this page.
  await page.evaluate(() => { window.slpFixtureRoot.unmount(); window.remountResponsiveFixture() })
  await page.clock.runFor(4000)
  if (await drawer.count()) throw new Error('A shown reset drawer slid out again on the same page')
  // Switching to another session is not a new notice: it does not slide out again.
  await page.evaluate(() => window.slpSetSession('fixture-other'))
  await page.clock.runFor(4000)
  if (await drawer.count()) throw new Error('Switching sessions showed the same notice again')
  await page.evaluate(() => { window.slpFixtureRoot.unmount(); window.remountResponsiveFixture() })
  await page.clock.runFor(4000)
  if (await drawer.count()) throw new Error('Remounting the same session slid the drawer out again')
  // A drawer open at the switch belongs to its session: it closes, and the next
  // session does not get it again.
  await page.evaluate(item => { window.slpResetNotices = [item]; window.slpFixtureRoot.unmount(); window.remountResponsiveFixture() }, notice('fixture-switch'))
  await appear()
  await page.evaluate(() => window.slpSetSession('fixture-third'))
  await drawer.waitFor({ state: 'detached', timeout: 2000 })
  await page.clock.runFor(4000)
  if (await drawer.count()) throw new Error('The previous session\'s drawer slid out in the next session')
  await page.evaluate(() => { delete window.slpFixtureSession })
  const panelText = async () => {
    await page.locator('[data-slp-reset-kind="codex"] .slp-quota-trigger').click()
    const section = page.locator('.slp-reset-section')
    await section.waitFor()
    const value = (await section.innerText()).replace(/\s+/g, ' ')
    await page.keyboard.press('Escape')
    return value
  }
  const listed = await panelText()
  if (!listed.includes('Codex resets around') || !listed.includes('Plus / Pro') || listed.includes('AIHOT') || !listed.includes('Post')) throw new Error('Details panel reset section: ' + listed)
  // The original-post link floats right after the sentence and scope: it never
  // reads as part of the scope ("Plus / Pro") and shares the last line instead
  // of spending a line of its own.
  await page.locator('[data-slp-reset-kind="codex"] .slp-quota-trigger').click()
  const panel = page.locator('.slp-panel').filter({ has: page.locator('.slp-reset-section') }).last()
  await panel.waitFor()
  const panelShot = join(folder, 'reset-panel.png')
  await panel.screenshot({ path: panelShot })
  const postLayout = await page.evaluate(measurePostLine)
  await page.keyboard.press('Escape')
  if (Math.abs(postLayout.lineRight - postLayout.linkRight) > 1.5) throw new Error('Details panel post link is not right-aligned: ' + JSON.stringify(postLayout))
  if (postLayout.linkLeft - postLayout.lastRight < 4) throw new Error('Details panel post link touches the scope: ' + JSON.stringify(postLayout))
  if (postLayout.linkTop > postLayout.lastBottom - 2) throw new Error('Details panel post link sits below a last line with room: ' + JSON.stringify(postLayout))
  // A long credit-reset line (the Codex "reset cards issued … Go, Plus, Pro,
  // Business" shape) wraps. "Post" takes the room left on its last line instead
  // of adding a third line whenever the sentence alone wraps.
  const longNotice = { ...notice('fixture-long'), type: 'reset_credit', phase: 'confirmed', at: Date.now() - 86400000, window: null, scope: 'Go, Plus, Pro, Business' }
  await show(codex, longNotice)
  await page.clock.runFor(1000)
  await appear()
  await settle()
  await drawer.getByRole('button', { name: 'Got it' }).click()
  await page.clock.runFor(300)
  await drawer.waitFor({ state: 'detached', timeout: 2000 })
  await page.locator('[data-slp-reset-kind="codex"] .slp-quota-trigger').click()
  await page.waitForFunction(() => document.querySelector('.slp-reset-section')?.textContent.includes('reset cards issued'))
  const wrappedPanel = page.locator('.slp-panel').filter({ has: page.locator('.slp-reset-section') }).last()
  const wrappedShot = join(folder, 'reset-panel-wrapped.png')
  await wrappedPanel.screenshot({ path: wrappedShot })
  const wrapped = await page.evaluate(measurePostLine)
  await page.keyboard.press('Escape')
  if (wrapped.lines < 2) throw new Error('The long details-panel notice did not wrap: ' + JSON.stringify(wrapped))
  if (wrapped.linkTop > wrapped.lastBottom - 2) throw new Error('Details panel post link left the last line of a wrapped notice: ' + JSON.stringify(wrapped))
  if (wrapped.lineBottom - wrapped.lastBottom > 8) throw new Error('Details panel post link added a line under a wrapped notice: ' + JSON.stringify(wrapped))
  if (Math.abs(wrapped.lineRight - wrapped.linkRight) > 1.5) throw new Error('Wrapped details panel post link is not right-aligned: ' + JSON.stringify(wrapped))
  // "Got it" closes it for good; the panel still shows the notice.
  await show(codex, notice('fixture-ack'))
  await appear()
  await settle()
  if (await drawer.getAttribute('data-notice-id') !== 'fixture-ack') throw new Error('Unexpected drawer before "Got it": ' + await drawer.getAttribute('data-notice-id'))
  await drawer.getByRole('button', { name: 'Got it' }).click()
  await page.clock.runFor(300)
  await drawer.waitFor({ state: 'detached', timeout: 2000 })
  const acked = await page.evaluate(() => { try { return localStorage.getItem('statusline-plus:reset-ack') } catch (error) { return 'memory' } })
  if (acked !== 'memory' && !String(acked).includes('codex|fixture-ack')) throw new Error('"Got it" was not stored: ' + acked)
  if (!(await panelText()).includes('Codex resets around')) throw new Error('An acknowledged notice left the details panel')
  // The same event confirmed later is the same notice: "Got it" follows it, so
  // no second drawer, while the details panel updates to the confirmation.
  const confirmed = { ...notice('fixture-ack'), phase: 'confirmed', at: Date.now(), window: null }
  await page.evaluate(item => { window.slpResetNotices = [item]; window.slpFixtureRoot.unmount(); window.remountResponsiveFixture() }, confirmed)
  await page.clock.runFor(4000)
  if (await drawer.count()) throw new Error('A confirmed event slid out after "Got it"')
  if (!(await panelText()).includes('was reset')) throw new Error('The details panel did not show the confirmation')
  // A subscription without its own chip slides out of the chip the header has.
  // Its window is an estimate: the drawer names it as the chip does, and the
  // panel marks the estimate without naming the source.
  const estimated = { ...notice('fixture-other', 'antigravity'), window: { precision: 'estimate', from: Date.now() + 3600000, through: Date.now() + 3600000 } }
  await show(codex, estimated)
  await appear()
  await settle()
  const otherText = (await drawer.innerText()).replace(/\s+/g, ' ').trim()
  if (!/^Agy resets around (today|tomorrow) \d\d:\d\d ↗ Got it$/.test(otherText)) throw new Error('Antigravity drawer text: ' + otherText)
  const otherShot = join(folder, 'reset-drawer-other.png')
  await page.screenshot({ path: otherShot, clip: { x: 0, y: 0, width: page.viewportSize().width, height: 120 } })
  const other = await page.evaluate(() => {
    const chip = document.querySelector('[data-slp-reset-kind="codex"]').getBoundingClientRect()
    const sheet = document.querySelector('.slp-reset-sheet').getBoundingClientRect()
    return { gap: Math.round(sheet.top - chip.bottom), left: Math.round(sheet.left - chip.left), width: Math.round(sheet.width - chip.width), ratio: sheet.width / chip.width }
  })
  if (other.gap !== 2 || other.left !== 0 || other.width < -1 || other.ratio > 1.51) throw new Error('Antigravity notice is not under the header chip: ' + JSON.stringify(other))
  await drawer.getByRole('button', { name: 'Got it' }).click()
  await page.clock.runFor(300)
  const otherListed = await panelText()
  if (!otherListed.includes('Agy resets around')) throw new Error('Codex panel does not list the Antigravity reset: ' + otherListed)
  if (!otherListed.includes('estimated') || otherListed.includes('AIHOT')) throw new Error('Estimated reset wording: ' + otherListed)
  // Several notices: one drawer, one line each, one "Got it" for all.
  await show(codex, [notice('fixture-many-a'), notice('fixture-many-b', 'antigravity')])
  await appear()
  await settle()
  const group = await drawer.evaluate(node => ({ count: node.dataset.count, lines: node.querySelectorAll('.slp-reset-text').length, buttons: node.querySelectorAll('.slp-reset-ack').length,
    tops: [...node.querySelectorAll('.slp-reset-text')].map(text => Math.round(text.getBoundingClientRect().top)) }))
  if (group.count !== '2' || group.lines !== 2 || group.buttons !== 1 || !(group.tops[1] > group.tops[0])) throw new Error('Grouped reset drawer: ' + JSON.stringify(group))
  if (await page.locator('.slp-reset-drawer').count() !== 1) throw new Error('Grouped notices opened more than one drawer')
  const groupShot = join(folder, 'reset-drawer-group.png')
  await page.screenshot({ path: groupShot, clip: { x: 0, y: 0, width: page.viewportSize().width, height: 120 } })
  await drawer.getByRole('button', { name: 'Got it' }).click()
  await page.clock.runFor(300)
  await drawer.waitFor({ state: 'detached', timeout: 2000 })
  const groupAcks = await page.evaluate(() => { try { return localStorage.getItem('statusline-plus:reset-ack') } catch (error) { return 'memory' } })
  if (groupAcks !== 'memory' && !(groupAcks.includes('codex|fixture-many-a') && groupAcks.includes('antigravity|fixture-many-b'))) throw new Error('One "Got it" did not acknowledge every notice: ' + groupAcks)
  await page.clock.runFor(3000)
  if (await drawer.count()) throw new Error('An acknowledged group slid out again')
  // A direct DeepSeek model has only the peak chip: the drawer uses it.
  await show({ deepseek: true, overrides: { showQuota: false, showDeepseekPeak: true } }, notice('fixture-peak'))
  await appear()
  await settle()
  const peak = await page.evaluate(() => {
    const chip = document.querySelector('[data-slp-reset-last]').getBoundingClientRect(), sheet = document.querySelector('.slp-reset-sheet').getBoundingClientRect()
    return { gap: Math.round(sheet.top - chip.bottom), left: Math.round(sheet.left - chip.left), width: Math.round(sheet.width - chip.width), ratio: sheet.width / chip.width }
  })
  if (peak.gap !== 2 || peak.left !== 0 || peak.width < -1 || peak.ratio > 1.51) throw new Error('Reset drawer is not under the peak chip: ' + JSON.stringify(peak))
  await drawer.getByRole('button', { name: 'Got it' }).click()
  await page.clock.runFor(300)
  // No chip in the header: no drawer, however long it waits.
  await show({ model: null, overrides: { showQuota: false, showDeepseekPeak: false } }, notice('fixture-nochip'))
  await page.clock.runFor(5000)
  if (await drawer.count()) throw new Error('A reset drawer appeared with no chip to slide out of')
  await page.evaluate(() => { window.slpQuotaDelayMs = 0; window.disposeResponsiveFixture() })
  return { panel: 'reset', waitsForChip: true, anchored: 'slides from Codex chip, 2px, chip width', compact: placed, material: 'translucent', otherKind: 'under the header chip, listed in Codex panel', grouped: 'two notices, one drawer, one Got it', peakChip: 'under the DeepSeek peak chip', noChip: 'no drawer',
    detailsScreenshot: relative(root, panelShot), holdOnHover: true, oncePerPage: true, ack: true, detailsPanel: true, screenshots: [relative(root, midShot), relative(root, screenshot), relative(root, otherShot)] }
}

async function verifyResponsive(page, folder) {
  await page.setViewportSize({ width: 390, height: 844 })
  await mountResponsiveFixture(page)
  const toggle = page.getByRole('checkbox', { name: 'Hide bottom status line on narrow screens', exact: true })
  const dock = page.locator('#fixture-dock .slp-root')
  const assertResources = async (open, total) => {
    await page.waitForFunction(({ open, total }) => {
      const state = window.slpResponsive
      return state.sources.filter(source => !source.closed).length === open &&
        state.gitRequests.length === total && state.gitRequests.filter(request => !request.aborted).length === open
    }, { open, total })
  }
  await toggle.waitFor()
  if (!await toggle.isChecked() || await dock.count()) throw new Error('Stored preference did not suppress the initial narrow dock')
  await assertResources(0, 0)
  await page.locator('#fixture-header .slp-quota-with-age').waitFor()
  await page.locator('#fixture-footer .slp-peak-dot-btn').waitFor()
  // Both footer actions render side by side; an offered DSH update makes the restart button glow.
  await page.locator('#fixture-footer .slp-rs-btn[data-update="true"]').waitFor()
  // A failed refresh recovers without activity, with exactly three retries.
  const quota = page.locator('#fixture-header .slp-quota-trigger')
  const quotaCount = count => page.waitForFunction(expected => window.slpResponsive.quotaRequests.length === expected, count)
  await quotaCount(1)
  await page.evaluate(() => { window.slpResponsive.quotaFailures = 4 })
  // Opening details no longer bypasses the cache; the explicit Refresh button does.
  await quota.click()
  await assertPanelVisible(page, page.locator('.slp-panel').first())
  await page.locator('.slp-panel .slp-link-btn').first().click()
  await quotaCount(2)
  await page.locator('#fixture-header .slp-err').waitFor()
  for (const [index, delay] of [15000, 30000, 60000].entries()) {
    await page.clock.runFor(delay); await quotaCount(index + 3)
  }
  await page.clock.runFor(120000); await quotaCount(5)
  if (!(await quota.getAttribute('title')).includes('Automatic retries exhausted')) throw new Error('Retry exhaustion was not explained while retaining successful data')
  const retryBodies = await page.evaluate(() => window.slpResponsive.quotaRequests.slice(2).map(request => JSON.parse(request.body)))
  if (retryBodies.some(body => body.force)) throw new Error('Automatic retries bypassed Host backoff')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await quotaCount(6)
  await page.locator('#fixture-header .slp-err').waitFor({ state: 'detached' })
  if (!(await quota.innerText()).includes('20%')) throw new Error('Focus recovery did not restore the quota')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await quotaCount(6)
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 481, height: 844 })
  await dock.waitFor(); await assertResources(1, 1)
  await page.setViewportSize({ width: 480, height: 844 })
  await dock.waitFor({ state: 'detached' }); await assertResources(0, 1)
  await page.setViewportSize({ width: 320, height: 844 })
  await page.clock.runFor(2000); await assertResources(0, 1)
  if (!await page.locator('#fixture-header .slp-quota-with-age').isVisible() ||
      !await page.locator('#fixture-footer .slp-peak-dot-btn').isVisible() ||
      !await page.locator('#fixture-native').isVisible()) throw new Error('Hiding the dock affected other UI')
  await toggle.uncheck(); await page.clock.runFor(700)
  await dock.waitFor(); await assertResources(1, 2)
  await toggle.check(); await page.clock.runFor(700)
  await dock.waitFor({ state: 'detached' }); await assertResources(0, 2)
  await page.evaluate(() => window.slpFixtureRoot.unmount())
  await page.waitForFunction(() => window.slpResponsive.observers.every(observer => observer.closed))
  await page.evaluate(() => window.remountResponsiveFixture())
  await toggle.waitFor()
  if (!await toggle.isChecked() || await dock.count()) throw new Error('Setting was not retained on remount')
  await assertResources(0, 2)
  // The update affordance: named after the new version, installed on one click,
  // and it reports the live swap the page detects through the instance id. The
  // fixture records the request instead of running pnpm.
  const versionBadge = page.locator('.slp-version')
  await versionBadge.waitFor()
  if ((await versionBadge.innerText()).trim() !== 'v0.1.9') throw new Error('Settings did not show the running version')
  const updateButton = page.locator('.slp-update')
  await updateButton.waitFor()
  if (!(await updateButton.innerText()).includes('9.9.9')) throw new Error('Update button did not name the new version')
  await updateButton.click()
  await page.waitForFunction(() => document.querySelector('.slp-update')?.textContent?.includes('Refresh'), null, { timeout: 15000 })
  const updateBodies = await page.evaluate(() => window.slpResponsive.updateRequests)
  if (updateBodies.length !== 1 || updateBodies[0].version !== '9.9.9') throw new Error('Update request was not sent exactly once')
  if (await updateButton.isDisabled()) throw new Error('Update stopped being clickable before the page could refresh')
  const screenshot = join(folder, 'responsive-settings.png')
  await page.locator('.slp-set').screenshot({ path: screenshot, animations: 'disabled' })
  await page.setViewportSize({ width: 768, height: 844 })
  await dock.waitFor(); await assertResources(1, 3)
  // A sidebar can narrow the input area without narrowing the browser viewport.
  await page.locator('#fixture-dock').evaluate(node => { node.style.width = '480px' })
  await dock.waitFor({ state: 'detached' }); await assertResources(0, 3)
  if (!await page.locator('#fixture-native').isVisible()) throw new Error('Container suppression hid native stats')
  await page.locator('#fixture-dock').evaluate(node => { node.style.width = '481px' })
  await dock.waitFor(); await assertResources(1, 4)
  await page.evaluate(() => window.disposeResponsiveFixture())
  await assertResources(0, 4)
  await page.waitForFunction(() => window.slpResponsive.observers.every(observer => observer.closed))
  return { panel: 'responsive', widths: [320, 390, 480, 481, 768],
    lifecycle: 'three retries/exhaustion hint/focus recovery/container suppression/native stats/settings save/remount/resource cleanup passed', screenshot: relative(root, screenshot) }
}

// DSH 0.2.2-rc.2 dropped useAnchoredPosition from its primitives. Clicking a
// header chip then threw and the Host removed the chip until reload (issue #1).
async function verifyAnchorFallback(folder, errors) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  page.setDefaultTimeout(8000)
  page.on('pageerror', error => errors.push(redact(error.message)))
  try {
    await mountResponsiveFixture(page, { hostAnchor: false })
    const chip = page.locator('#fixture-header .slp-quota-trigger')
    await chip.waitFor()
    // The open quota panel's "updated Ns ago" ticks every second while under a
    // minute old; its tooltip holds.
    await chip.click()
    const age = page.locator('.slp-anchored .slp-quota-age')
    await age.waitFor(); await age.hover()
    const ageTitle = await age.getAttribute('title')
    await page.clock.runFor(3000)
    if (await age.getAttribute('title') !== ageTitle) throw new Error('Quota age tooltip changed while hovered')
    await page.keyboard.press('Escape'); await page.locator('.slp-anchored').waitFor({ state: 'detached' })
    if (!/\d+s/.test(ageTitle)) throw new Error('Quota age was not in seconds, so the hold went untested: ' + ageTitle)
    // A changing native tooltip blinks, so the text holds while hovered.
    await chip.hover()
    const hovered = await chip.getAttribute('title')
    await page.clock.runFor(65000)
    if (await chip.getAttribute('title') !== hovered) throw new Error('Chip tooltip changed while hovered')
    await page.mouse.move(380, 830)
    await page.clock.runFor(30000)
    if (await chip.getAttribute('title') === hovered) throw new Error('Chip tooltip stayed frozen after the pointer left')
    // The sidebar peak dot: its open panel ticks every second, the tooltip holds.
    const dot = page.locator('#fixture-footer .slp-peak-dot-btn')
    await dot.click(); await page.locator('.slp-panel-fixed').waitFor()
    await page.mouse.move(380, 830); await dot.hover()
    const dotTitle = await dot.getAttribute('title')
    await page.clock.runFor(3000)
    if (await dot.getAttribute('title') !== dotTitle) throw new Error('Peak dot tooltip changed while hovered with its panel open')
    await dot.click(); await page.mouse.move(380, 830)
    for (let round = 0; round < 2; round++) {
      await chip.click()
      const panel = page.locator('.slp-anchored')
      await assertPanelVisible(page, panel)
      const [anchor, box] = [await chip.boundingBox(), await panel.boundingBox()]
      if (box.y < anchor.y + anchor.height || box.x < 0 || box.x + box.width > 390) throw new Error('Fallback panel is not placed below its chip inside the viewport')
      if (round === 0) await page.screenshot({ path: join(folder, 'anchor-fallback.png'), animations: 'disabled' })
      await page.keyboard.press('Escape')
      await panel.waitFor({ state: 'detached' })
      if (!await chip.isVisible()) throw new Error('Quota chip disappeared after closing its panel')
    }
    await page.evaluate(() => window.disposeResponsiveFixture())
    return { panel: 'anchor-fallback', lifecycle: 'hover tooltips held (chip, peak dot, panel age)/open/close twice without the Host hook passed', screenshot: relative(root, join(folder, 'anchor-fallback.png')) }
  } finally { await page.close() }
}

// Header details used to shrink-wrap to their longest line: on a wide window
// the peak rule ran as one ~980px line, and a long quota note would stretch the
// same way. Both anchored panels now cap at 380px and wrap; a narrow window
// still keeps them inside the viewport.
async function verifyPanelWidth(folder, errors) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  page.setDefaultTimeout(8000)
  page.on('pageerror', error => errors.push(redact(error.message)))
  try {
    await mountResponsiveFixture(page, { hostAnchor: false, deepseek: true, overrides: { showDeepseekPeak: true } })
    const peak = page.locator('#fixture-header .slp-peak-trigger')
    await peak.waitFor()
    await peak.click()
    const peakPanel = page.locator('.slp-anchored')
    await peakPanel.waitFor()
    const peakBox = await peakPanel.boundingBox()
    if (peakBox.width > 380.5) throw new Error('Peak panel stretched to ' + peakBox.width + 'px instead of wrapping at 380px')
    if (peakBox.height < 100) throw new Error('Peak panel rule did not wrap: ' + peakBox.height + 'px tall')
    await page.screenshot({ path: join(folder, 'panel-width-peak.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
    await peakPanel.waitFor({ state: 'detached' })
    const quota = page.locator('#fixture-header .slp-quota-trigger:not(.slp-peak-trigger)')
    await quota.click()
    const quotaPanel = page.locator('.slp-anchored')
    await quotaPanel.waitFor()
    const quotaBox = await quotaPanel.boundingBox()
    if (quotaBox.width > 380.5) throw new Error('Quota panel stretched to ' + quotaBox.width + 'px instead of wrapping at 380px')
    await page.keyboard.press('Escape')
    await quotaPanel.waitFor({ state: 'detached' })
    // The footer popover is fixed and keeps its own 240px design cap; the
    // viewport-fitting code must not replace it with a wider one.
    const dot = page.locator('#fixture-footer .slp-peak-dot-btn')
    await dot.click()
    const compact = page.locator('.slp-panel-fixed')
    await compact.waitFor()
    const compactMax = await compact.evaluate(node => parseFloat(getComputedStyle(node).maxWidth))
    if (!(compactMax <= 240.5)) throw new Error('Footer peak popover lost its 240px cap: ' + compactMax + 'px')
    await dot.click()
    await compact.waitFor({ state: 'detached' })
    await page.setViewportSize({ width: 320, height: 640 })
    await peak.click()
    await peakPanel.waitFor()
    const narrow = await peakPanel.boundingBox()
    if (narrow.width > 296.5 || narrow.x < 0 || narrow.x + narrow.width > 320) throw new Error('Peak panel does not fit a 320px window: ' + JSON.stringify(narrow))
    await page.keyboard.press('Escape')
    await page.evaluate(() => window.disposeResponsiveFixture())
    return { panel: 'panel-width', lifecycle: 'peak and quota details cap at 380px on a wide window and fit 320px', screenshot: relative(root, join(folder, 'panel-width-peak.png')) }
  } finally { await page.close() }
}

// Reorder the live bottom row by dragging: the row, the saved order and the
// settings list all follow, a drag never clicks the chip it ends on, and a
// plain click still does.
async function verifyDockDrag(folder, errors) {
  const page = await browser.newPage({ viewport: { width: 768, height: 844 } })
  page.setDefaultTimeout(8000)
  page.on('pageerror', error => errors.push(redact(error.message)))
  try {
    await mountResponsiveFixture(page, { dockData: true })
    const dock = page.locator('#fixture-dock .slp-row')
    const git = dock.locator('[data-component="git"]'), tps = dock.locator('[data-component="tps"]')
    await git.locator('.slp-git-branch').waitFor(); await tps.locator('.slp-tps').waitFor()
    const shown = () => dock.locator('.slp-dock-item').evaluateAll(items => items.filter(item => item.getClientRects().length).map(item => item.dataset.component))
    const listed = () => page.locator('.slp-order-list .slp-order-item').evaluateAll(items => items.map(item => item.dataset.component))
    const requests = () => page.evaluate(() => window.slpResponsive.gitRequests.length)
    if ((await shown()).join() !== 'git,tps') throw new Error('Unexpected initial dock order: ' + (await shown()).join())
    // Text matches the Host's own dock stat: tertiary, secondary on hover.
    const token = name => page.evaluate(name => { const probe = document.createElement('span'); probe.style.color = 'var(' + name + ')'; document.body.appendChild(probe); const color = getComputedStyle(probe).color; probe.remove(); return color }, name)
    const colorOf = locator => locator.evaluate(node => getComputedStyle(node).color)
    const [tertiary, secondary] = [await token('--dsw-alias-label-tertiary'), await token('--dsw-alias-label-secondary')]
    if (await colorOf(tps.locator('.slp-tps')) !== tertiary || await colorOf(git.locator('.slp-git-branch')) !== tertiary) throw new Error('Bottom-row text is not the Host dock stat colour')
    await git.locator('button').hover()
    // The colour eases in, so wait for the transition to land.
    await page.waitForFunction(expected => getComputedStyle(document.querySelector('#fixture-dock [data-component="git"] .slp-git-branch')).color === expected, secondary, { timeout: 2000 })
      .catch(() => { throw new Error('Bottom-row trigger does not brighten on hover like the Host stat') })
    await page.mouse.move(700, 800)
    const before = await requests()
    // A short wobble stays a click candidate; nothing moves.
    const from = await tps.boundingBox(), to = await git.boundingBox()
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down()
    await page.mouse.move(from.x + from.width / 2 + 3, from.y + from.height / 2)
    if (await dock.getAttribute('data-reordering')) throw new Error('A 3 px wobble started a drag')
    await page.mouse.move(to.x + 4, to.y + to.height / 2, { steps: 6 })
    // The row previews the result: TPS (faint, outlined) already sits before Git
    // while the DOM keeps its order until the drop is saved.
    const visual = () => dock.locator('.slp-dock-item').evaluateAll(items => items.filter(item => item.getClientRects().length)
      .map(item => ({ id: item.dataset.component, left: item.offsetLeft })).sort((a, b) => a.left - b.left).map(item => item.id).join())
    await page.waitForFunction(() => document.querySelector('#fixture-dock [data-component="tps"]').style.order !== '')
    if (await visual() !== 'tps,git' || await tps.getAttribute('data-dragging') !== 'true') throw new Error('The row did not preview TPS before Git while dragging')
    if ((await shown()).join() !== 'git,tps') throw new Error('The preview changed the DOM order before the drop')
    // A translucent copy of the picked component follows the pointer.
    const ghost = await page.locator('.slp-dock-ghost').evaluate(node => {
      const box = node.getBoundingClientRect(), style = getComputedStyle(node)
      return { text: node.textContent, opacity: Number(style.opacity), events: style.pointerEvents, left: box.left, right: box.right, top: box.top, bottom: box.bottom }
    })
    if (!ghost.text.includes('TPS') || !(ghost.opacity > 0.5 && ghost.opacity < 1) || ghost.events !== 'none') throw new Error('Drag ghost is missing, opaque or catches the pointer')
    // A size smaller than the original (scaled around the grab point), as wide
    // as its content, with the grabbed point (TPS's centre) under the pointer
    // and within the row's height.
    const pointer = { x: to.x + 4, y: to.y + to.height / 2 }, row = await dock.boundingBox(), scale = 0.88
    const near = (a, b) => Math.abs(a - b) <= 2
    if (!near(ghost.right - ghost.left, from.width * scale) || !near(ghost.bottom - ghost.top, from.height * scale) || !near(pointer.x - ghost.left, from.width / 2 * scale) ||
        ghost.top < row.y - 1 || ghost.bottom > row.y + row.height + 1) throw new Error('Drag ghost is not a size smaller, left the grab point or the row: ' + JSON.stringify({ ghost, pointer, from, row }))
    const screenshot = join(folder, 'dock-drag.png')
    const area = await dock.boundingBox()
    await page.screenshot({ path: screenshot, animations: 'disabled', clip: { x: Math.max(0, area.x - 24), y: Math.max(0, area.y - 8), width: area.width + 48, height: area.height + 40 } })
    await page.mouse.up()
    await page.waitForFunction(() => [...document.querySelectorAll('#fixture-dock .slp-dock-item')].map(item => item.dataset.component).join() === 'tps,git')
    const saved = await page.evaluate(() => window.slpResponsive.mutations.flat().filter(op => op.path[0] === 'componentOrder').map(op => op.value))
    if (saved.length !== 1 || saved[0].indexOf('tps') > saved[0].indexOf('git')) throw new Error('Drag did not save one componentOrder with TPS before Git')
    await page.waitForFunction(() => { const ids = [...document.querySelectorAll('.slp-order-list .slp-order-item')].map(item => item.dataset.component); return ids.indexOf('tps') < ids.indexOf('git') })
    if ((await listed()).indexOf('tps') > (await listed()).indexOf('git')) throw new Error('Settings order list did not follow the drag')
    if (await requests() !== before) throw new Error('The click ending a drag refreshed the Git chip under it')
    if (await dock.getAttribute('data-reordering') || await dock.locator('[data-dragging]').count() || await page.locator('.slp-dock-ghost').count() ||
        await dock.locator('.slp-dock-item').evaluateAll(items => items.some(item => item.style.order))) throw new Error('Drag state was left on the row')
    await git.locator('button').click()
    await page.waitForFunction(count => window.slpResponsive.gitRequests.length > count, before)
    // Escape abandons a drag in progress without saving.
    const box = await tps.boundingBox(), target = await git.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down()
    await page.mouse.move(target.x + target.width - 4, target.y + target.height / 2, { steps: 6 })
    await page.keyboard.press('Escape'); await page.mouse.up()
    if ((await shown()).join() !== 'tps,git' || await visual() !== 'tps,git' || await page.locator('.slp-dock-ghost').count()) throw new Error('Escape did not cancel the drag')
    if (await dock.locator('.slp-dock-item').evaluateAll(items => items.some(item => item.style.order))) throw new Error('Preview order styles were left on the row')
    await page.evaluate(() => window.disposeResponsiveFixture())
    return { panel: 'dock-drag', lifecycle: 'Host text colours/live preview/grab-anchored ghost/save/settings sync/no stray click/click/Escape passed', screenshot: relative(root, screenshot) }
  } finally { await page.close() }
}

// Another plugin's dock items: they render in the row through the
// `statusline-plus.dock.item` child slot, list in settings with a tag, show in
// the preview, hide by their own switch, drag like built-ins, may replace a
// built-in by its id, and come and go with their registration. A crashing item
// is hidden instead of leaving a gap.
async function verifyDockExtension(folder, errors) {
  const page = await browser.newPage({ viewport: { width: 768, height: 844 } })
  page.setDefaultTimeout(8000)
  // React's development build reports the boundary-caught crash too; only that one is expected.
  page.on('pageerror', error => { if (error.message !== 'demo item failed') errors.push(redact(error.message)) })
  try {
    await mountResponsiveFixture(page, { dockData: true })
    const dock = page.locator('#fixture-dock .slp-row')
    await dock.locator('[data-component="git"] .slp-git-branch').waitFor()
    await page.evaluate(() => {
      const { React, slpSlots } = window, name = 'statusline-plus.dock.item'
      const add = (spec, component) => slpSlots.register({ name, ...spec }, component)
      window.slpExt = {
        ci: add({ id: 'demo.ci', order: 50, label: 'CI' }, props => React.createElement('span', { className: 'demo-ci', 'data-session': props.sessionId }, 'CI ok')),
        crash: add({ id: 'demo.crash', order: 60, label: 'Crash' }, () => { throw new Error('demo item failed') }),
        empty: add({ id: 'demo.empty', order: 65, label: 'Empty' }, () => null),
        add,
      }
    })
    const shown = () => dock.locator('.slp-dock-item').evaluateAll(items => items.filter(item => item.getClientRects().length).map(item => item.dataset.component).join())
    const listed = () => page.locator('.slp-order-list .slp-order-item').evaluateAll(items => items.map(item => item.dataset.component))
    const item = id => page.locator('.slp-order-list .slp-order-item[data-component="' + id + '"]')
    await dock.locator('[data-component="demo.ci"] .demo-ci').waitFor()
    if (await dock.locator('.demo-ci').getAttribute('data-session') !== 'fixture-parent') throw new Error('Dock extension did not receive the session props')
    if (await shown() !== 'git,tps,demo.ci') throw new Error('Unexpected dock with extensions: ' + await shown())
    // Like the Host, a crashed entry is retired: it leaves the row and the settings list.
    await page.waitForFunction(() => !document.querySelector('#fixture-dock [data-component="demo.crash"], .slp-order-item[data-component="demo.crash"]'))
    await page.waitForFunction(() => document.querySelector('.slp-order-list .slp-order-item[data-component="demo.empty"]'))
    if (await dock.locator('[data-component="demo.empty"]').evaluate(node => node.getClientRects().length)) throw new Error('An extension rendering null still takes a place in the row')
    if ((await listed()).slice(-2).join() !== 'demo.ci,demo.empty' || !await item('demo.ci').locator('.slp-ext-tag').count()) throw new Error('Settings did not list the extensions with a tag: ' + (await listed()).join())
    if (!(await page.locator('.slp-preview .slp-ext-sample').allTextContents()).includes('CI')) throw new Error('Preview has no placeholder for the extension')
    // Registering a built-in id replaces that built-in in place.
    await page.evaluate(() => { window.slpExt.tps = window.slpExt.add({ id: 'tps', label: 'My TPS' }, () => window.React.createElement('span', { className: 'my-tps' }, 'my tps')) })
    await dock.locator('[data-component="tps"] .my-tps').waitFor()
    if (await dock.locator('.slp-tps').count() || !await item('tps').locator('.slp-ext-tag').count()) throw new Error('Replacement did not stand in for TPS or lacks the Replaced tag')
    await page.evaluate(() => window.slpExt.tps())
    await dock.locator('[data-component="tps"] .slp-tps').waitFor()
    // A replacement that crashes is retired too, and the built-in comes back.
    await page.evaluate(() => { window.slpExt.badTps = window.slpExt.add({ id: 'tps', label: 'Bad TPS' }, () => { throw new Error('demo item failed') }) })
    await dock.locator('[data-component="tps"] .slp-tps').waitFor()
    await page.waitForFunction(() => !document.querySelector('.slp-order-item[data-component="tps"] .slp-ext-tag'))
    if (await item('tps').locator('.slp-ext-tag').count()) throw new Error('TPS kept the Replaced tag after the replacement left')
    // Its own switch hides it and is saved as hiddenComponents.
    const ops = key => page.evaluate(key => window.slpResponsive.mutations.flat().filter(op => op.path[0] === key).map(op => op.value), key)
    await item('demo.ci').locator('input[type="checkbox"]').uncheck()
    await page.waitForFunction(() => !document.querySelector('#fixture-dock .demo-ci'))
    if (JSON.stringify((await ops('hiddenComponents')).at(-1)) !== '["demo.ci"]') throw new Error('Hiding the extension did not save hiddenComponents')
    await item('demo.ci').locator('input[type="checkbox"]').check()
    await dock.locator('.demo-ci').waitFor()
    // Dragged before Git like any built-in.
    const from = await dock.locator('[data-component="demo.ci"]').boundingBox(), to = await dock.locator('[data-component="git"]').boundingBox()
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down()
    await page.mouse.move(to.x + 4, to.y + to.height / 2, { steps: 8 }); await page.mouse.up()
    await page.waitForFunction(() => [...document.querySelectorAll('#fixture-dock .slp-dock-item')].map(item => item.dataset.component)[0] === 'demo.ci')
    const order = (await ops('componentOrder')).at(-1) || []
    if (!(order.indexOf('demo.ci') >= 0 && order.indexOf('demo.ci') < order.indexOf('git'))) throw new Error('Drag did not save the extension id before Git: ' + JSON.stringify(order))
    const screenshot = join(folder, 'dock-extension.png')
    const area = await dock.boundingBox()
    await page.screenshot({ path: screenshot, animations: 'disabled', clip: { x: Math.max(0, area.x - 24), y: Math.max(0, area.y - 8), width: area.width + 48, height: area.height + 24 } })
    // Late registrations appear; unregistered items leave the row and settings.
    await page.evaluate(() => { window.slpExt.late = window.slpExt.add({ id: 'demo.late', order: 70, label: 'Late' }, () => window.React.createElement('span', { className: 'demo-late' }, 'late')) })
    await dock.locator('.demo-late').waitFor()
    await page.evaluate(() => { window.slpExt.late(); window.slpExt.ci() })
    await page.waitForFunction(() => !document.querySelector('#fixture-dock .demo-late, #fixture-dock .demo-ci, .slp-order-item[data-component="demo.late"], .slp-order-item[data-component="demo.ci"]'))
    if (await shown() !== 'git,tps') throw new Error('Unregistered extensions left the dock as: ' + await shown())
    await page.evaluate(() => { window.slpExt.crash(); window.slpExt.empty(); window.disposeResponsiveFixture() })
    return { panel: 'dock-extension', lifecycle: 'child slot render/session props/crash retired/crashed replacement restores built-in/empty hidden/settings tag/preview/replace built-in/hide switch/drag save/late add/unregister passed', screenshot: relative(root, screenshot) }
  } finally { await page.close() }
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
  const data = opts.live ? await mountLive(page, opts) : ['responsive', 'restart', 'reset'].includes(opts.panel) ? {} : opts.panel === 'chip' ? (await mountFixture(page), {}) : opts.panel === 'modelbar' ? (await mountModelBarFixture(page), {}) : (await mountFixture(page), { hasCosts: true, subagents: 2 })
  const checks = []
  if (['all', 'cost'].includes(opts.panel)) {
    if (!data.hasCosts) throw new Error('Selected session has no priced usage')
    checks.push(await verifyCost(page, folder, opts.live))
  }
  if (['all', 'subagents'].includes(opts.panel)) checks.push(await verifySubagents(page, folder, opts.live, data.subagents))
  if (!opts.live && ['all', 'chip'].includes(opts.panel)) {
    await mountChipFixture(page)
    checks.push(await verifyChip(page, folder))
  }
  if (!opts.live && ['all', 'modelbar'].includes(opts.panel)) {
    if (opts.panel === 'all') await mountModelBarFixture(page)
    checks.push(await verifyModelBar(page, folder))
  }
  if (!opts.live && ['all', 'responsive'].includes(opts.panel)) {
    checks.push(await verifyResponsive(page, folder))
    checks.push(await verifyAnchorFallback(folder, errors))
    checks.push(await verifyPanelWidth(folder, errors))
    checks.push(await verifyDockDrag(folder, errors))
    checks.push(await verifyDockExtension(folder, errors))
  } else if (!opts.live) await page.evaluate(() => window.slpFixtureRoot?.unmount())
  if (!opts.live && ['all', 'restart'].includes(opts.panel)) checks.push(await verifyRestart(page, folder))
  if (!opts.live && ['all', 'reset'].includes(opts.panel)) checks.push(await verifyReset(page, folder))
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
