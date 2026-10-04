'use strict'

import { z } from 'zod'

const HISTORY_LIMIT = 64
const ID_LIMIT = 256
const NAME_LIMIT = 128
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const timestamp = z.number().finite().nonnegative().nullable()
const phaseSchema = z.enum(['waiting', 'thinking', 'tools', 'stopped'])
const toolSchema = z.object({
  callId: z.string().min(1).max(ID_LIMIT), name: z.string().min(1).max(NAME_LIMIT).nullable(),
  startedAt: timestamp, endedAt: timestamp,
  status: z.enum(['running', 'completed', 'failed', 'cancelled', 'not-started', 'unknown', 'stopped']),
  timingBasis: z.enum(['call-record', 'dispatch-record']),
}).strict()
const storedToolSchema = toolSchema.extend({ turn: count, step: count }).strict()
const viewSchema = z.object({
  phase: phaseSchema, turn: count.nullable(), step: count.nullable(),
  activeCount: count.nullable(), tools: z.array(toolSchema).max(HISTORY_LIMIT), truncated: z.boolean(),
  scope: z.literal('session-only'), excludesInherited: z.literal(true),
}).strict()
const stateSchema = z.object({
  inheritedEventCount: count, lastSeq: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
  turn: count.nullable(), step: count.nullable(), turnOpen: z.boolean(), phase: phaseSchema,
  calls: z.array(storedToolSchema).max(HISTORY_LIMIT), activeIncomplete: z.boolean(),
  truncated: z.boolean(), view: viewSchema,
}).strict()

const validCount = value => Number.isSafeInteger(value) && value >= 0
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= ID_LIMIT
const timeOf = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const endTime = (call, time) => {
  const end = timeOf(time)
  return end !== null && (call.startedAt === null || end >= call.startedAt) ? end : null
}
const isRunning = call => call.status === 'running'
const inStep = (state, data) => state.turnOpen && state.step !== null && state.turn === data.turn && state.step === data.step

function makeView(state, previous) {
  const tools = previous && previous.calls === state.calls ? previous.view.tools : state.calls.map(call => ({
    callId: call.callId, name: call.name, startedAt: call.startedAt, endedAt: call.endedAt,
    status: call.status, timingBasis: call.timingBasis,
  }))
  const activeCount = state.activeIncomplete ? null : state.calls.filter(isRunning).length
  const old = previous?.view
  if (old && old.phase === state.phase && old.turn === state.turn && old.step === state.step &&
      old.activeCount === activeCount && old.truncated === state.truncated && old.tools === tools) return old
  return { phase: state.phase, turn: state.turn, step: state.step, activeCount, tools, truncated: state.truncated,
    scope: 'session-only', excludesInherited: true }
}

function finish(state, patch, seq) {
  const next = { ...state, ...patch, lastSeq: seq }
  next.view = makeView(next, state)
  return next
}

function stopPending(calls, time) {
  if (!calls.some(isRunning)) return calls
  // A boundary proves that waiting ended, not that the tool succeeded or even
  // that its external side effects stopped. Keep the outcome explicitly unknown.
  return calls.map(call => isRunning(call) ? { ...call, status: 'stopped', endedAt: endTime(call, time) } : call)
}

function appendCall(state, call) {
  let calls = [...state.calls, call], activeIncomplete = state.activeIncomplete, truncated = state.truncated
  if (calls.length > HISTORY_LIMIT) {
    const settled = calls.findIndex(item => !isRunning(item))
    const index = settled < 0 ? 0 : settled
    activeIncomplete ||= isRunning(calls[index])
    calls.splice(index, 1)
    truncated = true
  }
  return { calls, activeIncomplete, truncated }
}

function resultStatus(isError, code, nested) {
  // Native top-level results may omit isError; PTC settlements require it.
  // Malformed flags must not turn an unknown outcome into apparent success.
  if (isError === false || isError === undefined && !nested) return 'completed'
  if (isError !== true) return 'unknown'
  if (code === 'ABORTED_BEFORE_DISPATCH' || code === 'TOOL_NOT_STARTED') return 'not-started'
  if (code === 'ABORTED') return 'cancelled'
  if (code === 'TOOL_OUTCOME_UNKNOWN') return 'unknown'
  return 'failed'
}

