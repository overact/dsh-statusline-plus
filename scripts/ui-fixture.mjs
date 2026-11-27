import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { root } from './verification.mjs'

export const uiRequire = createRequire(new URL('../tools/ui/package.json', import.meta.url))

// Offline stand-ins for the Host-provided client modules. Same contract as the
// real hooks' common path; the real ones are only exercised against a live Host.
// hostAnchor: false mirrors primitives 0.2.2-rc.2+, which no longer export
// useAnchoredPosition, so the plugin's own placement runs.
export async function installHostModules(page, { hostAnchor = true } = {}) {
  await page.evaluate(hostAnchor => {
    const { React, ReactDOM } = window
    const useAnchoredPosition = ({ anchorRef, panelRef, gap, margin }) => {
      const [position, setPosition] = React.useState(null)
      React.useLayoutEffect(() => {
        const rect = anchorRef.current.getBoundingClientRect(), width = panelRef.current.offsetWidth
        setPosition({ left: Math.max(margin, Math.min(rect.left, document.documentElement.clientWidth - margin - width)), top: rect.bottom + gap })
      }, [])
      return position
    }
    const MenuSurface = React.forwardRef(({ phase, ...props }, ref) => React.createElement('div', { ...props, ref }))
    window.slpHostModule = name => {
      if (name === 'react') return React
      if (name === 'react-dom') return ReactDOM
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return hostAnchor ? { useAnchoredPosition, MenuSurface } : { MenuSurface }
      throw new Error('Unexpected fixture dependency: ' + name)
    }
  }, hostAnchor)
}

export async function mountFixture(page, hostOptions) {
  await page.clock.install()
  await page.setContent(`<!doctype html><html lang="en"><head><style>
    :root{--dsw-alias-label-primary:#111;--dsw-alias-label-secondary:#555;--dsw-alias-label-tertiary:#777;--dsw-alias-bg-overlay:#fff;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#fafafa;--dsw-alias-border-l1:#ddd;--dsw-alias-border-l2:#ccc;--dsw-alias-brand-primary:#4d6bfe;--dsw-alias-state-business-primary:#4d6bfe;--dsw-alias-state-success-primary:#3f9b6a;--dsw-alias-state-warn-primary:#d97706;--dsw-alias-state-warn-label:#b45309;--dsw-alias-state-error-primary:#d92d20;--dsw-alias-interactive-bg-hover:#0000000d}
    body{font:14px sans-serif;margin:0}#shell{position:fixed;left:56px;right:8px;bottom:24px;height:340px;overflow:auto}
    #root{position:absolute;bottom:16px;left:16px;right:16px}
  </style></head><body><div id="shell"><div id="root"></div></div></body></html>`)
  for (const name of ['react', 'react-dom']) {
    const folder = dirname(uiRequire.resolve(name + '/package.json'))
    await page.addScriptTag({ path: join(folder, 'umd', name + '.development.js') })
  }
  await installHostModules(page, hostOptions)
  await page.evaluate(() => {
    window.__ModuleLoader__ = { load(spec) { window.slpComponents = spec.factory(window.slpHostModule) } }
  })
  const source = await readFile(join(root, 'lib/client.js'), 'utf8')
  if (!source.includes('return module.exports')) throw new Error('Client factory format changed; update UI fixture adapter')
  await page.addScriptTag({ content: source.replace('return module.exports', 'return { apply, ActivityRow, CostRow, QuotaUnavailable, QuotaChip, ModelQuotaLabel, publishConfig, setComposerStarted, CSS }') })
  await page.evaluate(() => {
    const { React, ReactDOM, slpComponents: components } = window
    const style = document.createElement('style'); style.textContent = components.CSS; document.head.appendChild(style)
    const part = (amount, tokens) => ({ amountUsd: amount, tokensUsd: tokens })
    const cost = { session: { ...part(10, 0), pricedMessages: 1, unpricedMessages: 0, sources: { official: 1 }, vendors: { openai: 1 }, reasons: {},
      breakdown: { input: part(2, 12000), cache: part(3, 1000700), output: part(5, 200) } },
      catalog: { version: 'fixture', generatedAt: 1790105504346 } }
    const catalog = [{ id: 'one', label: 'Worker 1', mode: 'continuable' }, { id: 'two', label: 'Worker 2', mode: 'one-shot' },
      { id: 'external', label: 'External worker', mode: 'external' }]
    const state = { ids: ['one', 'two'], projectionsBySession: Object.fromEntries(catalog.slice(0, 2).map(child => [child.id, { values: {
      modelSelection: { lastUsed: { model: 'fixture-model', reasoningEffort: 'high' }, next: { model: 'pending-model', reasoningEffort: 'max' } },
      subagentTiming: { settledMs: 12000, active: null },
    } }])) }
    // The parent's own discovery/settlement fold: the external child has no
    // Session, so this record is its only running state and timing.
    const createdAt = Date.now() - 12000
    function App() {
      const [running, setRunning] = React.useState([true, true])
      const [settledAt, setSettledAt] = React.useState(null)
      window.setChildRunning = (index, value) => setRunning(previous => previous.map((item, n) => n === index ? value : item))
      window.setChildSettled = value => setSettledAt(value ? Date.now() : null)
      const settlement = { children: [
        { id: 'one', mode: 'continuable', label: 'Worker 1', createdAt, settledAt: null },
        { id: 'two', mode: 'one-shot', label: 'Worker 2', createdAt, settledAt: null },
        { id: 'external', mode: 'external', label: 'External worker', createdAt, settledAt },
      ] }
      return React.createElement('div', { className: 'slp-row' },
        React.createElement(components.ActivityRow, { sessionId: 'fixture-parent',
          useProjection: key => key === 'statuslineSubagents' ? settlement : catalog,
          useSessions: select => select(state), useSessionStatus: select => select(new Map(catalog.slice(0, 2).map((child, index) => [child.id, { running: running[index] }]))) }),
        React.createElement(components.CostRow, { useProjection: () => cost }))
    }
    window.slpFixtureRoot = ReactDOM.createRoot(document.getElementById('root'))
    window.slpFixtureRoot.render(React.createElement(App))
  })
}

