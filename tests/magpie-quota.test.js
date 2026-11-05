'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
process.env.SLP_TEST = '1'
const windowOf = (result, id) => result.windows.find(item => item.id === id)
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
  assert.equal(windowOf(result, 'gemini-5h').usedPercent, 95)
  assert.equal(windowOf(result, 'gemini-5h').remainingPercent, 5)
  assert.equal(windowOf(result, 'gemini-weekly').usedPercent, 49)
  assert.equal(windowOf(result, 'third-5h').remainingPercent, 100)
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

test('magpie codex windows are shortest first, with real window lengths', () => {
  const result = api.parseMagpieCodex(codexRows, now)
  assert.equal(result.plan, 'prolite')
  assert.equal('email' in result, false, 'the browser does not need the Codex account address')
  assert.equal(result.windows[0].minutes, 300)
  assert.equal(result.windows[0].usedPercent, 13)
  assert.equal(result.windows[0].resetInSec, 5 * 3600)
  assert.equal(result.windows[0].label, undefined, 'a known length is named in the viewer language')
  assert.equal(result.windows[1].minutes, 10080)
  assert.equal(result.windows[1].usedPercent, 36)
})

test('magpie codex with a single window does not invent another', () => {
  const result = api.parseMagpieCodex([{ provider: 'codex', windows: [{ name: '7 days', used: 10 }] }], now)
  assert.equal(result.windows.length, 1)
  assert.equal(result.windows[0].minutes, 10080)
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
  assert.equal(result.windows[0].minutes, 300)
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
  assert.equal(result.source, 'cpa')
  assert.equal(result.plan, 'plus')
  assert.equal(result.windows[0].minutes, 300)
})

test('a CPA pin skips magpie even when it is reachable', async t => {
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
  const result = await api.fetchCodexQuota({ quotaSources: { codex: 'cpa' } }, undefined, undefined)
  assert.equal(result.source, 'cpa')
  assert.equal(urls.length, 1)
})

test('a Magpie pin does not fall back to CPA', async t => {
  const home = withTempHome(t)
  mkdirSync(join(home, '.cli-proxy-api'))
  writeFileSync(join(home, '.cli-proxy-api', 'codex-fixture.json'), JSON.stringify({ access_token: 'not.a-real.token' }))
  const before = global.fetch
  t.after(() => { global.fetch = before })
  global.fetch = async () => { throw new Error('ECONNREFUSED') }
  await assert.rejects(api.fetchCodexQuota({ quotaSources: { codex: 'magpie' } }, undefined, undefined), /network/)
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
  assert.equal(windowOf(result, 'gemini-5h').usedPercent, 95)
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
  assert.equal(result.source, 'cpa')
  assert.equal(windowOf(result, 'gemini-5h').usedPercent, 10)
  assert.equal(windowOf(result, 'gemini-weekly').usedPercent, 20)
})

const codexGrant = { kind: 'grant', payload: { type: 'oauth', access: 'fixture-not-real' } }
const whamBody = JSON.stringify({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18000 } } })
function stubNetwork(t, respond) {
  const original = global.fetch, requests = []
  t.after(() => { global.fetch = original })
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), auth: options && options.headers && (options.headers.Authorization || options.headers.authorization) })
    return respond(String(url))
  }
  return requests
}
const noMagpie = url => {
  if (url.includes('/v1/magpie/')) throw new Error('refused')
  return new Response(whamBody, { status: 200 })
}
function emptyHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'slp-dsh-login-')), original = process.env.HOME
  process.env.HOME = home
  t.after(() => { process.env.HOME = original; rmSync(home, { recursive: true, force: true }) })
}

test('codex falls back to the DSH login only after Magpie and CPA have nothing', async t => {
  emptyHome(t)
  const requests = stubNetwork(t, noMagpie)
  const keys = []
  const credentials = { readRecord: async key => { keys.push(key); return codexGrant } }
  const result = await api.fetchCodexQuota({}, undefined, undefined, credentials)
  assert.equal(result.source, 'host')
  assert.equal(result.windows[0].usedPercent, 12)
  assert.deepEqual(keys, ['llm-pi-ai/openai-codex'])
  assert.deepEqual(requests.map(request => new URL(request.url).pathname), ['/v1/magpie/quotas', '/backend-api/wham/usage'])
})

