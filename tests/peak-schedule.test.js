'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { PeakScheduleSource, checkOfficialRule, parseHolidayYear, PRICING_URL } = require('../lib/peak-schedule.js')

const OFFICIAL = '<li>北京时间周一至周五（不含中国法定节假日）9:00 - 12:00、14:00 - 18:00 为高峰时段；其余时段，包括周末及中国法定节假日全天均为空闲时段</li>'
const days = year => Array.from({ length: 25 }, (_, i) => ({ name: '春节', date: `${year}-02-${String(i + 1).padStart(2, '0')}`, isOffDay: true }))
  .concat([{ name: '春节', date: `${year}-02-28`, isOffDay: false }])

test('official rule sentence: match, changed windows/scope, and missing sentence', () => {
  assert.equal(checkOfficialRule(OFFICIAL).status, 'match')
  assert.deepEqual(checkOfficialRule(OFFICIAL).windows, ['09:00-12:00', '14:00-18:00'])
  assert.equal(checkOfficialRule(OFFICIAL.replace('18:00', '19:00')).status, 'changed')
  assert.equal(checkOfficialRule(OFFICIAL.replace('包括周末及', '')).status, 'changed', 'weekends no longer named off-peak')
  assert.equal(checkOfficialRule(OFFICIAL.replace('9:00 - 12:00、', '')).status, 'changed')
  assert.equal(checkOfficialRule('<p>价格表</p>').status, 'unreadable')
})

test('holiday-cn years are validated; an empty year means unpublished', () => {
  const parsed = parseHolidayYear({ year: 2026, days: days(2026) }, 2026)
  assert.equal(parsed.published, true); assert.equal(parsed.off.length, 25); assert.deepEqual(parsed.work, ['2026-02-28'])
  assert.deepEqual(parseHolidayYear({ year: 2027, days: [] }, 2027), { year: 2027, published: false, off: [], work: [], names: {} })
  assert.equal(parseHolidayYear({ year: 2026, days: days(2026) }, 2025), null, 'year mismatch')
  assert.equal(parseHolidayYear({ year: 2026, days: days(2026).slice(0, 5) }, 2026), null, 'too few off days')
  assert.equal(parseHolidayYear({ year: 2026, days: [...days(2026), { date: '2025-12-31', isOffDay: true }] }, 2026), null, 'date outside year')
})

function fakeFetch(routes, calls) {
  return async url => {
    calls.push(url)
    const body = routes(url)
    if (body instanceof Error) throw body
    return { ok: body !== null, status: body === null ? 404 : 200, text: async () => typeof body === 'string' ? body : JSON.stringify(body) }
  }
}

test('source: lazy daily refresh, jsDelivr then raw fallback, shared in-flight, cache reuse and retry backoff', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slp-peak-'))
  const cachePath = path.join(dir, 'cache.json')
  let now = Date.parse('2026-10-02T02:00:00Z'), calls = []
  const routes = url => url === PRICING_URL ? OFFICIAL
    : url.includes('jsdelivr') && url.endsWith('2026.json') ? new Error('blocked')
      : url.endsWith('2026.json') ? { year: 2026, days: days(2026) }
        : url.endsWith('2027.json') ? { year: 2027, days: [] } : null
  const source = new PeakScheduleSource({ fetch: fakeFetch(routes, calls), now: () => now, cachePath })
  const [a, b] = await Promise.all([source.get(), source.get()])
  assert.equal(a, b === a ? a : a); assert.equal(calls.filter(u => u === PRICING_URL).length, 1, 'concurrent callers share one refresh')
  assert.ok(calls.some(u => u.includes('raw.githubusercontent.com') && u.endsWith('2026.json')), 'raw GitHub fallback')
  assert.equal(a.rule.status, 'match'); assert.equal(a.holidays[2026].published, true); assert.equal(a.holidays[2027].published, false)
  calls = []; await source.get(); assert.equal(calls.length, 0, 'fresh within 24 h')
  // A new process reads the cache without fetching.
  calls = []
  const restarted = new PeakScheduleSource({ fetch: fakeFetch(routes, calls), now: () => now, cachePath })
  assert.equal((await restarted.get()).holidays[2026].off.length, 25); assert.equal(calls.length, 0)
  // Expired + every source down: keep last good data, back off for an hour.
  now += 25 * 3600000
  const down = new PeakScheduleSource({ fetch: fakeFetch(() => new Error('offline'), calls), now: () => now, cachePath })
  assert.equal((await down.get()).holidays[2026].published, true)
  calls.length = 0; await down.get(); assert.equal(calls.length, 0, 'retry backoff')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a published year is never downgraded to unpublished', async () => {
  let now = Date.parse('2026-12-01T02:00:00Z'), published = true
  const routes = url => url === PRICING_URL ? OFFICIAL : url.endsWith('2027.json') ? { year: 2027, days: published ? days(2027) : [] } : { year: 2026, days: days(2026) }
  const source = new PeakScheduleSource({ fetch: fakeFetch(routes, []), now: () => now })
  assert.equal((await source.get()).holidays[2027].published, true)
  published = false; now += 25 * 3600000
  assert.equal((await source.get()).holidays[2027].published, true)
})
