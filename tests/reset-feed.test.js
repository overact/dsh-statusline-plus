'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { ResetFeed, FEED_URL, POLL_MS, DEFAULT_RESET_KINDS, parseResetFeed, pickResetNotices, sanitizeResetKinds } = require('../lib/reset-feed.js')

// Invented values shaped like the live /api/v1/<kind>-resets/recent response.
const NOW = Date.parse('2026-11-22T12:00:00+08:00')
const H = 3600000
const at = ms => new Date(ms).toISOString()
function event(over) {
  return Object.assign({
    id: 'reset-1', type: 'direct_reset', label: '全员重置', displayLabel: '额度重置', status: 'confirmed',
    title: 'Codex 额度重置已完成', scope: '', createdAt: at(NOW - 2 * H), updatedAt: at(NOW - 2 * H),
    confirmedAt: at(NOW - 2 * H), occurredOn: null, confirmationBasis: null, schedule: null, estimate: null,
    presentation: { status: 'confirmed', scopeKnown: true, scopeLabel: 'Plus / Pro', kindExplicit: true, timeInferred: false },
    posts: [{ id: 'p1', author: 'someone', url: 'https://x.com/someone/status/1' }],
    url: 'https://aihot.news/codex-reset',
  }, over)
}
function feed(events) {
  return { schemaVersion: 1, timezone: 'Asia/Shanghai', today: '2026-11-22', checkedAt: at(NOW), historyFrom: at(NOW - 30 * 24 * H),
    count: events.length, events, activities: [], outage: null, monitor: null, notice: null }
}
function response(status, body, headers = {}) {
  return { status, ok: status >= 200 && status < 300, headers: { get: name => headers[name.toLowerCase()] ?? null }, json: async () => body }
}

test('parser keeps known shapes, drops unknown ones and foreign links', () => {
  const events = parseResetFeed(feed([
    event(),
    event({ id: 'bad-type', type: 'mystery' }),
    event({ id: 'no-created', createdAt: 'not a date' }),
    event({ id: 'evil-link', url: 'https://evil.example/codex-reset', posts: [{ url: 'javascript:alert(1)' }] }),
  ]), 'codex')
  assert.deepEqual(events.map(e => e.id), ['reset-1', 'evil-link'])
  assert.equal(events[0].scope, 'Plus / Pro')
  assert.equal(events[0].postUrl, 'https://x.com/someone/status/1')
  assert.equal(events[1].url, null)
  assert.equal(events[1].postUrl, null)
  assert.equal(parseResetFeed({ schemaVersion: 2, events: [] }, 'codex'), null, 'an unknown schema is not guessed')
})

test('a reset confirmed in the last 24 h shows; older history never does', () => {
  const events = parseResetFeed(feed([
    event({ id: 'recent', confirmedAt: at(NOW - 3 * H) }),
    event({ id: 'old', confirmedAt: at(NOW - 25 * H) }),
  ]), 'codex')
  const notices = pickResetNotices(events, NOW)
  assert.deepEqual(notices.map(n => [n.id, n.phase]), [['recent', 'confirmed']])
  assert.equal(notices[0].at, NOW - 3 * H)
})

test('an announced reset shows when its window overlaps the next 24 h', () => {
  const announced = over => event(Object.assign({ status: 'announced', confirmedAt: null,
    presentation: { status: 'announced', scopeKnown: false, scopeLabel: null, kindExplicit: true, timeInferred: false } }, over))
  const events = parseResetFeed(feed([
    announced({ id: 'soon', schedule: { precision: 'approximate', from: at(NOW + 5 * H), through: at(NOW + 5 * H), label: '约' } }),
    announced({ id: 'far', schedule: { precision: 'exact', from: at(NOW + 30 * H), through: at(NOW + 30 * H), label: '' } }),
    // "Before <deadline>" may land any time after the post, so a far deadline still counts.
    announced({ id: 'deadline', createdAt: at(NOW - H), schedule: { precision: 'deadline', from: at(NOW + 40 * H), through: at(NOW + 40 * H), label: '前' } }),
    announced({ id: 'estimate', estimate: { from: at(NOW + 2 * H), through: at(NOW + 4 * H), basis: 'model', label: '', reason: '' } }),
    announced({ id: 'passed', schedule: { precision: 'exact', from: at(NOW - 3 * H), through: at(NOW - 3 * H), label: '' } }),
    announced({ id: 'stale', presentation: { status: 'likely_completed' }, estimate: { from: at(NOW + H), through: at(NOW + 2 * H), basis: 'model' } }),
    announced({ id: 'untimed-new', createdAt: at(NOW - H) }),
    announced({ id: 'untimed-old', createdAt: at(NOW - 30 * H) }),
  ]), 'codex')
  const notices = pickResetNotices(events, NOW)
  assert.deepEqual(notices.map(n => n.id).sort(), ['deadline', 'estimate', 'soon', 'untimed-new'])
  assert.equal(notices.find(n => n.id === 'estimate').window.precision, 'estimate')
  assert.ok(notices.every(n => n.phase === 'announced'))
})

