'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { RequestPool } = require('../lib/request-pool')
const tick = () => new Promise(setImmediate)

test('concurrent refreshes share one request; only the last subscriber cancels it', async () => {
  const pool = new RequestPool()
  let calls = 0, resolve, upstream
  const load = signal => { calls++; upstream = signal; return new Promise(r => { resolve = r }) }
  const a = new AbortController(), b = new AbortController()
  const first = pool.run('codex', load, { signal: a.signal, force: true })
  const second = pool.run('codex', load, { signal: b.signal, force: true })
  await tick(); assert.equal(calls, 1)
  a.abort(new Error('left')); await assert.rejects(first, /left/)
  assert.equal(upstream.aborted, false)
  resolve('quota'); assert.equal(await second, 'quota')
  assert.equal(pool.entries.size, 0)
  pool.close()
})

test('last subscriber leaving aborts work and frees the entry', async () => {
  const pool = new RequestPool()
  const controller = new AbortController()
  let upstream
  const pending = pool.run('one', signal => { upstream = signal; return new Promise(() => {}) }, { signal: controller.signal })
  await tick(); controller.abort(new Error('gone'))
  await assert.rejects(pending, /gone/); await tick()
  assert.equal(upstream.aborted, true); assert.equal(pool.entries.size, 0)
  pool.close()
})

test('429 backoff cannot be bypassed by force and expires predictably', async () => {
  let now = 0, calls = 0
  const pool = new RequestPool({ now: () => now })
  const load = async () => { calls++; throw new Error('rate-limit') }
  await assert.rejects(pool.run('quota', load), /rate-limit/)
  await assert.rejects(pool.run('quota', load, { force: true }), /rate-limit/)
  assert.equal(calls, 1)
  now = 60001
  await assert.rejects(pool.run('quota', load), /rate-limit/)
  assert.equal(calls, 2); pool.close()
})

test('config invalidation cancels old results and never overwrites new cache entries', async () => {
  const pool = new RequestPool()
  let resolveOld
  const old = pool.run('same-provider', () => new Promise(r => { resolveOld = r }))
  await tick(); pool.clear(); await assert.rejects(old, /invalidated/)
  assert.equal(await pool.run('same-provider', async () => 'new'), 'new')
  resolveOld('old'); await tick()
  assert.equal(await pool.run('same-provider', async () => 'wrong'), 'new')
  pool.close()
})

test('deadline, bounded cache and plugin teardown leave no in-flight entries', async () => {
  const pool = new RequestPool({ limit: 2, timeoutMs: 10 })
  await assert.rejects(pool.run('hang', () => new Promise(() => {})), /timeout/)
  for (const key of ['a', 'b', 'c']) await pool.run(key, async () => key)
  assert.equal(pool.cache.size, 2)
  const pending = pool.run('running', () => new Promise(() => {}))
  pool.close(); await assert.rejects(pending, /invalidated/)
  assert.equal(pool.cache.size, 0); assert.equal(pool.entries.size, 0)
  await assert.rejects(pool.run('other', async () => 1), /disabled/)
})

test('invalidation before dispatch prevents even starting the loader', async () => {
  const pool = new RequestPool()
  let calls = 0
  const pending = pool.run('queued', async () => { calls++; return 'obsolete' })
  pool.clear()
  await assert.rejects(pending, /invalidated/)
  assert.equal(calls, 0)
  pool.close()
})
