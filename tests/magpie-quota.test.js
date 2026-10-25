'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
process.env.SLP_TEST = '1'
const { __test: api } = require('../lib/index')
const { RequestPool } = require('../lib/request-pool')

const now = Date.parse('2026-10-25T12:00:00+11:00')
const antigravityRows = [{
  provider: 'antigravity',
  user: 'a@example.invalid',
  plan: 'Google AI Pro',
  windows: [
    { name: 'Gemini · 7 days', used: 48.6, remaining: 51.4, resetsAt: '2026-10-31T10:32:33+11:00' },
    { name: 'Gemini · 5 hours', used: 95.4, remaining: 4.6, resetsAt: '2026-10-25T17:00:00+11:00' },
    { name: 'Claude & GPT · 7 days', used: 0, remaining: 100, resetsAt: '2026-11-01T10:00:00+11:00' },
    { name: 'Claude & GPT · 5 hours', used: 0, remaining: 100, resetsAt: '2026-10-25T17:00:00+11:00' },
  ],
}]
const codexRows = [{
  provider: 'codex',
  plan: 'prolite',
  user: 'c@example.invalid',
  windows: [
    { name: '7 days', used: 36, remaining: 64, resetsAt: '2026-10-31T10:32:33+11:00' },
    { name: '5 hours', used: 12.5, remaining: 87.5, resetsAt: '2026-10-25T17:00:00+11:00' },
  ],
}]

function withTempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'slp-magpie-'))
  const previous = process.env.HOME
  process.env.HOME = home
  t.after(() => { process.env.HOME = previous; rmSync(home, { recursive: true, force: true }) })
  return home
}

test('magpie antigravity rows map to the account shape and keep the Gemini pair', () => {
  const result = api.parseMagpieAntigravity(antigravityRows, now)
  assert.equal(result.email, 'a@example.invalid')
  assert.equal(result.gemini5h.usedPercent, 95)
  assert.equal(result.gemini5h.remainingFraction, 0.046)
  assert.equal(result.geminiWeekly.usedPercent, 49)
  assert.equal(result.thirdParty.remainingFraction, 1)
  assert.equal(result.status, 'available')
  assert.equal(result.accounts.length, 1)
  assert.equal(result.selectedFileName, result.accounts[0].fileName)
})

test('magpie antigravity marks a fully spent window as exhausted and ignores empty rows', () => {
  const exhausted = api.parseMagpieAntigravity([{ provider: 'antigravity', user: 'b@example.invalid', windows: [{ name: 'Gemini · 5 hours', used: 100 }] }], now)
  assert.equal(exhausted.status, 'exhausted')
  assert.equal(api.parseMagpieAntigravity([{ provider: 'antigravity', windows: [] }], now), null)
  assert.equal(api.parseMagpieAntigravity([], now), null)
})

test('magpie codex windows become primary/secondary with real window lengths', () => {
  const result = api.parseMagpieCodex(codexRows, now)
  assert.equal(result.planType, 'prolite')
  assert.equal(result.email, 'c@example.invalid')
  assert.equal(result.primary.windowMinutes, 300)
  assert.equal(result.primary.usedPercent, 12.5)
  assert.equal(result.primary.resetAfterSeconds, 5 * 3600)
  assert.equal(result.secondary.windowMinutes, 10080)
  assert.equal(result.secondary.usedPercent, 36)
})

test('magpie codex with a single window omits secondary instead of inventing one', () => {
  const result = api.parseMagpieCodex([{ provider: 'codex', windows: [{ name: '7 days', used: 10 }] }], now)
  assert.equal(result.primary.windowMinutes, 10080)
  assert.equal('secondary' in result, false)
})

test('fetchMagpieQuotas reads the local gateway quotas endpoint', async t => {
  const before = global.fetch
  t.after(() => { global.fetch = before })
  let seen
  global.fetch = async (url) => {
    seen = String(url)
    return new Response(JSON.stringify({ data: antigravityRows }), { status: 200 })
  }
  const rows = await api.fetchMagpieQuotas({}, undefined, undefined)
  assert.match(seen, /\/v1\/magpie\/quotas$/)
  assert.equal(rows.length, 1)
})

function writeAntigravityFixture(home) {
  mkdirSync(join(home, '.cli-proxy-api'))
  writeFileSync(join(home, '.cli-proxy-api', 'antigravity-fixture.json'), JSON.stringify({
    access_token: 'fixture-not-real', refresh_token: 'fixture-refresh', email: 'a@example.invalid',
  }))
}

test('codex quota reads magpie before a valid CPA credential', async t => {
  const home = withTempHome(t)
  mkdirSync(join(home, '.cli-proxy-api'))
  writeFileSync(join(home, '.cli-proxy-api', 'codex-fixture.json'), JSON.stringify({ access_token: 'fixture-not-real' }))
  const before = global.fetch
  t.after(() => { global.fetch = before })
  global.fetch = async (url) => {
    assert.match(String(url), /\/v1\/magpie\/quotas$/)
    return new Response(JSON.stringify({ data: codexRows }), { status: 200 })
  }
  const result = await api.fetchCodexQuota({}, undefined, undefined)
  assert.equal(result.source, 'magpie')
  assert.equal(result.primary.windowMinutes, 300)
})

