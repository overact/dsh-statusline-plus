'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const { createSessionMetricsProjection, quoteUsage, tariffAt, possibleTariffs, COVERAGE_START, PRICING_AS_OF, MONEY_UNITS } = require('../lib/session-metrics')
const { createPricingCatalog } = require('../lib/model-pricing')
const { PeakScheduleSource } = require('../lib/peak-schedule')

const beijing = value => Date.parse(value + '+08:00')
const PEAK = beijing('2026-10-08T10:00:00')
const OFF_PEAK = beijing('2026-10-08T19:00:00')
const route = { provider: 'deepseek', model: 'deepseek-flash' }
const usage = { inputTokens: 1000000, outputTokens: 1000000, cacheReadTokens: 1000000 }
const quote = (patch = {}) => quoteUsage({ route, usage, startedAt: PEAK, observedAt: PEAK + 1000, ...patch })
const cny = result => [result.minUnits / MONEY_UNITS, result.maxUnits / MONEY_UNITS]

function fold(inheritedEventCount = 0, catalog, schedule) {
  const definition = createSessionMetricsProjection(catalog, schedule)
  let state = definition.init({}, inheritedEventCount), seq = 0
  return {
    definition,
    get state() { return state },
    get view() { return definition.wire.view(state) },
    event(type, data = {}, time = PEAK, extra = {}) {
      state = definition.apply(state, { type, data, time, seq: seq++, ...extra })
      definition.stateSchema.parse(state); definition.wire.viewSchema.parse(definition.wire.view(state))
      return state
    },
    request(turn = 1, step = 1, selection = route, time = PEAK) {
      this.event('turn/start', { turn }, time)
      this.event('step/start', { turn, step }, time)
      this.event('request/header', { header: { config: selection } }, time)
    },
    message(turn = 1, step = 1, sample, selection = route, time = PEAK + 1000) {
      if (arguments.length < 3) sample = usage
      return this.event('assistant/message', { turn, step, usage: sample,
        message: { source: selection }, stream: [{ type: 'chunk', time, chunk: { type: 'usage', usage: sample } }] }, time)
    },
  }
}

test('native price quotes settle subscription usage, replace corrections and keep currencies separate', () => {
  const cost = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }
  const catalog = createPricingCatalog([{ provider: 'openai', model: 'gpt-6-sol', cost }], { version: 'fixture', generatedAt: PEAK })
  const f = fold(0, catalog), codex = { provider: 'codex', model: 'gpt-6-sol' }
  f.request(1, 1, codex); f.message(1, 1, usage, codex)
  assert.equal(f.view.currency, 'USD'); assert.equal(f.view.session.amountUsd, 12.2)
  assert.equal(f.view.session.amountCny, null); assert.equal(f.view.session.sources['pi-ai'], 1)
  assert.equal(f.view.session.breakdown.input.amountUsd, 2)
  assert.equal(f.view.session.breakdown.cache.amountUsd, 0.2)
  assert.equal(f.view.session.breakdown.output.amountUsd, 10)
  assert.equal(f.view.session.breakdown.input.tokensUsd, 1000000)
  assert.equal(f.view.session.breakdown.cache.tokensUsd, 1000000)
  assert.equal(f.view.session.breakdown.output.tokensUsd, 1000000)
  assert.equal(f.view.session.breakdown.input.tokensCny, null)
  f.message(1, 1, { inputTokens: 1000000, outputTokens: 0 }, codex)
  assert.equal(f.view.session.amountUsd, 2); assert.equal(f.view.session.pricedMessages, 1)
  assert.equal(f.view.session.breakdown.cache.amountUsd, 0)
  assert.equal(f.view.session.breakdown.output.amountUsd, 0)
  assert.equal(f.view.session.breakdown.cache.tokensUsd, 0)
  assert.equal(f.view.session.breakdown.output.tokensUsd, 0)
  f.event('step/end', { turn: 1, step: 1 }); f.event('step/start', { turn: 1, step: 2 }); f.message(1, 2)
  assert.equal(f.view.currency, 'mixed'); assert.equal(f.view.session.amountCny, 10.04)
  assert.equal(f.view.session.amountUsd, 2); assert.equal(f.view.session.pricedMessages, 2)
  assert.equal(f.view.session.breakdown.input.amountCny, 2)
  assert.equal(f.view.session.breakdown.cache.amountCny, 0.04)
  assert.equal(f.view.session.breakdown.output.amountCny, 8)
  assert.equal(f.view.session.breakdown.input.tokensCny, 1000000)
  assert.equal(f.view.session.breakdown.input.tokensUsd, 1000000)
  f.event('llm/retry-started', { turn: 1, step: 2 }); f.message(1, 2, usage, codex)
  assert.equal(f.view.session.amountUsd, 14.2); assert.equal(f.view.session.pricedMessages, 3)
  assert.equal(f.view.session.breakdown.input.amountUsd, 4)
  assert.equal(f.view.session.breakdown.cache.amountUsd, 0.2)
  assert.equal(f.view.session.breakdown.output.amountUsd, 10)
  assert.equal(f.view.session.breakdown.input.tokensUsd, 2000000)
  assert.equal(f.view.session.breakdown.cache.tokensUsd, 1000000)
  const next = createPricingCatalog([{ provider: 'openai', model: 'gpt-6-sol', cost: { ...cost, input: 3 } }], { version: 'fixture', generatedAt: PEAK })
  assert.notEqual(createSessionMetricsProjection(catalog).stateVersion, createSessionMetricsProjection(next).stateVersion)
})

