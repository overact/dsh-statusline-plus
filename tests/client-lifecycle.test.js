'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')

function harness({ hidden = false, wallTime = Date.now(), panelLayout = null } = {}) {
  const states = [], refs = [], effects = [], pending = [], timers = new Set(), requests = [], mutations = [], sources = []
  let cursor = 0, exported, now = 0
  const timeouts = new Map()
  const React = {
    createElement(type, props, ...children) { return { type, props, children } },
    useState(initial) {
      const i = cursor++
      if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial
      return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value }]
    },
    useRef(initial) { const i = cursor++; return refs[i] || (refs[i] = { current: initial }) },
    useEffect(fn, deps) {
      const i = cursor++, old = effects[i]
      if (!old || deps.some((v, n) => !Object.is(v, old.deps[n]))) pending.push(() => {
        old?.cleanup?.(); effects[i] = { deps, cleanup: fn() }
      })
    },
  }
  let scopeValue = { showGit: false }
  const documentEvents = new Map()
  const scope = { getSnapshot: () => ({ mode: 'host', writable: true, value: scopeValue }), mutate: async ops => {
    mutations.push(ops)
    for (const operation of ops) {
      if (operation.op === 'unset') { scopeValue = { ...scopeValue }; delete scopeValue[operation.path[0]] }
      else scopeValue = { ...scopeValue, [operation.path[0]]: operation.value }
    }
  } }
  const context = {
    window: { __ModuleLoader__: { load: spec => { exported = spec.factory(() => React) } } },
    document: {
      visibilityState: hidden ? 'hidden' : 'visible',
      addEventListener(name, fn) { if (!documentEvents.has(name)) documentEvents.set(name, new Set()); documentEvents.get(name).add(fn) },
      removeEventListener(name, fn) { documentEvents.get(name)?.delete(fn) },
    },
    AbortController, Date: class extends Date { static now() { return wallTime + now } }, console,
    performance: { now: () => now },
    setTimeout(fn, delay) { const token = {}; timeouts.set(token, { fn, at: now + delay }); return token },
    clearTimeout(token) { timeouts.delete(token) },
    EventSource: class {
      constructor(url) { this.url = url; sources.push(this) }
      close() { this.closed = true }
      emit(data) { this.onmessage?.({ data: JSON.stringify(data) }) }
    },
    setInterval(fn) { const token = { fn }; timers.add(token); return token },
    clearInterval(token) { timers.delete(token) },
    fetch(url, opts) {
      return new Promise(resolve => {
        requests.push({ url, opts, resolve: data => resolve({ json: async () => data }) })
        opts?.signal?.addEventListener('abort', () => resolve({ json: async () => ({ ok: false, error: 'aborted' }) }))
      })
    },
  }
  if (panelLayout) {
    context.document.documentElement = { clientWidth: panelLayout.width }
    context.getComputedStyle = node => ({ overflowX: node.overflowX || 'visible' })
    context.ResizeObserver = class {
      constructor(callback) { this.callback = callback; this.nodes = new Set(); panelLayout.observers.push(this) }
      observe(node) { this.nodes.add(node) }
      disconnect() { this.nodes.clear() }
    }
  }
  const source = fs.readFileSync(require.resolve('../lib/client'), 'utf8').replace('return module.exports', 'return { ContextProjection, ContextRow, componentOrder, reorderComponent, layoutPreset, matchingPreset, dockComponents, LayoutEditor, LayoutPreview, ToolActivityRow, toolElapsed, quotaRefreshOnStep, TpsRow, useLiveTps, useQuotaResource, normalizeWindows, formatPathSegs, fmtResetHours, codexWindowLabel, isCodexModel, isAntigravityModel, providerMatchesModel, fmtMoney, ProviderQuotaLine, CodexQuotaLine, AntigravityQuotaLine, OpenCodeQuotaLine, parseSeconds, PeakPanel, PeakFooterDot, deepseekPeakStatus, HeaderChip, SettingsPage, DeepseekPeakChip, ActivityRow, childActivityRows, childElapsed, CostRow, estimateCost, quotaFreshness, QuotaChip, publishConfig, apiSetConfig, setScope: function (scope) { settingsScope = scope } }')
  vm.runInNewContext(source, context)
  exported.setScope(scope)
  return {
    ...exported, requests, mutations, timers, sources, timeouts, documentEvents,
    setVisible(value) { context.document.visibilityState = value ? 'visible' : 'hidden'; documentEvents.get('visibilitychange')?.forEach(fn => fn()) },
    tick() { timers.forEach(timer => timer.fn()) },
    setConfig(value) { scopeValue = value; exported.publishConfig(value) },
    renderComponent(component, props = {}) { cursor = 0; const result = component(props); while (pending.length) pending.shift()(); return result },
    renderTps(sessionId) { cursor = 0; const result = exported.TpsRow({ sessionId }); while (pending.length) pending.shift()(); return result },
    advance(ms) { now += ms; for (const [token, task] of timeouts) if (task.at <= now) { timeouts.delete(token); task.fn() } },
    renderLive(sessionId, enabled = true) { cursor = 0; const result = exported.useLiveTps(sessionId, enabled); while (pending.length) pending.shift()(); return result },
    render(resource, config, step = 0) { cursor = 0; const result = exported.useQuotaResource(resource, config, step); while (pending.length) pending.shift()(); return result },
    unmount() { effects.forEach(e => e.cleanup?.()) },
  }
}
const config = { enabled: true, showQuota: true, intervalSec: 60 }
const resource = { kind: 'provider', id: 'openrouter', key: 'provider:openrouter', onStep: true }
const flush = () => new Promise(resolve => setImmediate(resolve))

test('quota freshness retains the actual fetch time and never fabricates a missing timestamp', () => {
  const h = harness(), now = 1700000000000
  assert.match(h.quotaFreshness({ fetchedAt: now - 30000 }, 60000, null, now).label, /30s/)
  assert.equal(h.quotaFreshness({ fetchedAt: now - 60000 }, 60000, null, now).stale, true)
  assert.match(h.quotaFreshness({ fetchedAt: now - 1000 }, 60000, 'network', now).title, /Refresh failed/)
  for (const fetchedAt of [undefined, null, 0, NaN, now + 10000]) {
    assert.match(h.quotaFreshness({ fetchedAt }, 60000, null, now).label, /unknown/)
  }
})

test('manual quota refresh failure retains the last successful data and its original timestamp', async () => {
  const h = harness(); h.render(resource, config)
  const data = { fetchedAt: 1700000000000, remaining: 12 }
  h.requests[0].resolve({ ok: true, data }); await flush()
  h.render(resource, config).refresh()
  h.requests[1].resolve({ ok: false, error: 'network' }); await flush()
  const result = h.render(resource, config)
  assert.equal(result.data, data)
  assert.equal(result.staleError, 'network')
  assert.equal(result.error, null)
  h.unmount()
})

test('a newly successful quota refresh is fresh immediately between age-clock ticks', async () => {
  const now = 1700000000000, h = harness({ wallTime: now })
  const props = { resource, config: { ...config, cacheTtlMs: 1000 }, stepCount: 0 }
  h.renderComponent(h.QuotaChip, props)
  h.requests[0].resolve({ ok: true, data: { style: 'balance', fetchedAt: now, remaining: 1 } }); await flush()
  const title = view => h.ProviderQuotaLine(view.children[0].props).children[0].props.title
  let view = h.renderComponent(h.QuotaChip, props)
  assert.match(title(view), /0s/)
  assert.equal(view.children.length, 1, 'header has only the quota component, with no visible age')
  h.advance(10000)
  view.children[0].props.refresh()
  h.requests[1].resolve({ ok: true, data: { style: 'balance', fetchedAt: now + 10000, remaining: 2 } }); await flush()
  view = h.renderComponent(h.QuotaChip, props)
  assert.match(title(view), /0s/)
  h.advance(5000); view = h.renderComponent(h.QuotaChip, props)
  assert.doesNotMatch(title(view), /Expired/, 'Host minimum TTL still applies to tooltip freshness')
  h.setVisible(false); h.renderComponent(h.QuotaChip, props)
  assert.equal(h.timers.size, 0)
  h.unmount()
})

test('child activity uses independent running status and native timing without conflating unknown with stopped', () => {
  const h = harness(), catalog = [{ id: 'one', label: 'worker' }, { id: 'two' }, { id: 'three' }]
  const state = { byId: { one: { running: false } }, projectionsBySession: {
    one: { values: { subagentTiming: { settledMs: 5000, active: { since: 10000, through: 14000 } } } },
  } }
  const rows = h.childActivityRows(catalog, state, new Map([['one', { running: true }], ['two', { running: false }]]))
  assert.equal(rows[0].running, true)
  assert.equal(rows[1].running, false)
  assert.equal(rows[2].running, null)
  assert.equal(h.childElapsed(rows[0], 20000), 15)
  rows[0].running = false
  assert.equal(h.childElapsed(rows[0], 90000), 9)
  assert.equal(h.childElapsed(rows[2], 90000), null)
  const synthetic = h.childActivityRows([{ id: 'cold' }], { ids: [], byId: { cold: { running: false } } }, null)
  assert.equal(synthetic[0].running, null)
  const baseline = h.childActivityRows([{ id: 'cold' }], { ids: ['cold'], byId: { cold: { running: false } } }, null)
  assert.equal(baseline[0].running, false)
})

test('activity details are bounded and tick only while visible, open and running', () => {
  const h = harness(), catalog = Array.from({ length: 20 }, (_, i) => ({ id: 'child-' + i, label: 'Worker ' + i }))
  const props = { useProjection: () => catalog, useSessions: select => select({ byId: {} }),
    useSessionStatus: select => select(new Map([[catalog[0].id, { running: true }]])) }
  let view = h.renderComponent(h.ActivityRow, props)
  assert.equal(view.children[0].children[0], 'Subagents 0/20 · ?19')
  assert.match(view.children[0].props.title, /1 running.*19 unknown/)
  assert.equal(h.timers.size, 0)
  view.children[0].props.onClick()
  view = h.renderComponent(h.ActivityRow, props)
  assert.equal(view.children[1].children[2].length, 12)
  assert.equal(h.timers.size, 1)
  h.setVisible(false); h.renderComponent(h.ActivityRow, props)
  assert.equal(h.timers.size, 0)
  h.unmount()
})

test('child details use actual consumed model and catalog mode, never pending model selection', () => {
  const h = harness(), catalog = [{ id: 'one', mode: 'continuable' }, { id: 'two', mode: 'unknown' }]
  const rows = h.childActivityRows(catalog, { byId: { one: { projectionValues: {
    modelSelection: { lastUsed: { model: 'used-model', reasoningEffort: 'high' }, next: { model: 'pending-model', reasoningEffort: 'max' } },
  } } }, projectionsBySession: { two: { values: { modelSelection: { lastUsed: null, next: { model: 'never-used' } } } } } }, null)
  assert.equal(rows[0].mode, 'continuable'); assert.equal(rows[0].model, 'used-model')
  assert.equal(rows[0].effort, 'high')
  assert.equal(rows[1].mode, 'unknown'); assert.equal(rows[1].model, null)
  assert.equal(rows[1].effort, null)
})