test('the official schedule wins over the AIHOT estimate, and confirmed events drop the estimate', () => {
  const [announced, confirmed] = parseResetFeed(feed([
    event({ id: 'a', status: 'announced', confirmedAt: null,
      schedule: { precision: 'deadline', from: at(NOW + H), through: at(NOW + H), label: '' },
      estimate: { from: at(NOW + 2 * H), through: at(NOW + 3 * H), basis: 'model', label: '', reason: '' } }),
    event({ id: 'c', estimate: { from: at(NOW), through: at(NOW + H), basis: 'model' } }),
  ]), 'codex')
  assert.equal(pickResetNotices([announced], NOW)[0].window.precision, 'deadline')
  assert.equal(confirmed.estimate, null)
})

test('feed sends the ETag back and reuses its events on 304', async () => {
  let now = NOW
  const calls = []
  const replies = [response(200, feed([event()]), { etag: 'W/"v1-a"' }), response(304, null)]
  const source = new ResetFeed({ now: () => now, fetch: async (url, options) => { calls.push({ url, headers: options.headers }); return replies.shift() } })
  const first = await source.notices(['codex'])
  assert.equal(first.notices.length, 1)
  assert.equal(calls[0].url, FEED_URL('codex'))
  assert.equal(calls[0].headers['if-none-match'], undefined)
  await source.notices(['codex'])
  assert.equal(calls.length, 1, 'no second request inside the poll interval')
  now += POLL_MS
  const second = await source.notices(['codex'])
  assert.equal(calls[1].headers['if-none-match'], 'W/"v1-a"')
  assert.deepEqual(second.notices.map(n => n.id), ['reset-1'])
  assert.equal(source.entries.codex.fetchedAt, now, 'a 304 counts as a fresh read')
})

test('a 429 waits for Retry-After and at least one poll interval', async () => {
  let now = NOW, calls = 0
  const source = new ResetFeed({ now: () => now, fetch: async () => { calls++; return response(429, null, { 'retry-after': '30' }) } })
  assert.deepEqual((await source.notices(['claude'])).notices, [])
  now += POLL_MS - 1
  await source.notices(['claude'])
  assert.equal(calls, 1)
  now += 2
  await source.notices(['claude'])
  assert.equal(calls, 2)
})

test('only known subscriptions are fetched; the cache survives a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slp-reset-'))
  const cachePath = path.join(dir, 'cache.json')
  const urls = []
  const fetchImpl = async url => { urls.push(url); return response(200, feed([event()]), { etag: 'W/"v1-b"' }) }
  await new ResetFeed({ now: () => NOW, cachePath, fetch: fetchImpl }).notices(sanitizeResetKinds('codex,grok-bot,../x'))
  assert.deepEqual(urls, [FEED_URL('codex')])
  const restarted = new ResetFeed({ now: () => NOW + 60000, cachePath, fetch: async () => { throw new Error('should use cache') } })
  const result = await restarted.notices(['codex'])
  assert.deepEqual(result.notices.map(n => [n.id, n.postUrl]), [['reset-1', 'https://x.com/someone/status/1']])
  assert.equal(restarted.entries.codex.etag, 'W/"v1-b"')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('Grok reads the grok-bot feed and is only fetched when asked for', async () => {
  assert.equal(FEED_URL('grok'), 'https://aihot.news/api/v1/grok-bot-resets/recent')
  assert.deepEqual(sanitizeResetKinds('grok,codex'), ['codex', 'grok'])
  assert.deepEqual(DEFAULT_RESET_KINDS, ['codex', 'antigravity', 'claude'], 'Grok starts unticked')
  const urls = []
  await new ResetFeed({ now: () => NOW, fetch: async url => { urls.push(url); return response(200, feed([event({ id: 'g' })])) } }).notices(['grok'])
  assert.deepEqual(urls, [FEED_URL('grok')])
})

test('nextCheckAt is the earliest next read, so the browser asks right after it', async () => {
  let now = NOW
  const replies = { codex: () => response(200, feed([])), claude: () => response(429, null, { 'retry-after': String(3 * 3600) }) }
  const source = new ResetFeed({ now: () => now, fetch: async url => replies[url.includes('codex') ? 'codex' : 'claude']() })
  const first = await source.notices(['codex', 'claude'])
  assert.equal(first.nextCheckAt, NOW + POLL_MS, 'codex is due first; claude waits for Retry-After')
  now += 60000
  assert.equal((await source.notices(['claude'])).nextCheckAt, NOW + 3 * 3600000)
})
