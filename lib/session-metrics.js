'use strict'

import { z } from 'zod'
import { pricingModelId, pricingModelAlias, quoteCatalogUsage } from './model-pricing.js'
import { peakTariffAt, peakPricingSnapshot, PRICING_URL } from './peak-schedule.js'
import { lastStreamUsage } from './session-records.js'
import { createHash } from 'node:crypto'

// This is a verified rate-card snapshot, not a claimed historical effective date.
// Requests before the verification cut remain unpriced. Updating the card or
// fold semantics requires a stateVersion bump so native checkpoints refold.
const PRICING_AS_OF = '2026-10-02T04:24:12Z'
const COVERAGE_START = Date.parse(PRICING_AS_OF)
const PRICING_SOURCE = PRICING_URL
const MONEY_UNITS = 100000000
// Model identity selects a vendor reference card, independent of subscription
// or gateway billing. Configurable endpoints are never treated as invoices.
// Integer 1e-8 CNY per token: no floating-point money accumulates in the fold.
const RATES = {
  'deepseek-flash': { peak: { read: 4, input: 200, output: 800 }, offPeak: { read: 2, input: 100, output: 400 } },
  'deepseek-v4-pro': { peak: { read: 30, input: 900, output: 2700 }, offPeak: { read: 15, input: 450, output: 1350 } },
}
// One request has one tariff, so every quote and total is a single amount.
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const timestamp = z.number().finite().nonnegative()
const money = z.number().finite().nonnegative().nullable()
const routeSchema = z.object({ provider: z.string(), model: z.string() }).strict()
const COMPONENTS = ['input', 'cache', 'output']
const partTotalsSchema = z.object({ cnyUnits: count, usdUnits: count, tokensCny: count, tokensUsd: count }).strict()
const breakdownSchema = schema => z.object(Object.fromEntries(COMPONENTS.map(key => [key, schema]))).strict()
const aggregateSchema = z.object({
  cnyUnits: count, usdUnits: count, pricedMessages: count, unpricedMessages: count, cacheMisses: count,
  usdMessages: count, sources: z.record(z.string(), count),
  reasons: z.record(z.string(), count),
  breakdown: breakdownSchema(partTotalsSchema),
}).strict()
const quoteSchema = z.object({
  units: count.nullable(), reason: z.string().nullable(), cacheMiss: z.boolean().optional(),
  currency: z.literal('USD').optional(), source: z.enum(['pi-ai', 'fallback']).optional(),
  breakdown: breakdownSchema(z.object({ units: count, tokens: count }).strict()).optional(),
}).strict()
const moneyViewSchema = z.object({ amountCny: money, amountUsd: money }).strict()
const totalViewSchema = moneyViewSchema.extend({
  sources: z.record(z.string(), count),
  pricedMessages: count, unpricedMessages: count, cacheMisses: count, reasons: z.record(z.string(), count),
  breakdown: breakdownSchema(moneyViewSchema.extend({ tokensCny: count.nullable(), tokensUsd: count.nullable() }).strict()),
}).strict()
const viewSchema = z.object({
  currency: z.enum(['CNY', 'USD', 'mixed']), pricingAsOf: z.literal(PRICING_AS_OF),
  catalog: z.object({ version: z.string().nullable(), generatedAt: timestamp.nullable(), fallbackAsOf: z.string() }).strict().nullable(),
  coverageStartsAt: z.literal(PRICING_AS_OF), pricingSource: z.literal(PRICING_SOURCE),
  billingVerified: z.literal(false), pricingBasis: z.literal('official-rate-card-reference'),
  scope: z.literal('session-only'), includesSubagents: z.literal(false), excludesInherited: z.literal(true),
  session: totalViewSchema,
  activeFrom: timestamp.nullable(), activeTo: timestamp.nullable(), compactions: count,
  pendingRequest: z.boolean(),
}).strict()
const stateSchema = z.object({
  inheritedEventCount: count, route: routeSchema.nullable(),
  request: z.object({ turn: count, step: count, startedAt: timestamp.nullable(), settled: z.boolean(), route: routeSchema.nullable() }).strict().nullable(),
  last: z.object({ turn: count, step: count, quote: quoteSchema }).strict().nullable(),
  turn: count.nullable(), current: aggregateSchema, session: aggregateSchema,
  activeFrom: timestamp.nullable(), activeTo: timestamp.nullable(), compactions: count, view: viewSchema,
}).strict()

