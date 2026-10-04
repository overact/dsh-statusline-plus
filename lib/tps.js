'use strict'

// Native DSH 0.1.5+ stream frames are transient, not session projection events.
// Keep only counters per attempt; never retain generated text or poll a log.
const IDLE = Object.freeze({ phase: 'idle', tokensPerSecond: null, estimated: true })
// Require a meaningful observation interval; never clamp legitimate high rates.
const MIN_OBSERVATION_MS = 500
const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0
const validSessionId = id => typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\0\r\n/\\]/.test(id)
function canonicalSessionId(id) {
  const match = typeof id === 'string' && id.match(/^(?:session-)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)
  return match ? match[1].toLowerCase() : id
}

function estimateTextTokens(text) {
  if (typeof text !== 'string') return 0
  let cjk = 0, other = 0
  for (const char of text) {
    const point = char.codePointAt(0)
    if (point >= 0x2e80 && point <= 0x9fff || point >= 0xff00 && point <= 0xffef) cjk++
    else other++
  }
  // Fractional counts are intentional: splitting a delta must not inflate TPS.
  return cjk * 0.75 + other / 3.5
}

function deltaText(chunk) {
  if (!chunk) return ''
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') return typeof chunk.text === 'string' ? chunk.text : ''
  // Tool names are metadata and may repeat; count only generated argument deltas.
  if (chunk.type === 'tool-call-delta') return typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : ''
  return ''
}

// Read the first token timestamp from native compact records without expanding
// them or allocating a second chunk array. A named tool delta counts as a token
// boundary, matching DSH's assistantStreamFirstTokenTime convention.
function firstStreamTokenTime(stream) {
  if (!Array.isArray(stream)) return null
  for (const record of stream) {
    if (!record || typeof record !== 'object') return null
    if (record.type === 'chunk') {
      if (deltaText(record.chunk) || record.chunk?.type === 'tool-call-delta' && record.chunk.name !== undefined) return finite(record.time) ? record.time : null
      continue
    }
    if (!['text-chunks', 'reasoning-chunks', 'tool-call-chunks'].includes(record.type)) return null
    let time = record.time0
    const members = record.type === 'tool-call-chunks' ? record.args : record.texts
    if (!finite(time) || !Array.isArray(members) || !Array.isArray(record.dt)) return null
    if (record.type === 'tool-call-chunks' && record.name !== undefined) return time
    for (let i = 0; i < members.length; i++) {
      if (i > 0) { if (!finite(record.dt[i - 1])) return null; time += record.dt[i - 1] }
      if (typeof members[i] !== 'string') return null
      if (members[i].length) return finite(time) ? time : null
    }
  }
  return null
}

// assistant/attempt has no top-level usage in DSH 0.2.0, but its compact
// stream preserves the provider's latest usage chunk. Read it without keeping
// any generated content or adding reasoning tokens already folded into output.
function lastStreamUsage(stream) {
  if (!Array.isArray(stream)) return null
  for (let i = stream.length - 1; i >= 0; i--) {
    const record = stream[i]
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage
  }
  return null
}

