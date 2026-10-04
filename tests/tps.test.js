'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { TpsTracker, streamTps, estimateTextTokens, firstStreamTokenTime } = require('../lib/tps')
const start = (tracker, id = 'one', attemptId = 'a') => tracker.onFrame({ agent: { session: { id } }, frame: { type: 'start', attemptId, turn: 1, step: 1 } })
const chunk = (tracker, index, time, text, id = 'one', attemptId = 'a') => tracker.onFrame({ agent: { session: { id } }, frame: { type: 'chunk', attemptId, index, time, chunk: { type: 'text-delta', text } } })
const settle = (tracker, usage, extra = {}) => tracker.onSession({ id: 'one' }, { type: 'assistant/message', time: 2100, data: { turn: 1, step: 1, usage, ...extra } })

test('native chunks wait for the observation window; final usage keeps its own baseline', () => {
  const tracker = new TpsTracker(); start(tracker)
  chunk(tracker, 0, 1000, 'a'.repeat(350))
  chunk(tracker, 1, 1500, 'b'.repeat(175))
  assert.equal(tracker.read('one').tokensPerSecond, 100)
  chunk(tracker, 2, 1750, 'c'.repeat(350))
  assert.equal(tracker.read('one').tokensPerSecond, 200)
  settle(tracker, { outputTokens: 40 })
  assert.deepEqual(tracker.read('one'), { phase: 'completed', tokensPerSecond: 36.4, estimated: false })
})

test('startup bursts and short settlements stay unknown without capping sustained rates', () => {
  const tracker = new TpsTracker(); start(tracker)
  chunk(tracker, 0, 1000, 'a'); chunk(tracker, 1, 1001, 'x'.repeat(350))
  assert.equal(tracker.read('one').tokensPerSecond, null)
  chunk(tracker, 2, 1499, 'x'); assert.equal(tracker.read('one').tokensPerSecond, null)
  chunk(tracker, 3, 1500, 'x'.repeat(7000))
  assert.ok(tracker.read('one').tokensPerSecond > 4000, 'no arbitrary speed cap')
  start(tracker); chunk(tracker, 0, 2000, 'a')
  settle(tracker, { outputTokens: 500 })
  assert.equal(tracker.read('one').tokensPerSecond, null)
})

test('sub-integer changes update the snapshot without redundant notifications', () => {
  const tracker = new TpsTracker(), state = {}; let notices = 0
  const off = tracker.subscribe('one', () => notices++)
  tracker.publish('one', state, 'streaming', 100.1)
  tracker.publish('one', state, 'streaming', 100.2)
  assert.equal(notices, 1); assert.equal(state.view.tokensPerSecond, 100.2)
  tracker.publish('one', state, 'streaming', 100.6)
  assert.equal(notices, 2)
  tracker.publish('one', state, 'completed', 100.6, false)
  assert.equal(notices, 3); off()
})

test('fractional estimates and same-timestamp deltas do not inflate the first baseline', () => {
  assert.ok(Math.abs(estimateTextTokens('hello') - [...'hello'].reduce((n,c) => n + estimateTextTokens(c), 0)) < 1e-12)
  const tracker = new TpsTracker(); start(tracker)
  chunk(tracker, 0, 1000, 'a'.repeat(175)); chunk(tracker, 1, 1000, 'a'.repeat(175))
  chunk(tracker, 2, 2000, 'b'.repeat(35))
  assert.equal(tracker.read('one').tokensPerSecond, 10)
})

test('sessions, retries, duplicate frames and late end frames remain isolated', () => {
  const tracker = new TpsTracker(); start(tracker); start(tracker, 'two')
  chunk(tracker, 0, 1000, 'hello'); chunk(tracker, 1, 2000, ' world')
  const view = tracker.read('one')
  chunk(tracker, 1, 2000, ' world')
  assert.equal(tracker.read('one'), view)
  assert.equal(tracker.read('two').tokensPerSecond, null)
  start(tracker, 'one', 'retry')
  tracker.onFrame({ agent: { session: { id: 'one' } }, frame: { type: 'end', attemptId: 'a' } })
  assert.equal(tracker.read('one').phase, 'streaming')
  assert.equal(tracker.read('one').tokensPerSecond, null)
})

test('frame gaps become unknown, but native durable stream timing restores final usage', () => {
  const tracker = new TpsTracker(); start(tracker)
  chunk(tracker, 0, 1000, 'hello'); chunk(tracker, 2, 2000, ' world')
  assert.equal(tracker.read('one').tokensPerSecond, null)
  settle(tracker, { outputTokens: 11 }, { stream: [{ type: 'text-chunks', time0: 1000, texts: ['hello', ' world'], dt: [1000] }] })
  assert.equal(tracker.read('one').tokensPerSecond, 10)
  assert.equal(tracker.read('one').estimated, false)
})