test('token breakdown combines cache reads and writes, excludes unknown prices and replaces repeated settlement', () => {
  const catalog = createPricingCatalog([{ provider: 'openai', model: 'gpt-6-sol', cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } }])
  const f = fold(0, catalog), selection = { provider: 'codex', model: 'gpt-6-sol' }
  const sample = { inputTokens: 12000, cacheReadTokens: 1000000, cacheWriteTokens: 700, outputTokens: 90, reasoningTokens: 80 }
  f.request(1, 1, selection); f.message(1, 1, sample, selection)
  assert.equal(f.view.session.breakdown.cache.tokensUsd, 1000700)
  assert.equal(f.view.session.breakdown.output.tokensUsd, 90, 'reasoning is already included in provider output')
  const previous = f.state
  f.message(1, 1, sample, selection)
  assert.equal(f.state, previous, 'a repeated settlement does not accrue tokens twice')
  f.message(1, 1, { ...sample, cacheReadTokens: 2000000 }, selection)
  assert.equal(f.view.session.breakdown.cache.tokensUsd, 2000700)
  f.event('step/end', { turn: 1, step: 1 }); f.event('step/start', { turn: 1, step: 2 })
  f.message(1, 2, sample, { provider: 'unknown', model: 'unknown' })
  assert.equal(f.view.session.unpricedMessages, 1)
  assert.equal(f.view.session.breakdown.input.tokensUsd, 12000, 'counts correspond to the priced subtotal')
})

test('token accumulation overflow preserves the prior subtotal even when a component rate is zero', () => {
  const catalog = createPricingCatalog([{ provider: 'openai', model: 'gpt-6-sol', cost: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 } }])
  const f = fold(0, catalog), selection = { provider: 'codex', model: 'gpt-6-sol' }
  f.request(1, 1, selection); f.message(1, 1, { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 }, selection)
  f.event('step/end', { turn: 1, step: 1 }); f.event('step/start', { turn: 1, step: 2 })
  f.message(1, 2, { inputTokens: 1, outputTokens: 0 }, selection)
  assert.equal(f.view.session.breakdown.input.tokensUsd, Number.MAX_SAFE_INTEGER)
  assert.equal(f.view.session.pricedMessages, 1)
  assert.equal(f.view.session.reasons['usage-overflow'], 1)
})

test('Go V4.1 Flash uses the same vendor reference and request-time peak discount as direct API', () => {
  const go = { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }
  const catalog = createPricingCatalog([
    { ...go, cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 } },
    { provider: 'deepseek', model: 'deepseek-flash', cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 } },
  ])
  for (const [time, amount] of [[PEAK, 1.506], [OFF_PEAK, 0.753]]) {
    const f = fold(0, catalog)
    f.request(1, 1, go, time); f.message(1, 1, usage, go, time + 1000)
    assert.equal(f.view.session.amountUsd, amount)
    assert.equal(f.view.session.pricedMessages, 1)
    assert.equal(f.view.session.unpricedMessages, 0)
    assert.deepEqual(f.view.session.reasons, {})
  }
})

