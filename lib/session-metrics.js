'use strict'

import { z } from 'zod'
import { quoteCatalogUsage } from './model-pricing.js'
import { peakTariffAt, peakPricingSnapshot } from './peak-schedule.js'
import { createHash } from 'node:crypto'

// This is a verified rate-card snapshot, not a claimed historical effective date.
// Requests before the verification cut remain unpriced. Updating the card or
// fold semantics requires a stateVersion bump so native checkpoints refold.
const PRICING_AS_OF = '2026-10-02T04:24:12Z'
const COVERAGE_START = Date.parse(PRICING_AS_OF)
const PRICING_SOURCE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'
const MONEY_UNITS = 100000000
// Model identity selects a vendor reference card, independent of subscription
// or gateway billing. Configurable endpoints are never treated as invoices.
// Integer 1e-8 CNY per token: no floating-point money accumulates in the fold.
const RATES = {
  'deepseek-flash': { peak: { read: 4, input: 200, output: 800 }, offPeak: { read: 2, input: 100, output: 400 } },
  'deepseek-v4-pro': { peak: { read: 30, input: 900, output: 2700 }, offPeak: { read: 15, input: 450, output: 1350 } },
}
const FLASH_ALIASES = new Set(['deepseek-flash', 'deepseek-v4.1-flash'])
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const timestamp = z.number().finite().nonnegative()
const routeSchema = z.object({ provider: z.string(), model: z.string() }).strict()
const COMPONENTS = ['input', 'cache', 'output']
const unitRangeSchema = z.object({ minUnits: count, maxUnits: count }).strict()
const unitTotalsSchema = unitRangeSchema.extend({ minUsdUnits: count, maxUsdUnits: count }).strict()
const partTotalsSchema = unitTotalsSchema.extend({ tokensCny: count, tokensUsd: count }).strict()
const breakdownSchema = schema => z.object(Object.fromEntries(COMPONENTS.map(key => [key, schema]))).strict()
const aggregateSchema = z.object({
  minUnits: count, maxUnits: count, pricedMessages: count, unpricedMessages: count,
  minUsdUnits: count, maxUsdUnits: count, usdMessages: count, sources: z.record(z.string(), count),
  reasons: z.record(z.string(), count),
  breakdown: breakdownSchema(partTotalsSchema),
}).strict()
const quoteSchema = z.object({
  minUnits: count.nullable(), maxUnits: count.nullable(), reason: z.string().nullable(),
  currency: z.literal('USD').optional(), source: z.enum(['pi-ai', 'fallback']).optional(),
  breakdown: breakdownSchema(unitRangeSchema.extend({ tokens: count }).strict()).optional(),
}).strict()
const moneyViewSchema = z.object({
  amountCny: z.number().finite().nonnegative().nullable(),
  minCny: z.number().finite().nonnegative().nullable(),
  maxCny: z.number().finite().nonnegative().nullable(),
  amountUsd: z.number().finite().nonnegative().nullable(),
  minUsd: z.number().finite().nonnegative().nullable(), maxUsd: z.number().finite().nonnegative().nullable(),
}).strict()
const totalViewSchema = moneyViewSchema.extend({
  sources: z.record(z.string(), count),
  pricedMessages: count, unpricedMessages: count, reasons: z.record(z.string(), count),
  breakdown: breakdownSchema(moneyViewSchema.extend({ tokensCny: count.nullable(), tokensUsd: count.nullable() }).strict()),
}).strict()
const viewSchema = z.object({
  currency: z.enum(['CNY', 'USD', 'mixed']), pricingAsOf: z.literal(PRICING_AS_OF),
  catalog: z.object({ version: z.string().nullable(), generatedAt: timestamp.nullable(), fallbackAsOf: z.string() }).strict().nullable(),
  coverageStartsAt: z.literal(PRICING_AS_OF), pricingSource: z.literal(PRICING_SOURCE),
  billingVerified: z.literal(false), pricingBasis: z.literal('official-rate-card-reference'),
  scope: z.literal('session-only'), includesSubagents: z.literal(false), excludesInherited: z.literal(true),
  session: totalViewSchema,
  pendingRequest: z.boolean(),
}).strict()
const stateSchema = z.object({
  inheritedEventCount: count, route: routeSchema.nullable(),
  request: z.object({ turn: count, step: count, startedAt: timestamp.nullable(), settled: z.boolean(), route: routeSchema.nullable() }).strict().nullable(),
  last: z.object({ turn: count, step: count, quote: quoteSchema }).strict().nullable(),
  turn: count.nullable(), current: aggregateSchema, session: aggregateSchema, view: viewSchema,
}).strict()

