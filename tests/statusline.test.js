'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync, spawn } = require('node:child_process')
const { EventEmitter } = require('node:events')
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { homedir, tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

process.env.SLP_TEST = '1'
const { __test } = require('../lib/index.js')

function loadClientPluginForTest(options = {}) {
  const previous = {
    window: global.window,
    document: global.document,
    fetch: global.fetch,
    AbortSignal: global.AbortSignal,
    setInterval: global.setInterval,
    clearInterval: global.clearInterval,
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout,
    Date: global.Date,
  }
  function restore() {
    global.window = previous.window
    global.document = previous.document
    global.fetch = previous.fetch
    global.AbortSignal = previous.AbortSignal
    global.setInterval = previous.setInterval
    global.clearInterval = previous.clearInterval
    global.setTimeout = previous.setTimeout
    global.clearTimeout = previous.clearTimeout
    global.Date = previous.Date
  }
  let captured
  let activeRenderer = null
  const React = {
    createElement(type, props, ...children) { return { type, props: Object.assign({}, props || {}, { children }) } },
    useState(initial) { if (!activeRenderer) throw new Error('React hook used outside renderer'); return activeRenderer.useState(initial) },
    useEffect(effect, deps) { if (!activeRenderer) throw new Error('React hook used outside renderer'); return activeRenderer.useEffect(effect, deps) },
    useRef(initial) { if (!activeRenderer) throw new Error('React hook used outside renderer'); return activeRenderer.useRef(initial) },
  }
  function createRenderer() {
    const hookSlots = []
    let hookIndex = 0
    let pendingEffects = []
    let configInitialUsed = false
    const renderer = {
      useState(initial) {
        if (hookIndex === 0 && initial === null && !configInitialUsed && options.initialConfig !== undefined) {
          configInitialUsed = true
          initial = options.initialConfig
        }
        const index = hookIndex++
        let slot = hookSlots[index]
        if (!slot) {
          slot = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
          hookSlots[index] = slot
        }
        return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next }]
      },
      useRef(initial) {
        const index = hookIndex++
        let slot = hookSlots[index]
        if (!slot) {
          slot = { kind: 'ref', value: { current: initial } }
          hookSlots[index] = slot
        }
        return slot.value
      },
      useEffect(effect, deps) {
        const index = hookIndex++
        let slot = hookSlots[index]
        const changed = !slot || !Array.isArray(deps) || !Array.isArray(slot.deps) || deps.length !== slot.deps.length || deps.some((value, i) => !Object.is(value, slot.deps[i]))
        if (!slot) {
          slot = { kind: 'effect', deps: deps, cleanup: null }
          hookSlots[index] = slot
        } else if (changed) {
          slot.deps = deps
        }
        if (changed) pendingEffects.push({ slot, effect })
      },
      render(component, props) {
        hookIndex = 0
        pendingEffects = []
        activeRenderer = renderer
        let value
        try {
          value = component(props)
          if (value && typeof value.type === 'function') value = value.type(value.props)
          if (value && typeof value.type === 'function' && value.type.name === 'LiveStatusPanel') value = value.type(value.props)
        } finally {
          activeRenderer = null
        }
        for (const item of pendingEffects) {
          if (typeof item.slot.cleanup === 'function') item.slot.cleanup()
          item.slot.cleanup = item.effect() || null
        }
        return value
      },
      unmount() {
        for (const slot of hookSlots) {
          if (slot && typeof slot.cleanup === 'function') {
            slot.cleanup()
            slot.cleanup = null
          }
        }
      },
    }
    return renderer
  }
  const style = { setAttribute() {}, textContent: '', parentNode: { removeChild() {} } }
  const initialConfig = options.initialConfig === undefined ? { enabled: true, showGit: true, showContext: false, showTokens: false, showTps: false, gitCwd: '' } : options.initialConfig
  const eventCounts = { focus: 0, visibilitychange: 0 }
  const configResponse = options.configResponse === undefined ? { ok: true, config: initialConfig } : options.configResponse
  const windowListeners = new Map()
  global.window = {
    __ModuleLoader__: {
      load(entry) {
        captured = entry.factory(() => React)
      },
    },
    addEventListener(name, fn) { if (!windowListeners.has(name)) windowListeners.set(name, new Set()); windowListeners.get(name).add(fn); if (eventCounts[name] !== undefined) eventCounts[name] += 1 },
    removeEventListener(name, fn) { windowListeners.get(name)?.delete(fn); if (eventCounts[name] !== undefined) eventCounts[name] -= 1 },
  }
  const docListeners = new Map()
  global.document = {
    head: { appendChild() {} },
    createElement() { return style },
    addEventListener(name, fn) {
      if (!docListeners.has(name)) docListeners.set(name, new Set())
      docListeners.get(name).add(fn)
      if (eventCounts[name] !== undefined) eventCounts[name] += 1
    },
    removeEventListener(name, fn) {
      if (docListeners.has(name)) docListeners.get(name).delete(fn)
      if (eventCounts[name] !== undefined) eventCounts[name] -= 1
    },
    visibilityState: 'visible',
  }
  global.window.document = global.document
  const gitRequests = []
  const gitResolvers = []
  const defaultGitData = { isRepo: true, branch: 'main', ahead: 0, behind: 0, counts: { staged: 0, unstaged: 0, untracked: 0, conflict: 0 }, lineStats: { added: 0, deleted: 0 } }
  global.fetch = async (url, requestOptions = {}) => {
    if (url === '/statusline/api/config') {
      return { json: async () => configResponse }
    }
    if (url === '/statusline/api/git') {
      gitRequests.push({ url, options: requestOptions })
      if (options.deferGit) {
        return new Promise((resolve) => { gitResolvers.push((data, error) => resolve({ json: async () => error ? { ok: false, error } : { ok: true, data } })) })
      }
      return { json: async () => ({ ok: true, data: defaultGitData }) }
    }
    if (url === '/statusline/api/session-model') {
      return { json: async () => (options.sessionModelResponse !== undefined ? options.sessionModelResponse : { ok: true, data: { model: 'gemini-3.8-flash-high', provider: 'antigravity' } }) }
    }
    if (url === '/statusline/api/antigravity-quota') {
      return { json: async () => (options.antigravityQuotaResponse !== undefined ? options.antigravityQuotaResponse : { ok: true, data: { gemini5h: { usedPercent: 14, remainingPercent: 86, resetInSec: 10800 }, geminiWeekly: { usedPercent: 20, remainingPercent: 80, resetInSec: 86400 } } }) }
    }
    return { json: async () => ({ ok: true }) }
  }
  global.AbortSignal = undefined
  global.setInterval = () => 0
  global.clearInterval = () => {}
  if (options.clock) {
    const clock = options.clock
    global.Date = class extends previous.Date { static now() { return clock.now } }
    global.setTimeout = (fn, delay) => { const token = {}; clock.tasks.set(token, { fn, at: clock.now + delay }); return token }
    global.clearTimeout = token => clock.tasks.delete(token)
  }
  try {
    const clientSource = require('node:fs').readFileSync(require.resolve('../lib/client.js'), 'utf8')
    new Function(clientSource)()
    const registrations = []
    const slots = {
      inject(name, setup) { setup() },
      register(spec, component) {
        registrations.push({ spec, component })
        return () => {}
      },
    }
    captured.apply({ configForms: { get() { return {
        getSnapshot() { return { value: configResponse && configResponse.ok ? configResponse.config : undefined, mode: 'host', writable: true } },
        subscribe() { return () => {} }, mutate: async () => {},
      } } }, get(name) {
      if (name === 'slots') return slots

    }, effect(setup) { setup() } })
    return {
      registrations,
      gitRequests,
      gitResolvers,
      eventCounts,
      docListeners,
      windowListeners,
      createRenderer,
      restore,
    }
  } catch (error) {
    restore()
    throw error
  }
}