const finiteTime = n => typeof n === 'number' && Number.isFinite(n) && n >= 0
const validCount = n => Number.isSafeInteger(n) && n >= 0
const emptyAggregate = () => ({ cnyUnits: 0, usdUnits: 0, usdMessages: 0, sources: {}, pricedMessages: 0, unpricedMessages: 0, cacheMisses: 0, reasons: {},
  breakdown: Object.fromEntries(COMPONENTS.map(key => [key, { cnyUnits: 0, usdUnits: 0, tokensCny: 0, tokensUsd: 0 }])) })
const unknown = (reason, cacheMiss = false) => ({ units: null, reason, cacheMiss })
// Which aggregate fields a quote adds to, by its currency.
const unitsField = quote => quote.currency === 'USD' ? 'usdUnits' : 'cnyUnits'
const tokensField = quote => quote.currency === 'USD' ? 'tokensUsd' : 'tokensCny'

function routeOf(value) {
  if (!value || typeof value.provider !== 'string' || !value.provider || typeof value.model !== 'string' || !value.model) return null
  return { provider: value.provider, model: value.model }
}

// The first compact stream record is the billing instant: it is the earliest
// evidence that the server is serving this request, and it keeps one request at
// one tariff instead of a range. No generated content is inspected.

function usageOf(event) {
  if (event.type === 'assistant/message' && event.data?.usage !== undefined) return event.data.usage
  return lastStreamUsage(event.data?.stream) ?? undefined
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

function quoteUsage({ route, usage, observedAt, catalog, schedule }) {
  // A miss is a request that reported input but no cache read. This is a
  // request count, not a token count; a provider that never reports cache
  // fields will show every request as a miss, so the UI only shows it when the
  // context panel already has a cache read figure.
  const cacheMiss = !!usage && validCount(usage.inputTokens) && usage.inputTokens > 0 &&
    (usage.cacheReadTokens === undefined || validCount(usage.cacheReadTokens) && usage.cacheReadTokens === 0)
  const unknownHere = reason => unknown(reason, cacheMiss)
  const card = catalog?.resolve(route)
  if (!route) return unknownHere('unsupported-model')
  const model = pricingModelId(route.model)
  const priceModel = pricingModelAlias(model)
  const rates = Object.hasOwn(RATES, priceModel) ? RATES[priceModel] : null
  if (!card && !rates) return unknownHere('unsupported-model')
  if (!usage || !validCount(usage.inputTokens) || !validCount(usage.outputTokens) ||
      usage.cacheReadTokens !== undefined && !validCount(usage.cacheReadTokens) ||
      usage.cacheWriteTokens !== undefined && !validCount(usage.cacheWriteTokens)) return unknownHere('missing-or-invalid-usage')
  const read = usage.cacheReadTokens ?? 0, write = usage.cacheWriteTokens ?? 0
  const tokenTotal = usage.inputTokens + usage.outputTokens + read + write
  if (!validCount(tokenTotal) || usage.totalTokens !== undefined && usage.totalTokens !== tokenTotal) return unknownHere('inconsistent-usage')
  if (card) {
    let tariff
    if (card.provider === 'deepseek') {
      if (!finiteTime(observedAt)) return unknownHere('request-time-unknown')
      tariff = peakTariffAt(observedAt, schedule)
      if (!tariff) return unknownHere('tariff-window-unknown')
    }
    const quote = quoteCatalogUsage(card, usage, MONEY_UNITS, tariff)
    if (quote.reason) return unknownHere(quote.reason)
    const tokens = { input: usage.inputTokens, cache: read + write, output: usage.outputTokens }
    return { ...quote, cacheMiss, breakdown: Object.fromEntries(COMPONENTS.map(key => [key, { ...quote.breakdown[key], tokens: tokens[key] }])) }
  }
  // The published card has cache-hit and cache-miss input, but no distinct
  // cache-creation rate. Never silently price a cache-write bucket as a read.
  if (write > 0) return unknownHere('cache-write-rate-unknown')
  if (!finiteTime(observedAt)) return unknownHere('request-time-unknown')
  if (observedAt < COVERAGE_START) return unknownHere('historical-price-unknown')
  const tariff = peakTariffAt(observedAt, schedule)
  if (!tariff) return unknownHere('tariff-window-unknown')
  const breakdown = {}
  for (const [key, tokens, field] of [['input', usage.inputTokens, 'input'], ['cache', read, 'read'], ['output', usage.outputTokens, 'output']]) {
    breakdown[key] = { units: tokens * rates[tariff][field], tokens }
  }
  const units = breakdown.input.units + breakdown.cache.units + breakdown.output.units
  if (!validCount(units)) return unknownHere('usage-overflow')
  return { units, breakdown, reason: null, cacheMiss }
}

function addQuote(aggregate, quote, direction) {
  const result = { ...aggregate, reasons: { ...aggregate.reasons }, sources: { ...aggregate.sources }, breakdown: { ...aggregate.breakdown } }
  const bump = (table, key) => {
    table[key] = (table[key] || 0) + direction
    if (!table[key]) delete table[key]
  }
  if (quote.cacheMiss) result.cacheMisses = Math.max(0, result.cacheMisses + direction)
  if (quote.reason !== null) {
    result.unpricedMessages += direction
    bump(result.reasons, quote.reason)
    return result
  }
  const units = unitsField(quote), tokens = tokensField(quote)
  result.pricedMessages += direction
  if (quote.currency === 'USD') result.usdMessages += direction
  result[units] += quote.units * direction
  bump(result.sources, quote.source || 'deepseek-fallback')
  for (const key of COMPONENTS) {
    const part = { ...result.breakdown[key] }, quotePart = quote.breakdown[key]
    part[units] += quotePart.units * direction
    part[tokens] += quotePart.tokens * direction
    result.breakdown[key] = part
  }
  return result
}

function moneyView(totals, known, knownUsd) {
  return { amountCny: known ? totals.cnyUnits / MONEY_UNITS : null, amountUsd: knownUsd ? totals.usdUnits / MONEY_UNITS : null }
}

function aggregateView(aggregate) {
  // Zero is meaningful only after explicit zero usage, with no unknown items.
  const hasCny = aggregate.pricedMessages > aggregate.usdMessages, hasUsd = aggregate.usdMessages > 0
  const known = hasCny && (aggregate.cnyUnits > 0 || aggregate.unpricedMessages === 0)
  const knownUsd = hasUsd && (aggregate.usdUnits > 0 || aggregate.unpricedMessages === 0)
  return { ...moneyView(aggregate, known, knownUsd), sources: aggregate.sources,
    breakdown: Object.fromEntries(COMPONENTS.map(key => [key, { ...moneyView(aggregate.breakdown[key], known, knownUsd),
      tokensCny: hasCny ? aggregate.breakdown[key].tokensCny : null,
      tokensUsd: hasUsd ? aggregate.breakdown[key].tokensUsd : null }])),
    pricedMessages: aggregate.pricedMessages, unpricedMessages: aggregate.unpricedMessages,
    cacheMisses: aggregate.cacheMisses, reasons: aggregate.reasons }
}

function makeView(state, catalog) {
  const usd = state.session.usdMessages, cny = state.session.pricedMessages - usd
  return { currency: usd ? cny ? 'mixed' : 'USD' : 'CNY', catalog: catalog?.info || null, pricingAsOf: PRICING_AS_OF, coverageStartsAt: PRICING_AS_OF, pricingSource: PRICING_SOURCE,
    billingVerified: false, pricingBasis: 'official-rate-card-reference',
    scope: 'session-only', includesSubagents: false, excludesInherited: true,
    session: aggregateView(state.session),
    activeFrom: state.activeFrom, activeTo: state.activeTo, compactions: state.compactions,
    pendingRequest: !!(state.request && !state.request.settled) }
}
function withView(state, catalog) { return { ...state, view: makeView(state, catalog) } }

function settle(state, turn, step, quote, catalog) {
  const previous = state.last?.turn === turn && state.last.step === step ? state.last.quote : null
  if (previous && JSON.stringify(previous) === JSON.stringify(quote) && state.request?.settled) return state
  let session = state.session, current = state.turn === turn ? state.current : emptyAggregate()
  if (previous) { session = addQuote(session, previous, -1); if (state.turn === turn) current = addQuote(current, previous, -1) }
  if (quote.reason === null && !validCount(session[unitsField(quote)] + quote.units)) quote = unknown('cost-overflow')
  if (quote.reason === null && COMPONENTS.some(key => !validCount(session.breakdown[key][tokensField(quote)] + quote.breakdown[key].tokens))) quote = unknown('usage-overflow')
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
    const observedAt = streamUpperBound(event)
    const quote = quoteUsage({ route, usage: usageOf(event), observedAt, catalog, schedule })
    // Request span from the first dispatch to the latest settlement, for cost per hour.
    const from = finiteTime(request?.startedAt) ? request.startedAt : observedAt
    let timed = state
    if (finiteTime(from)) {
      const activeFrom = state.activeFrom === null ? from : Math.min(state.activeFrom, from)
      const activeTo = Math.max(state.activeTo ?? 0, finiteTime(observedAt) ? observedAt : from)
      if (activeFrom !== state.activeFrom || activeTo !== state.activeTo) timed = { ...state, activeFrom, activeTo }
    }
    const settled = settle(timed, data.turn, data.step, quote, catalog)
    return settled === timed && timed !== state ? withView(timed, catalog) : settled
  }
  if (event.type === 'step/end' && state.request?.turn === data.turn && state.request.step === data.step) {
    const settled = state.request.settled ? state : settle(state, data.turn, data.step, unknown('missing-settlement'), catalog)
    return withView({ ...settled, request: null }, catalog)
  }
  if (event.type === 'compaction/end') {
    if (data.error || !validCount(state.compactions + 1)) return state
    return withView({ ...state, compactions: state.compactions + 1 }, catalog)
  }
  if (event.type === 'turn/end' && state.turn === data.turn && state.request) return withView({ ...state, request: null }, catalog)
  return state
}

function createSessionMetricsProjection(catalog, schedule) {
  schedule = peakPricingSnapshot(schedule)
  // Catalog/calendar snapshots invalidate native checkpoints once, on load.
  const stateVersion = parseInt(createHash('sha256').update(JSON.stringify([15, // 15: one amount per request; the min/max range fields are gone
    catalog?.revision || 2, schedule.windows, schedule.holidays, schedule.rule?.status])).digest('hex').slice(0, 7), 16) + 2
  return {
    key: 'statuslineMetrics', stateVersion, stateSchema,
    init(_header, inheritedEventCount = 0) {
      return withView({ inheritedEventCount: validCount(inheritedEventCount) ? inheritedEventCount : 0,
        route: null, request: null, last: null, turn: null, current: emptyAggregate(), session: emptyAggregate(),
        activeFrom: null, activeTo: null, compactions: 0 }, catalog)
    },
    apply: (state, event) => applyMetrics(state, event, catalog, schedule),
    wire: { viewSchema, view: state => state.view },
  }
}

export { createSessionMetricsProjection, quoteUsage, peakTariffAt as tariffAt,
  PRICING_AS_OF, COVERAGE_START, PRICING_SOURCE, MONEY_UNITS }