test('a pinned source never reaches the DSH login, and a pinned DSH login reads nothing else', async t => {
  emptyHome(t)
  const requests = stubNetwork(t, noMagpie)
  let reads = 0
  const credentials = { readRecord: async () => { reads++; return codexGrant } }
  await assert.rejects(api.fetchCodexQuota({ quotaSources: { codex: 'cpa' } }, undefined, undefined, credentials), /no-credential/)
  await assert.rejects(api.fetchCodexQuota({ quotaSources: { codex: 'magpie' } }, undefined, undefined, credentials), /network/)
  await assert.rejects(api.fetchCodexQuota({ codexAccount: 'codex-a.json' }, undefined, undefined, credentials), /no-credential/)
  assert.equal(reads, 0)
  requests.length = 0
  const result = await api.fetchCodexQuota({ quotaSources: { codex: 'dsh' } }, undefined, undefined, credentials)
  assert.equal(result.source, 'host')
  assert.deepEqual(requests.map(request => new URL(request.url).pathname), ['/backend-api/wham/usage'])
})

test('the DSH login is only read: expired or unknown grants make no request and nothing is written', async t => {
  emptyHome(t)
  const requests = stubNetwork(t, noMagpie)
  const pinned = { quotaSources: { codex: 'dsh' } }
  const expired = { kind: 'grant', payload: { type: 'oauth', access: 'fixture-not-real', refresh: 'fixture-not-real', expires: 1 } }
  const calls = []
  const service = record => new Proxy({ readRecord: async () => record }, { get(target, name) { calls.push(name); return target[name] } })
  await assert.rejects(api.fetchCodexQuota(pinned, undefined, undefined, service(expired)), /auth/)
  for (const record of [undefined, { kind: 'api-key', value: 'x' }, { kind: 'grant', payload: { type: 'apikey' } }, { kind: 'grant', payload: { type: 'oauth', access: 'a\nb' } }]) {
    await assert.rejects(api.fetchCodexQuota(pinned, undefined, undefined, service(record)), /no-credential/)
  }
  await assert.rejects(api.fetchCodexQuota(pinned, undefined, undefined, undefined), /no-credential/)
  assert.equal(requests.length, 0)
  assert.deepEqual([...new Set(calls)], ['readRecord'])
})

test('antigravity has no DSH login to read and CPA never refreshes or rewrites a token', async t => {
  await assert.rejects(api.fetchAntigravityQuota({ quotaSources: { antigravity: 'dsh' } }, false), /no-credential/)
  const hosts = []
  stubNetwork(t, url => { hosts.push(new URL(url).hostname); return new Response('{}', { status: 401 }) })
  await assert.rejects(api.fetchAntigravityQuotaForCred({ accessToken: 'fixture-not-real', refreshToken: 'fixture-not-real', filePath: '/nonexistent', fileName: 'a.json' }, Date.now()), /auth/)
  assert.deepEqual(hosts, ['daily-cloudcode-pa.googleapis.com'])
})

// ---- every subscription, every user environment ----
const realFetch = globalThis.fetch
function routed(t, routes) {
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    const text = String(url)
    calls.push({ url: text, headers: options.headers || {} })
    for (const [part, reply] of routes) {
      if (!text.includes(part)) continue
      if (reply instanceof Error) throw reply
      return new Response(JSON.stringify(reply.body), { status: reply.status || 200 })
    }
    throw new TypeError('fetch failed')
  }
  t.after(() => { globalThis.fetch = realFetch })
  return calls
}
function writeLogin(home, path, value) {
  const file = join(home, ...path)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
  return file
}
const NO_MAGPIE = ['/v1/magpie/quotas', Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })]
const WHAM = { plan_type: 'plus', rate_limit: { primary_window: { used_percent: 7, limit_window_seconds: 18000 } } }
const CLAUDE_USAGE = { five_hour: { utilization: 12.4, resets_at: '2099-01-01T00:00:00Z' }, seven_day: { utilization: 40 }, seven_day_opus: { utilization: null } }
const AGY_SUMMARY = { groups: [{ displayName: 'Claude and GPT models', buckets: [{ bucketId: '3p-5h', window: '5h', remainingFraction: 0.5 }] }] }
const claudeLogin = (extra = {}) => ({ claudeAiOauth: { accessToken: 'claude-file-token', expiresAt: Date.now() + 60000, scopes: ['user:inference', 'user:profile'], ...extra } })
function isolatedEnv(t) {
  for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'MAGPIE_GATEWAY_URL']) {
    const previous = process.env[key]
    delete process.env[key]
    t.after(() => { if (previous !== undefined) process.env[key] = previous })
  }
  return withTempHome(t)
}