test('composer dock resolves Git cwd from the authoritative useSessions session summary', async () => {
  const harness = loadClientPluginForTest({
    initialConfig: { enabled: true, showGit: true, showContext: false, showTokens: false, showTps: false, gitCwd: '' },
    deferGit: true,
  })
  const { registrations, gitRequests, gitResolvers, createRenderer, eventCounts } = harness
  try {
    const dock = registrations.find((entry) => entry.spec.name === 'conversation.composer.dock')
    assert.ok(dock, 'composer dock should be registered')
    const sessionState = { current: { id: 's1', cwd: '/tmp/session-repo' } }
    const selectors = []
    const props = {
      sessionId: 's1',
      useSessions: (selector) => {
        selectors.push(selector)
        return selector({ byId: { s1: sessionState.current } })
      },
      useWorkspaces: () => null,
      useProjection: () => null,
    }
    const renderer = createRenderer()
    const element = dock.component(props)
    const panel = renderer.render(element.type, element.props)
    assert.equal(panel.props.className, 'slp-root')
    assert.deepEqual(eventCounts, { focus: 1, visibilitychange: 2 })
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(selectors.length > 0, 'useSessions should be queried for the current session')
    assert.equal(selectors[0]({ byId: { s1: { cwd: '/tmp/session-repo' } } }), '/tmp/session-repo')
    assert.equal(gitRequests.length, 1, JSON.stringify({ selectors: selectors.length, panel: panel.props, requests: gitRequests }))
    assert.deepEqual(JSON.parse(gitRequests[0].options.body), { cwd: '/tmp/session-repo', sessionId: 's1' })
    sessionState.current = { id: 's2', cwd: '/tmp/session-repo' }
    const changedElement = dock.component({
      sessionId: 's2',
      useSessions: (selector) => selector({ byId: { s2: sessionState.current } }),
      useWorkspaces: () => null,
      useProjection: () => null,
    })
    renderer.render(changedElement.type, changedElement.props)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(gitRequests.length, 2, 'a same-cwd session switch should issue a session-scoped request')
    assert.deepEqual(JSON.parse(gitRequests[1].options.body), { cwd: '/tmp/session-repo', sessionId: 's2' })
    assert.equal(gitResolvers.length, 2)
    gitResolvers[0]({ branch: 'old-session' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(gitResolvers.length, 2)
    gitResolvers[1]({ branch: 'new-session' })
    await new Promise((resolve) => setImmediate(resolve))
    renderer.unmount()
    assert.deepEqual(eventCounts, { focus: 0, visibilitychange: 0 })
  } finally {
    harness.restore()
  }
})

test('Git bursts retain one trailing refresh, manual clicks bypass delay, and disposal cancels it', async () => {
  const clock = { now: 1000, tasks: new Map() }
  const h = loadClientPluginForTest({ clock, deferGit: true }), renderer = h.createRenderer()
  let step = 0
  try {
    const dock = h.registrations.find(entry => entry.spec.name === 'conversation.composer.dock')
    const props = { sessionId: 's1', useSessions: select => select({ byId: { s1: { cwd: '/tmp/repo' } } }),
      useProjection: key => key === 'sessionStats' ? { steps: step } : null }
    const element = dock.component(props), render = () => renderer.render(element.type, element.props)
    const advance = async ms => { clock.now += ms; for (const [token, task] of clock.tasks) if (task.at <= clock.now) { clock.tasks.delete(token); task.fn() } await new Promise(setImmediate) }
    render()
    for (let i = 0; i < 10; i++) { step++; render(); h.windowListeners.get('focus').forEach(fn => fn()) }
    assert.equal(h.gitRequests.length, 1, 'concurrent automatic triggers are shared')
    h.gitResolvers[0]({ isRepo: true, repoRoot: '/tmp/repo', branch: 'old', counts: {} })
    await new Promise(setImmediate)
    assert.equal(clock.tasks.size, 1)
    await advance(999); assert.equal(h.gitRequests.length, 1)
    await advance(1); assert.equal(h.gitRequests.length, 2, 'latest step still receives a fresh trailing snapshot')
    h.gitResolvers[1]({ isRepo: true, repoRoot: '/tmp/repo', branch: 'new', counts: {} })
    await new Promise(setImmediate)
    let panel = render(), git = panel.props.children[0].props.children[0].find(node => node.props.key === 'git')
    assert.equal(git.props.data.branch, 'new')
    step++; panel = render(); assert.equal(clock.tasks.size, 1)
    git.props.refresh()
    assert.equal(h.gitRequests.length, 3, 'manual clicks query immediately')
    assert.equal(JSON.parse(h.gitRequests[2].options.body).force, true)
    assert.equal(clock.tasks.size, 0)
    h.gitResolvers[2]({ isRepo: true, repoRoot: '/tmp/repo', branch: 'manual', counts: {} })
    await new Promise(setImmediate)
    step++; render(); assert.equal(clock.tasks.size, 1)
    renderer.unmount(); assert.equal(clock.tasks.size, 0)
    await advance(2000); assert.equal(h.gitRequests.length, 3)
  } finally { renderer.unmount(); h.restore() }
})

test('disabled composer dock does not request Git or install focus listeners', async () => {
  const harness = loadClientPluginForTest({
    initialConfig: { enabled: false, showGit: true, showContext: false, showTokens: false, showTps: false, gitCwd: '/tmp/disabled-repo' },
  })
  const { registrations, gitRequests, createRenderer, eventCounts } = harness
  try {
    const dock = registrations.find((entry) => entry.spec.name === 'conversation.composer.dock')
    const props = {
      sessionId: 's-disabled',
      useSessions: (selector) => selector({ byId: { 's-disabled': { cwd: '/tmp/disabled-repo' } } }),
      useWorkspaces: () => null,
      useProjection: () => null,
    }
    const renderer = createRenderer()
    const element = dock.component(props)
    assert.equal(renderer.render(element.type, element.props), null)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(gitRequests.length, 0)
    assert.deepEqual(eventCounts, { focus: 0, visibilitychange: 0 })
    renderer.unmount()
  } finally {
    harness.restore()
  }
})

test('Git stays disabled when config is loaded asynchronously with enabled=false', async () => {
  const harness = loadClientPluginForTest({
    initialConfig: undefined,
    configResponse: { ok: true, config: { enabled: false, showGit: true, showContext: false, showTokens: false, showTps: false, gitCwd: '/tmp/disabled-repo' } },
  })
  const { registrations, gitRequests, createRenderer, eventCounts } = harness
  try {
    const dock = registrations.find((entry) => entry.spec.name === 'conversation.composer.dock')
    const props = {
      sessionId: 's-async-disabled',
      useSessions: (selector) => selector({ byId: { 's-async-disabled': { cwd: '/tmp/disabled-repo' } } }),
      useWorkspaces: () => null,
      useProjection: () => null,
    }
    const renderer = createRenderer()
    const element = dock.component(props)
    assert.equal(renderer.render(element.type, element.props), null)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(gitRequests.length, 0)
    assert.deepEqual(eventCounts, { focus: 0, visibilitychange: 0 })
    renderer.unmount()
  } finally {
    harness.restore()
  }
})

test('quota percentage mode accepts only used/left and defaults to used', () => {
  assert.equal(__test.sanitizeConfig({}).quotaPercentMode, 'used')
  assert.equal(__test.sanitizeConfig({ quotaPercentMode: 'left' }).quotaPercentMode, 'left')
  assert.equal(__test.sanitizeConfig({ quotaPercentMode: 'remaining' }).quotaPercentMode, 'used')
})

test('narrow-screen preference defaults off and survives config sanitization', () => {
  assert.equal(__test.sanitizeConfig({}).hideBottomOnNarrow, false)
  assert.equal(__test.sanitizeConfig({ hideBottomOnNarrow: true }).hideBottomOnNarrow, true)
  assert.equal(__test.sanitizeConfig({ hideBottomOnNarrow: 'false' }).hideBottomOnNarrow, false)
})

test('sanitizeConfig normalizes booleans, clamps numbers, and keeps usage on the official endpoint', () => {
  const out = __test.sanitizeConfig({
    enabled: 'false',
    showQuota: 0,
    showTps: 'yes',
    showOpenCodeQuota: 'off',
    showTokens: true,
    compactLayout: true,
    componentOrder: ['tokens', 'tools', 'context'],
    intervalSec: 999999,
    cacheTtlMs: 999999999,
    usageUrl: 'https://example.invalid/steal',
  })
  assert.equal(out.enabled, false)
  assert.equal(out.showQuota, false)
  assert.equal(out.showTps, true)
  assert.equal(out.showOpenCodeQuota, false)
  assert.equal(out.showTokens, undefined)
  assert.equal(out.compactLayout, undefined)
  assert.deepEqual(out.componentOrder, ['tools', 'context', 'git', 'tps', 'cost', 'activity'])
  assert.equal(out.intervalSec, 3600)
  assert.equal(out.cacheTtlMs, 3600000)
  assert.equal(out.usageUrl, 'https://opencode.ai/zen/go/v1/usage')
  assert.doesNotThrow(() => __test.sanitizeConfig(null))
  assert.doesNotThrow(() => __test.sanitizeConfig('bad'))
  assert.equal(__test.sanitizeConfig({ providers: [{ id: 'deepseek', onTurn: false }] }).quotaOnStep, false)
  assert.equal(__test.sanitizeConfig({ codexQuotaOnTurn: false }).quotaOnStep, false)
  assert.equal(__test.sanitizeConfig({ quotaOnStep: true, codexQuotaOnTurn: false }).quotaOnStep, true)
  assert.equal(__test.sanitizeConfig({ quotaOnStep: false }).quotaOnStep, false)
})

test('parseGitStatus counts AA/DD/UU conflicts', () => {
  const out = __test.parseGitStatus([
    '## main',
    'AA file-a.ts',
    'DD file-d.ts',
    'UU file-u.ts',
  ].join('\n'))
  assert.equal(out.counts.conflict, 3)
  assert.equal(out.counts.staged, 0)
  assert.equal(out.counts.unstaged, 0)
})

test('parseGitStatusV2 preserves literal quotes and backslashes in NUL paths', () => {
  const out = __test.parseGitStatusV2([
    '# branch.head main',
    '1 M. N... 100 100 100 100 100 literal "quote" and \\slash.ts',
    '? untracked "quote" and \\slash.txt',
  ].join('\0'))
  assert.ok(out.files.includes('literal "quote" and \\slash.ts'))
  assert.ok(out.files.includes('untracked "quote" and \\slash.txt'))
})

test('parseGitStatusV2 preserves a following record after a non-rename type-2 record', () => {
  const out = __test.parseGitStatusV2([
    '2 R. N... 100 100 100 100 100 R100 old.ts',
    'new.ts',
    '? later.txt',
  ].join('\0'))
  assert.equal(out.counts.untracked, 1)
  assert.ok(out.files.includes('later.txt'))
})

test('parseGitStatusV2 handles branch metadata, untracked files, conflicts, and rename paths', () => {
  const out = __test.parseGitStatusV2([
    '# branch.oid abcdef',
    '# branch.head main',
    '# branch.ab +5 -3',
    '1 M. N... 100 100 100 100 100 file with spaces.ts',
    'u UU N... 100 100 100 100 100 100 100 conflict.ts',
    '? untracked.txt',
    '2 R. N... 100 100 100 100 100 R100 old.ts',
    'new -> name.ts',
  ].join('\0'))
  assert.equal(out.branch, 'main')
  assert.equal(out.ahead, 5)
  assert.equal(out.behind, 3)
  assert.equal(out.counts.staged, 2)
  assert.equal(out.counts.unstaged, 0)
  assert.equal(out.counts.untracked, 1)
  assert.equal(out.counts.conflict, 1)
  assert.ok(out.files.includes('new -> name.ts'))
})

test('parseGitStatusV2 consumes origPath in real Git format without leaking', () => {
  const out = __test.parseGitStatusV2([
    '2 R. N... 100644 100644 100644 1111111 2222222 R100 destination.ts',
    '10-notes.txt',
    '1 M. N... 100644 100644 100644 1111111 2222222 modified.ts',
  ].join('\0'))
  assert.equal(out.counts.staged, 2)
  assert.equal(out.counts.unstaged, 0)
  assert.ok(out.files.includes('destination.ts'))
  assert.ok(out.files.includes('modified.ts'))
  assert.ok(!out.files.includes('10-notes.txt'))
})

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function fakeSubprocess() {
  return {
    async resolveExecutable() { throw new Error('not provided') },
    spawn({ argv, cwd }) {
      const child = spawn(argv[0], argv.slice(1), { cwd })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
      const done = new Promise((resolveDone, rejectDone) => {
        child.on('error', rejectDone)
        child.on('close', (exitCode, signal) => resolveDone({ exitCode, signal }))
      })
      return {
        done,
        collected: {
          stdout: { readFrom() { return { text: stdout } } },
          stderr: { readFrom() { return { text: stderr } } },
        },
      }
    },
  }
}

test('resolveGitRepo refuses to infer another repository from tool history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'slp-test-'))
  try {
    const repo = join(root, 'repo')
    const outside = join(root, 'outside')
    mkdirSync(repo, { recursive: true })
    mkdirSync(outside, { recursive: true })
    git(root, ['init', '-q', repo])
    git(repo, ['config', 'user.email', 'test@example.com'])
    git(repo, ['config', 'user.name', 'Test'])
    writeFileSync(join(repo, 'a.ts'), 'x\n')
    git(repo, ['add', 'a.ts'])
    git(repo, ['commit', '-qm', 'init'])
    const repoFile = join(repo, 'a.ts')
    assert.equal(await __test.resolveGitRepo(fakeSubprocess(), outside, [repoFile]), null)
    assert.equal(await __test.resolveGitRepo(fakeSubprocess(), repo, []), repo)
    assert.equal(await __test.resolveGitRepo(fakeSubprocess(), null, [repoFile]), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fetchGitStatus uses porcelain v2 and preserves the repo root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'slp-test-'))
  try {
    const repo = join(root, 'repo')
    mkdirSync(repo, { recursive: true })
    git(root, ['init', '-q', repo])
    git(repo, ['config', 'user.email', 'test@example.com'])
    git(repo, ['config', 'user.name', 'Test'])
    writeFileSync(join(repo, 'tracked.ts'), 'before\n')
    git(repo, ['add', 'tracked.ts'])
    git(repo, ['commit', '-qm', 'init'])
    git(repo, ['mv', 'tracked.ts', 'renamed.ts'])
    writeFileSync(join(repo, 'tracked.ts'), 'after\n')
    writeFileSync(join(repo, 'new file.ts'), 'new\n')
    const raw = git(repo, ['status', '--porcelain=v2', '-z', '--branch'])
    const parsed = __test.parseGitStatusV2(raw)
    assert.ok(parsed.files.includes('renamed.ts'))
    const out = await __test.fetchGitStatus(fakeSubprocess(), repo)
    assert.equal(out.isRepo, true)
    assert.equal(out.repoRoot, repo)
    assert.ok(out.counts.staged >= 1)
    assert.equal(out.counts.untracked, 2)
    assert.ok(out.files.includes('renamed.ts'))
    assert.ok(out.files.includes('new file.ts'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fetchGitStatus throws on genuine fatal git errors instead of misreporting isRepo: false', async () => {
  const fakeSubproc = {
    async resolveExecutable() { return '/usr/bin/git' },
    spawn(spec) {
      if (spec.argv.includes('rev-parse')) {
        return {
          done: Promise.resolve({ exitCode: 0, signal: null }),
          collected: {
            stdout: { readFrom() { return { text: '/tmp/fake-repo\n' } } },
            stderr: { readFrom() { return { text: '' } } },
          },
        }
      }
      return {
        done: Promise.resolve({ exitCode: 128, signal: null }),
        collected: {
          stdout: { readFrom() { return { text: '' } } },
          stderr: { readFrom() { return { text: 'fatal: index file corrupt\n' } } },
        },
      }
    },
  }
  await assert.rejects(
    async () => {
      await __test.fetchGitStatus(fakeSubproc, '/tmp/fake-repo')
    },
    /git status 失败.*fatal: index file corrupt/
  )
})

test('Git keeps branch/file state when optional line statistics fail', async () => {
  const calls = []
  const subprocess = {
    resolveExecutable: async () => '/usr/bin/git',
    spawn(spec) {
      calls.push(spec.argv)
      const diff = spec.argv.includes('diff')
      const text = spec.argv.includes('rev-parse') ? '/tmp/repo\n' : '# branch.head main\0'
      return { done: Promise.resolve({ exitCode: diff ? 1 : 0, signal: null }),
        collected: { stdout: { readFrom: () => ({ text: diff ? '' : text }) }, stderr: { readFrom: () => ({ text: diff ? 'fixture failure' : '' }) } } }
    },
  }
  const result = await __test.fetchGitStatus(subprocess, '/tmp/repo', [])
  assert.equal(result.branch, 'main')
  assert.equal(result.lineStats, null)
  assert.equal(result.lineStatsError, 'line-stats-unavailable')
  assert.ok(calls.every(argv => argv.includes('--no-optional-locks') && argv.includes('core.fsmonitor=false')))
})

test('Git UI labels the resolved repository and marks retained results stale', async () => {
  const harness = loadClientPluginForTest({ deferGit: true, initialConfig: { enabled: true, showGit: true, showCwd: true, showContext: false, showTokens: false, showTps: false } })
  try {
    const dock = harness.registrations.find(entry => entry.spec.name === 'conversation.composer.dock')
    const renderer = harness.createRenderer()
    const element = dock.component({ sessionId: 's1', useSessions: select => select({ byId: { s1: { cwd: '/tmp/repo/nested' } } }), useProjection: () => null })
    const render = () => renderer.render(element.type, element.props)
    const gitProps = panel => panel.props.children[0].props.children[0].find(node => node.props.key === 'git').props
    render()
    harness.gitResolvers[0]({ isRepo: true, repoRoot: '/tmp/repo', branch: 'main', counts: {}, lineStats: null })
    await new Promise(setImmediate)
    const first = gitProps(render())
    assert.equal(first.path, '/tmp/repo')
    first.refresh()
    harness.gitResolvers[1](null, 'network')
    await new Promise(setImmediate)
    const stale = gitProps(render())
    assert.equal(stale.data.branch, 'main')
    assert.equal(stale.stale, true)
    renderer.unmount()
  } finally { harness.restore() }
})

function fakeSshBridge(outputs) {
  const anchorPath = '/virtual/ssh-anchor'
  const remoteRoot = '/srv/workspace'
  const calls = []
  const routedSubprocess = {
    async resolveExecutable() { throw new Error('remote executable resolution must use the remote PATH') },
    spawn(spec) {
      calls.push(spec)
      const next = outputs.shift() || { stdout: '', stderr: '', exitCode: 0 }
      return {
        done: Promise.resolve({ exitCode: next.exitCode || 0, signal: null }),
        collected: {
          stdout: { readFrom() { return { text: next.stdout || '', lossy: false } } },
          stderr: { readFrom() { return { text: next.stderr || '', lossy: false } } },
        },
      }
    },
  }
  const bridge = {
    mapLocalPath(localPath) {
      const absolute = resolve(localPath)
      if (absolute !== anchorPath && !absolute.startsWith(anchorPath + '/')) return undefined
      return {
        anchorPath,
        target: { transport: 'ssh', alias: 'test-host' },
        remotePath: remoteRoot + absolute.slice(anchorPath.length),
      }
    },
    mapRemotePath(mapping) {
      if (mapping.anchorPath !== anchorPath || mapping.target.alias !== 'test-host') return undefined
      if (mapping.remotePath !== remoteRoot && !mapping.remotePath.startsWith(remoteRoot + '/')) return undefined
      return anchorPath + mapping.remotePath.slice(remoteRoot.length)
    },
    subprocess() { return routedSubprocess },
  }
  return { anchorPath, remoteRoot, calls, bridge }
}

test('fetchGitStatus detects an SSH repo without local anchor contents and maps repoRoot locally', async () => {
  const fixture = fakeSshBridge([
    { stdout: '/srv/workspace/repo\n' },
    { stdout: ['# branch.head remote-main', '# branch.ab +2 -1', '1 .M N... 100644 100644 100644 abc def src/tracked.ts', '? src/new.ts'].join('\0') },
    { stdout: '4\t1\tsrc/tracked.ts\n' },
    { stdout: '2\t0\tsrc/staged.ts\n' },
  ])
  const localSubprocess = {
    async resolveExecutable() { return '/usr/bin/git' },
    spawn() { throw new Error('SSH Git must not use the local subprocess') },
  }
  const cwd = fixture.anchorPath + '/repo/src'
  const out = await __test.fetchGitStatus(localSubprocess, cwd, [], fixture.bridge)
  assert.equal(out.isRepo, true)
  assert.equal(out.repoRoot, fixture.anchorPath + '/repo')
  assert.deepEqual(out.remote, { host: 'test-host', root: '/srv/workspace/repo' })
  assert.equal(out.branch, 'remote-main')
  assert.equal(out.ahead, 2)
  assert.equal(out.behind, 1)
  assert.equal(out.counts.unstaged, 1)
  assert.equal(out.counts.untracked, 1)
  assert.deepEqual(out.lineStats, {
    added: 6,
    deleted: 1,
    staged: { added: 2, deleted: 0 },
    unstaged: { added: 4, deleted: 1 },
  })
  assert.deepEqual(fixture.calls.map((call) => call.argv), [
    ['git', 'rev-parse', '--show-toplevel'],
    ['git', 'status', '--porcelain=v2', '-z', '--branch'],
    ['git', 'diff', '--numstat', '--no-ext-diff'],
    ['git', 'diff', '--cached', '--numstat', '--no-ext-diff'],
  ].map(argv => [argv[0], '--no-optional-locks', '-c', 'core.fsmonitor=false', ...argv.slice(1)]))
  assert.equal(fixture.calls[0].cwd, cwd)
  assert.ok(fixture.calls.slice(1).every((call) => call.cwd === fixture.anchorPath + '/repo'))
})

async function installRouteHarness(options = {}) {
  const routes = new Map()
  const api = require('../lib/index.js')
  let disposePlugin = () => {}
  let disposeBridgeFiber = () => {}
  const context = {
    on() { return () => {} },
    webServer: {
      register(spec) {
        routes.set(spec.path, spec.handler)
        return () => routes.delete(spec.path)
      },
    },
    subprocess: options.subprocess || fakeSubprocess(),
    credentials: null,
    sessionProjections: { register() { return () => {} } },
    settings: { installSection(owner, name, schema, initial, hooks) {
      hooks.setSource(() => initial); hooks.onChange()
    } },
    effect(factory) { disposePlugin = factory() || (() => {}) },
  }
  if (options.sshRemoteHostBridge) {
    context.inject = (services, callback) => {
      assert.deepEqual(services, ['sshRemoteHostBridge'])
      disposeBridgeFiber = callback({ sshRemoteHostBridge: options.sshRemoteHostBridge }) || (() => {})
      return { dispose() { disposeBridgeFiber() } }
    }
  }
  await api.apply(context)
  routes.disposeBridge = () => disposeBridgeFiber()
  routes.disposePlugin = () => disposePlugin()
  return routes
}

function callRoute(handler, method, headers, body) {
  const req = new EventEmitter()
  req.method = method
  req.headers = headers || {}
  const response = {
    status: null,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value },
    writeHead(status, headersValue) { this.status = status; Object.assign(this.headers, headersValue) },
    end(value) { this.body = value || '' },
  }
  const pending = handler(req, response)
  if (body !== undefined) {
    process.nextTick(() => {
      req.emit('data', body)
      req.emit('end')
    })
  }
  return Promise.resolve(pending).then(() => ({ response, json: response.body ? JSON.parse(response.body) : null }))
}

test('Git route reuses completed snapshots briefly, scopes them by session and bypasses on manual refresh', async () => {
  const base = fakeSubprocess(), calls = []
  const routes = await installRouteHarness({ subprocess: { ...base, spawn(spec) { calls.push(spec); return base.spawn(spec) } } })
  try {
    const request = (sessionId, force) => callRoute(routes.get('/statusline/api/git'), 'POST', { 'content-type': 'application/json' }, JSON.stringify({ cwd: process.cwd(), sessionId, force }))
    assert.equal((await request('one')).json.ok, true)
    assert.equal(calls.length, 4)
    await request('one'); assert.equal(calls.length, 4, 'completed snapshot is reused')
    await request('one', true); assert.equal(calls.length, 8, 'manual refresh bypasses the snapshot')
    await request('two'); assert.equal(calls.length, 12, 'another session has its own scope')
  } finally { routes.disposePlugin() }
})

test('route guards reject wrong methods, cross-origin requests, and non-JSON bodies', async () => {
  const routes = await installRouteHarness()
  const usage = routes.get('/statusline/api/usage')
  const wrongMethod = await callRoute(usage, 'GET', {})
  assert.equal(wrongMethod.response.status, 405)
  const wrongType = await callRoute(usage, 'POST', { 'content-type': 'text/plain' }, '{}')
  assert.equal(wrongType.response.status, 415)
  const crossOrigin = await callRoute(usage, 'POST', { origin: 'http://evil.invalid', host: '127.0.0.1:3080', 'content-type': 'application/json' }, '{}')
  assert.equal(crossOrigin.response.status, 403)
})

test('Git route negotiates bridge v1 and fails closed after its optional fiber unloads', async () => {
  const fixture = fakeSshBridge([
    { stdout: fixtureRemoteRoot() + '\n' },
    { stdout: '# branch.head main\0' },
    { stdout: '' },
    { stdout: '' },
  ])
  function fixtureRemoteRoot() { return '/srv/workspace' }
  const negotiation = []
  const service = {
    negotiate(request) {
      negotiation.push(request)
      return fixture.bridge
    },
  }
  const localCalls = []
  const localSubprocess = {
    async resolveExecutable() { return '/usr/bin/git' },
    spawn(spec) {
      localCalls.push(spec)
      return {
        done: Promise.resolve({ exitCode: 128, signal: null }),
        collected: {
          stdout: { readFrom() { return { text: '', lossy: false } } },
          stderr: { readFrom() { return { text: 'fatal: not a git repository', lossy: false } } },
        },
      }
    },
  }
  const routes = await installRouteHarness({ sshRemoteHostBridge: service, subprocess: localSubprocess })
  assert.deepEqual(negotiation, [{
    minVersion: 1,
    maxVersion: 1,
    requiredCapabilities: ['path-mapping', 'reverse-path-mapping', 'routed-subprocess'],
  }])
  const gitRoute = routes.get('/statusline/api/git')
  const first = await callRoute(gitRoute, 'POST', { 'content-type': 'application/json' }, JSON.stringify({ cwd: fixture.anchorPath }))
  assert.equal(first.json.ok, true)
  assert.equal(first.json.data.isRepo, true)
  assert.equal(first.json.data.repoRoot, fixture.anchorPath)
  assert.equal(localCalls.length, 0)

  routes.disposeBridge()
  const second = await callRoute(gitRoute, 'POST', { 'content-type': 'application/json' }, JSON.stringify({ cwd: fixture.anchorPath }))
  assert.equal(second.json.ok, true)
  assert.equal(second.json.data.isRepo, false)
  assert.ok(localCalls.length > 0, 'bridge unload must not retain routed SSH execution')
  routes.disposePlugin()
})

test('sanitizeConfig injects the OpenRouter provider preset when absent', () => {
  const out = __test.sanitizeConfig({})
  const or = out.providers.find((p) => p.id === 'openrouter')
  assert.ok(or, 'openrouter preset should be auto-injected')
  assert.equal(or.apiKeyEnv, 'OPENROUTER_API_KEY')
  assert.equal(or.style, 'balance')
  assert.equal(or.endpoints.length, 2)
  assert.equal(or.endpoints[0].url, 'https://openrouter.ai/api/v1/credits')
  assert.equal(or.endpoints[1].parse.remainingPath, 'data.limit_remaining')
})

test('sanitizeConfig merges a partial openrouter override and drops invalid providers', () => {
  const out = __test.sanitizeConfig({
    providers: [
      { id: 'openrouter', enabled: false },
      { id: 'bad id!', apiKeyEnv: 'KEY' },
      { id: 'nokey', apiKeyEnv: '' },
      {
        id: 'zai',
        label: 'Z.ai',
        style: 'balance',
        apiKeyEnv: 'ZAI_API_KEY',
        redBelow: 10,
        endpoints: [{ url: 'https://api.z.ai/api/paas/v4/balance', parse: { remainingPath: 'data.total_balance', currency: 'CNY' } }],
        match: { providerSub: ['z.ai', 'zai'] },
      },
      { id: 'badurl', apiKeyEnv: 'KEY', endpoints: [{ url: 'http://openrouter.ai/api/v1/key', parse: { remainingPath: 'a' } }] },
      { id: 'badred', apiKeyEnv: 'KEY', endpoints: [{ url: 'https://example.com/x', parse: { remainingPath: 'a' } }], redBelow: 'abc' },
    ],
  })
  const or = out.providers.find((p) => p.id === 'openrouter')
  assert.ok(or)
  assert.equal(or.enabled, false)
  assert.equal(or.endpoints.length, 2, 'partial override inherits preset endpoints')
  const zai = out.providers.find((p) => p.id === 'zai')
  assert.ok(zai)
  assert.deepEqual(zai.match.providerSub, ['z.ai', 'zai'])
  assert.equal(zai.redBelow, 10, 'valid redBelow is kept')
  const badred = out.providers.find((p) => p.id === 'badred')
  assert.ok(badred, 'invalid optional field keeps the provider')
  assert.equal(badred.redBelow, undefined, 'non-numeric redBelow is omitted')
})

test('sanitizeProviderEndpointUrl only allows public https endpoints', () => {
  assert.equal(__test.sanitizeProviderEndpointUrl('https://openrouter.ai/api/v1/key'), 'https://openrouter.ai/api/v1/key')
  assert.equal(__test.sanitizeProviderEndpointUrl('http://openrouter.ai/api/v1/key'), null)
  assert.equal(__test.sanitizeProviderEndpointUrl('https://user:pass@openrouter.ai/api/v1/key'), null)
  assert.equal(__test.sanitizeProviderEndpointUrl('https://169.254.169.254/latest/meta-data'), null)
  assert.equal(__test.sanitizeProviderEndpointUrl('https://127.0.0.1:8080/x'), null)
})

test('pickPath walks dotted segments including array indices', () => {
  assert.equal(__test.pickPath({ a: { b: [{ c: 5 }] } }, 'a.b.0.c'), 5)
  assert.equal(__test.pickPath({ a: 1 }, 'a.b.c'), undefined)
  assert.equal(__test.pickPath(null, 'a'), undefined)
})

test('providerBalanceFromParse parses the openrouter key and credits endpoints', () => {
  const keyShape = __test.providerBalanceFromParse(
    { data: { limit_remaining: 7.35, limit: 50, usage: 42.65 } },
    { remainingPath: 'data.limit_remaining', limitPath: 'data.limit', usedPath: 'data.usage', currency: 'USD' },
  )
  assert.equal(keyShape.remaining, 7.35)
  assert.equal(keyShape.limit, 50)
  assert.equal(keyShape.used, 42.65)
  assert.equal(keyShape.currency, 'USD')

  const credits = __test.providerBalanceFromParse(
    { data: { total_credits: 100.5, total_usage: 25.75 } },
    { mode: 'openrouter-credits' },
  )
  assert.equal(credits.remaining, 74.75)
  assert.equal(credits.used, 25.75)
  // 预充值语义：total_credits 是累计充值而非上限，limit 不应被伪装出来
  assert.equal(credits.limit, undefined)
  assert.equal(__test.providerBalanceFromParse({ data: {} }, { mode: 'openrouter-credits' }), null)
})

test('providerBalanceFromParse keeps key-endpoint limit as a real cap and tolerates unlimited keys', () => {
  // 设了 key 消费上限：limit 是真实上限
  const capped = __test.providerBalanceFromParse(
    { data: { limit: 50, limit_remaining: 42.5, usage: 7.5 } },
    { remainingPath: 'data.limit_remaining', limitPath: 'data.limit', usedPath: 'data.usage' },
  )
  assert.equal(capped.remaining, 42.5)
  assert.equal(capped.limit, 50)
  // 未设上限的普通 key：limit/limit_remaining 为 null，只剩 usage
  const unlimited = __test.providerBalanceFromParse(
    { data: { limit: null, limit_remaining: null, usage: 3.5 } },
    { remainingPath: 'data.limit_remaining', limitPath: 'data.limit', usedPath: 'data.usage' },
  )
  assert.equal(unlimited.remaining, undefined)
  assert.equal(unlimited.limit, undefined)
  assert.equal(unlimited.used, 3.5)
})

test('providerBalanceFromParse derives the missing side from the other two', () => {
  const noUsed = __test.providerBalanceFromParse({ data: { available: 3 } }, { remainingPath: 'data.available' })
  assert.equal(noUsed.remaining, 3)
  assert.equal(noUsed.used, undefined)
  const noRemaining = __test.providerBalanceFromParse({ data: { limit: 10, used: 4 } }, { limitPath: 'data.limit', usedPath: 'data.used' })
  assert.equal(noRemaining.remaining, 6)
})

test('providerWindowsFromParse extracts declared windows and skips missing ones', () => {
  const wins = __test.providerWindowsFromParse(
    { plan: { primary: { used: 42, reset: 3600 } } },
    [
      { label: '5h', usedPercentPath: 'plan.primary.used', resetInSecPath: 'plan.primary.reset' },
      { label: 'week', usedPercentPath: 'plan.week.used' },
    ],
  )
  assert.equal(wins.length, 1)
  assert.equal(wins[0].label, '5h')
  assert.equal(wins[0].usedPercent, 42)
  assert.equal(wins[0].resetInSec, 3600)
  assert.equal(__test.providerWindowsFromParse({ x: 1 }, []), null)
})

test('estimateTextTokens counts CJK and latin text with a mixed heuristic', () => {
  assert.equal(__test.estimateTextTokens(''), 0)
  // 4 个 CJK 字 → 4 * 0.75 = 3
  assert.equal(__test.estimateTextTokens('你好世界'), 3)
  // 'hello world foo' = 15 个非 CJK 字符 → 15 / 3.5 ≈ 4.286
  assert.ok(Math.abs(__test.estimateTextTokens('hello world foo') - 15 / 3.5) < 1e-9)
})

test('header chip retains rendered quota without resetting to loading on step updates', async () => {
  const harness = loadClientPluginForTest({
    initialConfig: { enabled: true, showQuota: true, showAntigravityQuota: true, quotaAuto: true },
  })
  const { registrations, createRenderer, restore } = harness
  try {
    const headerEntry = registrations.find((entry) => entry.spec.name === 'conversation.session.header.actions')
    assert.ok(headerEntry, 'session header action should be registered')
    let currentSteps = 0
    const props = {
      sessionId: 'sess-1',
      useProjection(key) {
        if (key === 'sessionStats') return { steps: currentSteps }
        return null
      },
    }
    const renderer = createRenderer()
    // Initial render
    let tree = renderer.render(headerEntry.component, props)
    // Wait microtasks for async session-model and antigravity-quota promises
    await new Promise((r) => setTimeout(r, 20))
    tree = renderer.render(headerEntry.component, props)
    assert.ok(tree, 'tree should not be null')

    // Now simulate turn step increment:
    currentSteps = 1
    const nextTree = renderer.render(headerEntry.component, props)
    assert.ok(nextTree, 'nextTree should not be null')
    const isBareLoadingErr = nextTree.type === 'span' && nextTree.props.className === 'slp-codex-err'
    assert.equal(isBareLoadingErr, false, 'should not collapse to error/loading text span on step update')
  } finally {
    restore()
  }
})

test('parseAntigravityQuotaSummary extracts real 5h and weekly quotas from groups', () => {
  const { parseAntigravityQuotaSummary } = __test
  const now = 1788393524000
  const cred = { email: 'user@example.com', projectId: 'test-proj' }
  const summaryJson = {
    groups: [
      {
        displayName: 'Gemini Models',
        buckets: [
          {
            bucketId: 'gemini-weekly',
            displayName: 'Weekly Limit Remaining',
            window: 'weekly',
            resetTime: new Date(now + 360000 * 1000).toISOString(),
            remainingFraction: 0.9517,
          },
          {
            bucketId: 'gemini-5h',
            displayName: 'Five Hour Limit Remaining',
            window: '5h',
            resetTime: new Date(now + 10800 * 1000).toISOString(),
            remainingFraction: 0.8531,
          },
        ],
      },
      {
        displayName: 'Claude and GPT models',
        buckets: [
          {
            bucketId: '3p-5h',
            displayName: '3P 5h',
            window: '5h',
            resetTime: new Date(now + 18000 * 1000).toISOString(),
            remainingFraction: 1,
          },
        ],
      },
    ],
  }

  const result = parseAntigravityQuotaSummary(now, cred, summaryJson)
  assert.ok(result, 'result should be non-null')
  assert.equal(result.email, 'user@example.com')
  assert.equal(result.projectId, 'test-proj')
  assert.equal(result.gemini5h.remainingPercent, 85)
  assert.equal(result.gemini5h.usedPercent, 15)
  assert.equal(result.gemini5h.resetInSec, 10800)
  assert.equal(result.geminiWeekly.remainingPercent, 95)
  assert.equal(result.geminiWeekly.usedPercent, 5)
  assert.equal(result.geminiWeekly.resetInSec, 360000)
  assert.equal(result.thirdParty.remainingPercent, 100)
  assert.equal(result.thirdParty.usedPercent, 0)
})

test('Antigravity upstream host uses official daily-cloudcode-pa endpoint', () => {
  assert.equal(__test.ANTIGRAVITY_HOST, 'daily-cloudcode-pa.googleapis.com')
})

test('decodeRecentSessionText bounds frames and output bytes while skipping torn tail frames', () => {
  const zlib = require('node:zlib')
  const { decodeRecentSessionText } = __test

  // 5 frames with 400 bytes each
  const frames = [
    zlib.zstdCompressSync(Buffer.from('frame-0: ' + 'a'.repeat(400) + '\n')),
    zlib.zstdCompressSync(Buffer.from('frame-1: ' + 'b'.repeat(400) + '\n')),
    zlib.zstdCompressSync(Buffer.from('frame-2: ' + 'c'.repeat(400) + '\n')),
    zlib.zstdCompressSync(Buffer.from('frame-3: ' + 'd'.repeat(400) + '\n')),
    zlib.zstdCompressSync(Buffer.from('frame-4: ' + 'e'.repeat(400) + '\n')),
  ]
  const fullBuffer = Buffer.concat(frames)

  // 1. Decode with maxFrames: 2 (should get the latest 2: frame-3 and frame-4)
  const textCapped = decodeRecentSessionText(fullBuffer, { maxFrames: 2 })
  assert.ok(textCapped.includes('frame-3'))
  assert.ok(textCapped.includes('frame-4'))
  assert.ok(!textCapped.includes('frame-2'))

  // 2. Decode with maxOutputBytes (1024 bytes -> can only fit ~2-3 frames, not frame-0)
  const textBytesCapped = decodeRecentSessionText(fullBuffer, { maxOutputBytes: 1024 })
  assert.ok(textBytesCapped.includes('frame-4'))
  assert.ok(!textBytesCapped.includes('frame-0'))

  // 3. Torn tail frame: simulate trailing frame cut off mid-write
  const tornFrame = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x01, 0x02, 0x03])
  const tornBuffer = Buffer.concat([...frames, tornFrame])
  const textTorn = decodeRecentSessionText(tornBuffer, { maxFrames: 5 })
  assert.ok(textTorn.includes('frame-4'))
  assert.ok(textTorn.includes('frame-3'))
})

test('readLiveSessionModel extracts state directly from in-memory session', () => {
  const { readLiveSessionModel } = __test

  const mockSession = {
    id: '11111111-2222-3333-4444-555555555555',
    requestHeader() {
      return { config: { provider: 'antigravity', model: 'gemini-3.8-flash-high' } }
    },
    events: [
      { type: 'tool/call', data: { name: 'read', arguments: { file_path: '/tmp/project/src/index.js' } } },
      { type: 'tool/call', data: { name: 'bash', arguments: { command: 'cd /tmp/project && git status' } } },
    ],
  }

  const mockSessions = {
    get(id) {
      if (id.includes('11111111-2222-3333-4444-555555555555')) return mockSession
      return undefined
    },
  }

  const model = readLiveSessionModel(mockSessions, '11111111-2222-3333-4444-555555555555')
  assert.deepEqual(model, { provider: 'antigravity', model: 'gemini-3.8-flash-high' })

})

test('a single large zstd frame cannot bypass the output cap', () => {
  const zlib = require('node:zlib')
  const packed = zlib.zstdCompressSync(Buffer.alloc(8 * 1024 * 1024, 120))
  assert.ok(Buffer.byteLength(__test.decodeRecentSessionText(packed, { maxOutputBytes: 1024 })) <= 1024)
})

test('truncated Git output is reported instead of showing misleading counts', async () => {
  const subprocess = {
    async resolveExecutable() { return '/usr/bin/git' },
    spawn() { return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: {
      stdout: { readFrom: () => ({ text: '/tmp/repo', lossy: true }) },
    } } },
  }
  await assert.rejects(__test.fetchGitStatus(subprocess, '/tmp/repo', []), /git-output-too-large/)
})