test('collapsed and hidden Subagents skip metadata; open panels read only twelve children', () => {
  const h = harness(), catalog = Array.from({ length: 500 }, (_, i) => ({ id: 'worker-' + i, label: 'Worker ' + i, createdAt: i }))
  let modelReads = 0
  const ids = catalog.map(child => child.id)
  ids.indexOf = () => { throw new Error('baseline membership must use a set') }
  const state = { ids, byId: {}, projectionsBySession: {} }
  for (const child of catalog) {
    state.byId[child.id] = { running: true }
    const values = {}
    Object.defineProperty(values, 'modelSelection', { enumerable: true, get() { modelReads++; return { lastUsed: { model: 'used-model', reasoningEffort: 'high' } } } })
    state.projectionsBySession[child.id] = { values }
  }
  const props = { sessionId: 'parent', useProjection: () => catalog, useSessions: select => select(state) }
  let view = h.renderComponent(h.ActivityRow, props)
  assert.equal(view.children[0].children[0], 'Subagents 0/500')
  assert.equal(modelReads, 0)
  view.children[0].props.onClick(); view = h.renderComponent(h.ActivityRow, props)
  assert.equal(modelReads, 12)
  assert.equal(view.children[1].children[2].length, 12)
  modelReads = 0
  h.setVisible(false); h.renderComponent(h.ActivityRow, props)
  assert.equal(modelReads, 0)
  h.unmount()
})

test('stopped Subagents fade at 5s, disappear at 15s and resume with a fresh lifetime', () => {
  const h = harness(), catalog = [{ id: 'worker' }], statuses = new Map([['worker', { running: true }]])
  const props = { sessionId: 'parent', useProjection: () => catalog, useSessionStatus: select => select(statuses) }
  let view = h.renderComponent(h.ActivityRow, props)
  assert.equal(view.children[0].children[0], 'Subagents 0/1')
  assert.equal(h.timeouts.size, 0)
  statuses.set('worker', { running: false }); view = h.renderComponent(h.ActivityRow, props)
  assert.equal(view.children[0].children[0], 'Subagents 1/1')
  assert.equal(view.children[0].props.style.opacity, 1)
  h.advance(4999); view = h.renderComponent(h.ActivityRow, props)
  assert.equal(view.children[0].props.style.opacity, 1)
  h.advance(1); view = h.renderComponent(h.ActivityRow, props)
  assert.equal(view.children[0].props.style.opacity, 0.5)
  h.advance(9999); assert.ok(h.renderComponent(h.ActivityRow, props))
  h.advance(1); assert.equal(h.renderComponent(h.ActivityRow, props), null)
  assert.equal(h.timeouts.size, 0)
  statuses.set('worker', { running: true }); view = h.renderComponent(h.ActivityRow, props)
  assert.equal(view.children[0].props.style.opacity, 1)
  statuses.set('worker', { running: false }); view = h.renderComponent(h.ActivityRow, props)
  h.advance(5000); view = h.renderComponent(h.ActivityRow, props)
  assert.equal(view.children[0].props.style.opacity, 0.5)
  h.unmount(); assert.equal(h.timeouts.size, 0)
})

test('Subagent expiry is per child, preserves running and unknown rows, and pauses timers when hidden', () => {
  const h = harness(), catalog = [{ id: 'old' }, { id: 'running' }, { id: 'unknown' }]
  const statuses = new Map([['old', { running: false }], ['running', { running: true }]])
  const props = { sessionId: 'parent', useProjection: () => catalog, useSessionStatus: select => select(statuses) }
  let view = h.renderComponent(h.ActivityRow, props)
  view.children[0].props.onClick(); view = h.renderComponent(h.ActivityRow, props)
  h.advance(5000); view = h.renderComponent(h.ActivityRow, props)
  assert.equal(view.children[0].props.style.opacity, 1, 'live chip stays legible')
  assert.equal(view.children[1].children[2].find(row => row.props.key === 'old').props.style.opacity, 0.5)
  h.setVisible(false); assert.equal(h.renderComponent(h.ActivityRow, props), null)
  assert.equal(h.timeouts.size, 0); assert.equal(h.timers.size, 0)
  h.advance(10000); h.setVisible(true); view = h.renderComponent(h.ActivityRow, props)
  assert.equal(view.children[0].children[0], 'Subagents 1/3 · ?1')
  view.children[0].props.onClick(); view = h.renderComponent(h.ActivityRow, props)
  assert.equal(view.children[1].children[2].length, 2)
  h.unmount(); assert.equal(h.timeouts.size, 0); assert.equal(h.timers.size, 0)
})

test('Subagent lifetime is isolated by parent session and disabled for settings previews', () => {
  const h = harness(), props = { sessionId: 'first', useProjection: () => [{ id: 'worker' }], useSessionStatus: select => select(new Map([['worker', { running: false }]])) }
  h.renderComponent(h.ActivityRow, props); h.advance(15000)
  assert.equal(h.renderComponent(h.ActivityRow, props), null)
  assert.ok(h.renderComponent(h.ActivityRow, { ...props, sessionId: 'second' }))
  h.unmount(); assert.equal(h.timeouts.size, 0)
  const preview = harness()
  preview.renderComponent(preview.ActivityRow, { ...props, preview: true }); preview.advance(90000)
  assert.ok(preview.renderComponent(preview.ActivityRow, { ...props, preview: true }))
  assert.equal(preview.timeouts.size, 0); preview.unmount()
})

test('Subagent progress counts finished children across detail expiry, unknown status and resumption', () => {
  const h = harness(), catalog = [{ id: 'one' }, { id: 'two' }, { id: 'three' }]
  const statuses = new Map(catalog.map(child => [child.id, { running: true }]))
  const props = { sessionId: 'parent', useProjection: () => catalog, useSessionStatus: select => select(statuses) }
  const label = () => h.renderComponent(h.ActivityRow, props)?.children[0].children[0]
  assert.equal(label(), 'Subagents 0/3')
  statuses.set('one', { running: false })
  assert.equal(label(), 'Subagents 1/3')
  h.advance(15000)
  assert.equal(label(), 'Subagents 1/3', 'hiding a finished detail row cannot decrease progress or shrink the denominator')
  statuses.set('two', { running: false }); statuses.set('three', { running: false })
  assert.equal(label(), 'Subagents 3/3')
  statuses.set('one', { running: true })
  assert.equal(label(), 'Subagents 2/3', 'a resumed child is no longer finished')
  statuses.set('one', { running: false })
  assert.equal(label(), 'Subagents 3/3')
  catalog.push({ id: 'unknown' })
  assert.equal(label(), 'Subagents 3/4 · ?1', 'unknown status is not counted as finished')
  catalog.pop(); h.advance(15000)
  assert.equal(label(), undefined, 'the entire chip still expires once all finished detail rows have expired')
  h.unmount()
  assert.equal(h.timeouts.size, 0)
})

test('tools show bounded real calls, freeze settled durations and clean up hidden timers', () => {
  const now = 1700000000000, h = harness({ wallTime: now })
  const data = { activeCount: 3, tools: Array.from({ length: 20 }, (_, i) => ({ callId: String(i), name: 'tool_' + i,
    status: i < 3 ? 'running' : 'failed', startedAt: now - 12000, endedAt: i < 3 ? null : now - 2000 })), truncated: false }
  let running = true
  const props = { sessionId: 'one', useProjection: () => data, useSessionStatus: select => select(new Map([['one', { running }]])) }
  let view = h.renderComponent(h.ToolActivityRow, props)
  assert.equal(view.children[0].children[0], 'Tools 3')
  assert.match(view.children[0].props.title, /tool_0 · tool_1 \+1/)
  assert.doesNotMatch(textContent(view.children[0]), /tool_|12s/)
  assert.equal(h.timers.size, 0, 'collapsed count needs no elapsed clock')
  view.children[0].props.onClick(); view = h.renderComponent(h.ToolActivityRow, props)
  assert.equal(h.timers.size, 1)
  assert.equal(view.children[1].children[1].length, 12)
  assert.match(textContent(view), /not exact execution time/)
  assert.equal(h.toolElapsed(data.tools[3], now + 30000), 10)
  h.setVisible(false); assert.equal(h.renderComponent(h.ToolActivityRow, props), null)
  assert.equal(h.timers.size, 0)
  h.setVisible(true); view = h.renderComponent(h.ToolActivityRow, props)
  view.children[0].props.onClick(); h.renderComponent(h.ToolActivityRow, props)
  data.tools.forEach(row => { row.status = 'stopped'; row.endedAt = now }); data.activeCount = 0
  view = h.renderComponent(h.ToolActivityRow, props)
  assert.match(textContent(view), /Stopped; outcome unknown/)
  assert.equal(h.timers.size, 0)
  view.children[0].props.onClick(); assert.equal(h.renderComponent(h.ToolActivityRow, props), null)
  data.tools[0].status = 'running'; data.activeCount = 1
  running = false; assert.equal(h.renderComponent(h.ToolActivityRow, props), null, 'cold log tails do not imply a running tool')
  running = null; assert.equal(h.renderComponent(h.ToolActivityRow, props), null)
  running = true; data.activeCount = null
  view = h.renderComponent(h.ToolActivityRow, props)
  assert.equal(view.children[0].children[0], 'Tools ?')
  assert.equal(h.timers.size, 0)
  h.unmount()
})

test('ordering normalizes stale/duplicate ids and is shared by preview and actual construction', () => {
  const h = harness(), order = ['tools', 'cost', 'tools', 'removed']
  assert.deepEqual(JSON.parse(JSON.stringify(h.componentOrder(order))), ['tools', 'cost', 'git', 'context', 'tps', 'activity'])
  const chosen = { componentOrder: order, showTools: true, showCost: true, showGit: false, showContext: false, showTokens: false, showTps: false, showActivity: false }
  assert.deepEqual(Array.from(h.dockComponents(chosen, {}, {}).map(node => node.props.key)), ['tools', 'cost'])
  const preview = h.renderComponent(h.LayoutPreview, { config: chosen })
  assert.deepEqual(Array.from(descendants(preview, node => node.props?.key === 'tools' || node.props?.key === 'cost').map(node => node.props.key)), ['tools', 'cost'])
  h.unmount()
})

test('presets and reorder persist only layout fields, with immediate draft preview', async () => {
  const h = harness()
  h.setConfig({ enabled: true, providers: [{ id: 'deepseek', apiKeyEnv: 'EXISTING_REF' }], quotaOnStep: false, showDeepseekPeak: false })
  h.renderComponent(h.SettingsPage)
  function editor() { const page = h.renderComponent(h.SettingsPage); return descendants(page, node => node.type === h.LayoutEditor)[0] }
  let item = editor(), view = h.LayoutEditor(item.props)
  descendants(view, node => node.type === 'button' && textContent(node) === 'Activity first')[0].props.onClick()
  item = editor()
  assert.equal(item.props.config.componentOrder[0], 'tools')
  assert.equal(h.matchingPreset(item.props.config), 'activity')
  assert.equal(item.props.config.providers[0].apiKeyEnv, 'EXISTING_REF')
  assert.equal(item.props.config.showDeepseekPeak, false)
  assert.equal(h.mutations.length, 0, 'preview changes precede debounced save')
  h.advance(700); await flush()
  const keys = h.mutations[0].map(op => op.path[0])
  assert.ok(keys.includes('componentOrder')); assert.ok(keys.includes('showTools'))
  assert.ok(!keys.some(key => /provider|account|quota|peak|enabled/i.test(key)))
  item = editor(); view = h.LayoutEditor(item.props)
  descendants(view, node => node.type === 'button' && node.props['aria-label'] === 'Move Tool activity down')[0].props.onClick()
  assert.equal(editor().props.config.componentOrder[0], 'activity')
  assert.equal(h.matchingPreset(editor().props.config), 'custom')
  h.advance(700); await flush()
  assert.deepEqual(Array.from(h.mutations[1].map(op => op.path[0])), ['componentOrder'])
  h.unmount()
})