const finiteTime = n => typeof n === 'number' && Number.isFinite(n) && n >= 0
const validCount = n => Number.isSafeInteger(n) && n >= 0
const emptyAggregate = () => ({ minUnits: 0, maxUnits: 0, minUsdUnits: 0, maxUsdUnits: 0, usdMessages: 0, sources: {}, pricedMessages: 0, unpricedMessages: 0, reasons: {},
  breakdown: Object.fromEntries(COMPONENTS.map(key => [key, { minUnits: 0, maxUnits: 0, minUsdUnits: 0, maxUsdUnits: 0, tokensCny: 0, tokensUsd: 0 }])) })
const unknown = reason => ({ minUnits: null, maxUnits: null, reason })

function routeOf(value) {
  if (!value || typeof value.provider !== 'string' || !value.provider || typeof value.model !== 'string' || !value.model) return null
  return { provider: value.provider, model: value.model }
}

const tariffAt = peakTariffAt

// step/start (or retry-started) precedes network dispatch. The first compact
// stream record is an upper bound, without inspecting any generated content.
// Quote every possible tariff in this interval, including internal transitions.
function possibleTariffs(start, end, schedule) {
  if (!finiteTime(start) || !finiteTime(end) || end < start || end - start > 7 * 86400000) return null
  const values = new Set([tariffAt(start, schedule), tariffAt(end, schedule)])
  const firstDay = Math.floor((start + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000
  for (let day = firstDay; day <= end; day += 86400000) {
    for (const hour of [0, ...(schedule?.windows || [[9, 12], [14, 18]]).flat()]) {
      const boundary = day + hour * 3600000
      if (boundary > start && boundary <= end) { values.add(tariffAt(boundary, schedule)); values.add(tariffAt(boundary - 1, schedule)) }
    }
  }
  return values.has(null) ? null : [...values]
}

function usageOf(event) {
  if (event.type === 'assistant/message' && event.data?.usage !== undefined) return event.data.usage
  const stream = event.data?.stream
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index--) {
    const record = stream[index]
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage
  }
  return undefined
}

function streamUpperBound(event) {
  const stream = event.data?.stream
  if (Array.isArray(stream)) {
    for (const record of stream) {
      const time = record?.type === 'chunk' ? record.time : record?.time0
      if (finiteTime(time)) return time
    }
  }
  return finiteTime(event.time) ? event.time : null
}

function quoteUsage({ route, usage, startedAt, observedAt, catalog, schedule }) {
  const card = catalog?.resolve(route)
  if (!route) return unknown('unsupported-model')
  const model = String(route.model).toLowerCase().replace(/^deepseek\//, '')
  const priceModel = FLASH_ALIASES.has(model) ? 'deepseek-flash' : model
  const rates = Object.hasOwn(RATES, priceModel) ? RATES[priceModel] : null
  if (!card && !rates) return unknown('unsupported-model')
  if (!usage || !validCount(usage.inputTokens) || !validCount(usage.outputTokens) ||
      usage.cacheReadTokens !== undefined && !validCount(usage.cacheReadTokens) ||
      usage.cacheWriteTokens !== undefined && !validCount(usage.cacheWriteTokens)) return unknown('missing-or-invalid-usage')
  const read = usage.cacheReadTokens ?? 0, write = usage.cacheWriteTokens ?? 0
  const tokenTotal = usage.inputTokens + usage.outputTokens + read + write
  if (!validCount(tokenTotal) || usage.totalTokens !== undefined && usage.totalTokens !== tokenTotal) return unknown('inconsistent-usage')
  if (card) {
    let tariffs
    if (card.provider === 'deepseek') {
      if (!finiteTime(startedAt) || !finiteTime(observedAt)) return unknown('request-time-unknown')
      tariffs = possibleTariffs(startedAt, observedAt, schedule)
      if (!tariffs) return unknown('tariff-window-unknown')
    }
    const quote = quoteCatalogUsage(card, usage, MONEY_UNITS, tariffs)
    if (quote.reason) return unknown(quote.reason)
    const tokens = { input: usage.inputTokens, cache: read + write, output: usage.outputTokens }
    return { ...quote, breakdown: Object.fromEntries(COMPONENTS.map(key => [key, { ...quote.breakdown[key], tokens: tokens[key] }])) }
  }
  // The published card has cache-hit and cache-miss input, but no distinct
  // cache-creation rate. Never silently price a cache-write bucket as a read.
  if (write > 0) return unknown('cache-write-rate-unknown')
  if (!finiteTime(startedAt) || !finiteTime(observedAt)) return unknown('request-time-unknown')
  if (startedAt < COVERAGE_START) return unknown('historical-price-unknown')
  const tariffs = possibleTariffs(startedAt, observedAt, schedule)
  if (!tariffs) return unknown('tariff-window-unknown')
  const breakdown = {}
  for (const [key, tokens, field] of [['input', usage.inputTokens, 'input'], ['cache', read, 'read'], ['output', usage.outputTokens, 'output']]) {
    const amounts = tariffs.map(tariff => tokens * rates[tariff][field])
    breakdown[key] = { minUnits: Math.min(...amounts), maxUnits: Math.max(...amounts), tokens }
  }
  const amounts = [breakdown.input.minUnits + breakdown.cache.minUnits + breakdown.output.minUnits,
    breakdown.input.maxUnits + breakdown.cache.maxUnits + breakdown.output.maxUnits]
  if (amounts.some(amount => !validCount(amount))) return unknown('usage-overflow')
  return { minUnits: amounts[0], maxUnits: amounts[1], breakdown, reason: null }
}

function addQuote(aggregate, quote, direction) {
  const result = { ...aggregate, reasons: { ...aggregate.reasons }, sources: { ...aggregate.sources }, breakdown: { ...aggregate.breakdown } }
  if (quote.reason !== null) {
    result.unpricedMessages += direction
    result.reasons[quote.reason] = (result.reasons[quote.reason] || 0) + direction
    if (!result.reasons[quote.reason]) delete result.reasons[quote.reason]
  } else {
    result.pricedMessages += direction
    if (quote.currency === 'USD') {
      result.usdMessages += direction
      result.minUsdUnits += quote.minUnits * direction
      result.maxUsdUnits += quote.maxUnits * direction
    } else {
      result.minUnits += quote.minUnits * direction
      result.maxUnits += quote.maxUnits * direction
    }
    const source = quote.source || 'deepseek-fallback'
    result.sources[source] = (result.sources[source] || 0) + direction
    if (!result.sources[source]) delete result.sources[source]
    for (const key of COMPONENTS) {
      const part = { ...result.breakdown[key] }, quotePart = quote.breakdown[key]
      const min = quote.currency === 'USD' ? 'minUsdUnits' : 'minUnits', max = quote.currency === 'USD' ? 'maxUsdUnits' : 'maxUnits'
      part[min] += quotePart.minUnits * direction; part[max] += quotePart.maxUnits * direction
      part[quote.currency === 'USD' ? 'tokensUsd' : 'tokensCny'] += quotePart.tokens * direction
      result.breakdown[key] = part
    }
  }
  return result
}

function moneyView(aggregate, known, knownUsd) {
  const minCny = known ? aggregate.minUnits / MONEY_UNITS : null, maxCny = known ? aggregate.maxUnits / MONEY_UNITS : null
  const minUsd = knownUsd ? aggregate.minUsdUnits / MONEY_UNITS : null, maxUsd = knownUsd ? aggregate.maxUsdUnits / MONEY_UNITS : null
  return { amountCny: minCny === maxCny ? minCny : null, minCny, maxCny,
    amountUsd: minUsd === maxUsd ? minUsd : null, minUsd, maxUsd }
}

function aggregateView(aggregate) {
  // Zero is meaningful only after explicit zero usage, with no unknown items.
  const known = aggregate.pricedMessages > aggregate.usdMessages && (aggregate.maxUnits > 0 || aggregate.unpricedMessages === 0)
  const knownUsd = aggregate.usdMessages > 0 && (aggregate.maxUsdUnits > 0 || aggregate.unpricedMessages === 0)
  return { ...moneyView(aggregate, known, knownUsd), sources: aggregate.sources,
    breakdown: Object.fromEntries(COMPONENTS.map(key => [key, { ...moneyView(aggregate.breakdown[key], known, knownUsd),
      tokensCny: aggregate.pricedMessages > aggregate.usdMessages ? aggregate.breakdown[key].tokensCny : null,
      tokensUsd: aggregate.usdMessages > 0 ? aggregate.breakdown[key].tokensUsd : null }])),
    pricedMessages: aggregate.pricedMessages, unpricedMessages: aggregate.unpricedMessages, reasons: aggregate.reasons }
}

function makeView(state, catalog) {
  const usd = state.session.usdMessages, cny = state.session.pricedMessages - usd
  return { currency: usd ? cny ? 'mixed' : 'USD' : 'CNY', catalog: catalog?.info || null, pricingAsOf: PRICING_AS_OF, coverageStartsAt: PRICING_AS_OF, pricingSource: PRICING_SOURCE,
    billingVerified: false, pricingBasis: 'official-rate-card-reference',
    scope: 'session-only', includesSubagents: false, excludesInherited: true,
    session: aggregateView(state.session),
    pendingRequest: !!(state.request && !state.request.settled) }
}
function withView(state, catalog) { return { ...state, view: makeView(state, catalog) } }

function settle(state, turn, step, quote, catalog) {
  const previous = state.last?.turn === turn && state.last.step === step ? state.last.quote : null
  if (previous && JSON.stringify(previous) === JSON.stringify(quote) && state.request?.settled) return state
  let session = state.session, current = state.turn === turn ? state.current : emptyAggregate()
  if (previous) { session = addQuote(session, previous, -1); if (state.turn === turn) current = addQuote(current, previous, -1) }
  if (quote.reason === null && !validCount((quote.currency === 'USD' ? session.maxUsdUnits : session.maxUnits) + quote.maxUnits)) quote = unknown('cost-overflow')
  if (quote.reason === null && COMPONENTS.some(key => !validCount(session.breakdown[key][quote.currency === 'USD' ? 'tokensUsd' : 'tokensCny'] + quote.breakdown[key].tokens))) quote = unknown('usage-overflow')
  session = addQuote(session, quote, 1); current = addQuote(current, quote, 1)
  return withView({ ...state, session, current, turn,
    request: state.request ? { ...state.request, settled: true } : null,
    last: { turn, step, quote } }, catalog)
}

function applyMetrics(state, event, catalog, schedule) {
  if (!event || !validCount(event.seq) || event.seq < state.inheritedEventCount) return state
  const data = event.data || {}
  if (event.type === 'request/header') {
    const route = routeOf(data.header?.config)
    if (JSON.stringify(route) === JSON.stringify(state.route)) return state
    // Route metadata changes are host state only: retain the wire reference.
    return { ...state, route, request: state.request ? { ...state.request, route } : null }
  }
  if (event.type === 'turn/start') {
    if (!validCount(data.turn) || state.turn === data.turn) return state
    return withView({ ...state, turn: data.turn, current: emptyAggregate(), request: null, last: null }, catalog)
  }
  if (event.type === 'step/start' || event.type === 'llm/retry-started') {
    if (!validCount(data.turn) || !validCount(data.step)) return state
    return withView({ ...state, turn: data.turn, current: state.turn === data.turn ? state.current : emptyAggregate(), last: null,
      request: { turn: data.turn, step: data.step, startedAt: finiteTime(event.time) ? event.time : null, settled: false, route: state.route } }, catalog)
  }
  if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
    if (!validCount(data.turn) || !validCount(data.step)) return state
    const request = state.request?.turn === data.turn && state.request.step === data.step ? state.request : null
    // Message source is the exact consumed route; pending modelSelection is
    // intentionally never consulted. Reading source does not read content.
    const source = event.type === 'assistant/message' ? data.message?.source : undefined
    const route = source !== undefined ? routeOf(source) : request?.route
    const quote = quoteUsage({ route, usage: usageOf(event), startedAt: request?.startedAt, observedAt: streamUpperBound(event), catalog, schedule })
    return settle(state, data.turn, data.step, quote, catalog)
  }
  if (event.type === 'step/end' && state.request?.turn === data.turn && state.request.step === data.step) {
    const settled = state.request.settled ? state : settle(state, data.turn, data.step, unknown('missing-settlement'), catalog)
    return withView({ ...settled, request: null }, catalog)
  }
  if (event.type === 'turn/end' && state.turn === data.turn && state.request) return withView({ ...state, request: null }, catalog)
  return state
}

function createSessionMetricsProjection(catalog, schedule) {
  schedule = peakPricingSnapshot(schedule)
  // Catalog/calendar snapshots invalidate native checkpoints once, on load.
  const stateVersion = parseInt(createHash('sha256').update(JSON.stringify([6, catalog?.revision || 2,
    schedule.windows, schedule.holidays, schedule.rule?.status])).digest('hex').slice(0, 7), 16) + 2
  return {
    key: 'statuslineMetrics', stateVersion, stateSchema,
    init(_header, inheritedEventCount = 0) {
      return withView({ inheritedEventCount: validCount(inheritedEventCount) ? inheritedEventCount : 0,
        route: null, request: null, last: null, turn: null, current: emptyAggregate(), session: emptyAggregate() }, catalog)
    },
    apply: (state, event) => applyMetrics(state, event, catalog, schedule),
    wire: { viewSchema, view: state => state.view },
  }
}

export { createSessionMetricsProjection, quoteUsage, tariffAt, possibleTariffs,
  PRICING_AS_OF, COVERAGE_START, PRICING_SOURCE, MONEY_UNITS }
