'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const { EventEmitter } = require('node:events')
process.env.SLP_TEST = '1'
const plugin = require('../lib/index')
const fromDsh = createRequire(process.env.DSH_PACKAGE_DIR ? join(process.env.DSH_PACKAGE_DIR, 'package.json') : require.resolve('@deepseek-ai/dsh/package.json'))
const dsh = name => import(pathToFileURL(fromDsh.resolve('@deepseek-ai/' + name)).href)

async function fixture() {
  const [{ Context }, { SessionStore }, { SessionProjectionRegistry }, { SettingsProvider }] = await Promise.all([
    dsh('cordis'), dsh('dsh-session'), dsh('dsh-session-projection'), dsh('dsh-settings'),
  ])
  const ctx = new Context(), routes = new Map()
  new SessionStore(ctx); new SessionProjectionRegistry(ctx)
  const { installSettings } = await import('./native-settings-fixture.mjs')
  const attach = await installSettings(ctx, dsh)
  ctx.provide('webServer', { register(spec) { routes.set(spec.path, spec.handler); return () => routes.delete(spec.path) } })
  ctx.provide('subprocess', {})
  ctx.provide('credentials', { resolve: async () => ({ value: 'fixture-key-not-real' }) })
  const fiber = ctx.plugin(plugin)
  await fiber.await()
  attach('statusline-plus', fiber)
  return { ctx, fiber, routes, close: () => ctx.fiber.dispose() }
}
async function call(route, body = {}) {
  const req = new EventEmitter(), res = new EventEmitter()
  Object.assign(req, { method: 'POST', headers: { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json' } })
  Object.assign(res, { setHeader() {}, writeHead(status) { this.status = status }, end(text) { this.value = JSON.parse(text); this.writableEnded = true } })
  const pending = route(req, res)
  req.emit('data', JSON.stringify(body)); req.emit('end')
  await pending
  return res
}

test('native DSH settings drive the plugin, reject stale edits, and clean up on unload', async t => {
  const f = await fixture(); t.after(f.close)
  const initial = f.ctx.settings.describe().find(s => s.ns === 'statusline-plus')
  assert.ok(initial)
  assert.ok(initial.value.providers.find(provider => provider.id === 'deepseek'))
  assert.equal(initial.value.showDeepseekPeak, true)
  assert.equal(initial.value.deepseekPeakCountdown, true)
  assert.equal(initial.value.showActivity, true)
  assert.equal(initial.value.showCost, true)
  assert.equal(initial.value.compactLayout, undefined)
  assert.equal(initial.value.showTokens, undefined)
  assert.equal(initial.value.showOpenCodeQuota, true)
  assert.equal(initial.value.showContext, true)
  assert.equal(initial.value.quotaOnStep, undefined)
  await f.ctx.settings.update('statusline-plus', { quotaOnStep: false })
  assert.equal(f.ctx.settings.describe().find(s => s.ns === 'statusline-plus').value.quotaOnStep, false)
  assert.equal(plugin.__test.SettingsSchema({}).providers.find(provider => provider.id === 'zai').apiKeyEnv, 'ZAI_API_KEY')
  await f.ctx.settings.update('statusline-plus', { enabled: false })
  await Promise.resolve()
  const reply = await call(f.routes.get('/statusline/api/usage'))
  assert.equal(reply.value.error, 'disabled')
  const stale = await call(f.routes.get('/statusline/api/config'), { revision: initial.revision, patch: { showGit: false } })
  assert.equal(stale.status, 409)
  await f.fiber.dispose()
  assert.equal(f.routes.size, 0)
  assert.equal(f.ctx.settings.describe().find(s => s.ns === 'statusline-plus')?.value, undefined)
})

test('real live Session supplies the current model without disk decoding', async t => {
  const f = await fixture(); t.after(f.close)
  const session = f.ctx.sessions.create('12345678-1234-1234-1234-123456789abc', { meta: { cwd: '/tmp/fixture-project' } })
  const setModel = model => session.append('request/header', { reason: 'initial', header: { config: { provider: 'openrouter', model } } })
  setModel('gpt-5.6')
  assert.equal((await call(f.routes.get('/statusline/api/session-model'), { sessionId: session.id })).value.data.model, 'gpt-5.6')
  setModel('different-model')
  assert.equal((await call(f.routes.get('/statusline/api/session-model'), { sessionId: session.id })).value.data.model, 'different-model')
  assert.equal(session.events, undefined)
  assert.equal((await call(f.routes.get('/statusline/api/session-model'), { sessionId: 'missing' })).value.ok, false)
})

test('mounted plugin publishes native offline subscription prices through the actual Session registry', async t => {
  const f = await fixture(); t.after(f.close)
  const { createAssistantMessage } = await dsh('dsh-llm')
  const route = { provider: 'codex', model: 'gpt-6-astra' }, usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 100 }
  const time = Date.now()
  const session = f.ctx.sessions.create('session-42345678-1234-4234-8234-123456789abc', { seed: [
    { type: 'turn/start', seq: 0, time, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time, data: { turn: 1, step: 1 } },
    { type: 'request/header', seq: 2, time, data: { reason: 'initial', header: { config: route } } },
    { type: 'assistant/message', seq: 3, time: time + 1, surfaceOp: 'append', data: { turn: 1, step: 1, usage,
      message: createAssistantMessage({ content: [], source: route }), stream: [{ type: 'chunk', time: time + 1, chunk: { type: 'usage', usage } }] } },
  ] })
  const view = f.ctx.sessionProjections.snapshot(session, ['statuslineMetrics']).values.statuslineMetrics
  assert.equal(view.session.amountUsd, 0.0201)
  assert.equal(view.session.amountCny, null)
  assert.equal(view.session.sources['pi-ai'], 1)
  assert.equal(view.session.breakdown.input.amountUsd, 0.01)
  assert.equal(view.session.breakdown.cache.amountUsd, 0.0001)
  assert.equal(view.session.breakdown.output.amountUsd, 0.01)
  assert.equal(view.session.breakdown.input.tokensUsd, 1000)
  assert.equal(view.session.breakdown.cache.tokensUsd, 100)
  assert.equal(view.session.breakdown.output.tokensUsd, 200)
  assert.equal(view.catalog.version, '0.87.1')
  assert.equal(view.billingVerified, false)
  await f.fiber.dispose()
  assert.equal(f.ctx.sessionProjections.snapshot(session, ['statuslineMetrics']).values.statuslineMetrics, undefined)
})

test('native settings round-trip component order and reject unknown widgets without touching accounts', async t => {
  const f = await fixture(); t.after(f.close)
  const value = () => f.ctx.settings.describe().find(s => s.ns === 'statusline-plus').value
  const accounts = JSON.stringify(value().providers)
  assert.equal(value().showTools, true)
  assert.deepEqual(value().componentOrder, ['git', 'context', 'tps', 'cost', 'activity', 'tools'])
  await f.ctx.settings.update('statusline-plus', { componentOrder: ['tools', 'activity', 'tools'], showTools: false })
  assert.deepEqual(value().componentOrder, ['tools', 'activity', 'git', 'context', 'tps', 'cost'])
  assert.equal(value().showTools, false)
  assert.equal(JSON.stringify(value().providers), accounts)
  await assert.rejects(f.ctx.settings.update('statusline-plus', { componentOrder: ['invented-widget'] }))
  assert.equal(value().componentOrder[0], 'tools')
  await f.ctx.settings.update('statusline-plus', { componentOrder: ['tokens', 'context', 'tools', 'tokens'] })
  assert.deepEqual(value().componentOrder, ['context', 'tools', 'git', 'tps', 'cost', 'activity'])
  assert.equal(JSON.stringify(value().providers), accounts)
})

test('native OpenCode source toggle prevents requests while preserving credentials and other sources', async t => {
  const f = await fixture(); t.after(f.close)
  const value = () => f.ctx.settings.describe().find(s => s.ns === 'statusline-plus').value
  const before = value(), previous = global.fetch; t.after(() => { global.fetch = previous })
  let requests = 0
  global.fetch = async () => {
    requests++
    return new Response(JSON.stringify({ usage: { rolling: { percent: 20 } } }))
  }
  await f.ctx.settings.update('statusline-plus', { showOpenCodeQuota: false })
  const route = f.routes.get('/statusline/api/usage')
  assert.equal((await call(route, { force: true })).value.error, 'disabled')
  assert.equal(requests, 0)
  assert.equal(value().apiKeyEnv, before.apiKeyEnv)
  assert.equal(value().showCodexQuota, before.showCodexQuota)
  await f.ctx.settings.update('statusline-plus', { showOpenCodeQuota: true })
  assert.equal((await call(route)).value.ok, true)
  assert.equal(requests, 1)
})

test('Host-only validation serializes stable declarative schemas with volatile field metadata intact', () => {
  const first = JSON.stringify(plugin.Config), second = JSON.stringify(plugin.Config)
  assert.equal(first, second, 'wire schema identity remains stable across descriptions')
  const wire = JSON.parse(first), root = wire.refs[wire.uid]
  for (const field of ['componentOrder', 'providers', 'usageUrl']) {
    assert.equal(wire.refs[root.dict[field]].meta.volatile, true, field + ' remains editable without remount')
  }
  assert.ok(Object.values(wire.refs).every(node => !node.callback), 'no Host closures are transported')
})

test('quota payload readers reject oversized actual Response streams', async () => {
  const response = new Response('x'.repeat(1024 * 1024 + 1))
  await assert.rejects(plugin.__test.readQuotaJson(response), /invalid-response/)
})

test('native settings reject account paths rather than silently choosing another account', async t => {
  const f = await fixture(); t.after(f.close)
  await assert.rejects(f.ctx.settings.update('statusline-plus', { codexAccount: '../other.json' }))
  assert.equal(f.ctx.settings.describe().find(s => s.ns === 'statusline-plus')?.value.codexAccount, '')
})

test('display-only settings keep quota cache while request settings invalidate it', async t => {
  const f = await fixture(); t.after(f.close)
  await f.ctx.settings.update('statusline-plus', { enabled: true, showQuota: true })
  const previous = global.fetch; t.after(() => { global.fetch = previous })
  let requests = 0
  global.fetch = async () => {
    requests++
    return new Response(JSON.stringify({ usage: { rolling: { percent: 20 } } }))
  }
  const route = f.routes.get('/statusline/api/usage')
  assert.equal((await call(route)).value.ok, true)
  assert.equal(requests, 1)
  const config = f.ctx.settings.describe().find(s => s.ns === 'statusline-plus')?.value
  await f.ctx.settings.update('statusline-plus', { showCwd: !config.showCwd })
  assert.equal((await call(route)).value.ok, true)
  assert.equal(requests, 1)
  await f.ctx.settings.update('statusline-plus', { showDeepseekPeak: false, deepseekPeakCountdown: false, showActivity: false, showCost: false })
  assert.equal(f.ctx.settings.describe().find(item => item.ns === 'statusline-plus').value.showDeepseekPeak, false)
  assert.equal((await call(route)).value.ok, true)
  assert.equal(requests, 1)
  await f.ctx.settings.update('statusline-plus', { cacheTtlMs: config.cacheTtlMs === 30000 ? 60000 : 30000 })
  assert.equal((await call(route)).value.ok, true)
  assert.equal(requests, 2)
})

test('native DSH stream events reach SSE live, then real Session settlement replaces estimates', async t => {
  const f = await fixture(); t.after(f.close)
  await f.ctx.settings.update('statusline-plus', { enabled: true, showTps: true })
  const { AssistantStreamAccumulator, createAssistantMessage, assistantStreamFirstTokenTime } = await dsh('dsh-llm')
  const session = f.ctx.sessions.create('session-b2345678-1234-1234-1234-123456789abc', { meta: { cwd: '/tmp' } })
  const publicSessionId = session.id.replace(/^session-/, '')
  const req = new EventEmitter(), res = new EventEmitter(), frames = []
  Object.assign(req, { method: 'GET', url: '/statusline/api/tps?sessionId=' + publicSessionId, headers: { host: 'localhost' } })
  Object.assign(res, { writeHead(status) { this.status = status }, write(text) { frames.push(JSON.parse(text.slice(6))); return true }, end() { this.writableEnded = true } })
  const pending = f.routes.get('/statusline/api/tps')(req, res)
  t.after(async () => { res.emit('close'); await pending })
  assert.equal(res.status, 200)
  const { agentEvents } = await dsh('dsh-agent')
  const dispatcher = agentEvents(f.ctx, { session })
  const emit = frame => dispatcher.emit('agent/assistant-stream', { frame })
  session.append('step/start', { turn: 1, step: 1 })
  emit({ type: 'start', attemptId: 'native-attempt', revision: 1, turn: 1, step: 1 })
  const stream = new AssistantStreamAccumulator(), first = Date.now() - 2000
  for (const [index, time, text] of [[0, first, 'a'.repeat(350)], [1, first + 500, 'b'.repeat(175)]]) {
    const chunk = { type: 'text-delta', index: 0, text }
    stream.push({ time, chunk })
    emit({ type: 'chunk', attemptId: 'native-attempt', revision: index + 2, index, time, chunk })
  }
  assert.equal(frames.at(-1).tokensPerSecond, 100)
  assert.equal(frames.at(-1).phase, 'streaming')
  const settled = session.append('assistant/message', { turn: 1, step: 1,
    message: createAssistantMessage({ content: [{ type: 'text', text: 'fixture' }], source: { provider: 'fixture', model: 'fixture' } }),
    usage: { outputTokens: 40 }, stream: [...stream.snapshot()],
  }, { surfaceOp: 'append' })
  assert.equal(frames.at(-1).estimated, false)
  assert.equal(frames.at(-1).phase, 'completed')
  assert.equal(frames.at(-1).tokensPerSecond, Math.round(40 * 1000 / (settled.time - assistantStreamFirstTokenTime(stream.snapshot())) * 10) / 10)
  await f.ctx.settings.update('statusline-plus', { showTps: false })
  assert.equal(res.writableEnded, true)
  await pending
})

test('TPS SSE flushes a real HTTP response and disconnects cleanly', async t => {
  const { createServer } = require('node:http')
  const f = await fixture(); t.after(f.close)
  await f.ctx.settings.update('statusline-plus', { enabled: true, showTps: true })
  const handler = f.routes.get('/statusline/api/tps')
  const server = createServer((req, res) => { void handler(req, res).catch(() => { res.destroy() }) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const abort = new AbortController(); t.after(() => abort.abort())
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/statusline/api/tps?sessionId=fixture', { signal: abort.signal })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  const reader = response.body.getReader()
  const first = await reader.read()
  assert.equal(JSON.parse(new TextDecoder().decode(first.value).slice(6)).phase, 'idle')
  abort.abort()
})

test('native config forms retain credential and quota endpoint validation', async t => {
  const f = await fixture(); t.after(f.close)
  await assert.rejects(f.ctx.settings.update('statusline-plus', { apiKeyEnv: 'invalid-name' }))
  await assert.rejects(f.ctx.settings.update('statusline-plus', { usageUrl: 'https://example.invalid/usage' }))
  await assert.rejects(f.ctx.settings.update('statusline-plus', { providers: [{}] }))
})

test('native provider defaults upgrade old profiles and DeepSeek returns only normalized balances', async t => {
  const f = await fixture(); t.after(f.close)
  await f.ctx.settings.update('statusline-plus', { providers: [{ id: 'openrouter', enabled: false }, { id: 'deepseek', redBelow: 5 }] })
  const snapshot = f.ctx.settings.describe().find(item => item.ns === 'statusline-plus').value
  const deepseek = snapshot.providers.find(provider => provider.id === 'deepseek')
  assert.equal(deepseek.apiKeyEnv, 'DEEPSEEK_API_KEY')
  assert.deepEqual(deepseek.match.providerExact, ['deepseek-official', 'deepseek'])
  assert.ok(snapshot.providers.find(provider => provider.id === 'kimi-code'))
  assert.equal(snapshot.providers.find(provider => provider.id === 'openrouter').enabled, false)
  const previous = global.fetch; t.after(() => { global.fetch = previous })
  let requests = 0
  global.fetch = async (url, options) => {
    requests++
    assert.equal(url, 'https://api.deepseek.com/user/balance')
    assert.equal(options.headers.authorization, 'Bearer fixture-key-not-real')
    assert.equal(options.redirect, 'manual')
    return new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '2.34', topped_up_balance: '10' }], secret: 'never-return-upstream-extras' }))
  }
  const route = f.routes.get('/statusline/api/provider-quota')
  const reply = (await call(route, { id: 'deepseek' })).value
  assert.equal(reply.ok, true)
  assert.equal(reply.data.currency, 'CNY')
  assert.equal(reply.data.remaining, 12.34)
  assert.equal(reply.data.redBelow, 5)
  assert.equal(reply.data.balances[0].granted, 2.34)
  assert.equal(reply.data.used, undefined)
  assert.equal(reply.data.limit, undefined)
  assert.ok(!JSON.stringify(reply).includes('fixture-key-not-real'))
  assert.ok(!JSON.stringify(reply).includes('never-return-upstream-extras'))
  assert.equal((await call(route, { id: 'deepseek' })).value.ok, true)
  assert.equal(requests, 1)
  assert.equal((await call(route, { id: 'deepseek', force: true })).value.ok, true)
  assert.equal(requests, 2)
  await f.ctx.settings.update('statusline-plus', { providers: [{ id: 'deepseek', enabled: false }] })
  assert.equal((await call(route, { id: 'deepseek' })).value.error, 'not-found')
  assert.equal(requests, 2)
})

