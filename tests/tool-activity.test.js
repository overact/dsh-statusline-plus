'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const { createToolActivityProjection, HISTORY_LIMIT } = require('../lib/tool-activity')

function fold(inheritedEventCount = 0) {
  const definition = createToolActivityProjection()
  let state = definition.init({}, inheritedEventCount), seq = 0
  return {
    definition,
    get state() { return state },
    get view() { return definition.wire.view(state) },
    event(type, data = {}, time = 1000 + seq, extra = {}) {
      state = definition.apply(state, { type, data, time, seq: seq++, ...extra })
      definition.stateSchema.parse(state)
      definition.wire.viewSchema.parse(definition.wire.view(state))
      return state
    },
    open(turn = 1, step = 1) {
      this.event('turn/start', { turn }); this.event('step/start', { turn, step })
    },
    call(callId = 'call-1', name = 'read_file', turn = 1, step = 1, time = 2000) {
      return this.event('tool/call', { turn, step, callId, name, arguments: 'private arguments' }, time)
    },
    result(callId = 'call-1', isError = false, code, turn = 1, step = 1, time = 3000, extra = {}) {
      return this.event('tool/result', { turn, step, message: { source: { kind: 'tool', callId },
        isError, content: [{ type: 'text', text: 'private output' }] }, ...(code ? { error: { code } } : {}) },
      time, { surfaceOp: 'append', ...extra })
    },
  }
}

