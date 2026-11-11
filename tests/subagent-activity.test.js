'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createSubagentActivityProjection, CHILD_LIMIT } = require('../lib/subagent-activity')

function fold(inheritedEventCount = 0) {
  const definition = createSubagentActivityProjection()
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
    catalog(childId, mode = 'external', label = 'worker', time) {
      return this.event('subagent/catalog', { version: 2, childId, childCreatedAt: 1234, mode, label }, time)
    },
    settled(childId, time) {
      return this.event('user/message', { role: 'user', content: [{ type: 'text', text: 'private output' }],
        source: { kind: 'subagent-settled', form: 'notice', summary: 'private summary', senderSessionId: childId } }, time)
    },
  }
}

test('external children gain a durable running state and settlement edge from the parent log', () => {
  const f = fold()
  assert.deepEqual(f.view, { children: [], truncated: false })
  f.catalog('external-a', 'external', 'Claude Code review', 2000)
  assert.deepEqual(f.view.children, [{ id: 'external-a', mode: 'external', label: 'Claude Code review', createdAt: 2000, settledAt: null }])
  f.settled('external-a', 9000)
  assert.equal(f.view.children[0].settledAt, 9000)
  // A second settlement for the same child is the latest epoch, not a duplicate row.
  f.settled('external-a', 12000)
  assert.equal(f.view.children.length, 1)
  assert.equal(f.view.children[0].settledAt, 12000)
})

test('local modes, unknown modes and missing labels stay distinguishable', () => {
  const f = fold()
  f.catalog('a', 'one-shot', null, 100)
  f.catalog('b', 'continuable', 'Reviewer', 110)
  f.catalog('c', 'external', 'Codex', 120)
  f.catalog('d', 'something-new', 'Future', 130)
  assert.deepEqual(f.view.children.map(child => [child.mode, child.label]), [
    ['one-shot', null], ['continuable', 'Reviewer'], ['external', 'Codex'], ['unknown', 'Future'],
  ])
})

test('inherited catalog and settlement facts from a fork seed are excluded', () => {
  const f = fold(5)
  f.event('subagent/catalog', { version: 2, childId: 'inherited', childCreatedAt: 1, mode: 'external', label: 'ancestor' }, 100, { seq: 4 })
  f.event('user/message', { source: { kind: 'subagent-settled', senderSessionId: 'inherited' } }, 200, { seq: 4 })
  assert.deepEqual(f.view.children, [])
  f.event('subagent/catalog', { version: 2, childId: 'own', childCreatedAt: 1, mode: 'external', label: 'own' }, 300, { seq: 5 })
  assert.deepEqual(f.view.children.map(child => child.id), ['own'])
})

test('malformed facts are ignored without throwing or inventing a child', () => {
  const f = fold()
  const before = f.state
  f.event('subagent/catalog', { childId: '', mode: 'external' }, 100)
  f.event('subagent/catalog', { childId: 'x'.repeat(300), mode: 'external' }, 110)
  f.event('subagent/catalog', { childId: 'ok', mode: 'external' }, 120, { time: null })
  assert.equal(f.state, before)
  f.event('user/message', { source: { kind: 'agent-message', senderSessionId: 'ok' } }, 200)
  f.event('user/message', { source: { kind: 'subagent-settled' } }, 210)
  f.event('user/message', { source: { kind: 'subagent-settled', senderSessionId: 'never-seen' } }, 220)
  assert.deepEqual(f.view.children, [])
  f.catalog('ok', 'external', 'worker', 300)
  f.settled('ok', 400)
  assert.equal(f.view.children[0].settledAt, 400)
})

test('duplicate discovery keeps the first origin and refreshes only metadata', () => {
  const f = fold()
  f.catalog('a', 'external', 'first', 100)
  f.settled('a', 150)
  f.catalog('a', 'external', 'renamed', 200)
  assert.deepEqual(f.view.children, [{ id: 'a', mode: 'external', label: 'renamed', createdAt: 100, settledAt: 150 }])
})

test('the child list stays bounded and evicts a settled child before a running one', () => {
  const f = fold()
  f.catalog('settled', 'external', 'done', 100)
  f.settled('settled', 150)
  for (let index = 0; index < CHILD_LIMIT; index++) f.catalog('running-' + index, 'external', 'run', 200 + index)
  assert.equal(f.view.children.length, CHILD_LIMIT)
  assert.equal(f.view.truncated, true)
  assert.equal(f.view.children.some(child => child.id === 'settled'), false)
  assert.equal(f.view.children[0].id, 'running-0')
})