test('drag insertion moves before/after either direction and never duplicates or loses hidden widgets', () => {
  const h = harness(), order = Array.from(h.componentOrder())
  assert.deepEqual(Array.from(h.reorderComponent(order, 'tools', 'git', false)), ['tools', 'git', 'context', 'tps', 'cost', 'activity'])
  assert.deepEqual(Array.from(h.reorderComponent(order, 'git', 'cost', true)), ['context', 'tps', 'cost', 'git', 'activity', 'tools'])
  for (const [source, target] of [['git', 'git'], ['unknown', 'git'], ['git', 'unknown']]) assert.deepEqual(Array.from(h.reorderComponent(order, source, target)), order)
  assert.equal(new Set(h.reorderComponent(order, 'cost', 'tools', true)).size, 6)
})

test('pointer drag commits once on drop, while cancel, outside release and keyboard preserve the intended scope', () => {
  for (const pointerType of ['mouse', 'touch']) {
    const h = harness(), chosen = { ...h.layoutPreset('balanced'), showCost: false }, changes = []
    const view = h.LayoutEditor({ config: chosen, onChange: patch => changes.push(patch) })
    const treeList = descendants(view, node => node.props?.className === 'slp-order-list')[0]
    const handles = descendants(view, node => node.props?.className === 'slp-drag-handle')
    const rows = chosen.componentOrder.map((id, i) => {
      const attributes = { 'data-component': id }
      return { getAttribute: key => attributes[key], setAttribute: (key, value) => { attributes[key] = value }, removeAttribute: key => { delete attributes[key] },
        getBoundingClientRect: () => ({ top: i * 30, bottom: i * 30 + 30, height: 30 }) }
    })
    const list = { children: rows, getBoundingClientRect: () => ({ left: 0, right: 260, top: 0, bottom: 210 }) }
    let captured = false
    const handle = { closest: () => list, matches: () => false, focus() {},
      setPointerCapture() { captured = true }, hasPointerCapture: () => captured, releasePointerCapture() { captured = false } }
    const event = (currentTarget, y = 15, x = 10) => ({ currentTarget, pointerId: 9, pointerType, button: 0, isPrimary: true,
      clientX: x, clientY: y, preventDefault() {}, stopPropagation() {} })
    handles[0].props.onPointerDown(event(handle))
    treeList.props.onPointerMove(event(list, 100))
    assert.equal(changes.length, 0, 'drag position does not persist intermediate changes')
    assert.equal(rows[3].getAttribute('data-drop'), 'before')
    treeList.props.onPointerUp(event(list, 100))
    assert.equal(changes.length, 1); assert.deepEqual(Object.keys(changes[0]), ['componentOrder'])
    assert.deepEqual(Array.from(changes[0].componentOrder), ['context', 'tps', 'git', 'cost', 'activity', 'tools'])
    assert.equal(chosen.showCost, false); assert.equal(captured, false)
    assert.equal(list.slpOrderDrag, undefined); assert.ok(rows.every(row => row.getAttribute('data-drop') === undefined))
    handles[0].props.onPointerDown(event(handle)); treeList.props.onPointerMove(event(list, 170))
    treeList.props.onPointerCancel(event(list)); assert.equal(changes.length, 1); assert.equal(captured, false)
    handles[0].props.onPointerDown(event(handle)); treeList.props.onPointerMove(event(list, 170))
    treeList.props.onPointerUp(event(list, 170, 300)); assert.equal(changes.length, 1)
    handles[0].props.onPointerDown(event(handle)); treeList.props.onKeyDown({ ...event(list), key: 'Escape' })
    assert.equal(list.slpOrderDrag, undefined); assert.equal(changes.length, 1)
    handles[0].props.onKeyDown({ ...event(handle), key: 'ArrowDown' })
    assert.equal(changes.length, 2); assert.equal(changes[1].componentOrder[0], 'context')
    h.unmount()
  }
})

test('sample component details acquire no sessions, network sources or clocks', () => {
  const h = harness(), preview = h.renderComponent(h.LayoutPreview, { config: h.layoutPreset('activity') })
  const row = descendants(preview, node => node.props?.className === 'slp-row')[0]
  for (const element of row.children[0]) {
    const sampleHarness = harness()
    let output = sampleHarness.renderComponent(element.type, element.props)
    const button = descendants(output, node => node.type === 'button')[0]
    if (button) { button.props.onClick(); output = sampleHarness.renderComponent(element.type, element.props) }
    assert.equal(sampleHarness.requests.length, 0); assert.equal(sampleHarness.sources.length, 0); assert.equal(sampleHarness.timers.size, 0)
    sampleHarness.unmount()
  }
  assert.equal(h.requests.length, 0); assert.equal(h.timers.size, 0)
  h.unmount()
})

test('cost UI exposes partial coverage, tariff ranges and unknown pricing instead of fabricated zero', () => {
  const h = harness()
  assert.match(h.estimateCost({ pricedMessages: 0, unpricedMessages: 2 }), /Unpriced/)
  assert.match(h.estimateCost({ pricedMessages: 1, unpricedMessages: 2, amountCny: 0.0012 }), /0\.00.*subtotal/)
  assert.equal(h.estimateCost({ pricedMessages: 1, unpricedMessages: 0, amountCny: null, minCny: 1, maxCny: 2 }), '¥1.00–¥2.00')
  const bucket = { pricedMessages: 1, unpricedMessages: 0, amountCny: 0.0012 }
  const props = { useProjection: () => ({ currentTurn: bucket, session: bucket, pricingAsOf: '2026-10-02T04:24:12Z' }) }
  let view = h.renderComponent(h.CostRow, props)
  assert.match(view.children[0].props.title, /API reference cost.*1 priced/)
  assert.equal(view.children[0].children[0], '≈¥0.00')
  assert.doesNotMatch(view.children[0].children[0], /Turn|Session|subtotal/)
  view.children[0].props.onClick(); view = h.renderComponent(h.CostRow, props)
  assert.ok(view.children[1])
  assert.match(descendants(view, node => node.props?.className === 'slp-hint')[0].props['data-tip'], /model vendor.*same reference rates.*not an account charge/i)
  assert.match(textContent(view), /Breakdown needs Host update/)
  h.unmount()
})

test('cost UI shows native USD amounts, separate currencies, source freshness and unpriced reasons', () => {
  const h = harness()
  assert.equal(h.estimateCost({ pricedMessages: 1, amountUsd: 0.25 }, true), '$0.25')
  assert.equal(h.estimateCost({ pricedMessages: 2, amountCny: 1, amountUsd: 2 }, true), '¥1.00 + $2.00')
  const data = { session: { pricedMessages: 1, unpricedMessages: 1, amountUsd: 0.25, sources: { 'pi-ai': 1 }, reasons: { 'cache-write-rate-unknown': 1 } }, catalog: { version: '0.87.1', generatedAt: 1790105504346 } }
  const props = { useProjection: () => data }
  let view = h.renderComponent(h.CostRow, props)
  assert.equal(view.children[0].children[0], '≈$0.25')
  assert.match(view.children[0].props.title, /Unknown cache-write price/)
  view.children[0].props.onClick(); view = h.renderComponent(h.CostRow, props)
  assert.match(textContent(view), /pi-ai/)
  assert.doesNotMatch(textContent(view), /catalog generated|same reference rates/)
  const tip = descendants(view, node => node.props?.className === 'slp-hint')[0].props['data-tip']
  assert.match(tip, /Host pi-ai 0\.87\.1.*catalog generated/)
  assert.match(tip, /same reference rates for subscriptions/)
  assert.equal(h.requests.length, 0, 'cost rendering never queries prices online')
  h.unmount()
})

test('compact cost chart and rows share currency subtotals and range midpoints without rounding bar widths', () => {
  const h = harness(), part = (usd, cny = null) => ({ amountUsd: usd, minUsd: usd, maxUsd: usd, amountCny: cny, minCny: cny, maxCny: cny,
    tokensUsd: usd === null ? null : Math.round(usd * 1e6), tokensCny: cny === null ? null : Math.round(cny * 1e6) })
  const bucket = { pricedMessages: 1, unpricedMessages: 0, ...part(10), sources: { 'pi-ai': 1 },
    breakdown: { input: part(2), cache: part(3), output: part(5) } }
  const props = { useProjection: () => ({ session: bucket }) }
  let view = h.renderComponent(h.CostRow, props)
  const bars = node => descendants(node, item => item.props?.className === 'slp-cost-bar')
  const widths = bar => descendants(bar, item => item.props?.className === 'slp-cost-segment slp-cost-tint').map(item => parseFloat(item.props.style.width))
  assert.equal(bars(view).length, 0, 'collapsed panels do not build a chart')
  view.children[0].props.onClick(); view = h.renderComponent(h.CostRow, props)
  let tables = descendants(view, node => node.type === 'table')
  assert.equal(tables.length, 1)
  assert.match(textContent(tables[0]), /Input 2M \$2\.00 20%\s+Cache 3M \$3\.00 30%\s+Output 5M \$5\.00 50%/)
  assert.equal(descendants(tables[0], node => node.props?.className === 'slp-cost-tokens')[0].props.title, '2000000 tokens')
  assert.deepEqual(widths(bars(view)[0]), [20, 30, 50])
  assert.doesNotMatch(textContent(view), /0 unpriced|catalog generated/)
  Object.assign(bucket, part(10, 20))
  Object.assign(bucket.breakdown.input, part(2, 10)); Object.assign(bucket.breakdown.cache, part(3, 4)); Object.assign(bucket.breakdown.output, part(5, 6))
  view = h.renderComponent(h.CostRow, props)
  tables = descendants(view, node => node.type === 'table')
  assert.equal(tables.length, 2)
  assert.match(textContent(tables[0]), /Input 10M ¥10\.00 50%\s+Cache 4M ¥4\.00 20%\s+Output 6M ¥6\.00 30%/)
  assert.deepEqual(bars(view).map(widths), [[50, 20, 30], [20, 30, 50]], 'currencies each have their own chart')
  bucket.amountUsd = null; bucket.minUsd = 5; bucket.maxUsd = 10
  for (const key of ['input', 'cache', 'output']) { const item = bucket.breakdown[key]; item.amountUsd = null; item.minUsd = item.maxUsd / 2 }
  view = h.renderComponent(h.CostRow, props)
  assert.match(textContent(view), /Input 2M \$1\.00–\$2\.00 ≈20%/)
  assert.deepEqual(widths(bars(view)[1]), [20, 30, 50])
  for (const key of ['input', 'cache', 'output']) Object.assign(bucket.breakdown[key], part(0))
  Object.assign(bucket, part(0))
  view = h.renderComponent(h.CostRow, props)
  assert.doesNotMatch(textContent(view), /NaN|Infinity|100%/)
  assert.equal(widths(bars(view)[0]).length, 0, 'zero subtotal leaves the chart empty')
  Object.assign(bucket, part(0.0201))
  Object.assign(bucket.breakdown.input, part(0.01)); Object.assign(bucket.breakdown.cache, part(0.0001)); Object.assign(bucket.breakdown.output, part(0.01))
  view = h.renderComponent(h.CostRow, props)
  assert.match(textContent(view), /Input 10K \$0\.01/)
  assert.match(textContent(view), /Cache 0\.1K \$0\.00 0\.5%/)
  delete bucket.breakdown.input.tokensUsd
  assert.match(textContent(h.renderComponent(h.CostRow, props)), /Input — \$0\.01/, 'older hosts never show fabricated zero tokens')
  assert.ok(Math.abs(widths(bars(view)[0])[1] - 100 / 201) < 1e-12, 'tiny components retain precise chart proportions')
  delete bucket.breakdown.cache
  assert.equal(bars(h.renderComponent(h.CostRow, props)).length, 0, 'incomplete breakdown never renders a misleading chart')
  assert.equal(h.requests.length, 0)
  h.unmount()
})