test('codex quota falls back to CPA when magpie is unavailable', async t => {
  const home = withTempHome(t)
  mkdirSync(join(home, '.cli-proxy-api'))
  writeFileSync(join(home, '.cli-proxy-api', 'codex-fixture.json'), JSON.stringify({ access_token: 'not.a-real.token' }))
  const before = global.fetch
  t.after(() => { global.fetch = before })
  global.fetch = async (url) => {
    const target = String(url)
    if (target.includes('/v1/magpie/quotas')) throw new Error('ECONNREFUSED')
    assert.equal(target, 'https://chatgpt.com/backend-api/wham/usage')
    return new Response(JSON.stringify({ plan_type: 'plus', rate_limit: {
      primary_window: { used_percent: 12.5, limit_window_seconds: 18000, reset_at: 1790000000 },
    } }), { status: 200 })
  }
  const result = await api.fetchCodexQuota({}, undefined, undefined)
  assert.equal(result.source, undefined)
  assert.equal(result.planType, 'plus')
  assert.equal(result.primary.windowMinutes, 300)
})

test('quotaSource=cpa skips magpie even when it is reachable', async t => {
  const home = withTempHome(t)
  mkdirSync(join(home, '.cli-proxy-api'))
  writeFileSync(join(home, '.cli-proxy-api', 'codex-fixture.json'), JSON.stringify({ access_token: 'not.a-real.token' }))
  const before = global.fetch
  t.after(() => { global.fetch = before })
  const urls = []
  global.fetch = async (url) => {
    urls.push(String(url))
    assert.equal(String(url), 'https://chatgpt.com/backend-api/wham/usage')
    return new Response(JSON.stringify({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 5 } } }), { status: 200 })
  }
  const result = await api.fetchCodexQuota({ quotaSource: 'cpa' }, undefined, undefined)
  assert.equal(result.source, undefined)
  assert.equal(urls.length, 1)
})

test('quotaSource=magpie does not fall back to CPA', async t => {
  const home = withTempHome(t)
  mkdirSync(join(home, '.cli-proxy-api'))
  writeFileSync(join(home, '.cli-proxy-api', 'codex-fixture.json'), JSON.stringify({ access_token: 'not.a-real.token' }))
  const before = global.fetch
  t.after(() => { global.fetch = before })
  global.fetch = async () => { throw new Error('ECONNREFUSED') }
  await assert.rejects(api.fetchCodexQuota({ quotaSource: 'magpie' }, undefined, undefined), /network/)
})

test('quotaSource sanitizes to auto and keeps explicit values', () => {
  assert.equal(api.sanitizeConfig({ quotaSource: 'bogus' }).quotaSource, 'auto')
  assert.equal(api.sanitizeConfig({}).quotaSource, 'auto')
  assert.equal(api.sanitizeConfig({ quotaSource: 'cpa' }).quotaSource, 'cpa')
  assert.equal(api.sanitizeConfig({ quotaSource: 'magpie' }).quotaSource, 'magpie')
  assert.equal(api.sanitizeConfig({}).quotaShowAll, false)
  assert.equal(api.sanitizeConfig({ quotaShowAll: true }).quotaShowAll, true)
})

test('antigravity quota reads magpie before a valid CPA credential', async t => {
  const home = withTempHome(t)
  writeAntigravityFixture(home)
  const before = global.fetch
  t.after(() => { global.fetch = before })
  global.fetch = async (url) => {
    assert.match(String(url), /\/v1\/magpie\/quotas$/)
    return new Response(JSON.stringify({ data: antigravityRows }), { status: 200 })
  }
  const pool = new RequestPool()
  t.after(() => pool.close())
  const result = await api.fetchAntigravityQuota({ cacheTtlMs: 60000 }, true, undefined, pool)
  assert.equal(result.source, 'magpie')
  assert.equal(result.email, 'a@example.invalid')
  assert.equal(result.gemini5h.usedPercent, 95)
})

test('antigravity quota falls back to CPA when magpie is unavailable', async t => {
  const home = withTempHome(t)
  writeAntigravityFixture(home)
  const before = global.fetch
  t.after(() => { global.fetch = before })
  global.fetch = async (url) => {
    const target = String(url)
    if (target.includes('/v1/magpie/quotas')) throw new Error('ECONNREFUSED')
    assert.match(target, /retrieveUserQuotaSummary$/)
    return new Response(JSON.stringify({ groups: [
      { displayName: 'Gemini Models', buckets: [
        { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.9, resetTime: '2026-10-25T17:00:00+11:00' },
        { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.8, resetTime: '2026-10-31T10:00:00+11:00' },
      ] },
    ] }), { status: 200 })
  }
  const pool = new RequestPool()
  t.after(() => pool.close())
  const result = await api.fetchAntigravityQuota({ cacheTtlMs: 60000 }, true, undefined, pool)
  assert.equal(result.source, undefined)
  assert.equal(result.gemini5h.usedPercent, 10)
  assert.equal(result.geminiWeekly.usedPercent, 20)
})
