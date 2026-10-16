'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
process.env.SLP_TEST = '1'
const { __test: api } = require('../lib/index')
const { RequestPool } = require('../lib/request-pool')
const credentials = [100, 10, 0, -1].map((priority, i) => ({ priority, fileName: `account-${i}.json`, email: `test-${i}@example.invalid` }))
const quota = (fraction = 1) => ({ fetchedAt: 123, gemini5h: { remainingFraction: fraction, remainingPercent: Math.round(fraction * 100) }, geminiWeekly: { remainingFraction: fraction, remainingPercent: Math.round(fraction * 100) } })

test('missing, malformed and out-of-range quotas stay unknown', () => {
  for (const remainingFraction of [undefined, null, '1', NaN, Infinity, -1, 1.1]) {
    assert.equal(api.parseAntigravityQuotaSummary(0, {}, { groups: [{ displayName: 'Gemini', buckets: [{ window: '5h', remainingFraction }] }] }), null)
  }
  assert.equal(api.parseAntigravityQuotaSummary(0, {}, { groups: [] }), null)
  assert.equal(api.parseAntigravityQuotaSummary(0, {}, { groups: [{ displayName: 'Unknown family', buckets: [{ window: '5h', remainingFraction: 1 }] }] }), null)
})

test('empty upstream summary never invokes the obsolete models fallback', async t => {
  const before = global.fetch; t.after(() => { global.fetch = before })
  const urls = []
  global.fetch = async url => { urls.push(url); return new Response(JSON.stringify({ groups: [] }), { status: 200 }) }
  await assert.rejects(api.fetchAntigravityQuotaForCred({ accessToken: 'fixture-not-real' }, Date.now()), /invalid-response/)
  assert.equal(urls.length, 1)
  assert.ok(urls[0].endsWith('retrieveUserQuotaSummary'))
})

test('fallback preserves the successful account identity and priority', async () => {
  const result = await api.collectAntigravityQuotas(credentials.slice(0, 2), async cred => {
    if (cred.priority === 100) throw new Error('auth')
    return quota(0)
  })
  assert.equal(result.selectedFileName, credentials[1].fileName)
  assert.equal(result.priority, 10)
  assert.equal(result.status, 'exhausted')
  assert.equal(result.accounts[0].status, 'error')
})

test('positive fractions rounded to 0 percent are not treated as exhausted', async () => {
  const result = await api.collectAntigravityQuotas(credentials.slice(0, 1), async () => quota(0.001))
  assert.equal(result.status, 'available')
})

test('missing Gemini windows do not imply account availability', async () => {
  const result = await api.collectAntigravityQuotas(credentials.slice(0, 2), async cred => cred.priority === 100 ? { thirdParty: { remainingFraction: 1 } } : quota())
  assert.equal(result.selectedFileName, credentials[1].fileName)
  assert.equal(result.accounts[0].status, 'unknown')
})

test('bounded concurrency keeps results in priority order, not completion order', async () => {
  let active = 0, peak = 0
  const result = await api.collectAntigravityQuotas(credentials, async cred => {
    peak = Math.max(peak, ++active)
    await new Promise(resolve => setTimeout(resolve, cred.priority === 100 ? 10 : 1))
    active--
    return quota()
  })
  assert.equal(peak, 3)
  assert.equal(result.selectedFileName, credentials[0].fileName)
  assert.deepEqual(result.accounts.map(a => a.fileName), credentials.map(a => a.fileName))
})

test('deadline retains successful accounts and cancels slow account work', async t => {
  const pool = new RequestPool(); t.after(() => pool.close())
  let cancelled = false
  const result = await api.collectAntigravityQuotas(credentials.slice(0, 2), (cred, signal) => pool.run(cred.fileName, inner => {
    if (cred.priority === 100) return quota()
    return new Promise((resolve, reject) => inner.addEventListener('abort', () => { cancelled = true; reject(inner.reason) }, { once: true }))
  }, { signal }), undefined, 20)
  assert.equal(result.status, 'available')
  assert.equal(result.accounts[1].status, 'error')
  assert.equal(result.accounts[1].error, 'timeout')
  assert.equal(cancelled, true)
})