test('cost panel fits clipping containers at its final animation size and follows container resize', () => {
  const layout = { width: 390, observers: [] }, h = harness({ panelLayout: layout })
  let containerLeft = 282, scale = 0.97
  const container = { overflowX: 'auto', getBoundingClientRect: () => ({ left: containerLeft, right: 390, width: 390 - containerLeft }) }
  const panel = { style: {}, get offsetWidth() { return Math.min(248, Number.parseFloat(this.style.maxWidth) || 248) },
    getBoundingClientRect() {
      const width = this.offsetWidth, right = 270 - (Number.parseFloat(this.style.right) || 0), inset = width * (1 - scale) / 2
      return { left: right - width + inset, right: right - inset, width: width * scale }
    } }
  const props = { useProjection: () => ({ session: { pricedMessages: 1, unpricedMessages: 0, amountUsd: 1 } }) }
  let view = h.renderComponent(h.CostRow, props)
  view.props.ref.current = { parentElement: container, querySelector: () => panel }
  view.children[0].props.onClick(); h.renderComponent(h.CostRow, props)
  assert.equal(panel.offsetWidth, 84)
  assert.ok(layout.observers[0].nodes.has(container), 'container changes are observed even if trigger size stays unchanged')
  containerLeft = 56
  layout.observers[0].callback()
  scale = 1
  const bounds = panel.getBoundingClientRect()
  assert.equal(panel.offsetWidth, 248, 'panel recovers its width after native layout finishes resizing')
  assert.ok(bounds.left >= 68 && bounds.right <= 378, 'the final animation frame remains inside the clipping container')
  h.unmount()
  assert.equal(layout.observers[0].nodes.size, 0, 'closed panels release resize observations')
})

test('each provider balance and subscription quota trigger refreshes immediately', () => {
  for (const [name, data] of [
    ['ProviderQuotaLine', { style: 'balance', remaining: 12, currency: 'CNY' }],
    ['CodexQuotaLine', { primary: { usedPercent: 20, windowMinutes: 300 } }],
    ['AntigravityQuotaLine', { gemini5h: { usedPercent: 20, remainingPercent: 80 } }],
  ]) {
    const h = harness(); let calls = 0
    const view = h.renderComponent(h[name], { provider: { label: 'Test' }, data, refresh() { calls++ } })
    view.children[0].props.onClick()
    assert.equal(calls, 1, name)
    h.unmount()
  }
})

test('every quota chip opens details on click and refreshes only when opening', () => {
  for (const [name, data] of [
    ['ProviderQuotaLine', { style: 'windows', windows: [{ label: '5h', usedPercent: 23 }] }],
    ['ProviderQuotaLine', { style: 'balance', remaining: 12, currency: 'CNY' }],
    ['CodexQuotaLine', { primary: { usedPercent: 20, windowMinutes: 300 }, planType: 'plus' }],
    ['AntigravityQuotaLine', { gemini5h: { usedPercent: 20, remainingPercent: 80 } }],
    ['OpenCodeQuotaLine', { windows: { rolling: { percent: 20 } } }],
  ]) {
    const h = harness(); let calls = 0
    const props = { provider: { label: 'Test' }, data, refresh() { calls++ } }
    const render = () => h.renderComponent(h[name], props)
    const stale = render().children[0]
    assert.equal(stale.type, 'button', name)
    assert.equal(stale.props['aria-expanded'], false)
    stale.props.onClick()
    assert.ok(render().children[1], name + ' opens details')
    stale.props.onClick()
    assert.equal(render().children[1], null, name + ' closes even from a handler of an older render')
    assert.equal(calls, 1, name + ' closing does not bypass the cache')
    h.unmount()
  }
})

test('quota errors are retry buttons with localized reasons; loading is inert', () => {
  const h = harness(); let calls = 0
  for (const [name, error, reason] of [['CodexQuotaLine', 'account-required', /choose the account file/], ['AntigravityQuotaLine', 'account-required', /choose the account file/], ['ProviderQuotaLine', 'auth', /credential invalid/], ['OpenCodeQuotaLine', 'network', /quota fetch failed/]]) {
    const chip = h[name]({ provider: { label: 'Test' }, error, refresh() { calls++ } }).children[0]
    assert.equal(chip.type, 'button', name)
    assert.match(chip.props.title, reason)
    chip.props.onClick()
    assert.equal(h[name]({ provider: { label: 'Test' }, data: null, error: null, refresh() {} }).children[0].type, 'span')
  }
  assert.equal(calls, 4)
})

test('used/left mode reads the same in chip, tooltip and details, and colour tracks consumption', () => {
  const sources = [
    ['AntigravityQuotaLine', { gemini5h: { usedPercent: 14, remainingPercent: 86 }, geminiWeekly: { usedPercent: 90, remainingPercent: 10 } }],
    ['CodexQuotaLine', { primary: { usedPercent: 14, windowMinutes: 300 }, secondary: { usedPercent: 90, windowMinutes: 10080 } }],
    ['ProviderQuotaLine', { style: 'windows', windows: [{ label: '5h', usedPercent: 14 }, { label: '7d', usedPercent: 90 }] }],
    ['OpenCodeQuotaLine', { windows: { rolling: { percent: 14 }, weekly: { percent: 90 } } }],
  ]
  for (const [name, data] of sources) {
    for (const [mode, shown, hidden, word] of [['used', /14%.*90%/, /86%|10%/, /14% used/], ['left', /86%.*10%/, /14%|90%/, /86% left/]]) {
      const h = harness(), props = { provider: { label: 'Test' }, data, mode, refresh() {} }
      let view = h.renderComponent(h[name], props)
      assert.match(textContent(view.children[0]), shown, name + ' ' + mode)
      assert.doesNotMatch(textContent(view.children[0]), hidden, name + ' ' + mode)
      assert.ok(descendants(view.children[0], node => word.test(node.props?.title || '')).length, name + ' tooltip')
      const red = descendants(view.children[0], node => node.props?.style?.background === 'var(--dsw-alias-state-error-primary)')
      assert.equal(red.length, 1, name + ' the 90%-used window stays red in either mode')
      view.children[0].props.onClick()
      view = h.renderComponent(h[name], props)
      const panel = typeof view.children[1].type === 'function' ? h.renderComponent(view.children[1].type, view.children[1].props) : view.children[1]
      const values = descendants(panel, node => node.props?.className === 'slp-bar-pct').map(textContent)
      assert.deepEqual(values, mode === 'used' ? ['14%', '90%'] : ['86%', '10%'], name + ' details')
      assert.match(textContent(panel), mode === 'used' ? /used/ : /left/)
      assert.doesNotMatch(textContent(panel), mode === 'used' ? /left/ : /used/)
      h.unmount()
    }
  }
})

test('QuotaChip passes the saved percentage mode, defaulting to used', () => {
  const h = harness()
  const base = { resource: { kind: 'codex', key: 'codex' }, stepCount: 0 }
  assert.equal(h.renderComponent(h.QuotaChip, { ...base, config }).children[0].props.mode, 'used')
  assert.equal(h.renderComponent(h.QuotaChip, { ...base, config: { ...config, quotaPercentMode: 'left' } }).children[0].props.mode, 'left')
  h.unmount()
})

test('settings switch percentage mode and reset preferences in two steps without touching accounts', async () => {
  const h = harness()
  h.setConfig({ ...config, hideBottomOnNarrow: true, quotaPercentMode: 'used', showTps: true, cacheTtlMs: 30000, componentOrder: ['tools', 'git'],
    apiKeyEnv: 'MY_REF', codexAccount: 'a.json', gitCwd: '/repo', showCodexQuota: false, providers: [{ id: 'deepseek', apiKeyEnv: 'DS_REF' }] })
  h.renderComponent(h.SettingsPage)
  let view = h.renderComponent(h.SettingsPage)
  descendants(view, node => node.props?.['data-mode'] === 'left')[0].props.onClick()
  h.advance(700); await flush()
  assert.deepEqual(JSON.parse(JSON.stringify(h.mutations[0])), [{ op: 'set', path: ['quotaPercentMode'], value: 'left' }])
  view = h.renderComponent(h.SettingsPage)
  assert.equal(descendants(view, node => node.props?.['data-mode'] === 'left')[0].props['aria-pressed'], true)
  const button = () => descendants(h.renderComponent(h.SettingsPage), node => node.props?.name === 'reset')[0]
  button().props.onClick()
  assert.equal(h.mutations.length, 1, 'first click only arms')
  assert.match(textContent(button()), /Confirm reset/)
  h.advance(4000)
  assert.doesNotMatch(textContent(button()), /Confirm/, 'arming expires')
  button().props.onClick(); button().props.onClick(); await flush(); await flush()
  const ops = h.mutations[1]
  assert.ok(ops.every(op => op.op === 'unset'))
  const keys = ops.map(op => op.path[0])
  for (const key of ['quotaPercentMode', 'showTps', 'cacheTtlMs', 'componentOrder', 'enabled', 'hideBottomOnNarrow']) assert.ok(keys.includes(key), key)
  for (const key of ['apiKeyEnv', 'usageUrl', 'codexAccount', 'antigravityAccount', 'gitCwd', 'providers', 'showCodexQuota', 'showAntigravityQuota', 'showOpenCodeQuota']) assert.ok(!keys.includes(key), key)
  view = h.renderComponent(h.SettingsPage)
  assert.equal(descendants(view, node => node.props?.['data-mode'] === 'used')[0].props['aria-pressed'], true)
  assert.equal(descendants(view, node => node.props?.name === 'cacheTtlMs')[0].props.defaultValue, '60')
  assert.equal(descendants(view, node => node.props?.name === 'hideBottomOnNarrow')[0].props.checked, false)
  assert.match(textContent(view), /Defaults restored/)
  h.advance(700); await flush()
  assert.equal(h.mutations.length, 2, 'no debounced save writes the old values back')
  h.unmount()
})

test('details footer marks a failed refresh as stale and offers a real refresh button', () => {
  const h = harness(); let calls = 0
  const props = { data: { primary: { usedPercent: 20, windowMinutes: 300 }, fetchedAt: Date.now() }, staleError: 'network', ttlMs: 60000, refresh() { calls++ } }
  let view = h.renderComponent(h.CodexQuotaLine, props)
  assert.ok(descendants(view.children[0], node => node.props?.className === 'slp-err').length, 'chip flags the failed refresh')
  view.children[0].props.onClick()
  view = h.renderComponent(h.CodexQuotaLine, props)
  const foot = descendants(view.children[1], node => node.type === h.PanelFoot || node.type?.name === 'PanelFoot')[0]
  const rendered = foot.type(foot.props)
  assert.match(rendered.children[0].type(rendered.children[0].props).props.className, /slp-stale/)
  const button = rendered.children[1]
  assert.equal(button.type, 'button')
  button.props.onClick({ stopPropagation() {} })
  assert.equal(calls, 2)
  h.unmount()
})

test('OpenCode quota click both opens details and bypasses the cache immediately', async () => {
  const h = harness(), props = { resource: { kind: 'opencode', key: 'opencode', onStep: true }, config, stepCount: 0 }
  h.renderComponent(h.QuotaChip, props)
  h.requests[0].resolve({ ok: true, data: { fetchedAt: Date.now(), windows: { rolling: { percent: 20 } } } }); await flush()
  const line = () => h.OpenCodeQuotaLine(h.renderComponent(h.QuotaChip, props).children[0].props)
  line().children[0].props.onClick()
  assert.equal(JSON.parse(h.requests[1].opts.body).force, true)
  assert.ok(line().children[1], 'details are opened without waiting for the refresh')
  h.unmount()
})