class TpsTracker {
  constructor({ enabled = () => true, limit = 64 } = {}) {
    this.enabled = enabled
    this.limit = limit
    this.states = new Map()
    this.listeners = new Map()
    this.subscribers = 0
    // Revisions restart on Agent replacement. Weak ownership distinguishes a
    // new lifecycle without retaining Agents, sessions, or their transcripts.
    this.agentOwners = new WeakMap()
  }
  read(id) { return this.states.get(canonicalSessionId(id))?.view || IDLE }
  notify(id, view) {
    for (const subscriber of this.listeners.get(id) || []) {
      try { subscriber.listener(view) } catch { subscriber.close() }
    }
  }
  publish(id, state, phase, rate, estimated = true) {
    const rounded = finite(rate) ? Math.round(rate * 10) / 10 : null
    const old = state.view
    state.phase = phase
    if (old && old.phase === phase && old.tokensPerSecond === rounded && old.estimated === estimated) return
    state.view = { phase, tokensPerSecond: rounded, estimated }
    // The UI shows integers. Keep precision for readers without sending invisible changes.
    if (old && old.phase === phase && old.estimated === estimated &&
        old.tokensPerSecond !== null && rounded !== null && Math.round(old.tokensPerSecond) === Math.round(rounded)) return
    this.notify(id, state.view)
  }
  put(id, state) {
    this.states.delete(id)
    if (this.states.size >= this.limit) {
      const oldest = [...this.states].find(([, s]) => s.phase !== 'streaming')?.[0] || this.states.keys().next().value
      this.states.delete(oldest)
      this.notify(oldest, IDLE)
    }
    this.states.set(id, state)
  }
  onFrame({ agent, frame } = {}) {
    const id = canonicalSessionId(agent?.session?.id)
    if (!this.enabled() || !validSessionId(id) || !frame || typeof frame.attemptId !== 'string') return
    const revision = Number.isSafeInteger(frame.revision) && frame.revision > 0 ? frame.revision : null
    let owner = null
    if (revision !== null && agent && typeof agent === 'object') {
      owner = this.agentOwners.get(agent)
      if (!owner) { owner = Symbol(); this.agentOwners.set(agent, owner) }
    }
    const previous = this.states.get(id)
    if (owner !== null && previous?.owner === owner && revision <= previous.revision) return
    if (frame.type === 'start') {
      const state = { attemptId: frame.attemptId, turn: frame.turn, step: frame.step, nextIndex: 0,
        first: null, last: null, lastFrameTime: null, total: 0, firstTokens: 0, invalid: false, owner, revision }
      this.put(id, state)
      this.publish(id, state, 'streaming', null)
      return
    }
    const state = this.states.get(id)
    if (!state || state.attemptId !== frame.attemptId) return
    if (owner !== null && state.owner !== null && state.owner !== owner) return
    if (revision !== null) state.revision = revision
    if (frame.type === 'end') {
      if (state.phase === 'streaming') this.publish(id, state, 'interrupted', state.view?.tokensPerSecond)
      return
    }
    if (frame.type !== 'chunk' || state.phase !== 'streaming' || state.invalid) return
    if (Number.isSafeInteger(frame.index) && frame.index < state.nextIndex) return // duplicate
    if (frame.index !== state.nextIndex || !finite(frame.time) || state.lastFrameTime !== null && frame.time < state.lastFrameTime) {
      state.invalid = true
      this.publish(id, state, 'streaming', null)
      return
    }
    state.nextIndex++
    state.lastFrameTime = frame.time
    const added = estimateTextTokens(deltaText(frame.chunk))
    // A name-bearing tool delta is the native first-token boundary even before
    // argument text arrives. Names are metadata, so they contribute no count.
    if (state.first === null && frame.chunk?.type === 'tool-call-delta' && frame.chunk.name !== undefined) state.first = frame.time
    if (!added) return
    state.total += added
    if (state.first === null) state.first = frame.time
    if (frame.time === state.first) state.firstTokens = state.total
    state.last = frame.time
    const elapsed = state.last - state.first
    this.publish(id, state, 'streaming', elapsed >= MIN_OBSERVATION_MS ? (state.total - state.firstTokens) * 1000 / elapsed : null)
  }
  onSession(session, event) {
    const id = canonicalSessionId(session?.id)
    if (!this.enabled() || !validSessionId(id) || !event) return
    const data = event.data || {}
    let state = this.states.get(id)
    if (event.type === 'step/end') {
      if (state?.phase === 'streaming' && state.turn === data.turn && state.step === data.step) this.publish(id, state, 'interrupted', state.view?.tokensPerSecond)
      return
    }
    if (!['assistant/message', 'assistant/attempt'].includes(event.type)) return
    if (state && (state.turn !== data.turn || state.step !== data.step)) {
      if (state.phase === 'streaming') return
      state = null
    }
    if (!state) { state = { turn: data.turn, step: data.step, first: null, invalid: true }; this.put(id, state) }
    const first = firstStreamTokenTime(data.stream) ?? (!state.invalid ? state.first : null)
    const elapsed = first !== null && finite(event.time) ? event.time - first : 0
    const exact = (data.usage ?? lastStreamUsage(data.stream))?.outputTokens
    const hasExact = finite(exact)
    // Never subtract an estimated first chunk from provider-reported tokens.
    const total = hasExact ? exact : !state.invalid ? state.total : null
    const rate = elapsed >= MIN_OBSERVATION_MS && finite(total) ? total * 1000 / elapsed : null
    this.publish(id, state, event.type === 'assistant/message' && data.interrupted !== true ? 'completed' : 'interrupted', rate, !hasExact)
  }
  subscribe(id, listener, close = () => {}) {
    id = canonicalSessionId(id)
    if (this.subscribers >= this.limit) throw new Error('busy')
    const set = this.listeners.get(id) || new Set()
    this.listeners.set(id, set)
    const subscriber = { listener, close }
    set.add(subscriber); this.subscribers++
    let active = true
    return () => {
      if (!active) return
      active = false; set.delete(subscriber); this.subscribers--
      if (!set.size) this.listeners.delete(id)
    }
  }
  reset() {
    this.states.clear()
    for (const set of [...this.listeners.values()]) for (const subscriber of [...set]) subscriber.close()
  }
}

// One latest snapshot per slow socket: no unbounded queue and no artificial
// update timer. The native event listener never waits on a browser connection.
function streamTps(tracker, id, req, res, signal) {
  return new Promise(resolve => {
    let closed = false, blocked = false, latest = null, unsubscribe = () => {}
    const close = () => {
      if (closed) return
      closed = true; unsubscribe()
      res.removeListener('close', close); res.removeListener('error', close); res.removeListener('drain', drain)
      signal?.removeEventListener('abort', close)
      if (!res.writableEnded) res.end()
      resolve()
    }
    const write = view => {
      if (closed) return
      if (blocked) { latest = view; return }
      try { blocked = !res.write('data: ' + JSON.stringify({ sessionId: id, ...view }) + '\n\n') } catch { close() }
    }
    const drain = () => { blocked = false; if (latest) { const view = latest; latest = null; write(view) } }
    try { unsubscribe = tracker.subscribe(id, write, close) } catch {
      res.writeHead(503); res.end(); resolve(); return
    }
    res.on('close', close); res.on('error', close); res.on('drain', drain)
    signal?.addEventListener('abort', close, { once: true })
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
    res.flushHeaders?.()
    if (signal?.aborted || res.destroyed) close()
    else write(tracker.read(id))
  })
}

export { TpsTracker, streamTps, estimateTextTokens, firstStreamTokenTime, validSessionId }