// Exercise the registered settings/header/dock slots together, with native-like
// configuration updates and observable live-resource cleanup, without accounts.
// dockData: the Git route answers and a message has settled, so Git and TPS
// both show in the dock (the default leaves Git pending for resource checks).
// deepseek: the session reports a direct DeepSeek model, so the header also
// renders the peak chip; overrides: config values set before the first paint.
export async function mountResponsiveFixture(page, { dockData = false, deepseek = false, model = null, overrides = {}, ...hostOptions } = {}) {
  await mountFixture(page, hostOptions)
  await page.evaluate(({ dockData, deepseek, model, overrides }) => {
    window.slpFixtureRoot.unmount()
    document.getElementById('shell').style.cssText = 'position:static;height:auto;overflow:visible'
    document.getElementById('root').style.cssText = 'position:static'
    const { React, ReactDOM, slpComponents: components } = window
    const defaults = { enabled: true, hideBottomOnNarrow: false, showGit: true, showTps: true,
      showContext: false, showCost: false, showActivity: false, showTools: false, showCwd: false,
      showQuota: true, quotaAuto: false, showDeepseekPeak: false, showPeakDot: true, providers: [],
      cacheTtlMs: 60000, fetchTimeoutMs: 10000 }
    let config = { ...defaults, hideBottomOnNarrow: true, ...overrides }
    const listeners = new Set(), registrations = new Map(), cleanups = []
    window.slpResponsive = { sources: [], gitRequests: [], quotaRequests: [], quotaFailures: 0, mutations: [], observers: [], updateRequests: [], updateInstance: 'fixture-before-install', restartRequests: [] }
    const activity = window.slpResponsive
    // The footer button's update flow reads and advances this state. A test can
    // set `job.phase` or the new pid/version between polls to drive the panel.
    window.slpRestart = { pid: 1, ready: true, hostVersion: '0.2.2-rc.1', job: null }
    const NativeObserver = window.ResizeObserver
    window.ResizeObserver = class {
      constructor(callback) { this.native = new NativeObserver(callback); activity.observers.push(this) }
      observe(node) { this.closed = false; this.native.observe(node) }
      unobserve(node) { this.native.unobserve(node) }
      disconnect() { this.closed = true; this.native.disconnect() }
    }
    window.EventSource = class {
      constructor(url) {
        this.url = url; activity.sources.push(this)
        // TPS renders only after a reading, so each stream delivers one sample.
        const sessionId = decodeURIComponent(url.split('sessionId=')[1] || '')
        queueMicrotask(() => { if (!this.closed && this.onmessage) this.onmessage({ data: JSON.stringify({ sessionId, phase: 'completed', tokensPerSecond: 42, estimated: false }) }) })
      }
      close() { this.closed = true }
    }
    window.fetch = async (url, options = {}) => {
      if (url === '/statusline/api/git') {
        const request = { aborted: false }; activity.gitRequests.push(request)
        if (dockData) return { json: async () => ({ ok: true, data: { isRepo: true, branch: 'main', ahead: 0, behind: 0, counts: { staged: 0, unstaged: 1, untracked: 0, conflict: 0 } } }) }
        return new Promise(resolve => options.signal.addEventListener('abort', () => {
          request.aborted = true; resolve({ json: async () => ({ ok: false, error: 'aborted' }) })
        }))
      }
      if (url === '/statusline/api/usage') {
        activity.quotaRequests.push({ at: Date.now(), body: options.body })
        if (activity.quotaFailures > 0) { activity.quotaFailures--; return { json: async () => ({ ok: false, error: 'network' }) } }
        return { json: async () => ({ ok: true, data: { style: 'windows', windows: [{ id: 'rolling', minutes: 300, short: '5h', usedPercent: 20 }], fetchedAt: Date.now() } }) }
      }
      if (url.indexOf('/statusline/api/version') === 0) {
        // One update is always on offer here, so the settings header always has
        // something to render; the install itself is recorded, not performed.
        if (String(options.method || 'GET').toUpperCase() === 'POST') {
          activity.updateRequests.push(JSON.parse(options.body || '{}'))
          // A live swap replaces the running copy, which the page sees as a new
          // instance id; the fixture reports that instead of running pnpm.
          activity.updateInstance = 'fixture-after-install'
          return { json: async () => ({ ok: true, data: { version: '9.9.9', output: '', instanceId: 'fixture-before-install' } }) }
        }
        return { json: async () => ({ ok: true, data: { loaded: '0.1.9', installed: '0.1.9', latest: '9.9.9', latestEngines: '>=0.2.0-rc.2',
          compatible: true, updateAvailable: true, checkedAt: new Date().toISOString(), error: null,
          install: { linked: false, profile: 'fixture', dir: '/fixture' }, host: '0.2.1-rc.5',
          instanceId: activity.updateInstance } }) }
      }
      if (url === '/statusline/api/peak-schedule') return { json: async () => ({ ok: false }) }
      if (url === '/statusline/api/codex-quota') {
        // A test can hold the chip in its loading state for this long (fake clock).
        if (window.slpQuotaDelayMs) await new Promise(resolve => setTimeout(resolve, window.slpQuotaDelayMs))
        return { json: async () => ({ ok: true, data: { style: 'windows', windows: [{ id: '5h', minutes: 300, short: '5h', usedPercent: 30, resetInSec: 3600 }], fetchedAt: Date.now() }, serverNow: Date.now() }) }
      }
      // Reset notices come from window.slpResetNotices (none by default); requests are recorded.
      if (url.indexOf('/statusline/api/reset-notices') === 0) {
        activity.resetRequests = (activity.resetRequests || []).concat([url])
        return { json: async () => ({ ok: true, data: { notices: window.slpResetNotices || [], checkedAt: {} }, serverNow: Date.now() }) }
      }
      if (url.indexOf('/statusline/api/restart') === 0) {
        const state = window.slpRestart
        if (String(options.method || 'GET').toUpperCase() === 'POST') {
          const body = JSON.parse(options.body || '{}')
          activity.restartRequests.push(body)
          state.job = { id: 'job-1', phase: 'stopping', version: body.version || '0.2.2', previousVersion: '0.2.2-rc.1',
            logPath: '/fixture/statusline-host-update.log', startedAt: new Date().toISOString() }
          return { status: 202, ok: true, json: async () => ({ ok: true, data: { seq: 1, pid: state.pid, jobId: 'job-1' } }) }
        }
        return { status: 200, ok: true, json: async () => ({ ok: true, data: {
          soft: true, full: true, unit: 'dsh-web.service', pid: state.pid, phase: 'idle', active: 0,
          ready: state.ready, hostVersion: state.hostVersion, profile: 'web', job: state.job,
          update: { supported: true, helper: true, available: true, installed: '0.2.2-rc.1', latest: '0.2.2' },
        } }) }
      }
      throw new Error('Unexpected responsive fixture request: ' + url)
    }
    const scope = {
      // Mirrors the real configForms snapshot: only writable/value, no `mode`.
      getSnapshot: () => ({ value: config, writable: true }),
      subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) },
      mutate: async ops => {
        activity.mutations.push(ops)
        for (const op of ops) config = { ...config, [op.path[0]]: op.op === 'unset' ? defaults[op.path[0]] : op.value }
        listeners.forEach(fn => fn())
      },
    }
    // Like the Host, a list slot renders the winner of each id (lowest
    // `priority`) in `order`. A registration that declares `children` gets
    // `renderSlot`, which honours `only` and guards each entry: a crash leaves
    // the Host's `data-slot-error` anchor. `entriesOfSlot`, `subscribe` and
    // `getVersion` let the owner follow registrations that come and go.
    const versions = new Map(), slotListeners = new Map()
    const bump = name => {
      versions.set(name, (versions.get(name) || 0) + 1)
      queueMicrotask(() => (slotListeners.get(name) || new Set()).forEach(fn => fn()))
    }
    const winners = name => {
      const byId = new Map()
      for (const entry of registrations.get(name) || []) {
        const held = byId.get(entry.id)
        if (!held || entry.priority < held.priority) byId.set(entry.id, entry)
      }
      return [...byId.values()].sort((a, b) => a.order - b.order)
    }
    class EntryGuard extends React.Component {
      constructor(props) { super(props); this.state = { failed: false } }
      static getDerivedStateFromError() { return { failed: true } }
      // The Host retires a crashed list entry: it leaves entriesOfSlot, and another
      // registration under its id (or the owner's own fallback) takes its place.
      componentDidCatch(error) { console.error("slot entry crashed in '" + this.props.slot + "':", error); this.props.retire() }
      render() { return this.state.failed ? React.createElement('span', { 'data-slot-error': this.props.slot }) : this.props.children }
    }
    const slots = {
      inject: (_name, setup) => setup(),
      register: (spec, component) => {
        const entry = { id: spec.id, order: spec.order || 0, priority: spec.priority || 0, children: spec.children, component, options: { id: spec.id, order: spec.order, label: spec.label } }
        registrations.set(spec.name, [...(registrations.get(spec.name) || []), entry])
        bump(spec.name)
        return () => { registrations.set(spec.name, (registrations.get(spec.name) || []).filter(item => item !== entry)); bump(spec.name) }
      },
      entriesOfSlot: name => winners(name).map(entry => ({ options: entry.options })),
      subscribe: (name, fn) => {
        if (!slotListeners.has(name)) slotListeners.set(name, new Set())
        slotListeners.get(name).add(fn)
        return () => slotListeners.get(name).delete(fn)
      },
      getVersion: name => versions.get(name) || 0,
    }
    window.slpSlots = slots
    const renderEntry = (entry, props) => React.createElement(entry.component, { key: entry.id, ...props,
      // The Host wraps a child slot in a display:contents anchor named by the slot.
      ...(entry.children ? { renderSlot: (child, owner, opts) => React.createElement('span', { 'data-slot': child, style: { display: 'contents' } },
        ...winners(child).filter(item => !opts || opts.only === undefined || item.id === opts.only)
          .map(item => React.createElement(EntryGuard, { key: item.id, slot: child, retire: () => {
            registrations.set(child, (registrations.get(child) || []).filter(other => other !== item)); bump(child) } }, React.createElement(item.component, { ...props, ...owner })))) } : {}) })
    const slot = (name, props) => React.createElement(React.Fragment, null, ...winners(name).map(entry => renderEntry(entry, props)))
    components.apply({ configForms: { get: () => scope }, get: name => name === 'slots' ? slots
        // window.slpLocale ('zh-CN') renders the plugin's own Chinese strings.
        : name === 'locale' && window.slpLocale ? { getLocale: () => ({ active: window.slpLocale }) } : null,
      effect: setup => { const cleanup = setup(); if (cleanup) cleanups.push(cleanup) } })
    const settled = { session: { pricedMessages: 1, unpricedMessages: 0 } }
    const sessionProps = { sessionId: 'fixture-parent', useProjection: key => key === 'contextPressure' ? { pressureTokens: 12000, contextWindow: 200000 }
      : model && key === 'modelSelection' ? { next: model }
      : deepseek && key === 'modelSelection' ? { next: { provider: 'deepseek', model: 'deepseek-chat' } }
      : dockData && key === 'statuslineMetrics' ? settled : { steps: 0 },
      useSessions: select => select({ byId: { 'fixture-parent': { cwd: '/fixture-repo' } } }) }
    function App() {
      // window.slpFixtureSession seeds the header's session; window.slpSetSession
      // switches it live, so a test can change sessions without remounting.
      const [session, setSession] = React.useState(() => window.slpFixtureSession || null)
      window.slpSetSession = value => { window.slpFixtureSession = value || undefined; setSession(value || null) }
      return React.createElement(React.Fragment, null,
        // Mirrors DSH 0.2.2's title cluster: the actions slot sits inside clip + mask.
        React.createElement('div', { style: { display: 'flex', overflow: 'clip', maskImage: 'linear-gradient(to left, transparent, #000 20px)' } },
          // A session switch keeps the sidebar footer mounted, as the Host does.
          React.createElement('div', { id: 'fixture-header', className: 'fixture-headerActions' }, slot('conversation.session.header.actions',
            session ? { ...sessionProps, sessionId: session } : sessionProps))),
        React.createElement('div', { id: 'fixture-dock' },
          React.createElement('div', { 'data-composer-card': true, style: { width: '100%', height: '1px' } }),
          React.createElement('div', { 'data-composer-dock': true, style: { display: 'inline-flex' } },
            React.createElement('div', { id: 'fixture-native', 'data-composer-stat': 'usage' }, 'Native composer stats'),
            React.createElement('div', { 'data-slot': 'conversation.composer.dock' }, slot('conversation.composer.dock', sessionProps)))),
        React.createElement('div', { id: 'fixture-footer' }, slot('sidebar.footer.action')),
        slot('settings.section'))
    }
    window.remountResponsiveFixture = () => {
      window.slpFixtureRoot = ReactDOM.createRoot(document.getElementById('root'))
      window.slpFixtureRoot.render(React.createElement(App))
    }
    window.disposeResponsiveFixture = () => { window.slpFixtureRoot.unmount(); cleanups.forEach(fn => fn()) }
    window.remountResponsiveFixture()
  }, { dockData, deepseek, model, overrides })
}