test('TPS distinguishes current estimate, retained old rate and settled average', () => {
  const h = harness(); h.renderTps('one')
  h.sources[0].emit({ sessionId: 'one', phase: 'streaming', tokensPerSecond: 42, estimated: true })
  assert.equal(h.renderTps('one').children[0], 'TPS ≈42 tok/s')
  h.advance(100); h.sources[0].emit({ sessionId: 'one', phase: 'streaming', tokensPerSecond: null })
  assert.equal(h.renderTps('one').children[0], 'TPS last ≈42 tok/s')
  h.advance(100); h.sources[0].emit({ sessionId: 'one', phase: 'completed', tokensPerSecond: 50, estimated: false })
  const settled = h.renderTps('one')
  assert.equal(settled.children[0], 'TPS 50 tok/s')
  assert.match(settled.props.title, /Average speed for this generation/)
  h.unmount()
})

test('TPS marks streaming character estimates while keeping rounded rates readable', () => {
  const h = harness(); h.renderTps('one')
  for (const [rate, expected] of [[0, '0'], [12.4, '12'], [12.5, '13'], [99.9, '100'], [123.5, '124']]) {
    h.advance(100)
    h.sources[0].emit({ sessionId: 'one', phase: 'streaming', tokensPerSecond: rate, estimated: true })
    assert.equal(h.renderTps('one').children[0], 'TPS ≈' + expected + ' tok/s')
  }
  h.unmount()
})

test('disabled and hidden quota hooks start no requests or timers', () => {
  for (const options of [{ hidden: true }, {}]) {
    const h = harness(options)
    h.render(resource, options.hidden ? config : { ...config, enabled: false })
    assert.equal(h.requests.length, 0); assert.equal(h.timers.size, 0)
    h.unmount()
  }
})

test('TPS push is session-isolated, polling-free and closed when hidden/disabled/unmounted', () => {
  const h = harness()
  h.renderLive('one')
  h.sources[0].emit({ sessionId: 'one', phase: 'streaming', tokensPerSecond: 123, estimated: true })
  assert.equal(h.renderLive('one').tokensPerSecond, 123)
  assert.equal(h.renderLive('two'), null)
  assert.equal(h.sources[0].closed, true)
  h.sources[0].emit({ sessionId: 'one', phase: 'streaming', tokensPerSecond: 999 })
  assert.equal(h.renderLive('two'), null)
  h.sources[1].emit({ sessionId: 'two', phase: 'completed', tokensPerSecond: 40, estimated: false })
  assert.equal(h.renderLive('two').phase, 'completed')
  h.renderLive('two', false)
  assert.equal(h.sources[1].closed, true)
  assert.equal(h.timers.size, 0)
  h.unmount()
  const hidden = harness({ hidden: true }); hidden.renderLive('one')
  assert.equal(hidden.sources.length, 0); hidden.unmount()
})

test('TPS coalesces bursts to 25ms and flushes the latest final value', () => {
  const h = harness(); h.renderLive('one')
  const emit = (rate, phase = 'streaming') => h.sources[0].emit({ sessionId: 'one', phase, tokensPerSecond: rate })
  emit(10); assert.equal(h.renderLive('one').tokensPerSecond, 10)
  h.advance(5); emit(20); emit(30)
  assert.equal(h.timeouts.size, 1)
  h.advance(19); assert.equal(h.renderLive('one').tokensPerSecond, 10)
  h.advance(1); assert.equal(h.renderLive('one').tokensPerSecond, 30)
  emit(40, 'completed'); h.advance(25)
  assert.equal(h.renderLive('one').tokensPerSecond, 40)
  assert.equal(h.renderLive('one').phase, 'completed')
  assert.equal(h.timeouts.size, 0)
  emit(50); h.unmount(); assert.equal(h.timeouts.size, 0)
})

test('TPS retains same-session speed through TTFT and reconnect, never across sessions', () => {
  const h = harness(); h.renderLive('one')
  const emit = rate => h.sources[0].emit({ sessionId: 'one', phase: 'streaming', tokensPerSecond: rate, estimated: true })
  emit(null); assert.equal(h.renderLive('one').tokensPerSecond, null)
  h.advance(100); emit(42)
  h.advance(100); emit(null)
  assert.equal(h.renderLive('one').tokensPerSecond, 42)
  assert.equal(h.renderLive('one').held, true)
  h.advance(100); h.sources[0].onerror()
  assert.equal(h.renderLive('one').tokensPerSecond, 42)
  assert.equal(h.renderLive('one').phase, 'unavailable')
  h.advance(100); emit(50)
  assert.equal(h.renderLive('one').held, false)
  emit(60); assert.equal(h.timeouts.size, 1)
  assert.equal(h.renderLive('two'), null)
  assert.equal(h.timeouts.size, 0)
  h.sources[1].emit({ sessionId: 'two', phase: 'idle', tokensPerSecond: null })
  assert.equal(h.renderLive('two').tokensPerSecond, null)
  h.unmount()
})

test('TPS UI maps a bare scope UUID to its native session ID without discarding updates', () => {
  const h = harness(), id = '12345678-1234-4234-8234-123456789abc'
  h.renderLive(id)
  assert.equal(h.sources[0].url, '/statusline/api/tps?sessionId=session-' + id)
  h.sources[0].emit({ sessionId: 'session-' + id, phase: 'streaming', tokensPerSecond: 123, estimated: true })
  assert.equal(h.renderLive(id).tokensPerSecond, 123)
  h.unmount()
})

test('one selected source refreshes on steps without polling and aborts on unmount', async () => {
  const h = harness()
  h.render(resource, config)
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].url, '/statusline/api/provider-quota')
  h.requests[0].resolve({ ok: true, data: { remaining: 5 } }); await flush()
  h.render(resource, config, 1)
  assert.equal(h.requests.length, 2)
  assert.equal(JSON.parse(h.requests[1].opts.body).force, true)
  assert.equal(h.timers.size, 0)
  h.unmount()
  assert.equal(h.requests[1].opts.signal.aborted, true)
  assert.equal(h.timers.size, 0)
})

test('display-only edits neither refetch quota nor start timers', async () => {
  const h = harness()
  h.render(resource, config)
  h.requests[0].resolve({ ok: true, data: { remaining: 5 } }); await flush()
  const result = h.render(resource, { ...config, showGit: false, showTps: true })
  assert.equal(result.data.remaining, 5)
  assert.equal(h.requests.length, 1)
  assert.equal(h.timers.size, 0)
  h.unmount()
})

test('steps during an in-flight quota request coalesce into one trailing refresh', async () => {
  const h = harness()
  h.render(resource, config)
  h.render(resource, config, 1)
  h.render(resource, config, 2)
  assert.equal(h.requests.length, 1)
  h.requests[0].resolve({ ok: true, data: { remaining: 5 } }); await flush()
  assert.equal(h.requests.length, 2)
  h.requests[1].resolve({ ok: true, data: { remaining: 4 } }); await flush()
  assert.equal(h.render(resource, config, 2).data.remaining, 4)
  h.unmount()
})

test('switching quota sources cancels the old request and ignores late data', async () => {
  const h = harness()
  h.render(resource, config)
  h.render({ kind: 'codex', key: 'codex' }, config)
  assert.equal(h.requests[0].opts.signal.aborted, true)
  h.requests[1].resolve({ ok: true, data: { planType: 'fixture' } }); await flush()
  const result = h.render({ kind: 'codex', key: 'codex' }, config)
  assert.equal(result.data.planType, 'fixture')
  h.unmount()
})

test('billing provider and reset units do not infer Codex from a GPT model name', () => {
  const h = harness()
  assert.equal(h.isCodexModel({ provider: 'openrouter', model: 'gpt-5.6' }), false)
  assert.equal(h.isAntigravityModel({ provider: 'google', model: 'gemini-3' }), false)
  assert.equal(h.isCodexModel({ provider: 'codex', model: 'gpt-5.6' }), true)
  assert.equal(h.codexWindowLabel(300), '5h')
  assert.equal(h.fmtResetHours(30), '30s')
  assert.equal(h.fmtResetHours(18000), '5.0h')
  assert.equal(h.fmtResetHours(47 * 3600), '47.0h')
  assert.equal(h.fmtResetHours(48 * 3600), '2.0d')
  assert.equal(h.fmtResetHours(60 * 3600), '2.5d')
  assert.equal(h.fmtResetHours(7 * 86400), '7.0d')
})

test('client settings submit only changed fields through native mutation', async () => {
  const h = harness()
  assert.equal((await h.apiSetConfig({ showGit: false })).ok, true)
  assert.deepEqual(JSON.parse(JSON.stringify(h.mutations)), [[{ op: 'set', path: ['showGit'], value: false }]])
})

test('missing OpenCode windows stay unknown and paths display only their last two segments', () => {
  const h = harness()
  assert.equal(h.normalizeWindows({ windows: {} }, 0).length, 0)
  assert.equal(h.normalizeWindows({ windows: { rolling: { percent: null } } }, 0).length, 0)
  const windows = h.normalizeWindows({ windows: { rolling: { percent: 0 } } }, 0)
  assert.equal(windows.length, 1)
  assert.equal(windows[0].pct, 0)
  assert.equal(h.formatPathSegs('/home/user/projects/statusline/', 2), 'projects/statusline')
  assert.equal(h.formatPathSegs('C:\\projects\\statusline', 2), 'projects/statusline')
})

function textContent(node) {
  if (node === null || node === undefined || node === false) return ''
  if (Array.isArray(node)) return node.map(textContent).filter(Boolean).join(' ')
  if (typeof node !== 'object') return String(node)
  return textContent(node.children)
}
function descendants(node, predicate) {
  if (Array.isArray(node)) return node.flatMap(child => descendants(child, predicate))
  if (!node || typeof node !== 'object') return []
  return (predicate(node) ? [node] : []).concat(descendants(node.children, predicate))
}

test('built-in exact matches use only the billing provider and custom rules retain their behavior', () => {
  const h = harness()
  for (const [id, aliases, model] of [
    ['deepseek', ['deepseek'], 'deepseek-chat'],
    ['kimi-code', ['kimi-code', 'kimi-for-coding'], 'kimi-k2.5'],
    ['zai', ['zai', 'zai-coding'], 'glm-5'],
    ['zhipu', ['zhipu', 'zai-coding-cn'], 'glm-5'],
  ]) {
    const source = { id, match: { providerExact: aliases, providerSub: [model], modelPrefix: [model] } }
    for (const provider of aliases) assert.equal(h.providerMatchesModel(source, { provider: provider.toUpperCase(), model }), true)
    for (const provider of ['openrouter', 'opencode', 'unrelated-' + aliases[0]]) {
      assert.equal(h.providerMatchesModel(source, { provider, model }), false)
    }
    assert.equal(h.providerMatchesModel(source, { model: aliases[0] }), false)
  }
  assert.equal(h.providerMatchesModel({ match: { providerSub: ['DS'] } }, { provider: 'custom-ds', model: 'other' }), true)
  assert.equal(h.providerMatchesModel({ match: { providerSub: ['deepseek'] } }, { provider: 'custom', model: 'deepseek-chat' }), true)
  assert.equal(h.providerMatchesModel({ match: { modelPrefix: ['GLM-'] } }, { provider: 'custom', model: 'glm-5' }), true)
  h.unmount()
})

test('balance formatting preserves currency and treats absent values as unknown', () => {
  const h = harness()
  assert.equal(h.fmtMoney('12.34', 'CNY'), '¥12.34')
  assert.equal(h.fmtMoney(123.45, 'USD'), '$123.45')
  assert.equal(h.fmtMoney(4.5, 'EUR'), 'EUR 4.50')
  assert.equal(h.fmtMoney(0, 'cny'), '¥0.00')
  assert.equal(h.fmtMoney(1), '$1.00')
  for (const value of [null, undefined, '', '  ', false, NaN, Infinity, 'invalid']) assert.equal(h.fmtMoney(value, 'CNY'), '—')
  h.unmount()
})