test('caller cancellation propagates rather than returning partial quota', async () => {
  const controller = new AbortController(); controller.abort(new Error('fixture-cancel'))
  await assert.rejects(api.collectAntigravityQuotas(credentials, async () => quota(), controller.signal), /fixture-cancel/)
})

// CPA 把 priority 落盘成 JSON 字符串；回归覆盖 "显示层不认字符串" 导致的全部压成 0。
test('priority accepts the string values CPA writes to auth files', () => {
  assert.equal(api.parsePriority({ priority: '100' }), 100)
  assert.equal(api.parsePriority({ priority: '50' }), 50)
  assert.equal(api.parsePriority({ priority: 100 }), 100)
  assert.equal(api.parsePriority({ priority: '-1' }), -1)
  assert.equal(api.parsePriority({ priority: '10.5' }), 10.5)
  assert.equal(api.parsePriority({ priority: ' 20 ' }), 20)
  assert.equal(api.parsePriority({ attributes: { priority: '7' } }), 7)
  for (const value of [{}, { priority: '' }, { priority: '  ' }, { priority: 'n/a' }, { priority: null }, { priority: NaN }, { priority: Infinity }, { priority: true }, { priority: {} }, undefined]) {
    assert.equal(api.parsePriority(value), 0)
  }
})

test('readAllCredentials keeps CPA string priorities and orders accounts by them', t => {
  const root = mkdtempSync(join(tmpdir(), 'slp-agy-priority-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  // 文件名排序与优先级排序刻意相反：旧的 number-only 逻辑会退化成 a-low 打头。
  const fixtures = [
    ['antigravity-a-low.json', 'a-low@example.invalid', '10'],
    ['antigravity-b-high.json', 'b-high@example.invalid', '100'],
    ['antigravity-c-mid.json', 'c-mid@example.invalid', '50'],
  ]
  for (const [name, email, priority] of fixtures) {
    writeFileSync(join(root, name), JSON.stringify({ email, priority, refresh_token: 'fixture-not-real', access_token: 'fixture-not-real' }))
  }
  const creds = api.readAllCredentials('antigravity', root)
  assert.deepEqual(creds.map(c => c.email), ['b-high@example.invalid', 'c-mid@example.invalid', 'a-low@example.invalid'])
  assert.deepEqual(creds.map(c => c.priority), [100, 50, 10])
})

// Since 2026-10 some summaries carry only the Claude/GPT group (no Gemini group);
// shape copied from a live response, values replaced.
const thirdPartyOnly = { groups: [{ displayName: 'Claude and GPT models', buckets: [
  { bucketId: '3p-weekly', window: 'weekly', displayName: 'Weekly Limit Remaining', remainingFraction: 0.4 },
  { bucketId: '3p-5h', window: '5h', displayName: 'Five Hour Limit Remaining', remainingFraction: 0.9 },
] }] }

test('a Claude/GPT-only summary keeps both of its windows', () => {
  const result = api.parseAntigravityQuotaSummary(0, { fileName: 'a.json' }, thirdPartyOnly)
  assert.equal(result.gemini5h, null); assert.equal(result.geminiWeekly, null)
  assert.equal(result.thirdParty.remainingPercent, 90)
  assert.equal(result.thirdPartyWeekly.remainingPercent, 40)
})

test('account status falls back to Claude/GPT windows only when Gemini is absent', async () => {
  const third = fraction => ({ fetchedAt: 1, gemini5h: null, geminiWeekly: null, thirdParty: { remainingFraction: 1 }, thirdPartyWeekly: { remainingFraction: fraction } })
  const result = await api.collectAntigravityQuotas(credentials.slice(0, 2), async cred => cred.priority === 100 ? third(0) : third(0.5))
  assert.deepEqual(result.accounts.map(a => a.status), ['exhausted', 'available'])
  assert.equal(result.selectedFileName, credentials[1].fileName)
  // With Gemini present, Claude/GPT exhaustion does not decide availability.
  const mixed = await api.collectAntigravityQuotas(credentials.slice(0, 1), async () => ({ ...quota(), thirdPartyWeekly: { remainingFraction: 0 } }))
  assert.equal(mixed.accounts[0].status, 'available')
})
