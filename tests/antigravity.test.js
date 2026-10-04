'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
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