function applyToolActivity(state, event) {
  if (!event || !validCount(event.seq) || event.seq < state.inheritedEventCount || event.seq <= state.lastSeq) return state
  const data = event.data || {}, seq = event.seq
  if (event.type === 'turn/start') {
    if (!validCount(data.turn)) return state
    if (state.turnOpen && state.turn === data.turn) return finish(state, {}, seq)
    return finish(state, { turn: data.turn, step: null, turnOpen: true, phase: 'waiting',
      calls: stopPending(state.calls, event.time), activeIncomplete: false }, seq)
  }
  if (event.type === 'turn/end') {
    if (!state.turnOpen || state.turn !== data.turn) return state
    return finish(state, { turnOpen: false, step: null, phase: 'stopped',
      calls: stopPending(state.calls, event.time), activeIncomplete: false }, seq)
  }
  if (event.type === 'step/start') {
    if (!state.turnOpen || state.turn !== data.turn || !validCount(data.step)) return state
    if (state.step === data.step) return finish(state, {}, seq)
    return finish(state, { step: data.step, phase: 'thinking',
      calls: stopPending(state.calls, event.time), activeIncomplete: false }, seq)
  }
  if (event.type === 'step/end') {
    if (!inStep(state, data)) return state
    return finish(state, { step: null, phase: 'waiting',
      calls: stopPending(state.calls, event.time), activeIncomplete: false }, seq)
  }
  if (event.type === 'assistant/message' || event.type === 'assistant/attempt' ||
      event.type === 'llm/retry' || event.type === 'llm/retry-started') {
    if (!inStep(state, data)) return state
    const active = state.activeIncomplete || state.calls.some(isRunning)
    const phase = active ? 'tools' : event.type === 'llm/retry-started' ? 'thinking' : 'waiting'
    if (state.phase === phase) return finish(state, {}, seq)
    // Model-step boundaries are sufficient: no stream, reasoning or content is read.
    return finish(state, { phase }, seq)
  }

  const start = event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start'
  const result = event.type === 'tool/result' || event.type === 'tool/ptc-dispatch'
  if (!start && !result) return state
  const nested = event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch'
  if (!state.turnOpen || state.step === null || !nested && !inStep(state, data)) return state
  // Content-only surface replacements are not a second tool execution.
  if (event.type === 'tool/result' && event.surfaceOp !== 'append') return state
  const callId = nested ? data.subCallId : start ? data.callId : data.message?.source?.callId
  if (!validId(callId)) {
    if (!start) return state
    return finish(state, { phase: 'tools', activeIncomplete: true, truncated: true }, seq)
  }
  const basis = nested ? 'dispatch-record' : 'call-record'
  const index = state.calls.findIndex(call => call.callId === callId && call.turn === state.turn &&
    call.step === state.step && call.timingBasis === basis)
  if (start) {
    if (index !== -1) return finish(state, {}, seq)
    // Exclude fork-tail closers and unrelated sub-dispatches. A PTC event has
    // no turn/step fields; its recorded root must belong to this own step.
    if (nested && !state.calls.some(call => call.callId === data.rootCallId && call.turn === state.turn &&
        call.step === state.step) && !state.activeIncomplete) return state
    const name = typeof data.name === 'string' && data.name.length > 0 && data.name.length <= NAME_LIMIT ? data.name : null
    const patch = appendCall(state, { callId, name, startedAt: timeOf(event.time), endedAt: null, status: 'running',
      timingBasis: basis, turn: state.turn, step: state.step })
    return finish(state, { ...patch, phase: 'tools' }, seq)
  }
  // A synthetic TOOL_NOT_STARTED result without tool/call is not an execution.
  // Its name would require reading assistant content, so it is deliberately omitted.
  if (index === -1 || !isRunning(state.calls[index])) return state
  const calls = state.calls.slice()
  calls[index] = { ...calls[index], endedAt: endTime(calls[index], event.time),
    status: resultStatus(nested ? data.isError : data.message?.isError, data.error?.code, nested) }
  const phase = state.activeIncomplete || calls.some(isRunning) ? 'tools' : 'waiting'
  return finish(state, { calls, phase }, seq)
}

function createToolActivityProjection() {
  return {
    key: 'statuslineToolActivity', stateVersion: 1, stateSchema,
    init(_header, inheritedEventCount = 0) {
      const state = { inheritedEventCount: validCount(inheritedEventCount) ? inheritedEventCount : 0,
        lastSeq: -1, turn: null, step: null, turnOpen: false, phase: 'stopped',
        calls: [], activeIncomplete: false, truncated: false }
      return { ...state, view: makeView(state) }
    },
    apply: applyToolActivity,
    wire: { viewSchema, view: state => state.view },
  }
}

export { createToolActivityProjection, HISTORY_LIMIT }
