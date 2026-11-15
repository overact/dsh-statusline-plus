import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { artifacts, excerpt, redact, root } from './verification.mjs'
import { mountFixture, mountResponsiveFixture, uiRequire } from './ui-fixture.mjs'

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
  if (!['all', 'cost', 'subagents', 'responsive'].includes(opts.panel)) throw new Error('--panel must be cost, subagents, responsive or all')
  if (opts.live && opts.panel === 'responsive') throw new Error('Responsive verification changes fixture settings and is offline only')
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
  const data = opts.live ? await mountLive(page, opts) : opts.panel === 'responsive' ? {} : (await mountFixture(page), { hasCosts: true, subagents: 2 })
  const checks = []
  if (['all', 'cost'].includes(opts.panel)) {
    if (!data.hasCosts) throw new Error('Selected session has no priced usage')
    checks.push(await verifyCost(page, folder, opts.live))
  }
  if (['all', 'subagents'].includes(opts.panel)) checks.push(await verifySubagents(page, folder, opts.live, data.subagents))
  if (!opts.live && ['all', 'responsive'].includes(opts.panel)) {
    checks.push(await verifyResponsive(page, folder))
    checks.push(await verifyAnchorFallback(folder, errors))
    checks.push(await verifyDockDrag(folder, errors))
  } else if (!opts.live) await page.evaluate(() => window.slpFixtureRoot.unmount())
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