test('verified DeepSeek Flash/Pro prices apply to disjoint input, cache reads and output buckets', () => {
  assert.deepEqual(cny(quote()), [10.04, 10.04])
  assert.deepEqual(cny(quote({ startedAt: OFF_PEAK, observedAt: OFF_PEAK + 1000 })), [5.02, 5.02])
  assert.deepEqual(cny(quote({ route: { ...route, model: 'deepseek-v4-pro' } })), [36.3, 36.3])
  assert.deepEqual(cny(quote({ route: { ...route, model: 'deepseek-v4-pro' }, startedAt: OFF_PEAK, observedAt: OFF_PEAK + 1000 })), [18.15, 18.15])
  assert.deepEqual(cny(quote({ route: { ...route, model: 'deepseek-v4.1-flash' } })), [10.04, 10.04])
  assert.equal(quote({ usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, reasoningTokens: 20 } }).maxUnits, 10 * 200 + 20 * 800 + 30 * 4)
})

test('official fallback reference is channel-independent and unknown model versions stay unpriced', () => {
  for (const provider of ['openrouter', 'opencode', 'opencode-go', 'deepseek-custom', 'reseller-deepseek']) assert.deepEqual(cny(quote({ route: { ...route, provider } })), [10.04, 10.04])
  for (const model of ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v3', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'gpt-5', '__proto__', 'constructor']) assert.equal(quote({ route: { ...route, model } }).reason, 'unsupported-model')
  assert.equal(quote({ route: { ...route, provider: 'DEEPSEEK-OFFICIAL' } }).reason, null)
})

test('pricing reuses the peak indicator cache offline and schedule snapshots invalidate checkpoints', () => {
  let fetches = 0
  const source = new PeakScheduleSource({ fetch() { fetches++; throw new Error('no pricing fetch') } })
  const time = beijing('2027-02-10T10:00:00')
  source.data.holidays[2027] = { year: 2027, published: true, off: ['2027-02-10'], work: [], names: {} }
  const snapshot = source.pricingSnapshot(), f = fold(0, undefined, snapshot)
  assert.deepEqual(Object.keys(snapshot.holidays[2027]).sort(), ['off', 'published'], 'pricing retains no holiday names or make-up metadata')
  f.request(1, 1, route, time); f.message(1, 1, usage, route, time + 1)
  assert.equal(f.view.session.amountCny, 5.02)
  const originalVersion = f.definition.stateVersion
  source.data.holidays[2027].off = []
  const updated = source.pricingSnapshot()
  assert.notEqual(createSessionMetricsProjection(undefined, updated).stateVersion, originalVersion)
  assert.equal(tariffAt(time, snapshot), 'offPeak', 'original snapshot stays stable')
  assert.equal(tariffAt(time, updated), 'peak')
  assert.equal(quote({ schedule: { ...snapshot, rule: { status: 'changed' } } }).reason, 'tariff-window-unknown')
  assert.equal(fetches, 0)
})

test('missing, malformed or inconsistent usage is unknown and cache writes have no fabricated rate', () => {
  for (const sample of [undefined, null, {}, { inputTokens: null, outputTokens: 0 }, { inputTokens: 1 },
    { inputTokens: -1, outputTokens: 0 }, { inputTokens: 1.5, outputTokens: 0 }, { inputTokens: 1, outputTokens: NaN },
    { inputTokens: 1, outputTokens: 0, cacheReadTokens: null }, { inputTokens: 1, outputTokens: 0, cacheWriteTokens: '0' }]) {
    const result = quote({ usage: sample })
    assert.equal(result.reason, 'missing-or-invalid-usage'); assert.equal(result.minUnits, null)
  }
  assert.equal(quote({ usage: { ...usage, totalTokens: 123 } }).reason, 'inconsistent-usage')
  assert.equal(quote({ usage: { ...usage, cacheWriteTokens: 10 } }).reason, 'cache-write-rate-unknown')
  assert.equal(quote({ usage: { inputTokens: 0, outputTokens: Number.MAX_SAFE_INTEGER } }).reason, 'usage-overflow')
})

test('price verification cut prevents current rates from being applied to earlier history', () => {
  assert.equal(quote({ startedAt: COVERAGE_START - 1, observedAt: COVERAGE_START }).reason, 'historical-price-unknown')
  assert.equal(quote({ startedAt: COVERAGE_START, observedAt: COVERAGE_START + 1 }).reason, null)
  for (const startedAt of [undefined, null, NaN, Infinity]) assert.equal(quote({ startedAt }).reason, 'request-time-unknown')
  assert.equal(quote({ observedAt: PEAK - 1 }).reason, 'tariff-window-unknown')
})

test('request-start uncertainty across tariff boundaries produces a bounded range', () => {
  const start = beijing('2026-10-08T11:59:59'), end = beijing('2026-10-08T12:00:01')
  assert.deepEqual(cny(quote({ startedAt: start, observedAt: end })), [5.02, 10.04])
  assert.equal(tariffAt(start), 'peak'); assert.equal(tariffAt(end), 'offPeak')
  assert.deepEqual(new Set(possibleTariffs(OFF_PEAK, beijing('2026-10-09T19:00:00'))), new Set(['offPeak', 'peak']))
  assert.equal(quote({ observedAt: PEAK + 8 * 86400000 }).reason, 'tariff-window-unknown')
  assert.equal(quote({ startedAt: beijing('2027-01-04T10:00:00'), observedAt: beijing('2027-01-04T10:00:01') }).reason, 'tariff-window-unknown')
  const f = fold(); f.request(1, 1, route, start); f.message(1, 1, usage, route, end)
  assert.equal(f.view.session.amountCny, null)
  assert.equal(f.view.session.minCny, 5.02); assert.equal(f.view.session.maxCny, 10.04)
  assert.deepEqual([f.view.session.breakdown.input.minCny, f.view.session.breakdown.input.maxCny], [1, 2])
  assert.deepEqual([f.view.session.breakdown.cache.minCny, f.view.session.breakdown.cache.maxCny], [0.02, 0.04])
  assert.deepEqual([f.view.session.breakdown.output.minCny, f.view.session.breakdown.output.maxCny], [4, 8])
  assert.equal(f.view.session.breakdown.input.tokensCny, 1000000, 'tariff uncertainty does not make token counts uncertain')
})

test('published holiday ranges and weekends suppress peak pricing independently of host timezone', () => {
  const original = process.env.TZ
  try {
    for (const timezone of ['UTC', 'Australia/Sydney', 'America/New_York']) {
      process.env.TZ = timezone
      for (const time of ['2026-10-02T10:00:00', '2026-10-07T15:00:00', '2026-10-10T15:00:00']) assert.equal(tariffAt(beijing(time)), 'offPeak')
      assert.equal(tariffAt(PEAK), 'peak')
    }
  } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original }
})