test('native Coding Plan routes use provider auth and reject business failures and missing quota', async t => {
  const f = await fixture(); t.after(f.close)
  const previous = global.fetch; t.after(() => { global.fetch = previous })
  let response = { usages: { limit_5h: { used_ratio: 0.25 }, limit_7d: { used_ratio: 0.8 } } }
  global.fetch = async (url, options) => {
    const kimi = url.includes('kimi.com')
    assert.equal(options.headers.authorization, kimi ? 'Bearer fixture-key-not-real' : 'fixture-key-not-real')
    assert.equal(options.redirect, 'manual')
    return new Response(JSON.stringify(response))
  }
  const route = f.routes.get('/statusline/api/provider-quota')
  const kimi = (await call(route, { id: 'kimi-code' })).value
  assert.equal(kimi.data.windows[0].usedPercent, 25)
  response = { code: 200, success: true, data: { limits: [{ type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 42 }] } }
  assert.equal((await call(route, { id: 'zai' })).value.data.windows[0].usedPercent, 42)
  assert.equal((await call(route, { id: 'zhipu' })).value.data.windows[0].label, '5h')
  response = { code: 401, success: false, msg: 'private-upstream-error' }
  assert.deepEqual((await call(route, { id: 'zai', force: true })).value, { ok: false, error: 'auth' })
  response = { usages: { limit_5h: { reset_time: '2026-10-02T00:00:00Z' } } }
  assert.equal((await call(route, { id: 'kimi-code', force: true })).value.error, 'invalid-response')
  await assert.rejects(f.ctx.settings.update('statusline-plus', { providers: [{ id: 'deepseek', apiKeyEnv: 'sk-literal-secret' }] }))
})