test('DeepSeek chip renders every currency, balance components and account availability without inventing usage', () => {
  const h = harness()
  const provider = { id: 'deepseek', label: 'DeepSeek' }
  const data = { style: 'balance', isAvailable: true, redBelow: 1, balances: [
    { currency: 'CNY', remaining: 12.34, granted: 2.34, toppedUp: 10 },
    { currency: 'USD', remaining: 0.5, granted: 0, toppedUp: 0.5 },
  ] }
  let refreshes = 0
  const chip = h.ProviderQuotaLine({ provider, data, refresh: () => refreshes++ }).children[0]
  assert.match(textContent(chip), /DeepSeek/)
  assert.match(textContent(chip), /¥12\.34/)
  assert.match(textContent(chip), /\$0\.50/)
  assert.match(chip.props.title, /\(CNY\).*granted balance ¥2\.34.*topped-up balance ¥10\.00/)
  assert.match(chip.props.title, /account available/)
  assert.doesNotMatch(chip.props.title, /used|limit/)
  const amounts = descendants(chip, node => node.props?.className === 'slp-seg-label')
  assert.equal(amounts.length, 2)
  assert.equal(amounts[0].props.style.color, undefined)
  assert.equal(amounts[1].props.style.color, 'var(--dsw-alias-state-error-primary)')
  chip.props.onClick(); assert.equal(refreshes, 1)
  const unavailable = h.ProviderQuotaLine({ provider, data: { ...data, isAvailable: false }, refresh() {} }).children[0]
  assert.match(unavailable.props.title, /account currently unavailable/)
  for (const amount of descendants(unavailable, node => node.props?.className === 'slp-seg-label')) {
    assert.equal(amount.props.style.color, 'var(--dsw-alias-state-error-primary)')
  }
  const unknown = h.ProviderQuotaLine({ provider, data: { style: 'balance', remaining: null, used: undefined }, refresh() {} })
  assert.match(textContent(unknown), /DeepSeek.*—/)
  assert.doesNotMatch(textContent(unknown), /\$0/)
  h.unmount()
})

test('subscription chips show provider, window labels and actual percentages with elapsed reset tooltips', () => {
  const wallTime = 1700000000000, h = harness({ wallTime })
  const provider = { id: 'kimi-code', label: 'Kimi Code' }
  const data = { style: 'windows', fetchedAt: wallTime - 3600000, windows: [
    { label: '5h', usedPercent: 23, resetInSec: 7200 },
    { label: '7d', usedPercent: 0 },
    { label: 'monthly', usedPercent: null },
  ] }
  const render = () => h.ProviderQuotaLine({ provider, data, refresh() {} })
  const chip = render()
  assert.match(textContent(chip), /Kimi Code.*5h.*23%.*7d.*0%/)
  assert.doesNotMatch(textContent(chip), /monthly/)
  const segments = descendants(chip, node => node.props?.className === 'slp-seg')
  assert.equal(segments.length, 2)
  assert.equal(segments[0].props.title, '5h: 23% used · resets in 1.0h')
  assert.equal(segments[1].props.title, '7d: 0% used')
  const fills = descendants(chip, node => node.props?.style?.width === '23%')
  assert.equal(fills.length, 1)
  h.advance(1800000)
  assert.equal(descendants(render(), node => node.props?.className === 'slp-seg')[0].props.title, '5h: 23% used · resets in 30m')
  h.unmount()
})

test('provider onTurn setting reaches the header and prevents per-step requests while preserving manual refresh', async () => {
  const h = harness(), provider = { id: 'deepseek', onTurn: false, match: { providerExact: ['deepseek'] } }
  h.setConfig({ ...config, providers: [provider] })
  const props = { sessionId: 'one', useProjection: () => ({ steps: 0 }) }
  h.renderComponent(h.HeaderChip, props)
  h.requests[0].resolve({ ok: true, data: { provider: 'deepseek', model: 'deepseek-chat' } }); await flush()
  const header = h.renderComponent(h.HeaderChip, props)
  const chip = descendants(header, node => node.props?.resource)[0]
  assert.equal(chip.props.resource.onStep, false)
  assert.equal(chip.props.resource.cacheOnStep, true)
  h.unmount()

  const lifecycle = harness(), selected = chip.props.resource
  lifecycle.render(selected, config)
  lifecycle.requests[0].resolve({ ok: true, data: { remaining: 5 } }); await flush()
  lifecycle.render(selected, config, 1)
  const result = lifecycle.render(selected, config, 2)
  assert.equal(lifecycle.requests.length, 1)
  result.refresh()
  assert.equal(lifecycle.requests.length, 2)
  assert.equal(JSON.parse(lifecycle.requests[1].opts.body).force, true)
  lifecycle.unmount()
})

test('built-in turn refresh honors the host cache and manual refresh still bypasses it', async () => {
  const h = harness()
  const cached = { ...resource, id: 'deepseek', key: 'provider:deepseek', cacheOnStep: true }
  h.render(cached, config)
  h.requests[0].resolve({ ok: true, data: { remaining: 5 } }); await flush()
  h.render(cached, config, 1)
  assert.equal(h.requests.length, 2)
  assert.equal(JSON.parse(h.requests[1].opts.body).force, false)
  h.requests[1].resolve({ ok: true, data: { remaining: 5 } }); await flush()
  h.render(cached, config, 1).refresh()
  assert.equal(h.requests.length, 3)
  assert.equal(JSON.parse(h.requests[2].opts.body).force, true)
  h.unmount()
})

test('provider settings save credential references without accepting literal keys', async () => {
  const h = harness()
  const providers = [
    { id: 'deepseek', label: 'DeepSeek', style: 'balance', apiKeyEnv: 'DEEPSEEK_API_KEY', onTurn: false, redBelow: 1, match: { providerExact: ['deepseek'] } },
    { id: 'zhipu', label: '智谱', style: 'windows', apiKeyEnv: 'ZAI_CODING_CN_API_KEY', onTurn: false },
  ]
  h.setConfig({ ...config, providers })
  h.renderComponent(h.SettingsPage)
  let settings = h.renderComponent(h.SettingsPage)
  const credential = descendants(settings, node => node.type === 'input' && node.props?.value === 'DEEPSEEK_API_KEY')[0]
  assert.equal(credential.props.pattern, '[A-Za-z_][A-Za-z0-9_]*')
  credential.props.onChange({ target: { value: 'sk-example-not-a-reference' } })
  h.advance(700); await flush()
  assert.equal(h.mutations.length, 0)
  credential.props.onChange({ target: { value: 'MY_DEEPSEEK_KEY' } })
  h.advance(700); await flush()
  assert.equal(h.mutations.length, 1)
  let saved = h.mutations[0][0].value
  assert.equal(saved[0].apiKeyEnv, 'MY_DEEPSEEK_KEY')
  assert.deepEqual(JSON.parse(JSON.stringify(saved[0].match)), providers[0].match)
  assert.deepEqual(JSON.parse(JSON.stringify(saved[1])), providers[1])
  settings = h.renderComponent(h.SettingsPage)
  const row = descendants(settings, node => node.props?.key === 'deepseek')[0]
  const checkboxes = descendants(row, node => node.type === 'input' && node.props?.type === 'checkbox')
  assert.equal(checkboxes.length, 1, 'only source enablement stays inside the account card')
  assert.equal(saved[0].onTurn, false, 'legacy per-source preferences remain untouched')
  assert.ok(descendants(settings, node => node.props?.value === 'ZAI_CODING_CN_API_KEY').length)
  h.unmount()
})

test('DeepSeek peak clock ticks locally, stops while hidden and cleans up on unmount', () => {
  const h = harness({ wallTime: Date.parse('2026-10-08T00:59:59Z') })
  let chip = h.renderComponent(h.DeepseekPeakChip)
  assert.match(textContent(chip), /Off-peak.*00:00:01/)
  assert.doesNotMatch(textContent(chip), /50%/)
  assert.equal(h.timers.size, 1)
  assert.deepEqual(h.requests.map(r => r.url), ['/statusline/api/peak-schedule'], 'only the once-per-page schedule load')
  h.advance(1000); h.tick()
  chip = h.renderComponent(h.DeepseekPeakChip)
  assert.match(textContent(chip), /Peak rate.*03:00:00/)
  h.setVisible(false)
  assert.equal(h.renderComponent(h.DeepseekPeakChip), null)
  assert.equal(h.timers.size, 0)
  h.setVisible(true)
  h.renderComponent(h.DeepseekPeakChip)
  assert.equal(h.timers.size, 1)
  h.unmount()
  assert.equal(h.timers.size, 0)
  assert.equal(h.documentEvents.get('visibilitychange').size, 0)
})

test('footer dot shows peak state without a session, with countdown tooltip and an upward panel', () => {
  for (const [at, tone, word] of [['2026-10-08T02:00:00Z', 'peak', /Peak rate · Off-peak in 02:00:00/], ['2026-10-10T02:00:00Z', 'off', /Off-peak · Peak in/], ['2027-03-03T02:00:00Z', 'unknown', /Schedule unknown/]]) {
    const h = harness({ wallTime: Date.parse(at) })
    h.setConfig({ ...config })
    h.renderComponent(h.PeakFooterDot)
    let view = h.renderComponent(h.PeakFooterDot)
    const button = view.children[0]
    assert.equal(button.props['data-peak'], tone, at)
    assert.match(button.props.title, word)
    assert.equal(h.timers.size, 0, 'closed: no per-second interval')
    assert.equal(h.timeouts.size, 1, 'closed: one wake-up at the next switch')
    assert.ok([...h.timeouts.values()][0].at <= 60000)
    button.props.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 40, top: 860 }) } })
    view = h.renderComponent(h.PeakFooterDot)
    assert.match(view.children[1].props.className, /slp-panel-fixed/)
    assert.equal(h.timers.size, 1, 'open: 1 s countdown')
    h.unmount()
  }
  const off = harness(); off.setConfig({ ...config, showPeakDot: false })
  off.renderComponent(off.PeakFooterDot)
  assert.equal(off.renderComponent(off.PeakFooterDot), null)
  assert.equal(off.timers.size, 0)
  off.unmount()
})

test('fetched holiday calendar extends coverage, notes make-up days and flags a changed official rule', async () => {
  const h = harness()
  const off = Array.from({ length: 25 }, (_, i) => '2027-02-' + String(i + 1).padStart(2, '0'))
  const schedule = { holidays: { 2027: { year: 2027, published: true, off, work: ['2027-02-27'], names: { '2027-02-10': '春节' } } }, rule: { status: 'match' } }
  const weekday = Date.parse('2027-03-03T02:00:00Z') // Wed 10:00 Beijing
  assert.equal(h.deepseekPeakStatus(weekday).isPeak, null, 'built-in calendar does not cover 2027')
  const known = h.deepseekPeakStatus(weekday, schedule)
  assert.equal(known.isPeak, true); assert.equal(known.calendarSource, 'fetched')
  assert.equal(h.deepseekPeakStatus(Date.parse('2027-02-10T02:00:00Z'), schedule).holiday, '春节')
  const makeup = h.deepseekPeakStatus(Date.parse('2027-02-27T02:00:00Z'), schedule)
  assert.equal(makeup.isPeak, false); assert.equal(makeup.makeupWorkday, true)
  const builtinMakeup = h.deepseekPeakStatus(Date.parse('2026-10-10T02:00:00Z'))
  assert.equal(builtinMakeup.isPeak, false); assert.equal(builtinMakeup.makeupWorkday, true)
  assert.equal(h.deepseekPeakStatus(weekday, { ...schedule, rule: { status: 'changed' } }).ruleChanged, true)
  assert.equal(h.deepseekPeakStatus(weekday, { ...schedule, holidays: { 2027: { year: 2027, published: false, off: [] } } }).isPeak, null, 'unpublished stays unknown')
  // the dot loads the schedule and raises its alert badge
  h.setConfig({ ...config })
  h.renderComponent(h.PeakFooterDot)
  const request = h.requests.find(r => r.url === '/statusline/api/peak-schedule')
  request.resolve({ ok: true, data: { holidays: {}, rule: { status: 'changed' } } }); await flush()
  const dot = h.renderComponent(h.PeakFooterDot).children[0]
  assert.equal(dot.props['data-alert'], 'true')
  assert.match(dot.props.title, /rule may have changed/)
  h.unmount()
})