test('current user turn aggregates multiple steps and resets only on a new turn', () => {
  const f = fold(); f.request(); f.message()
  f.event('step/end', { turn: 1, step: 1 }); f.event('step/start', { turn: 1, step: 2 }); f.message(1, 2)
  assert.equal(f.state.current.maxUnits / MONEY_UNITS, 20.08); assert.equal(f.view.session.amountCny, 20.08)
  assert.equal(f.state.current.pricedMessages, 2)
  f.event('step/end', { turn: 1, step: 2 }); f.event('turn/end', { turn: 1 })
  assert.equal(f.state.current.maxUnits / MONEY_UNITS, 20.08)
  f.event('turn/start', { turn: 2 })
  assert.equal(f.state.turn, 2); assert.equal(f.state.current.pricedMessages, 0)
  assert.equal(f.view.currentTurn, undefined, 'unused per-turn amounts are not sent to browsers')
  assert.equal(f.view.session.amountCny, 20.08)
  f.event('step/start', { turn: 2, step: 1 }, OFF_PEAK); f.message(2, 1, usage, route, OFF_PEAK + 1000)
  assert.equal(f.state.current.maxUnits / MONEY_UNITS, 5.02); assert.equal(f.view.session.amountCny, 25.1)
})

test('model changes bind per request and pending next selection cannot reprice earlier requests', () => {
  const f = fold(); f.request()
  const unchanged = f.state, oldView = f.view
  f.event('model/selection', { provider: 'deepseek', model: 'deepseek-v4-pro' })
  assert.equal(f.state, unchanged); assert.equal(f.view, oldView)
  f.message(); f.event('step/end', { turn: 1, step: 1 })
  f.event('step/start', { turn: 1, step: 2 }); f.event('request/header', { header: { config: { ...route, model: 'deepseek-v4-pro' } } })
  f.message(1, 2, usage, { ...route, model: 'deepseek-v4-pro' })
  assert.equal(f.view.session.amountCny, 46.34)
  const reseller = fold(); reseller.request(); reseller.message(1, 1, usage, { provider: 'openrouter', model: 'deepseek-flash' })
  assert.equal(reseller.view.session.amountCny, 10.04); assert.equal(reseller.view.session.unpricedMessages, 0)
})