test('Magpie subscriptions are read whatever they are called, and unreadable rows are left out', () => {
  const list = api.parseMagpieSubscriptions([
    { provider: 'workbuddy-ai', name: 'WorkBuddy AI', plan: 'Free plan', windows: [{ name: 'Credits', used: 3, display: '3 / 100', resetsAt: '2099-01-01T00:00:00Z' }] },
    { provider: 'kimi', windows: [{ name: '5 hours', used: 10 }, { name: '7 days', used: 20 }] },
    { provider: 'opencode-go', windows: [], error: 'this key has no subscription' },
    { provider: 'broken', windows: [{ name: 'x', used: 'n/a' }] },
    { provider: 'multi', user: 'a@example.invalid', windows: [{ name: '5 hours', used: 100 }] },
    { provider: 'multi', user: 'b@example.invalid', windows: [{ name: '5 hours', used: 5 }] },
  ], now)
  assert.deepEqual(list.map(item => item.id), ['workbuddy-ai', 'kimi', 'multi'])
  assert.equal(list[0].label, 'WorkBuddy AI')
  assert.equal(list[0].windows[0].usedPercent, 3)
  assert.equal(list[1].windows[0].short, '5h')
  assert.equal(list[2].accountCount, 2)
  assert.equal(list[2].windows[0].usedPercent, 5)
  assert.ok(!JSON.stringify(list).includes('example.invalid'))
})

test('a model namespace finds its Magpie subscription, with an exact name winning', () => {
  const list = [{ id: 'workbuddy-ai' }, { id: 'kimi' }, { id: 'kimi-code' }]
  assert.equal(api.matchMagpieSubscription(list, ['workbuddy']).id, 'workbuddy-ai')
  assert.equal(api.matchMagpieSubscription(list, ['kimi-code']).id, 'kimi-code')
  assert.equal(api.matchMagpieSubscription(list, ['kimi-coding']).id, 'kimi')
  assert.equal(api.matchMagpieSubscription(list, ['openai']), null)
})

test('no gateway: Codex reads the official login file and sends it only to the official endpoint', async t => {
  const home = isolatedEnv(t)
  const file = writeLogin(home, ['.codex', 'auth.json'], { auth_mode: 'chatgpt', tokens: { access_token: 'codex-file-token', refresh_token: 'r' } })
  const before = require('node:fs').readFileSync(file, 'utf8')
  const calls = routed(t, [NO_MAGPIE, ['/wham/usage', { body: WHAM }]])
  const result = await api.fetchCodexQuota({}, undefined, undefined)
  assert.equal(result.source, 'official')
  assert.equal(result.windows[0].usedPercent, 7)
  const sent = calls.filter(call => call.headers.Authorization)
  assert.deepEqual(sent.map(call => new URL(call.url).host), ['chatgpt.com'])
  assert.equal(require('node:fs').readFileSync(file, 'utf8'), before)
})

test('an API-key Codex login has no subscription to read', async t => {
  const home = isolatedEnv(t)
  writeLogin(home, ['.codex', 'auth.json'], { auth_mode: 'apikey', OPENAI_API_KEY: 'sk-x', tokens: null })
  const calls = routed(t, [NO_MAGPIE])
  await assert.rejects(api.fetchCodexQuota({}, undefined, undefined), /no-credential/)
  assert.ok(calls.every(call => !call.headers.Authorization))
})