test('slow peak clock wakes exactly at the next switch instead of every second', () => {
  const h = harness({ wallTime: Date.parse('2026-10-08T03:59:30Z') }) // 11:59:30 Beijing, peak ends 12:00
  h.setConfig({ ...config })
  h.renderComponent(h.PeakFooterDot)
  let view = h.renderComponent(h.PeakFooterDot)
  assert.equal(view.children[0].props['data-peak'], 'peak')
  const [wake] = [...h.timeouts.values()]
  assert.ok(wake.at >= 30000 && wake.at <= 31000, 'scheduled for the 12:00 switch')
  h.advance(30100)
  view = h.renderComponent(h.PeakFooterDot)
  assert.equal(view.children[0].props['data-peak'], 'off')
  h.unmount()
})

test('header resolves the model from the native selection and refreshes when a turn starts', async () => {
  const h = harness()
  h.setConfig({ ...config, showDeepseekPeak: false, quotaOnStep: true, providers: [{ id: 'deepseek', label: 'DeepSeek', enabled: true, match: { providerExact: ['deepseek'] } }] })
  let running = false, steps = 0
  const props = { sessionId: 'fixture',
    useProjection: key => key === 'modelSelection' ? { lastUsed: null, next: { provider: 'deepseek', model: 'deepseek-flash' } } : key === 'sessionStats' ? { steps } : null,
    useSessionStatus: select => select(new Map([['fixture', { running }]])) }
  let view = h.renderComponent(h.HeaderChip, props)
  assert.equal(h.requests.length, 0, 'no session-log lookup when the selection is known')
  assert.equal(view.type, h.QuotaChip)
  assert.equal(view.props.resource.id, 'deepseek')
  const before = view.props.stepCount
  running = true
  view = h.renderComponent(h.HeaderChip, props)
  assert.ok(view.props.stepCount > before, 'turn start raises the refresh trigger before any step ends')
  h.unmount()
})

test('disabled or hidden peak indicators start no timers and countdown preference applies to details', () => {
  for (const options of [{ hidden: true }, {}]) {
    const h = harness(options)
    assert.equal(h.renderComponent(h.DeepseekPeakChip, options.hidden ? {} : { enabled: false }), null)
    assert.equal(h.timers.size, 0)
    h.unmount()
  }
  const h = harness({ wallTime: Date.parse('2026-10-08T02:00:00Z') })
  let chip = h.renderComponent(h.DeepseekPeakChip, { countdown: false })
  assert.match(textContent(chip), /Peak rate/)
  assert.doesNotMatch(textContent(chip), /02:00:00/)
  const button = descendants(chip, node => node.type === 'button')[0]
  assert.doesNotMatch(button.props.title, /Off-peak in/)
  button.props.onClick()
  chip = h.renderComponent(h.DeepseekPeakChip, { countdown: false })
  const panel = h.PeakPanel(chip.children[1].props)
  assert.match(textContent(panel), /Official rules and current prices/)
  assert.doesNotMatch(textContent(panel), /Off-peak in/)
  h.documentEvents.get('keydown').forEach(fn => fn({ key: 'Escape', stopPropagation() {} }))
  assert.equal(descendants(h.renderComponent(h.DeepseekPeakChip), node => node.props?.role === 'region').length, 0)
  h.unmount()
})

test('peak source follows direct DeepSeek billing and can display with balance disabled', async () => {
  for (const [provider, expected] of [['deepseek', true], ['deepseek-official', true], ['openrouter', false], ['opencode-go', false]]) {
    const h = harness()
    h.setConfig({ ...config, showQuota: false, showDeepseekPeak: true })
    const props = { sessionId: 'one' }
    h.renderComponent(h.HeaderChip, props)
    h.requests[0].resolve({ ok: true, data: { provider, model: 'deepseek-flash' } }); await flush()
    const header = h.renderComponent(h.HeaderChip, props)
    assert.equal(descendants(header, node => node.type === h.DeepseekPeakChip).length, expected ? 1 : 0)
    assert.equal(h.requests.length, 1)
    assert.equal(h.requests[0].url, '/statusline/api/session-model')
    h.unmount()
  }
})

test('peak display and countdown switches persist through native settings mutations', async () => {
  const h = harness()
  h.setConfig({ ...config, showDeepseekPeak: true, deepseekPeakCountdown: true, providers: [] })
  h.renderComponent(h.SettingsPage)
  const form = h.renderComponent(h.SettingsPage)
  const label = descendants(form, node => node.type === 'label' && textContent(node).includes('Show peak / off-peak in direct'))[0]
  descendants(label, node => node.type === 'input')[0].props.onChange({ target: { checked: false } })
  h.advance(700); await flush()
  assert.deepEqual(JSON.parse(JSON.stringify(h.mutations[0])), [{ op: 'set', path: ['showDeepseekPeak'], value: false }])
  const countdown = descendants(h.renderComponent(h.SettingsPage), node => node.type === 'label' && textContent(node).includes('Show peak / off-peak countdown'))[0]
  descendants(countdown, node => node.type === 'input')[0].props.onChange({ target: { checked: false } })
  h.advance(700); await flush()
  assert.deepEqual(JSON.parse(JSON.stringify(h.mutations[1])), [{ op: 'set', path: ['deepseekPeakCountdown'], value: false }])
  h.unmount()
})

test('grouped settings keep advanced controls folded and persist only the changed toggle', async () => {
  const h = harness()
  h.setConfig({ ...config, providers: [], showContext: false, showDeepseekPeak: true, deepseekPeakCountdown: true })
  h.renderComponent(h.SettingsPage)
  let view = h.renderComponent(h.SettingsPage)
  assert.deepEqual(descendants(view, node => node.type === 'h2').map(node => textContent(node).replace('ⓘ', '').trim()), [
    'Bottom status line', 'Quota and peak hours', 'Git', 'Quota sources and accounts',
  ])
  const folds = descendants(view, node => node.type === 'details')
  assert.ok(folds.some(node => textContent(node).includes('Advanced settings')))
  assert.ok(folds.every(node => !node.props.open))
  assert.equal(h.mutations.length, 0)
  const editorProps = descendants(view, node => node.type === h.LayoutEditor)[0].props
  const contextInput = descendants(h.LayoutEditor(editorProps), node => node.type === 'input' && node.props.name === 'showContext')[0]
  assert.equal(contextInput.props.checked, false)
  contextInput.props.onChange({ target: { checked: true } })
  h.advance(700); await flush()
  assert.deepEqual(JSON.parse(JSON.stringify(h.mutations[0])), [{ op: 'set', path: ['showContext'], value: true }])
  view = h.renderComponent(h.SettingsPage)
  const updated = descendants(view, node => node.type === h.LayoutEditor)[0].props
  assert.equal(descendants(h.LayoutEditor(updated), node => node.type === 'input' && node.props.name === 'showContext')[0].props.checked, true)
  h.unmount()
})

test('CTX retains used tokens and capacity without repeating the native percentage', () => {
  const h = harness()
  const projected = h.renderComponent(h.ContextProjection, { useProjection: () => ({ projectedTokens: 12345, contextWindow: 1000000 }) })
  const view = h.renderComponent(projected.type, projected.props)
  assert.equal(textContent(view).replace(/\s+/g, ' ').trim(), 'CTX 12.3K / 1M')
  assert.doesNotMatch(textContent(view), /%/)
  assert.equal(view.children[1].props.title, '12345 / 1000000 tokens')
  h.unmount()
})

test('one quota refresh switch overrides legacy per-source choices without rewriting accounts', async () => {
  const h = harness(), providers = [{ id: 'deepseek', label: 'DeepSeek', enabled: true, onTurn: false, style: 'balance' },
    { id: 'kimi-code', label: 'Kimi', enabled: true, onTurn: true, style: 'windows' }]
  h.setConfig({ ...config, providers })
  h.renderComponent(h.SettingsPage)
  let view = h.renderComponent(h.SettingsPage)
  const refresh = descendants(view, node => node.type === 'input' && node.props.name === 'quotaOnStep')
  assert.equal(refresh.length, 1)
  assert.equal(refresh[0].props.checked, false, 'legacy mixed preferences migrate conservatively')
  assert.equal(descendants(view, node => node.type === 'label' && textContent(node).trim() === 'Refresh after each step').length, 0)
  refresh[0].props.onChange({ target: { checked: true } })
  h.advance(700); await flush()
  assert.deepEqual(JSON.parse(JSON.stringify(h.mutations[0])), [{ op: 'set', path: ['quotaOnStep'], value: true }])
  assert.equal(h.quotaRefreshOnStep({ providers, quotaOnStep: true }), true)
  assert.equal(h.quotaRefreshOnStep({ providers, quotaOnStep: false }), false)
  h.unmount()
})

test('settings distinguish the master switch and disable subordinate controls without clearing them', () => {
  const h = harness()
  h.setConfig({ ...config, enabled: false, compactLayout: true, showGit: false, showDeepseekPeak: false,
    deepseekPeakCountdown: true, providers: [{ id: 'deepseek', label: 'DeepSeek', enabled: false }] })
  h.renderComponent(h.SettingsPage)
  const view = h.renderComponent(h.SettingsPage)
  const master = descendants(view, node => node.props?.className === 'slp-master')[0]
  assert.equal(descendants(master, node => node.type === 'input')[0].props.name, 'enabled')
  const disabled = descendants(view, node => node.type === 'fieldset' && node.props.disabled)
  assert.ok(disabled.some(node => descendants(node, n => n.type === h.LayoutEditor).length))
  assert.ok(disabled.some(node => descendants(node, n => n.props?.name === 'deepseekPeakCountdown').length))
  assert.ok(disabled.some(node => descendants(node, n => n.props?.name === 'gitCwd').length))
  assert.equal(descendants(view, node => node.props?.name === 'compactLayout').length, 0)
  assert.equal(h.mutations.length, 0)
  h.unmount()
})

test('shared refresh preference reaches every selected source, including manual OpenCode', async () => {
  for (const provider of ['deepseek', 'codex', 'antigravity', 'opencode-go', null]) {
    const h = harness()
    h.setConfig({ ...config, quotaOnStep: false, showDeepseekPeak: false, showCodexQuota: true, showAntigravityQuota: true,
      quotaAuto: provider !== null, providers: [{ id: 'deepseek', enabled: true, match: { providerExact: ['deepseek'] }, onTurn: true }] })
    const props = { sessionId: 'fixture' }
    let view = h.renderComponent(h.HeaderChip, props)
    if (provider !== null) {
      h.requests[0].resolve({ ok: true, data: { provider, model: provider === 'codex' ? 'gpt-5.6' : 'deepseek-flash' } }); await flush()
      view = h.renderComponent(h.HeaderChip, props)
    }
    assert.equal(view.type, h.QuotaChip)
    assert.equal(view.props.resource.onStep, false, provider || 'manual OpenCode')
    assert.equal(view.props.resource.cacheOnStep, true, provider || 'manual OpenCode')
    h.unmount()
  }
})