test('durable boundaries drive truthful phases without reading model content or guessing success', () => {
  const f = fold()
  assert.equal(f.view.phase, 'stopped'); assert.equal(f.view.activeCount, 0)
  f.event('turn/start', { turn: 1 }); assert.equal(f.view.phase, 'waiting')
  f.event('step/start', { turn: 1, step: 1 }); assert.equal(f.view.phase, 'thinking')
  f.event('assistant/attempt', { turn: 1, step: 1 }); assert.equal(f.view.phase, 'waiting')
  f.event('llm/retry', { turn: 1, step: 1 }); assert.equal(f.view.phase, 'waiting')
  f.event('llm/retry-started', { turn: 1, step: 1 }); assert.equal(f.view.phase, 'thinking')
  f.event('assistant/message', { turn: 1, step: 1, interrupted: true }); assert.equal(f.view.phase, 'waiting')
  f.call(); assert.equal(f.view.phase, 'tools')
  f.event('step/end', { turn: 1, step: 1 }, 4000)
  assert.equal(f.view.phase, 'waiting'); assert.equal(f.view.tools[0].status, 'stopped')
  assert.equal(f.view.tools[0].endedAt, 4000)
  f.event('turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(f.view.phase, 'stopped'); assert.equal(f.view.tools[0].status, 'stopped')
})

test('parallel calls remain independently pending until their durable results settle', () => {
  const f = fold(); f.open(); f.call('a', 'read_file', 1, 1, 100)
  f.call('b', 'search', 1, 1, 110)
  assert.equal(f.view.activeCount, 2)
  f.result('b', false, undefined, 1, 1, 200)
  assert.equal(f.view.activeCount, 1); assert.equal(f.view.phase, 'tools')
  assert.deepEqual(f.view.tools.map(tool => tool.status), ['running', 'completed'])
  f.result('a', true, 'TOOL_EXECUTION_FAILED', 1, 1, 250)
  assert.equal(f.view.activeCount, 0); assert.equal(f.view.phase, 'waiting')
  assert.deepEqual(f.view.tools.map(tool => tool.status), ['failed', 'completed'])
  assert.equal(f.view.tools[0].timingBasis, 'call-record')
  f.event('turn/end', { turn: 1, reason: { kind: 'error' } })
  assert.equal(f.view.tools[1].status, 'completed')
})

test('native cancellation and recovery identities distinguish unstarted, cancelled and unknown outcomes', () => {
  const f = fold(); f.open()
  const expected = { ABORTED_BEFORE_DISPATCH: 'not-started', ABORTED: 'cancelled',
    TOOL_NOT_STARTED: 'not-started', TOOL_OUTCOME_UNKNOWN: 'unknown', TOOL_ARGS_INVALID: 'failed' }
  for (const [code, status] of Object.entries(expected)) {
    f.call(code); f.result(code, true, code)
    assert.equal(f.view.tools.at(-1).status, status)
  }
  const before = f.state
  f.result('never-recorded', true, 'TOOL_NOT_STARTED')
  assert.equal(f.state, before)
  f.call('still-pending')
  f.event('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }, 4000)
  assert.equal(f.view.tools.at(-1).status, 'stopped')
  assert.equal(f.view.activeCount, 0)
})

test('native PTC start and settlement expose actual nested tool identities without transport contents', () => {
  const f = fold(); f.open(); f.call('root', 'run_code')
  const nested = { rootCallId: 'root', parentCallId: 'root', subCallId: 'root:ptc:1', name: 'web_fetch', arguments: { private: 'url' } }
  f.event('tool/ptc-dispatch-start', nested, 2200)
  assert.equal(f.view.activeCount, 2)
  assert.equal(f.view.tools[1].name, 'web_fetch')
  assert.equal(f.view.tools[1].timingBasis, 'dispatch-record')
  f.event('tool/ptc-dispatch', { ...nested, isError: true, error: { code: 'ABORTED' }, content: [] }, 2300)
  assert.equal(f.view.tools[1].status, 'cancelled'); assert.equal(f.view.activeCount, 1)
  f.result('root', false)
  assert.equal(f.view.activeCount, 0)
  const unrelated = f.state
  f.event('tool/ptc-dispatch-start', { ...nested, rootCallId: 'foreign', subCallId: 'foreign:ptc:1' })
  assert.equal(f.state, unrelated)
})

test('malformed outcome flags stay unknown, while optional native top-level isError remains supported', () => {
  const f = fold(); f.open(); f.call('root', 'run_code')
  for (const flag of [null, 'false', 0]) {
    const id = 'invalid-' + String(flag)
    f.call(id); f.result(id, flag)
    assert.equal(f.view.tools.at(-1).status, 'unknown')
  }
  f.call('legacy-optional')
  f.event('tool/result', { turn: 1, step: 1, message: { source: { callId: 'legacy-optional' } } }, 3000, { surfaceOp: 'append' })
  assert.equal(f.view.tools.at(-1).status, 'completed')
  const nested = { rootCallId: 'root', parentCallId: 'root', subCallId: 'root:ptc:missing', name: 'read_file' }
  f.event('tool/ptc-dispatch-start', nested)
  f.event('tool/ptc-dispatch', nested)
  assert.equal(f.view.tools.at(-1).status, 'unknown')
})

test('arguments, commands, prompts, responses, streams and raw failure reasons are never accessed or retained', () => {
  const privateField = (object, key) => Object.defineProperty(object, key, { get() { throw new Error('private field accessed') } })
  const f = fold(); f.open()
  const call = { turn: 1, step: 1, callId: 'safe-id', name: 'run_code' }
  privateField(call, 'arguments'); f.event('tool/call', call)
  const assistant = { turn: 1, step: 1 }
  privateField(assistant, 'message'); privateField(assistant, 'stream'); f.event('assistant/message', assistant)
  const nested = { rootCallId: 'safe-id', parentCallId: 'safe-id', subCallId: 'safe-id:ptc:1', name: 'read_file' }
  privateField(nested, 'arguments'); f.event('tool/ptc-dispatch-start', nested)
  const failure = { code: 'TOOL_ARGS_INVALID' }; privateField(failure, 'reason'); privateField(failure, 'name')
  const settled = { rootCallId: 'safe-id', subCallId: 'safe-id:ptc:1', isError: true, error: failure }
  privateField(settled, 'content'); privateField(settled, 'arguments'); f.event('tool/ptc-dispatch', settled)
  const message = { source: { kind: 'tool', callId: 'safe-id' }, isError: true }
  privateField(message, 'content')
  const result = { turn: 1, step: 1, message, error: failure }; privateField(result, 'meta')
  f.event('tool/result', result, 3000, { surfaceOp: 'append' })
  const serialized = JSON.stringify(f.state)
  assert.doesNotMatch(serialized, /arguments|content|stream|message|reason|meta|command|prompt|rootCallId|parentCallId/)
  assert.deepEqual(Object.keys(f.view.tools[0]).sort(), ['callId', 'endedAt', 'name', 'startedAt', 'status', 'timingBasis'])
})

test('duplicate and stale replay frames do not reopen calls, and surface replacements do no work', () => {
  const f = fold(); f.open(); f.call('same')
  const firstView = f.view
  f.call('same')
  assert.equal(f.view, firstView); assert.equal(f.view.tools.length, 1)
  const beforeReplacement = f.state
  f.result('same', true, 'FAILED', 1, 1, 3000, { surfaceOp: 'replace', sourceEventSeqs: [2] })
  assert.equal(f.state, beforeReplacement); assert.equal(f.view.activeCount, 1)
  f.result('same'); const settled = f.state
  f.event('tool/call', { turn: 1, step: 1, callId: 'same', name: 'read_file' }, 2000, { seq: 2 })
  assert.equal(f.state, settled)
  f.result('same', true, 'FAILED'); assert.equal(f.state, settled)
  f.event('step/end', { turn: 1, step: 1 }); f.event('step/start', { turn: 1, step: 2 })
  f.call('same', 'search', 1, 2); assert.equal(f.view.tools.length, 2)
  assert.equal(f.view.tools[1].status, 'running')
})

test('inherited prefix and fork-tail recovery never appear as local tool activity', () => {
  const f = fold(4)
  f.open(); f.call('parent'); f.result('parent')
  assert.equal(f.view.tools.length, 0); assert.equal(f.view.phase, 'stopped')
  f.event('session/end-seed', { inherited: true })
  f.result('parent', true, 'TOOL_OUTCOME_UNKNOWN')
  f.event('step/end', { turn: 1, step: 1 }); f.event('turn/end', { turn: 1, reason: { kind: 'forked' } })
  assert.equal(f.view.tools.length, 0); assert.equal(f.view.turn, null)
  f.open(2); f.call('child', 'read_file', 2)
  assert.equal(f.view.tools.length, 1); assert.equal(f.view.tools[0].callId, 'child')
  assert.equal(f.view.scope, 'session-only'); assert.equal(f.view.excludesInherited, true)
})

test('bounded history prioritizes pending calls and over-capacity activity is explicitly unknown', () => {
  const f = fold(); f.open(); f.call('keep-pending')
  for (let index = 0; index < HISTORY_LIMIT + 10; index++) { f.call('done-' + index); f.result('done-' + index) }
  assert.equal(f.view.tools.length, HISTORY_LIMIT); assert.equal(f.view.tools[0].callId, 'keep-pending')
  assert.equal(f.view.activeCount, 1); assert.equal(f.view.truncated, true)
  for (let index = 0; index < HISTORY_LIMIT; index++) f.call('active-' + index)
  assert.equal(f.view.tools.length, HISTORY_LIMIT); assert.equal(f.view.activeCount, null)
  for (let index = 0; index < HISTORY_LIMIT; index++) f.result('active-' + index)
  assert.equal(f.view.activeCount, null); assert.equal(f.view.phase, 'tools')
  f.event('step/end', { turn: 1, step: 1 })
  assert.equal(f.view.activeCount, 0); assert.equal(f.view.phase, 'waiting')
  assert.equal(f.view.truncated, true)
})

test('missing and backwards timestamps stay unknown and oversized metadata remains bounded', () => {
  const f = fold(); f.open(); f.call('clock', 'read_file', 1, 1, 2000)
  f.result('clock', false, undefined, 1, 1, 1000)
  assert.equal(f.view.tools[0].endedAt, null)
  f.call('no-clock', 'read_file', 1, 1, NaN); f.result('no-clock', false, undefined, 1, 1, Infinity)
  assert.equal(f.view.tools[1].startedAt, null); assert.equal(f.view.tools[1].endedAt, null)
  f.call('long-name', 'n'.repeat(10000)); assert.equal(f.view.tools[2].name, null)
  f.call('i'.repeat(10000)); assert.equal(f.view.activeCount, null); assert.equal(f.view.truncated, true)
  assert.ok(JSON.stringify(f.state).length < 10000)
})

test('unrelated events retain exact state/view references and checkpoints continue the same fold', () => {
  const f = fold(); f.open(); f.call()
  const before = f.state, view = f.view
  f.event('user/message', { content: 'private prompt' }); f.event('request/header', { header: {} })
  f.event('tool/result', { turn: 20, step: 1, message: { source: { callId: 'call-1' } } }, 2500, { surfaceOp: 'append' })
  assert.equal(f.state, before); assert.equal(f.view, view)
  const restored = f.definition.stateSchema.parse(JSON.parse(JSON.stringify(before)))
  const next = { type: 'tool/result', seq: 20, time: 3000, surfaceOp: 'append',
    data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'call-1' }, isError: false } } }
  const continued = f.definition.apply(restored, next)
  assert.deepEqual(continued.view, f.definition.apply(before, next).view)
  assert.equal(continued.view.tools[0].status, 'completed')
})