test('Claude order: Magpie, then CPA, then the official login, each tagged', async t => {
  const home = isolatedEnv(t)
  writeLogin(home, ['.claude', '.credentials.json'], claudeLogin())
  const usage = ['/api/oauth/usage', { body: CLAUDE_USAGE }]
  routed(t, [['/v1/magpie/quotas', { body: { data: [{ provider: 'claude', name: 'Claude', windows: [{ name: '5 hours', used: 50 }] }] } }], usage])
  const viaMagpie = await api.fetchClaudeQuota({})
  assert.equal(viaMagpie.source, 'magpie')
  assert.equal(viaMagpie.windows[0].usedPercent, 50)
  const calls = routed(t, [NO_MAGPIE, usage])
  const viaFile = await api.fetchClaudeQuota({})
  assert.equal(viaFile.source, 'official')
  assert.deepEqual(viaFile.windows.map(win => [win.label, win.usedPercent]), [['5h', 12], ['7d', 40]])
  const sent = calls.find(call => call.headers.Authorization)
  assert.equal(new URL(sent.url).host, 'api.anthropic.com')
  assert.equal(sent.headers['User-Agent'], undefined)
  writeLogin(home, ['.cli-proxy-api', 'claude-a.json'], { access_token: 'claude-cpa-token' })
  assert.equal((await api.fetchClaudeQuota({})).source, 'cpa')
})

test('Claude states: expired, wrong scope, missing and unmeasured never become numbers', async t => {
  const home = isolatedEnv(t)
  const calls = routed(t, [NO_MAGPIE, ['/api/oauth/usage', { body: {} }]])
  await assert.rejects(api.fetchClaudeQuota({}), /no-credential/)
  writeLogin(home, ['.claude', '.credentials.json'], claudeLogin({ expiresAt: Date.now() - 1 }))
  await assert.rejects(api.fetchClaudeQuota({}), /auth/)
  writeLogin(home, ['.claude', '.credentials.json'], claudeLogin({ scopes: ['user:inference'] }))
  await assert.rejects(api.fetchClaudeQuota({}), /no-credential/)
  assert.ok(calls.every(call => !call.headers.Authorization))
  writeLogin(home, ['.claude', '.credentials.json'], claudeLogin())
  await assert.rejects(api.fetchClaudeQuota({}), /invalid-response/)
})

test('CLAUDE_CONFIG_DIR and CODEX_HOME choose where the login files are read', async t => {
  const home = isolatedEnv(t)
  writeLogin(home, ['alt-claude', '.credentials.json'], claudeLogin())
  writeLogin(home, ['alt-codex', 'auth.json'], { tokens: { access_token: 'x' } })
  process.env.CLAUDE_CONFIG_DIR = join(home, 'alt-claude')
  process.env.CODEX_HOME = join(home, 'alt-codex')
  t.after(() => { delete process.env.CLAUDE_CONFIG_DIR; delete process.env.CODEX_HOME })
  routed(t, [NO_MAGPIE, ['/api/oauth/usage', { body: CLAUDE_USAGE }], ['/wham/usage', { body: WHAM }]])
  assert.equal((await api.fetchClaudeQuota({})).source, 'official')
  assert.equal((await api.fetchCodexQuota({}, undefined, undefined)).source, 'official')
})

test('Antigravity reads the official login, reports a hidden Gemini group, and never writes', async t => {
  const home = isolatedEnv(t)
  const file = writeLogin(home, ['.gemini', 'antigravity-cli', 'antigravity-oauth-token'], { token: { access_token: 'agy-file-token', refresh_token: 'r', expiry: '2099-01-01T00:00:00Z' } })
  const before = require('node:fs').readFileSync(file, 'utf8')
  routed(t, [NO_MAGPIE, [':retrieveUserQuotaSummary', { body: AGY_SUMMARY }]])
  const result = await api.fetchAntigravityQuota({}, false, undefined, new RequestPool({ timeoutMs: 5000 }))
  assert.equal(result.source, 'official')
  assert.equal(result.geminiHidden, true)
  assert.equal(windowOf(result, 'third-5h').usedPercent, 50)
  assert.equal(require('node:fs').readFileSync(file, 'utf8'), before)
  writeLogin(home, ['.gemini', 'antigravity-cli', 'antigravity-oauth-token'], { token: { access_token: 'x', expiry: '2000-01-01T00:00:00Z' } })
  await assert.rejects(api.fetchAntigravityQuota({}, false, undefined, new RequestPool({ timeoutMs: 5000 })), /auth/)
})