test('same-attempt settlement corrections replace accounting while explicit retries add independent calls', () => {
  const f = fold(); f.request(); const first = f.message()
  assert.equal(f.message(), first)
  f.message(1, 1, { inputTokens: 1000000, outputTokens: 0 })
  assert.equal(f.view.session.amountCny, 2); assert.equal(f.view.session.pricedMessages, 1)
  f.event('llm/retry-started', { turn: 1, step: 1 }, OFF_PEAK)
  f.event('assistant/attempt', { turn: 1, step: 1, stream: [
    { type: 'chunk', time: OFF_PEAK + 1, chunk: { type: 'usage', usage: { inputTokens: 1000000, outputTokens: 0 } } },
  ] }, OFF_PEAK + 2)
  assert.equal(f.view.session.amountCny, 3); assert.equal(f.view.session.pricedMessages, 2)
})

test('missing usage and missing settlements remain separately counted, including cancelled steps', () => {
  const f = fold(); f.request(); f.message(1, 1, undefined)
  assert.equal(f.view.session.amountCny, null); assert.equal(f.view.session.unpricedMessages, 1)
  f.event('step/end', { turn: 1, step: 1 })
  f.event('step/start', { turn: 1, step: 2 }); f.event('step/end', { turn: 1, step: 2 })
  assert.equal(f.view.session.unpricedMessages, 2)
  assert.equal(f.view.session.reasons['missing-settlement'], 1)
  assert.equal(f.view.pendingRequest, false)
  f.event('step/start', { turn: 1, step: 3 }); f.message(1, 3)
  assert.equal(f.view.session.amountCny, 10.04); assert.equal(f.view.session.unpricedMessages, 2)
})

test('zero costs require explicit complete zero usage and no unpriced messages', () => {
  const f = fold(); assert.equal(f.view.session.amountCny, null)
  f.request(); assert.equal(f.view.pendingRequest, true); assert.equal(f.view.session.amountCny, null)
  f.message(1, 1, { inputTokens: 0, outputTokens: 0 })
  assert.equal(f.view.session.amountCny, 0); assert.equal(f.view.pendingRequest, false)
  f.event('step/end', { turn: 1, step: 1 }); f.event('step/start', { turn: 1, step: 2 }); f.message(1, 2, undefined)
  assert.equal(f.view.session.amountCny, null); assert.equal(f.view.session.unpricedMessages, 1)
})

test('fold extracts usage and source metadata without reading or retaining any message content', () => {
  const f = fold(); f.request()
  const message = { source: route }
  Object.defineProperty(message, 'content', { get() { throw new Error('content must remain private') } })
  const packed = { type: 'text-chunks', time0: PEAK + 1000 }
  Object.defineProperty(packed, 'texts', { get() { throw new Error('generated text must remain private') } })
  const raw = { type: 'text-delta' }
  Object.defineProperty(raw, 'text', { get() { throw new Error('generated text must remain private') } })
  f.event('assistant/message', { turn: 1, step: 1, message, stream: [packed,
    { type: 'chunk', time: PEAK + 1001, chunk: raw },
    { type: 'chunk', time: PEAK + 1002, chunk: { type: 'usage', usage } },
  ] }, PEAK + 2000)
  assert.equal(f.view.session.amountCny, 10.04)
  assert.doesNotMatch(JSON.stringify(f.state), /content|texts|text-delta|stream|message/)
})