// The "no such subscription" status on its own, inside a header-sized (14px)
// container: the chip must take the shared 13px chip metric, fade for 10 s and
// then leave the tree instead of staying in the header forever.
export async function mountChipFixture(page) {
  await page.evaluate(() => {
    window.slpFixtureRoot.unmount()
    const { React, ReactDOM, slpComponents } = window
    document.getElementById('shell').style.cssText = 'position:static;height:auto;overflow:visible'
    const host = document.getElementById('root')
    host.style.cssText = 'position:static;font-size:14px;font-family:sans-serif;padding:16px'
    window.slpChipRoot = ReactDOM.createRoot(host)
    window.slpChipRoot.render(React.createElement(slpComponents.QuotaUnavailable,
      { title: 'Subscription not found', detail: 'no-credential' }))
  })
}

// A generic Magpie subscription with several accounts: no dedicated reader,
// but the details panel must still show every account and localized window
// names. The data mirrors what parseMagpieSubscriptions returns for agy-cli.
export async function mountMagpieAccountsFixture(page) {
  await mountFixture(page)
  await page.evaluate(() => {
    window.slpFixtureRoot.unmount()
    const { React, ReactDOM, slpComponents } = window
    document.getElementById('shell').style.cssText = 'position:static;height:auto;overflow:visible'
    const root = document.getElementById('root')
    root.style.cssText = 'position:relative;font-size:14px;font-family:sans-serif;padding:24px'
    root.innerHTML = ''
    const now = Date.now()
    const windows = used => [
      { id: 'gemini-5h', group: 'gemini', minutes: 300, usedPercent: used, remainingPercent: 100 - used, resetInSec: 9000 },
      { id: 'gemini-weekly', group: 'gemini', minutes: 10080, usedPercent: used + 1, remainingPercent: 99 - used, resetInSec: 600000 },
      { id: 'third-5h', group: 'third', minutes: 300, usedPercent: used + 2, remainingPercent: 98 - used, resetInSec: 9000 },
      { id: 'third-weekly', group: 'third', minutes: 10080, usedPercent: used + 3, remainingPercent: 97 - used, resetInSec: 600000 },
    ]
    const first = { fileName: 'magpie:agy-cli:1', email: 'one@example.invalid', windows: windows(10), status: 'available', fetchedAt: now }
    const second = { fileName: 'magpie:agy-cli:2', email: 'two@example.invalid', windows: windows(20), status: 'available', fetchedAt: now }
    const item = { id: 'agy-cli', style: 'windows', label: 'Antigravity (local agy CLI)', accountCount: 2,
      accounts: [first, second], selectedFileName: first.fileName, windows: first.windows, chipWindows: 2, fetchedAt: now, source: 'magpie' }
    const config = { enabled: true, showQuota: true, quotaPercentMode: 'used', cacheTtlMs: 60000 }
    window.fetch = async url => {
      if (String(url).indexOf('/statusline/api/magpie-quota') === 0) return { json: async () => ({ ok: true, data: item }) }
      throw new Error('Unexpected Magpie fixture request: ' + url)
    }
    slpComponents.publishConfig(config)
    ReactDOM.createRoot(root).render(React.createElement(slpComponents.QuotaChip, {
      resource: { kind: 'magpie', id: 'agy-cli', key: 'magpie:agy-cli' }, config: config, stepCount: 0,
    }))
  })
}