test('fallback happens only for a missing or rejected login; other failures stay what they are', async () => {
  const fail = code => async () => { throw new Error(code) }
  const ok = async () => ({ fine: true })
  assert.equal((await api.readInOrder([{ id: 'a', read: fail('no-credential') }, { id: 'b', read: ok }])).source, 'b')
  assert.equal((await api.readInOrder([{ id: 'a', read: fail('auth') }, { id: 'b', read: ok }])).source, 'b')
  await assert.rejects(api.readInOrder([{ id: 'a', read: fail('network') }, { id: 'b', read: ok }]), /network/)
  await assert.rejects(api.readInOrder([{ id: 'a', read: fail('invalid-response') }, { id: 'b', read: ok }]), /invalid-response/)
  assert.equal((await api.readInOrder([{ id: 'm', tool: true, read: fail('network') }, { id: 'b', read: ok }])).source, 'b')
  await assert.rejects(api.readInOrder([{ id: 'm', tool: true, read: fail('network') }, { id: 'b', read: fail('auth') }]), /network/)
  await assert.rejects(api.readInOrder([{ id: 'm', tool: true, read: fail('network') }, { id: 'b', read: fail('no-credential') }]), /no-credential/)
  await assert.rejects(api.readInOrder([{ id: 'a', read: fail('no-credential') }, { id: 'b', read: fail('auth') }]), /auth/)
})

test('a pin is the only source read, per subscription', async t => {
  const home = isolatedEnv(t)
  writeLogin(home, ['.claude', '.credentials.json'], claudeLogin())
  const calls = routed(t, [['/v1/magpie/quotas', { body: { data: [] } }], ['/api/oauth/usage', { body: CLAUDE_USAGE }]])
  assert.equal((await api.fetchClaudeQuota({ quotaSources: { claude: 'official' } })).source, 'official')
  assert.ok(calls.every(call => !call.url.includes('/v1/magpie/quotas')))
  await assert.rejects(api.fetchClaudeQuota({ quotaSources: { claude: 'magpie' } }), /no-credential/)
  await assert.rejects(api.fetchClaudeQuota({ quotaSources: { claude: 'cpa' } }), /no-credential/)
  await assert.rejects(api.fetchClaudeQuota({ quotaSources: { claude: 'dsh' } }), /no-credential/)
})

test('quotaSources keeps known pins per subscription and the raw editor rejects the rest', () => {
  const clean = api.sanitizeConfig({ quotaSources: { codex: 'cpa', claude: 'official', kimi: 'bogus', 'a/b': 'magpie' } }).quotaSources
  assert.deepEqual(clean, { codex: 'cpa', claude: 'official' })
  assert.deepEqual(api.sanitizeConfig({}).quotaSources, {})
  assert.deepEqual(api.sanitizeConfig({ quotaSources: 'cpa' }).quotaSources, {})
  assert.equal(api.sanitizeConfig({ quotaSource: 'cpa' }).quotaSource, undefined)
})

test('OpenCode reads Magpie first, and the settings test button still checks the key', async t => {
  isolatedEnv(t)
  routed(t, [['/v1/magpie/quotas', { body: { data: [{ provider: 'opencode-go', name: 'OpenCode Go', windows: [{ name: '5 hours', used: 9 }] }] } }]])
  const viaMagpie = await api.fetchOpenCodeQuota(undefined, { apiKeyEnv: 'SLP_ABSENT_KEY', usageUrl: 'https://opencode.ai/zen/go/v1/usage', fetchTimeoutMs: 1000 })
  assert.equal(viaMagpie.source, 'magpie')
  await assert.rejects(api.fetchOpenCodeQuota(undefined, { apiKeyEnv: 'SLP_ABSENT_KEY', usageUrl: 'https://opencode.ai/zen/go/v1/usage', fetchTimeoutMs: 1000 }, undefined, undefined, true), /no-credential/)
})