test('missing usage remains estimated and cancellation is not displayed as live', () => {
  const tracker = new TpsTracker(); start(tracker)
  chunk(tracker, 0, 1000, 'hello'); chunk(tracker, 1, 2000, ' world')
  tracker.onFrame({ agent: { session: { id: 'one' } }, frame: { type: 'end', attemptId: 'a' } })
  assert.equal(tracker.read('one').phase, 'interrupted')
  assert.equal(tracker.read('one').estimated, true)
  start(tracker); chunk(tracker, 0, 1000, 'hello'); settle(tracker, undefined)
  assert.equal(tracker.read('one').estimated, true)
})

test('compact timestamp reader handles leading empty fragments and rejects unknown formats', () => {
  assert.equal(firstStreamTokenTime([{ type: 'reasoning-chunks', time0: 1000, texts: ['', 'x'], dt: [50] }]), 1050)
  assert.equal(firstStreamTokenTime([{ type: 'new-format', time0: 1000 }]), null)
})

test('cancelled native assistant messages remain interrupted after their committed end marker', () => {
  const tracker = new TpsTracker(); start(tracker)
  chunk(tracker, 0, 1000, 'a'.repeat(350)); chunk(tracker, 1, 1500, 'b'.repeat(175))
  settle(tracker, { outputTokens: 40, reasoningTokens: 20 }, { interrupted: true })
  assert.deepEqual(tracker.read('one'), { phase: 'interrupted', tokensPerSecond: 36.4, estimated: false })
  tracker.onFrame({ agent: { session: { id: 'one' } }, frame: {
    type: 'end', attemptId: 'a', index: 2, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 4 },
  } })
  assert.equal(tracker.read('one').phase, 'interrupted')
  assert.equal(tracker.read('one').estimated, false)
})

test('native failed attempts recover latest provider usage from compact raw records without adding reasoning twice', () => {
  const tracker = new TpsTracker(); start(tracker)
  const stream = [
    { type: 'reasoning-chunks', time0: 1000, texts: ['reasoning', ' more'], dt: [500] },
    { type: 'chunk', time: 1500, chunk: { type: 'usage', usage: { outputTokens: 10, reasoningTokens: 8 } } },
    { type: 'chunk', time: 2000, chunk: { type: 'usage', usage: { outputTokens: 40, reasoningTokens: 20 } } },
    { type: 'chunk', time: 2050, chunk: { type: 'finish', reason: { kind: 'aborted' } } },
  ]
  tracker.onSession({ id: 'one' }, { type: 'assistant/attempt', time: 2100, data: { turn: 1, step: 1, stream } })
  assert.deepEqual(tracker.read('one'), { phase: 'interrupted', tokensPerSecond: 36.4, estimated: false })
  settle(tracker, { outputTokens: 22 }, { stream })
  assert.deepEqual(tracker.read('one'), { phase: 'completed', tokensPerSecond: 20, estimated: false }, 'top-level message usage remains authoritative')
})

test('missing or malformed native attempt usage stays unknown rather than becoming a zero-token measurement', () => {
  for (const outputTokens of [undefined, null, true, '40', NaN, Infinity]) {
    const tracker = new TpsTracker()
    tracker.onSession({ id: 'one' }, { type: 'assistant/attempt', time: 2100, data: {
      turn: 1, step: 1, stream: [
        { type: 'text-chunks', time0: 1000, texts: ['hello'], dt: [] },
        { type: 'chunk', time: 2000, chunk: { type: 'usage', usage: { outputTokens } } },
      ],
    } })
    assert.deepEqual(tracker.read('one'), { phase: 'interrupted', tokensPerSecond: null, estimated: true })
  }
})

test('tool-only live estimates share the native name-bearing first-token boundary without counting repeated names', () => {
  const tracker = new TpsTracker(); start(tracker)
  const agent = { session: { id: 'one' } }
  const emit = (index, time, argumentsDelta) => tracker.onFrame({ agent, frame: {
    type: 'chunk', attemptId: 'a', index, time,
    chunk: { type: 'tool-call-delta', name: 'tool-name-is-metadata', argumentsDelta },
  } })
  emit(0, 1000, '')
  emit(1, 1300, '')
  emit(2, 1500, 'a'.repeat(350))
  assert.equal(tracker.read('one').tokensPerSecond, 200)
  assert.equal(tracker.states.get('one').total, 100)
  settle(tracker, { outputTokens: 40 }, { stream: [
    { type: 'tool-call-chunks', time0: 1000, name: 'tool-name-is-metadata', args: ['', '', 'a'.repeat(350)], dt: [300, 200] },
  ] })
  assert.equal(tracker.read('one').tokensPerSecond, 36.4)
})

