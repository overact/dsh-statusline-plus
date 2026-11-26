'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { acceptEvent, inheritedCount, timeOf, validId } = require('../lib/session-fold.js')

test('the fold gate keeps this session and rejects older or repeated events', () => {
  assert.equal(acceptEvent({ seq: 4 }, 4), true, 'the boundary itself is accepted, as before')
  assert.equal(acceptEvent({ seq: 3 }, 4), false)
  assert.equal(acceptEvent({ seq: 5 }, 4, 5), false, 'a repeated seq is not folded twice')
  assert.equal(acceptEvent({ seq: 6 }, 4, 5), true)
  assert.equal(acceptEvent({ seq: '6' }, 4), false)
  assert.equal(acceptEvent(null, 0), false)
})

test('invalid inherited counts and ids collapse to safe defaults', () => {
  assert.equal(inheritedCount(3), 3)
  assert.equal(inheritedCount(-1), 0)
  assert.equal(inheritedCount(1.5), 0)
  assert.equal(validId('child'), true)
  assert.equal(validId(''), false)
  assert.equal(validId('x'.repeat(257)), false)
  assert.equal(timeOf(0), 0)
  assert.equal(timeOf(Infinity), null)
})