test('Git resolves a known workspace before invoking expensive history hints', async () => {
  let hintReads = 0
  const subprocess = {
    async resolveExecutable() { return '/usr/bin/git' },
    spawn({ argv }) { return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: {
      stdout: { readFrom: () => ({ text: argv.includes('rev-parse') ? '/tmp/repo' : '' }) },
    } } },
  }
  await __test.fetchGitStatus(subprocess, '/tmp/repo', () => { hintReads++; return [] })
  assert.equal(hintReads, 0)
})

test('Git shares the caller cancellation across discovery and status commands', async () => {
  const abort = new AbortController()
  let calls = 0
  const subprocess = {
    async resolveExecutable() { return '/usr/bin/git' },
    spawn({ signal }) {
      calls++
      return { done: new Promise(resolve => signal.addEventListener('abort', () => resolve({ exitCode: null, signal: 'SIGTERM' }))),
        collected: { stdout: { readFrom: () => ({ text: '' }) } } }
    },
  }
  const pending = __test.fetchGitStatus(subprocess, '/tmp/repo', ['/tmp/other'], undefined, abort.signal)
  await new Promise(setImmediate); abort.abort(new Error('cancelled-by-client'))
  await assert.rejects(pending, /cancelled-by-client/)
  assert.equal(calls, 1)
})

