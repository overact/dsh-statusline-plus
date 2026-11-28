'use strict'
// Today's spend across sessions. The Host does the log replay, so these tests
// supply the events the Host would hand back and check the arithmetic and the
// two rules that make the number trustworthy: a fork is not charged for its
// inherited prefix, and a retried step is charged once.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync, mkdirSync, utimesSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { todaySpend, touchedLogs, billableEvents, startOfLocalDay } = require('../lib/today-spend.js')

const ID = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222',
  fork: '33333333-3333-4333-8333-333333333333', retry: '44444444-4444-4444-8444-444444444444',
  torn: '55555555-5555-4555-8555-555555555555', odd: '66666666-6666-4666-8666-666666666666',
  today: '77777777-7777-4777-8777-777777777777', old: '88888888-8888-4888-8888-888888888888' }
const MESSAGE = (turn, step, { time = Date.now(), model = 'deepseek-flash', provider = 'deepseek', usage } = {}) => ({
  type: 'assistant/message', seq: 1, time,
  data: {
    turn, step,
    message: { source: { provider, model } },
    usage: usage || { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0 },
  },
})
const HEADER = time => ({ type: 'request/header', seq: 0, time,
  data: { header: { config: { provider: 'deepseek', model: 'deepseek-flash' } } } })
const ATTEMPT = (turn, step, time = Date.now()) => ({
  type: 'assistant/attempt', seq: 1, time, data: { turn, step, stream: [{ type: 'chunk', time, chunk: { type: 'text', text: '' } },
    { type: 'chunk', time, chunk: { type: 'usage', usage: { inputTokens: 2000, outputTokens: 0 } } }] },
})

function queryOf(sessions) {
  return { readSession: async id => { for (const s of sessions) if (s.id === id) return s.value; throw new Error('not found') } }
}

// A sessions root with one directory per id, in the layout the Host uses.
function sessionsRoot(entries) {
  const root = mkdtempSync(join(tmpdir(), 'slp-today-'))
  for (const entry of entries) {
    const directory = join(root, '--project--', entry.id)
    mkdirSync(directory, { recursive: true })
    const file = join(directory, 'session.v4.jsonl.zstd')
    writeFileSync(file, 'x')
    if (entry.ageMs) {
      const at = (Date.now() - entry.ageMs) / 1000
      utimesSync(file, at, at)
    }
  }
  return root
}

test('a session without a Host replay is reported as unsupported, not as zero', async () => {
  assert.deepEqual(await todaySpend({}), { supported: false })
  assert.deepEqual(await todaySpend({ query: {} }), { supported: false })
})

test('every priced request adds up, in the unit the per-session figure uses', async () => {
  const now = Date.now()
  const root = sessionsRoot([{ id: ID.a }, { id: ID.b }])
  try {
    const result = await todaySpend({
      now, root,
      query: queryOf([
        { id: ID.a, value: { inheritedEventCount: 0, events: [MESSAGE(1, 1, { time: now })] } },
        { id: ID.b, value: { inheritedEventCount: 0, events: [MESSAGE(1, 1, { time: now })] } },
      ]),
    })
    // 500000 units per request (see quoteUsage for 1000 in / 1000 out, see the
    // DeepSeek card), two sessions.
    assert.equal(result.cnyUnits, 1000000)
    assert.equal(result.usdUnits, 0)
    assert.equal(result.counted, 2)
    assert.equal(result.complete, true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a fork is not charged for the events it inherited', async () => {
  const now = Date.now()
  const root = sessionsRoot([{ id: ID.fork }])
  try {
    const inherited = MESSAGE(1, 1, { time: now })
    const own = MESSAGE(2, 1, { time: now })
    const result = await todaySpend({
      now, root,
      query: queryOf([{ id: ID.fork, value: { inheritedEventCount: 1, events: [inherited, own] } }]),
    })
    assert.equal(result.cnyUnits, 500000, 'one request was paid, not two')
    assert.equal(result.counted, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a retried step is charged once, and a retry that produced no message still is', async () => {
  const now = Date.now()
  const root = sessionsRoot([{ id: ID.retry }])
  try {
    const result = await todaySpend({
      now, root,
      query: queryOf([{ id: ID.retry, value: { inheritedEventCount: 0, events: [
        HEADER(now),
        ATTEMPT(1, 1, now), MESSAGE(1, 1, { time: now }),   // retried, then produced a message: one charge
        ATTEMPT(1, 2, now),                                  // retried and never settled: its tokens were spent
      ] } }]),
    })
    assert.equal(result.counted, 1)
    // 500000 for the message + 200000 for the 2000 uncached input tokens of the attempt.
    assert.equal(result.cnyUnits, 700000)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a session that ran past midnight does not carry yesterday into today', async () => {
  const now = Date.now()
  const start = startOfLocalDay(now)
  const root = sessionsRoot([{ id: ID.a }])
  try {
    const result = await todaySpend({
      now, root,
      query: queryOf([{ id: ID.a, value: { inheritedEventCount: 0, events: [
        // Yesterday's request: same log (the file was touched today), not today's spend.
        HEADER(start - 3600000),
        MESSAGE(1, 1, { time: start - 3600000 }),
        // A request that began before midnight and settled after it: the event
        // carries the settlement time, so it belongs to today.
        MESSAGE(2, 1, { time: start + 60000 }),
      ] } }]),
    })
    assert.equal(result.cnyUnits, 500000, 'one request today, not two')
    assert.equal(result.counted, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a log the Host cannot replay is counted as uncounted, never as free', async () => {
  const now = Date.now()
  const root = sessionsRoot([{ id: ID.torn }])
  try {
    const result = await todaySpend({
      now, root,
      query: { readSession: async () => { throw new Error('torn tail') } },
    })
    assert.equal(result.skipped, 1)
    assert.equal(result.cnyUnits, 0)
    assert.equal(result.complete, false, 'an unreadable log makes the total a lower bound')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('only logs touched since local midnight are read', () => {
  const root = sessionsRoot([{ id: ID.today }, { id: ID.old, ageMs: 26 * 3600000 }])
  try {
    const found = touchedLogs(root, startOfLocalDay(Date.now()))
    assert.deepEqual(found.map(entry => entry.id), [ID.today])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('an unpriced request is counted, not summed into a smaller number', async () => {
  const now = Date.now()
  const root = sessionsRoot([{ id: ID.odd }])
  try {
    const result = await todaySpend({
      now, root,
      query: queryOf([{ id: ID.odd, value: { inheritedEventCount: 0, events: [
        MESSAGE(1, 1, { time: now, provider: 'unknown-vendor', model: 'mystery-1' }),
      ] } }]),
    })
    assert.equal(result.unpriced, 1)
    assert.equal(result.cnyUnits, 0)
    assert.equal(result.counted, 0)
    assert.equal(result.complete, false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('an attempt followed by a message for the same step is not billed twice', () => {
  const events = [ATTEMPT(1, 1), MESSAGE(1, 1)]
  assert.equal(billableEvents(events, 0).length, 1)
  assert.equal(billableEvents(events, 0)[0].event.type, 'assistant/message')
  assert.equal(billableEvents([ATTEMPT(1, 7)], 0).length, 1, 'a retry with no message is still a cost')
  // A retry has no source of its own: it is billed at the route that was in force.
  const header = { type: 'request/header', seq: 0, time: Date.now(), data: { header: { config: { provider: 'deepseek', model: 'deepseek-flash' } } } }
  assert.deepEqual(billableEvents([header, ATTEMPT(1, 7)], 0)[0].route, { provider: 'deepseek', model: 'deepseek-flash' })
})
