'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createTtlMap } = require('../lib/ttl-map')

test('a TTL map expires on read and keeps the newest value for the limit', () => {
  let now = 1000
  const map = createTtlMap({ ttlMs: 500, limit: 2, now: () => now })
  map.set('a', 1)
  map.set('b', 2)
  assert.equal(map.get('a'), 1)
  now = 1500
  assert.equal(map.get('a'), undefined, 'the entry expired exactly at its TTL')
  map.set('c', 3)
  assert.equal(map.size, 2, 'the expired entry did not reserve a slot')
  map.set('d', 4)
  assert.equal(map.get('b'), undefined, 'the oldest entry was evicted')
  assert.equal(map.get('c'), 3)
  assert.equal(map.get('d'), 4)
})

test('a per-entry TTL overrides the map default, and clear drops everything', () => {
  let now = 0
  const map = createTtlMap({ ttlMs: 1000, now: () => now })
  map.set('short', 'x', 100)
  map.set('long', 'y')
  now = 101
  assert.equal(map.get('short'), undefined)
  assert.equal(map.get('long'), 'y')
  map.clear()
  assert.equal(map.size, 0)
})