test('native settings JSON is accepted by the installed browser schema validator', async t => {
  const f = await fixture(); t.after(f.close)
  const fs = require('node:fs'), vm = require('node:vm')
  const clientPath = fromDsh.resolve('@deepseek-ai/dsh-client-ui-settings/client')
  // Expose the real bundled validator only inside an isolated test VM.
  const source = fs.readFileSync(clientPath, 'utf8').replace('exports.apply = apply;', 'exports.auditSchema = Schema; exports.apply = apply;')
  let entry
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load(value) { entry = value } } } })
  const browser = entry.factory(name => name === '@deepseek-ai/cordis' ? { Service: class {} } : {})
  const view = JSON.parse(JSON.stringify(f.ctx.settings.describe().find(item => item.ns === 'statusline-plus')))
  const schema = new browser.auditSchema(view.schema)
  assert.doesNotThrow(() => schema(view.value))
  assert.equal(schema(view.value).enabled, true)
  assert.equal(JSON.stringify(view.schema).includes('"transform"'), false)
  const revision = view.revision
  await assert.rejects(f.ctx.settings.update('statusline-plus', { providers: [{ id: 'bad', apiKeyEnv: 'TEST_KEY', endpoints: [{ url: 'http://localhost/', parse: { remainingPath: 'x' } }] }] }))
  const unchanged = f.ctx.settings.describe().find(item => item.ns === 'statusline-plus')
  assert.equal(unchanged.revision, revision)
  assert.deepEqual(unchanged.value.providers, view.value.providers)
})