// The model seat's quota rail, inside buttons shaped like the Host's own
// (`background: 0 0` plus a hover rule that sets the `background` shorthand —
// the rule that used to clear a stylesheet-written rail).
export async function mountModelBarFixture(page) {
  await mountFixture(page)
  await page.evaluate(() => {
    window.slpFixtureRoot.unmount()
    const { React, ReactDOM, slpComponents } = window
    document.getElementById('shell').style.cssText = 'position:static;height:auto;overflow:visible'
    const root = document.getElementById('root')
    root.style.cssText = 'position:static;font-size:14px;font-family:sans-serif;padding:16px'
    document.head.insertAdjacentHTML('beforeend', `<style>
      .mq-host{display:flex;flex-direction:column;gap:10px;width:320px}
      .mq-trigger,.mq-row{border-radius:8px;height:28px;padding:0 4px 0 8px;display:flex;align-items:center;background:0 0;border:none;font:13px sans-serif;cursor:pointer}
      .mq-row{width:100%;height:34px;padding:5px 7px}
      .mq-scroll{height:102px;overflow-y:auto;width:320px;border:1px solid #ddd;border-radius:8px;margin-top:12px}
      .mq-scroll-row{width:100%;height:34px;padding:5px 7px;display:flex;align-items:center;background:0 0;border:none;font:13px sans-serif;cursor:pointer;text-align:left}
      .mq-scroll-row[data-active="true"]{background:#0000000d}
      @media (hover:hover){.mq-trigger:hover:not(:disabled){background:#0000000d}}
    </style>`)
    root.innerHTML = '<div class="mq-host">'
      + '<button id="mq-trigger" class="mq-trigger"><span id="mq-trigger-label"></span></button>'
      + '<button id="mq-row-claude" class="mq-row"><span id="mq-row-claude-label"></span></button>'
      + '<button id="mq-row-deepseek" class="mq-row"><span id="mq-row-deepseek-label"></span></button>'
      + '<div id="mq-scroll" class="mq-scroll"></div>'
      + '</div>'
    slpComponents.publishConfig({ enabled: true, showQuota: true, modelQuotaBar: true, modelQuotaRows: true,
      showClaudeQuota: true, showCodexQuota: true, showAntigravityQuota: true, showOpenCodeQuota: true,
      quotaPercentMode: 'used', cacheTtlMs: 60000,
      providers: [{ id: 'deepseek', label: 'DeepSeek', enabled: true, match: { providerExact: ['deepseek-account'] } }] })
    window.fetch = async url => {
      if (String(url).indexOf('/statusline/api/claude-quota') !== -1) {
        return { json: async () => ({ ok: true, data: { style: 'windows', chipWindows: 2, fetchedAt: Date.now(),
          windows: [{ id: '5h', minutes: 300, usedPercent: 34, remainingPercent: 66, resetInSec: 3600 }] } }) }
      }
      if (String(url).indexOf('/statusline/api/provider-quota') !== -1) {
        return { json: async () => ({ ok: true, data: { style: 'balance', remaining: 51.43, currency: 'CNY', fetchedAt: Date.now() } }) }
      }
      return { json: async () => ({ ok: false, error: 'not-found' }) }
    }
    const mount = (id, props) => ReactDOM.createRoot(document.getElementById(id)).render(React.createElement(slpComponents.ModelQuotaLabel, props))
    window.slpModelBarRoots = [
      mount('mq-trigger-label', { provider: { id: 'claude', name: 'Claude' }, model: { id: 'claude-opus-4-5', name: 'Claude Opus 4.5' }, placement: 'trigger', selected: true }),
      mount('mq-row-claude-label', { provider: { id: 'claude', name: 'Claude' }, model: { id: 'claude-opus-4-5', name: 'Claude Opus 4.5' }, placement: 'option', selected: false }),
      mount('mq-row-deepseek-label', { provider: { id: 'deepseek-account', name: 'DeepSeek' }, model: { id: 'deepseek-v4', name: 'DeepSeek V4' }, placement: 'option', selected: false }),
    ]
    // The Host highlights model rows from onMouseMove. A scroll moves a new row
    // under a stationary pointer without firing it, so this fixture reproduces
    // the gap the label's scroll bridge covers.
    function ScrollList() {
      const [active, setActive] = React.useState(0)
      return React.createElement('div', null,
        Array.from({ length: 30 }, (_, index) => React.createElement('button', {
          key: index, type: 'button', className: 'mq-scroll-row', 'data-scroll-row': index,
          'data-active': active === index ? 'true' : undefined,
          onMouseMove: () => setActive(index),
        }, React.createElement(slpComponents.ModelQuotaLabel, {
          provider: { id: 'claude', name: 'Claude' },
          model: { id: 'claude-opus-4-5', name: 'Claude Model ' + index },
          placement: 'option', selected: false,
        }))))
    }
    ReactDOM.createRoot(document.getElementById('mq-scroll')).render(React.createElement(ScrollList))
    window.setComposerStarted = value => slpComponents.setComposerStarted(value)
  })
}