test('native DSH 0.2.0 registry registers, folds PTC, restores checkpoints and tears down the wire capability', async t => {
  const fromDsh = createRequire(process.env.DSH_PACKAGE_DIR ? join(process.env.DSH_PACKAGE_DIR, 'package.json') : require.resolve('@deepseek-ai/dsh/package.json'))
  const dsh = name => import(pathToFileURL(fromDsh.resolve('@deepseek-ai/' + name)).href)
  const [{ Context }, { SessionStore }, { SessionProjectionRegistry }, { createToolResultMessage, createAssistantMessage }] = await Promise.all([
    dsh('cordis'), dsh('dsh-session'), dsh('dsh-session-projection'), dsh('dsh-llm'),
  ])
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  new SessionStore(ctx); new SessionProjectionRegistry(ctx)
  const definition = createToolActivityProjection(), changes = []
  const fiber = ctx.plugin({ name: 'tool-activity-fixture', inject: ['sessionProjections'], apply(scope) {
    scope.sessionProjections.register(definition)
    scope.sessionProjections.onChanged((_session, key, value) => changes.push({ key, value }))
  } })
  await fiber.await()
  const session = ctx.sessions.create('session-12345678-1234-4234-8234-123456789abc')
  session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
    source: { provider: 'fixture', model: 'fixture' }, content: [{ type: 'tool-call', id: 'root', name: 'run_code', arguments: '{"fixture":true}' }],
  }) }, { surfaceOp: 'append' })
  const call = session.append('tool/call', { turn: 1, step: 1, callId: 'root', name: 'run_code', arguments: '{"fixture":true}' })
  const nested = { rootCallId: 'root', parentCallId: 'root', subCallId: 'root:ptc:1', name: 'read_file', arguments: {} }
  session.append('tool/ptc-dispatch-start', nested)
  const running = ctx.sessionProjections.snapshot(session, ['statuslineToolActivity']).values.statuslineToolActivity
  assert.equal(running.activeCount, 2); assert.equal(running.tools[1].name, 'read_file')
  const checkpoint = ctx.sessionProjections.checkpoint(session)
  assert.equal(ctx.sessionProjections.viewCheckpoint(checkpoint).statuslineToolActivity.activeCount, 2)
  const child = ctx.sessions.fork(session, undefined, 'session-12345678-1234-4234-8234-123456789abd')
  const inherited = ctx.sessionProjections.snapshot(child, ['statuslineToolActivity']).values.statuslineToolActivity
  assert.deepEqual(inherited.tools, []); assert.equal(inherited.turn, null); assert.equal(inherited.phase, 'stopped')
  assert.ok(child.snapshotEvents().some(event => event.type === 'tool/result' && event.data.error?.code === 'TOOL_OUTCOME_UNKNOWN'))
  child.append('turn/start', { turn: 2 }); child.append('step/start', { turn: 2, step: 1 })
  child.append('tool/call', { turn: 2, step: 1, callId: 'child-call', name: 'search', arguments: '{}' })
  assert.deepEqual(ctx.sessionProjections.snapshot(child, ['statuslineToolActivity']).values.statuslineToolActivity.tools.map(tool => tool.callId), ['child-call'])
  session.append('tool/ptc-dispatch', { ...nested, isError: false, content: [] })
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'root', content: [], isError: false }) },
    { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  session.append('step/end', { turn: 1, step: 1 }); session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const finished = ctx.sessionProjections.snapshot(session, ['statuslineToolActivity']).values.statuslineToolActivity
  assert.equal(finished.activeCount, 0); assert.equal(finished.phase, 'stopped')
  assert.deepEqual(finished.tools.map(tool => tool.status), ['completed', 'completed'])
  const floor = ctx.sessionProjections.restoreFloor(checkpoint)
  const restored = ctx.sessionProjections.restore(checkpoint, session.snapshotEvents(floor), floor, session.header, session.inheritedEventCount)
  assert.deepEqual(restored.snapshot.values.statuslineToolActivity, finished)
  assert.ok(changes.some(change => change.key === 'statuslineToolActivity' && change.value.activeCount === 2))
  await fiber.dispose()
  assert.equal(ctx.sessionProjections.snapshot(session, ['statuslineToolActivity']).values.statuslineToolActivity, undefined)
  const remount = ctx.plugin({ name: 'tool-activity-remount', inject: ['sessionProjections'], apply(scope) {
    scope.sessionProjections.register(createToolActivityProjection())
  } })
  await remount.await()
  assert.deepEqual(ctx.sessionProjections.snapshot(session, ['statuslineToolActivity']).values.statuslineToolActivity, finished)
  await remount.dispose()
  assert.equal(ctx.sessionProjections.snapshot(session, ['statuslineToolActivity']).values.statuslineToolActivity, undefined)
})