test('reasoning and generated tool arguments contribute to estimates while usage and tool execution waits do not', () => {
  const tracker = new TpsTracker(); start(tracker)
  const agent = { session: { id: 'one' } }
  const emit = (index, time, payload) => tracker.onFrame({ agent, frame: { type: 'chunk', attemptId: 'a', index, time, chunk: payload } })
  emit(0, 1000, { type: 'reasoning-delta', text: 'a'.repeat(350) })
  emit(1, 1500, { type: 'reasoning-delta', text: 'b'.repeat(175) })
  emit(2, 2000, { type: 'tool-call-delta', argumentsDelta: 'c'.repeat(350) })
  assert.equal(tracker.read('one').tokensPerSecond, 150)
  emit(3, 2050, { type: 'usage', usage: { outputTokens: 40 } })
  assert.equal(tracker.read('one').tokensPerSecond, 150)
  settle(tracker, { outputTokens: 40 })
  const completed = tracker.read('one')
  tracker.onSession({ id: 'one' }, { type: 'tool/result', time: 90000, data: { turn: 1, step: 1 } })
  tracker.onSession({ id: 'one' }, { type: 'step/end', time: 90001, data: { turn: 1, step: 1 } })
  assert.equal(tracker.read('one'), completed)
  assert.equal(completed.tokensPerSecond, 36.4)
})

test('native revisions make duplicate opening markers harmless and permit a replacement Agent lifecycle', () => {
  const tracker = new TpsTracker(), agent = { session: { id: 'one' } }
  const opening = { type: 'start', attemptId: 'native:1', revision: 1, turn: 1, step: 1 }
  tracker.onFrame({ agent, frame: opening })
  tracker.onFrame({ agent, frame: { type: 'chunk', attemptId: 'native:1', revision: 2, index: 0, time: 1000, chunk: { type: 'text-delta', text: 'a'.repeat(350) } } })
  tracker.onFrame({ agent, frame: { type: 'chunk', attemptId: 'native:1', revision: 3, index: 1, time: 1500, chunk: { type: 'text-delta', text: 'b'.repeat(175) } } })
  const previous = tracker.read('one')
  tracker.onFrame({ agent, frame: opening })
  assert.equal(tracker.read('one'), previous)
  assert.equal(tracker.states.get('one').nextIndex, 2)
  const replacement = { session: { id: 'one' } }
  tracker.onFrame({ agent: replacement, frame: opening })
  assert.equal(tracker.read('one').tokensPerSecond, null)
  tracker.onFrame({ agent, frame: { type: 'chunk', attemptId: 'native:1', revision: 4, index: 0, time: 2000, chunk: { type: 'text-delta', text: 'stale' } } })
  assert.equal(tracker.states.get('one').nextIndex, 0, 'old Agent frames must not enter the replacement attempt')
})

test('a timestamp reversal across metadata frames invalidates the live estimate', () => {
  const tracker = new TpsTracker(); start(tracker)
  chunk(tracker, 0, 1000, 'a'.repeat(350))
  tracker.onFrame({ agent: { session: { id: 'one' } }, frame: {
    type: 'chunk', attemptId: 'a', index: 1, time: 2000, chunk: { type: 'usage', usage: { outputTokens: 50 } },
  } })
  chunk(tracker, 2, 1500, 'b'.repeat(175))
  assert.equal(tracker.read('one').tokensPerSecond, null)
  assert.equal(tracker.states.get('one').invalid, true)
})

test('tracker bounds sessions and subscriptions without retaining generated text', () => {
  const tracker = new TpsTracker({ limit: 2 }); start(tracker, 'one'); start(tracker, 'two'); start(tracker, 'three')
  assert.equal(tracker.states.size, 2)
  assert.equal(tracker.read('one').phase, 'idle')
  assert.equal(JSON.stringify([...tracker.states.values()]).includes('text'), false)
  const a = tracker.subscribe('one', () => {}), b = tracker.subscribe('two', () => {})
  assert.throws(() => tracker.subscribe('three', () => {}), /busy/)
  a(); b(); assert.equal(tracker.subscribers, 0)
})

test('SSE keeps only the latest snapshot under backpressure and cleans up on disconnect', async () => {
  const tracker = new TpsTracker(), res = new EventEmitter(), chunks = []
  let writable = false
  Object.assign(res, { writeHead() {}, write(value) { chunks.push(value); return writable }, end() { this.writableEnded = true } })
  const pending = streamTps(tracker, 'one', {}, res)
  start(tracker); chunk(tracker, 0, 1000, 'hello'); chunk(tracker, 1, 2000, ' world')
  assert.equal(chunks.length, 1)
  writable = true; res.emit('drain')
  assert.equal(chunks.length, 2)
  assert.equal(JSON.parse(chunks[1].slice(6)).tokensPerSecond, tracker.read('one').tokensPerSecond)
  res.emit('close'); await pending
  assert.equal(tracker.subscribers, 0)
  assert.equal(res.listenerCount('drain'), 0)
})