test('every selected source uses cached automatic step refresh and preserves force on click', async () => {
  for (const provider of ['deepseek', 'codex', 'antigravity', 'opencode-go', 'custom', null]) {
    const h = harness()
    const providers = [{ id: 'deepseek', match: { providerExact: ['deepseek'] } }, { id: 'custom', match: { providerSub: ['custom'] } }]
    h.setConfig({ ...config, quotaOnStep: true, showDeepseekPeak: false, showCodexQuota: true, showAntigravityQuota: true, quotaAuto: provider !== null, providers })
    let view = h.renderComponent(h.HeaderChip, { sessionId: 'fixture' })
    if (provider !== null) {
      h.requests[0].resolve({ ok: true, data: { provider, model: 'fixture-model' } }); await flush()
      view = h.renderComponent(h.HeaderChip, { sessionId: 'fixture' })
    }
    const selected = view.props.resource
    assert.equal(selected.cacheOnStep, true)
    const lifecycle = harness()
    lifecycle.render(selected, config, 0)
    lifecycle.requests[0].resolve({ ok: true, data: { remaining: 1 } }); await flush()
    lifecycle.render(selected, config, 1)
    assert.equal(JSON.parse(lifecycle.requests[1].opts.body).force, false, String(provider))
    lifecycle.requests[1].resolve({ ok: true, data: { remaining: 1 } }); await flush()
    lifecycle.render(selected, config, 1).refresh()
    assert.equal(JSON.parse(lifecycle.requests[2].opts.body).force, true, String(provider))
    assert.equal(lifecycle.timers.size, 0)
    lifecycle.unmount(); h.unmount()
  }
})

test('all account cards expose consistent source preferences without claiming authentication', () => {
  const h = harness()
  h.setConfig({ ...config, providers: [{ id: 'kimi-code', label: 'Kimi Code', enabled: true }, { id: 'deepseek', label: 'DeepSeek', enabled: false }], showCodexQuota: false, showAntigravityQuota: true })
  h.renderComponent(h.SettingsPage)
  const view = h.renderComponent(h.SettingsPage)
  const cards = descendants(view, node => node.type === 'details' && node.props.className === 'slp-provider-card')
  const summaries = cards.map(node => textContent(node.children[0]).replace(/\s+/g, ' ').trim())
  for (const text of ['Kimi Code · Enabled', 'DeepSeek · Disabled', 'Codex · Disabled', 'Antigravity · Enabled', 'OpenCode · Enabled']) assert.ok(summaries.includes(text), text)
  for (const card of cards) {
    const badge = descendants(card.children[0], node => node.props?.className?.startsWith('slp-provider-state'))[0]
    assert.equal(badge.props.className.includes('slp-source-enabled'), /Enabled/.test(textContent(badge)))
  }
  const tips = descendants(view, node => node.props?.className === 'slp-hint').map(node => node.props['data-tip']).join(' ')
  assert.match(tips, /does not verify login or credentials/)
  assert.match(tips, /Enabling a source opens its settings automatically/)
  assert.equal(h.mutations.length, 0)
  h.unmount()
})

test('cache duration is displayed in effective seconds and saved in existing milliseconds', async () => {
  const h = harness()
  h.setConfig({ ...config, cacheTtlMs: 60000, fetchTimeoutMs: 10000 })
  h.renderComponent(h.SettingsPage)
  let view = h.renderComponent(h.SettingsPage)
  let input = descendants(view, node => node.props?.name === 'cacheTtlMs')[0]
  assert.equal(input.props.defaultValue, '60'); assert.equal(input.props.min, 15)
  assert.ok(descendants(view, node => /Expiry does not start polling/.test(node.props?.['data-tip'] || '')).length)
  assert.equal(input.props.onChange, undefined, 'partial keystrokes are never clamped or saved')
  input.props.onBlur({ target: { value: '30' } }); h.advance(700); await flush()
  assert.deepEqual(JSON.parse(JSON.stringify(h.mutations[0])), [{ op: 'set', path: ['cacheTtlMs'], value: 30000 }])
  h.unmount()
  const legacy = harness(); legacy.setConfig({ ...config, cacheTtlMs: 1000 })
  legacy.renderComponent(legacy.SettingsPage); view = legacy.renderComponent(legacy.SettingsPage)
  input = descendants(view, node => node.props?.name === 'cacheTtlMs')[0]
  assert.equal(input.props.defaultValue, '15'); assert.equal(legacy.mutations.length, 0)
  legacy.unmount()
})

test('seconds fields commit on blur: out-of-range clamps, blank or junk restores, timeout is in seconds', async () => {
  assert.equal(parseSecondsOf('3', 15, 3600), 15)
  assert.equal(parseSecondsOf('99999', 15, 3600), 3600)
  assert.equal(parseSecondsOf(' 42.4 ', 15, 3600), 42)
  assert.equal(parseSecondsOf('', 15, 3600), null)
  assert.equal(parseSecondsOf('abc', 15, 3600), null)
  const h = harness()
  h.setConfig({ ...config, cacheTtlMs: 60000, fetchTimeoutMs: 10000 })
  h.renderComponent(h.SettingsPage)
  const view = h.renderComponent(h.SettingsPage)
  const timeout = descendants(view, node => node.props?.name === 'fetchTimeoutMs')[0]
  assert.equal(timeout.props.defaultValue, '10')
  const blank = { value: '' }
  descendants(view, node => node.props?.name === 'cacheTtlMs')[0].props.onBlur({ target: blank })
  assert.equal(blank.value, '60', 'a cleared field shows the saved value again')
  const target = { value: '5' }
  timeout.props.onBlur({ target }); h.advance(700); await flush()
  assert.deepEqual(JSON.parse(JSON.stringify(h.mutations)), [[{ op: 'set', path: ['fetchTimeoutMs'], value: 5000 }]])
  h.unmount()
})

function parseSecondsOf(raw, min, max) { return harness().parseSeconds(raw, min, max) }

test('credential fields explain why a literal key is refused', () => {
  const h = harness()
  h.setConfig({ ...config, providers: [{ id: 'deepseek', label: 'DeepSeek', apiKeyEnv: 'DEEPSEEK_API_KEY' }] })
  h.renderComponent(h.SettingsPage)
  const input = descendants(h.renderComponent(h.SettingsPage), node => node.props?.name === 'cred:deepseek')[0]
  let message = null, reported = 0
  const target = { value: 'sk-123', setCustomValidity(m) { message = m }, reportValidity() { reported++ } }
  input.props.onChange({ target })
  assert.match(message, /never a literal API key/); assert.equal(reported, 1)
  input.props.onChange({ target: { ...target, value: 'MY_KEY' } })
  assert.equal(message, '')
  h.unmount()
})

test('removed layout options do not survive stale order, presets, previews or settings', () => {
  const h = harness(), chosen = { ...h.layoutPreset('balanced'), showTokens: true, compactLayout: true,
    componentOrder: ['tokens', 'tools', 'context', 'tokens', 'git'] }
  assert.deepEqual(Array.from(h.componentOrder(chosen.componentOrder)), ['tools', 'context', 'git', 'tps', 'cost', 'activity'])
  assert.ok(h.dockComponents(chosen, {}).every(node => node.props.key !== 'tokens'))
  for (const preset of ['minimal', 'balanced', 'activity']) {
    assert.equal(h.layoutPreset(preset).showTokens, undefined)
    assert.equal(h.layoutPreset(preset).compactLayout, undefined)
    assert.equal(h.matchingPreset({ ...h.layoutPreset(preset), showTokens: true, compactLayout: true }), preset)
  }
  const preview = h.renderComponent(h.LayoutPreview, { config: chosen })
  assert.equal(descendants(preview, node => node.props?.className === 'slp-preview').length, 1)
  h.unmount()
  const settings = harness(); settings.setConfig({ ...config, ...chosen })
  settings.renderComponent(settings.SettingsPage)
  const view = settings.renderComponent(settings.SettingsPage)
  assert.doesNotMatch(textContent(view), /Compact layout|Token input\/output\/cache/)
  settings.unmount()
})

test('each source slider opens its own settings when enabled and preserves account configuration', async () => {
  for (const [id, field] of [['kimi-code', 'providers'], ['codex', 'showCodexQuota'], ['antigravity', 'showAntigravityQuota'], ['opencode', 'showOpenCodeQuota']]) {
    const h = harness(), provider = { id: 'kimi-code', label: 'Kimi Code', enabled: false, apiKeyEnv: 'EXISTING_REF', onTurn: false }
    h.setConfig({ ...config, providers: [provider], showCodexQuota: false, showAntigravityQuota: false, showOpenCodeQuota: false, codexAccount: 'fixture.json' })
    h.renderComponent(h.SettingsPage)
    function card() { return descendants(h.renderComponent(h.SettingsPage), node => node.props?.['data-source'] === id)[0] }
    let view = card()
    assert.equal(view.props.open, false)
    const toggle = descendants(view.children[0], node => node.props?.role === 'switch')[0]
    assert.equal(toggle.props.checked, false)
    toggle.props.onChange({ target: { checked: true } })
    view = card()
    assert.equal(view.props.open, true)
    assert.equal(descendants(view, node => node.props?.role === 'switch')[0].props.checked, true)
    assert.equal(descendants(view, node => node.type === 'fieldset')[0].props.disabled, false)
    h.advance(700); await flush()
    assert.deepEqual(Array.from(h.mutations[0].map(op => op.path[0])), [field])
    if (field === 'providers') assert.deepEqual(JSON.parse(JSON.stringify(h.mutations[0][0].value)), [{ ...provider, enabled: true }])
    view.props.onToggle({ currentTarget: { open: false } })
    assert.equal(card().props.open, false, 'enabled cards can still be manually collapsed')
    descendants(card(), node => node.props?.role === 'switch')[0].props.onChange({ target: { checked: false } })
    view = card()
    assert.equal(view.props.open, false)
    assert.equal(descendants(view, node => node.type === 'fieldset')[0].props.disabled, true)
    assert.ok(descendants(h.renderComponent(h.SettingsPage), node => node.props?.value === 'fixture.json').length)
    h.advance(700); await flush()
    assert.equal(h.mutations.length, 2)
    h.unmount()
  }
})

test('OpenCode disabled preference blocks automatic and manual selection', async () => {
  for (const quotaAuto of [true, false]) {
    const h = harness()
    h.setConfig({ ...config, showOpenCodeQuota: false, showDeepseekPeak: false, quotaAuto })
    let view = h.renderComponent(h.HeaderChip, { sessionId: 'fixture' })
    if (quotaAuto) {
      h.requests[0].resolve({ ok: true, data: { provider: 'opencode-go', model: 'fixture' } }); await flush()
      view = h.renderComponent(h.HeaderChip, { sessionId: 'fixture' })
    }
    assert.equal(view, null, 'no matching source shows nothing instead of a placeholder')
    h.unmount()
  }
})

test('unmatched billing providers leave the header empty, including while the model resolves', async () => {
  const h = harness()
  h.setConfig({ ...config, showDeepseekPeak: false, quotaAuto: true, providers: [] })
  assert.equal(h.renderComponent(h.HeaderChip, { sessionId: 'fixture' }), null)
  h.requests[0].resolve({ ok: true, data: { provider: 'anthropic', model: 'claude' } }); await flush()
  assert.equal(h.renderComponent(h.HeaderChip, { sessionId: 'fixture' }), null)
  h.unmount()
})