test('a stopped Magpie is absent, so an expired login says so, while a busy Magpie stays retryable', async t => {
  const home = isolatedEnv(t)
  writeLogin(home, ['.claude', '.credentials.json'], claudeLogin({ expiresAt: Date.now() - 1 }))
  routed(t, [NO_MAGPIE])
  await assert.rejects(api.fetchClaudeQuota({}), /auth/)
  routed(t, [['/v1/magpie/quotas', new TypeError('fetch failed')]])
  await assert.rejects(api.fetchClaudeQuota({}), /network/)
})

test('Antigravity without a subscription is not reported as an expired login', async t => {
  const home = isolatedEnv(t)
  writeLogin(home, ['.gemini', 'antigravity-cli', 'antigravity-oauth-token'], { token: { access_token: 'x', expiry: '2099-01-01T00:00:00Z' } })
  const pool = new RequestPool({ timeoutMs: 5000 })
  routed(t, [NO_MAGPIE, [':retrieveUserQuotaSummary', { status: 403, body: { error: { status: 'PERMISSION_DENIED', details: [{ reason: 'SUBSCRIPTION_REQUIRED' }] } } }]])
  await assert.rejects(api.fetchAntigravityQuota({}, false, undefined, pool), /no-credential/)
  routed(t, [NO_MAGPIE, [':retrieveUserQuotaSummary', { status: 403, body: { error: { status: 'PERMISSION_DENIED' } } }]])
  await assert.rejects(api.fetchAntigravityQuota({}, false, undefined, pool), /auth/)
})

test('one refresh of every chip reads Magpie once through the shared reader', async t => {
  isolatedEnv(t)
  const calls = routed(t, [['/v1/magpie/quotas', { body: { data: [
    { provider: 'codex', windows: [{ name: '5 hours', used: 1 }] },
    { provider: 'antigravity', windows: [{ name: 'Gemini · 5 hours', used: 1 }] },
    { provider: 'claude', windows: [{ name: '5 hours', used: 1 }] },
    { provider: 'opencode-go', windows: [{ name: '5 hours', used: 1 }] },
  ] } }]])
  const pool = new RequestPool({ timeoutMs: 5000 })
  t.after(() => pool.close())
  const config = { apiKeyEnv: 'SLP_ABSENT_KEY', readMagpie: signal => pool.run('rows', s => api.requestMagpieQuotas(s), { signal, ttlMs: 3000 }) }
  const results = await Promise.all([
    api.fetchCodexQuota(config), api.fetchAntigravityQuota(config, false, undefined, pool),
    api.fetchClaudeQuota(config), api.fetchOpenCodeQuota(undefined, config), api.fetchMagpieSubscriptions(config),
  ])
  assert.equal(calls.length, 1)
  assert.equal(results[2].source, 'magpie')
})


test('OpenCode usage becomes the shared window list; an unmeasured window is not 0%', () => {
  assert.deepEqual(api.parseOpenCodeUsage({}, 0), [])
  assert.deepEqual(api.parseOpenCodeUsage({ rolling: { percent: null }, weekly: { percent: 101 } }, 0), [])
  const [rolling, monthly] = api.parseOpenCodeUsage({ rolling: { percent: 0, resetInSec: 60 }, monthly: { usagePercent: 40, resetsAt: new Date(120000).toISOString() } }, 0)
  assert.deepEqual(rolling, { id: 'rolling', minutes: 300, short: '5h', usedPercent: 0, remainingPercent: 100, resetInSec: 60 })
  assert.equal(monthly.id, 'monthly')
  assert.equal(monthly.resetInSec, 120)
})

test('a saved pin survives the schema: the Host hands stored config over frozen', () => {
  const stored = Object.freeze({ quotaSources: Object.freeze({ claude: 'official' }) })
  assert.deepEqual(api.SettingsSchema(stored).quotaSources, { claude: 'official' })
  assert.deepEqual(api.SettingsSchema({}).quotaSources, {})
})