test('fork-inherited events are excluded and checkpoint continuation preserves only own-session totals', () => {
  const f = fold(4)
  f.event('turn/start', { turn: 1 }); f.event('step/start', { turn: 1, step: 1 })
  f.event('request/header', { header: { config: route } }); f.message()
  assert.equal(f.view.session.pricedMessages, 0); assert.equal(f.view.session.amountCny, null)
  f.request(2); f.message(2)
  assert.equal(f.view.session.amountCny, 10.04)
  assert.equal(f.view.scope, 'session-only'); assert.equal(f.view.includesSubagents, false); assert.equal(f.view.excludesInherited, true)
  assert.equal(f.view.session.breakdown.input.tokensCny, 1000000, 'counts exclude inherited fork events')
  assert.equal(f.view.pricingAsOf, PRICING_AS_OF)
  assert.equal(f.view.billingVerified, false)
  assert.equal(f.view.pricingBasis, 'official-rate-card-reference')
  const restored = f.definition.stateSchema.parse(JSON.parse(JSON.stringify(f.state)))
  const continued = f.definition.apply(restored, { type: 'turn/start', data: { turn: 3 }, time: PEAK, seq: 20 })
  assert.equal(continued.current.pricedMessages, 0); assert.equal(continued.view.session.amountCny, 10.04)
})

test('session money overflow becomes an unpriced request and preserves previously counted subtotal', () => {
  const f = fold(), huge = { inputTokens: Math.floor(Number.MAX_SAFE_INTEGER / 400), outputTokens: 0 }
  f.request(); f.message(1, 1, huge); f.event('step/end', { turn: 1, step: 1 })
  f.event('step/start', { turn: 1, step: 2 }); f.message(1, 2, huge); f.event('step/end', { turn: 1, step: 2 })
  const subtotal = f.view.session.amountCny
  f.event('step/start', { turn: 1, step: 3 }); f.message(1, 3, huge)
  assert.equal(f.view.session.pricedMessages, 2); assert.equal(f.view.session.unpricedMessages, 1)
  assert.equal(f.view.session.reasons['cost-overflow'], 1)
  assert.equal(f.view.session.amountCny, subtotal)
})

test('native DSH 0.2.0 projection registry registers, replays and publishes the runtime-defined wire key', async t => {
  const fromDsh = createRequire(process.env.DSH_PACKAGE_DIR ? join(process.env.DSH_PACKAGE_DIR, 'package.json') : require.resolve('@deepseek-ai/dsh/package.json'))
  const dsh = name => import(pathToFileURL(fromDsh.resolve('@deepseek-ai/' + name)).href)
  const [{ Context }, { SessionStore }, { SessionProjectionRegistry }] = await Promise.all([dsh('cordis'), dsh('dsh-session'), dsh('dsh-session-projection')])
  const { createAssistantMessage } = await dsh('dsh-llm')
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  new SessionStore(ctx); new SessionProjectionRegistry(ctx)
  const definition = createSessionMetricsProjection(), changes = []
  const fiber = ctx.plugin({ name: 'metrics-fixture', inject: ['sessionProjections'], apply(scope) {
    scope.sessionProjections.register(definition)
    scope.sessionProjections.onChanged((session, key, value, seq) => changes.push({ session, key, value, seq }))
  } })
  await fiber.await()
  const seed = [
    { type: 'turn/start', data: { turn: 1 }, seq: 0, time: PEAK },
    { type: 'step/start', data: { turn: 1, step: 1 }, seq: 1, time: PEAK },
    { type: 'request/header', data: { header: { config: route }, reason: 'initial' }, seq: 2, time: PEAK },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: createAssistantMessage({ content: [], source: route }), usage,
      stream: [{ type: 'chunk', time: PEAK + 1, chunk: { type: 'usage', usage } }] }, seq: 3, time: PEAK + 1, surfaceOp: 'append' },
  ]
  const session = ctx.sessions.create('session-f2345678-1234-4234-8234-123456789abc', { seed })
  const snapshot = ctx.sessionProjections.snapshot(session, ['statuslineMetrics'])
  assert.equal(snapshot.values.statuslineMetrics.session.amountCny, 10.04)
  session.append('turn/start', { turn: 2 })
  const wire = ctx.sessionProjections.snapshot(session, ['statuslineMetrics']).values.statuslineMetrics
  assert.equal(wire.currentTurn, undefined)
  assert.equal(ctx.sessionProjections.stateOf(session, 'statuslineMetrics').turn, 2)
  assert.ok(changes.some(change => change.key === 'statuslineMetrics'))
  const checkpoint = ctx.sessionProjections.checkpoint(session)
  assert.equal(ctx.sessionProjections.viewCheckpoint(checkpoint).statuslineMetrics.session.amountCny, 10.04)
  await fiber.dispose()
  assert.equal(ctx.sessionProjections.snapshot(session, ['statuslineMetrics']).values.statuslineMetrics, undefined)
})