test('oversized recent frames cannot expose stale model records from older frames', () => {
  const zlib = require('node:zlib')
  const old = zlib.zstdCompressSync(Buffer.from('{"type":"request/header","data":{"header":{"config":{"provider":"codex","model":"old"}}}}\n'))
  const recent = zlib.zstdCompressSync(Buffer.alloc(8192, 120))
  const text = __test.decodeRecentSessionText(Buffer.concat([old, recent]), { maxOutputBytes: 1024 })
  assert.equal(text, '')
})

test('disk lookup chooses the newest committed v2 generation and refuses unknown successors', () => {
  const root = mkdtempSync(join(tmpdir(), 'slp-generation-'))
  try {
    writeFileSync(join(root, 'session.jsonl.zstd'), 'older')
    writeFileSync(join(root, 'session.v2.jsonl'), 'current')
    writeFileSync(join(root, 'session.v9.jsonl.tmp'), 'uncommitted')
    assert.equal(__test.selectSessionLog(root), join(root, 'session.v2.jsonl'))
    writeFileSync(join(root, 'session.v3.jsonl'), 'future')
    assert.throws(() => __test.selectSessionLog(root), /unsupported session format/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Antigravity quota panel opens on trigger click and auto-hides on click outside, Escape, or blur', async () => {
  const harness = loadClientPluginForTest({
    initialConfig: { enabled: true, showQuota: true, showAntigravityQuota: true, quotaAuto: true },
  })
  const { registrations, createRenderer, docListeners, restore } = harness
  try {
    const headerEntry = registrations.find((entry) => entry.spec.name === 'conversation.session.header.actions')
    assert.ok(headerEntry, 'session header action should be registered')
    const props = {
      sessionId: 'sess-1',
      useProjection() { return null },
    }
    const renderer = createRenderer()
    // Initial render
    let tree = renderer.render(headerEntry.component, props)
    await new Promise((r) => setTimeout(r, 20))
    // Render HeaderChip -> QuotaChip element
    tree = renderer.render(headerEntry.component, props)
    assert.ok(tree)
    // Render QuotaChip in fresh renderer -> span wrapping AntigravityQuotaLine
    const chipRenderer = createRenderer()
    const chipTree = chipRenderer.render(tree.type, tree.props)
    assert.ok(chipTree)
    const agComponent = chipTree.props.children[0]
    assert.ok(agComponent)

    // AntigravityQuotaLine props from quota response
    const agData = {
      email: 'user@example.com',
      gemini5h: { usedPercent: 14, remainingPercent: 86, resetInSec: 10800 },
      geminiWeekly: { usedPercent: 20, remainingPercent: 80, resetInSec: 86400 },
    }
    let refreshed = 0
    const agProps = {
      data: agData,
      error: null,
      refresh() { refreshed++ },
    }

    // Render AntigravityQuotaLine in its own renderer
    const agRenderer = createRenderer()
    let agTree = agRenderer.render(agComponent.type, agProps)
    assert.ok(agTree)
    assert.equal(agTree.props.className, 'slp-quota-root')
    assert.equal(agTree.props.children[1], null)

    // 1. Click button to OPEN panel
    const button = agTree.props.children[0]
    button.props.onClick()
    agTree = agRenderer.render(agComponent.type, agProps)
    const panel = agTree.props.children[1]
    assert.ok(panel, 'panel should be open')
    assert.equal(panel.type.name, 'AntigravityDetailPanel')

    // 2. Click INSIDE the panel: should stay open
    const rootEl = {
      contains(target) {
        return target === 'inside' || target === 'root'
      },
    }
    if (agTree.props.ref) agTree.props.ref.current = rootEl

    const pointerListeners = docListeners.get('pointerdown') || new Set()
    assert.ok(pointerListeners.size > 0, 'pointerdown listener should be registered')
    for (const fn of pointerListeners) fn({ target: 'inside' })
    agTree = agRenderer.render(agComponent.type, agProps)
    assert.ok(agTree.props.children[1], 'panel should stay open when clicking inside')

    // 3. Click OUTSIDE the panel: should close
    for (const fn of pointerListeners) fn({ target: 'outside' })
    agTree = agRenderer.render(agComponent.type, agProps)
    assert.equal(agTree.props.children[1], null, 'panel should close on click outside')

    // 4. Click button to open again, then press Escape: should close
    button.props.onClick()
    agTree = agRenderer.render(agComponent.type, agProps)
    assert.ok(agTree.props.children[1], 'panel should open again')
    const keyListeners = docListeners.get('keydown') || new Set()
    let stopped = false
    for (const fn of keyListeners) fn({ key: 'Escape', stopPropagation() { stopped = true } })
    assert.ok(stopped, 'Escape should stop propagation')
    agTree = agRenderer.render(agComponent.type, agProps)
    assert.equal(agTree.props.children[1], null, 'panel should close on Escape')

    // 5. Click button to open again, then blur with outside target: should close
    button.props.onClick()
    agTree = agRenderer.render(agComponent.type, agProps)
    assert.ok(agTree.props.children[1], 'panel should open again')
    agTree.props.onBlur({ relatedTarget: 'outside' })
    agTree = agRenderer.render(agComponent.type, agProps)
    assert.equal(agTree.props.children[1], null, 'panel should close on blur to outside target')

    // 6. Click button while open: should toggle closed
    button.props.onClick()
    agTree = agRenderer.render(agComponent.type, agProps)
    assert.ok(agTree.props.children[1], 'panel should open again')
    button.props.onClick()
    agTree = agRenderer.render(agComponent.type, agProps)
    assert.equal(agTree.props.children[1], null, 'button click should toggle closed')
  } finally {
    restore()
  }
})

test('OpenCode quota panel in QuotaChip opens and auto-hides on click outside', async () => {
  const harness = loadClientPluginForTest({
    initialConfig: { enabled: true, showQuota: true, quotaAuto: false },
  })
  const { registrations, createRenderer, docListeners, restore } = harness
  try {
    const headerEntry = registrations.find((entry) => entry.spec.name === 'conversation.session.header.actions')
    assert.ok(headerEntry)
    const props = { sessionId: 'sess-opencode', useProjection() { return null } }
    const renderer = createRenderer()
    renderer.render(headerEntry.component, props)
    await new Promise((r) => setTimeout(r, 20))
    const tree = renderer.render(headerEntry.component, props)
    assert.ok(tree)
    // tree is QuotaChip element
    const chipRenderer = createRenderer()
    let chipTree = chipRenderer.render(tree.type, {
      ...tree.props,
      resource: { kind: 'opencode', key: 'opencode:sess-opencode', onStep: true },
    })
    assert.ok(chipTree)
    assert.equal(chipTree.props.className, 'slp-quota-with-age')
    // QuotaChip wraps the per-source line; render the OpenCode line itself.
    const line = chipTree.props.children[0]
    const lineRenderer = createRenderer()
    const renderLine = () => lineRenderer.render(line.type, { ...line.props, data: { fetchedAt: Date.now(), windows: { rolling: { percent: 20 } } } })
    chipTree = renderLine()
    assert.equal(chipTree.props.className, 'slp-quota-root')
    const button = chipTree.props.children[0]
    assert.ok(button)
    // Click button to open
    button.props.onClick()
    chipTree = renderLine()
    assert.ok(chipTree.props.children[1], 'panel should open on click')
    // Attach root ref
    const rootEl = { contains(target) { return target === 'inside' } }
    if (chipTree.props.ref) chipTree.props.ref.current = rootEl

    const pointerListeners = docListeners.get('pointerdown') || new Set()
    // Click outside
    for (const fn of pointerListeners) fn({ target: 'outside' })
    chipTree = renderLine()
    assert.equal(chipTree.props.children[1], null, 'panel should close on click outside')
  } finally {
    restore()
  }
})
