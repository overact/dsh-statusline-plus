'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { parseDeepSeekBalance, parseKimiWindows, parseZaiWindows } = require('../lib/provider-presets.js')

process.env.SLP_TEST = '1'
const { __test } = require('../lib/index.js')

const NOW = Date.parse('2026-10-02T00:00:00Z')
const RESET = '2026-10-02T01:00:00Z'

function deepseek(entries, available = true) {
  return { is_available: available, balance_infos: entries }
}

function zai(limits, extra = {}) {
  return { code: 200, success: true, data: { limits }, ...extra }
}

test('DeepSeek retains distinct currencies and granted/recharged balances without inventing a cap', () => {
  const payload = deepseek([
    { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
    { currency: 'USD', total_balance: '4.25', granted_balance: '0.25', topped_up_balance: '4.00' },
  ])
  const result = parseDeepSeekBalance(payload)
  assert.deepEqual(result, {
    currency: 'CNY', remaining: 110, isAvailable: true,
    balances: [
      { currency: 'CNY', remaining: 110, granted: 10, toppedUp: 100 },
      { currency: 'USD', remaining: 4.25, granted: 0.25, toppedUp: 4 },
    ],
  })
  for (const entry of [result, ...result.balances]) {
    assert.equal(Object.hasOwn(entry, 'limit'), false)
    assert.equal(Object.hasOwn(entry, 'used'), false)
  }
  assert.deepEqual(__test.providerBalanceFromParse(payload, { mode: 'deepseek-balance' }), result)
})

test('DeepSeek preserves zero and negative balances and the account availability flag', () => {
  assert.deepEqual(parseDeepSeekBalance(deepseek([
    { currency: 'USD', total_balance: '-0.25' },
    { currency: 'CNY', total_balance: 0 },
  ], false)), {
    currency: 'USD', remaining: -0.25, isAvailable: false,
    balances: [{ currency: 'USD', remaining: -0.25 }, { currency: 'CNY', remaining: 0 }],
  })
})

test('DeepSeek discards malformed amounts instead of coercing null or booleans to zero', () => {
  const result = parseDeepSeekBalance(deepseek([
    null,
    { currency: 'CNY', total_balance: false },
    { currency: 'USD', total_balance: null },
    { currency: 'CNY', total_balance: '' },
    { currency: 'CNY', total_balance: 'Infinity' },
    { currency: 'CNY\n', total_balance: '10' },
    { currency: 'USD', total_balance: '2', granted_balance: true, topped_up_balance: null },
  ]))
  assert.deepEqual(result.balances, [{ currency: 'USD', remaining: 2 }])
  for (const available of [undefined, null, 0, 'false']) {
    assert.equal(parseDeepSeekBalance({ is_available: available, balance_infos: [{ currency: 'CNY', total_balance: '1' }] }), null)
  }
  for (const payload of [null, {}, deepseek([]), deepseek([{ currency: 'CNY', total_balance: true }])]) {
    assert.equal(parseDeepSeekBalance(payload), null)
  }
})

test('Kimi official usage fractions produce correctly labeled 5h, weekly and monthly windows', () => {
  assert.deepEqual(parseKimiWindows({
    goods_version: 2,
    usages: {
      limit_5h: { used_ratio: 0.3, reset_time: RESET },
      limit_7d: { used_ratio: '0.2' },
      limit_month_total: { used_ratio: 0.4 },
      limit_month_code: { used_ratio: '0.25' },
    },
  }, NOW), [
    { label: '5h', usedPercent: 30, resetInSec: 3600 },
    { label: '7d', usedPercent: 20 },
    { label: 'month', usedPercent: 40 },
    { label: 'code month', usedPercent: 25 },
  ])
})

test('Kimi accepts empty/full windows and does not invent missing windows or reset times', () => {
  assert.deepEqual(parseKimiWindows({ usages: {
    limit_5h: { used_ratio: 0, reset_time: 'not-a-date' },
    limit_7d: { used_ratio: 1, reset_time: '2026-10-01T23:59:00Z' },
    unknown_window: { used_ratio: 0.2 },
  } }, NOW), [
    { label: '5h', usedPercent: 0 },
    { label: '7d', usedPercent: 100, resetInSec: 0 },
  ])
  assert.equal(parseKimiWindows({ usages: { unknown_window: { used_ratio: 0.2 } } }, NOW), null)
})

test('Kimi rejects invalid fractions and malformed payloads rather than displaying zero usage', () => {
  for (const ratio of [undefined, null, '', ' ', true, false, -0.1, 1.1, 'NaN', Infinity]) {
    assert.equal(parseKimiWindows({ usages: { limit_5h: { used_ratio: ratio } } }, NOW), null)
  }
  for (const payload of [null, [], 'bad', {}, { usages: [] }, { usages: {} }]) {
    assert.equal(parseKimiWindows(payload, NOW), null)
  }
})

test('Kimi legacy subscription usage and duration-based limits retain their distinct windows', () => {
  assert.deepEqual(parseKimiWindows({
    usage: { limit: '100', remaining: '60', resetTime: RESET },
    limits: [
      { window: { duration: '300', timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: 200, used: 50 } },
      { window: { duration: 18000, timeUnit: 'TIME_UNIT_SECOND' }, detail: { limit: 100, remaining: 10 } },
      { window: { duration: 7, timeUnit: 'TIME_UNIT_DAY' }, detail: { limit: 100, used: 0 } },
    ],
  }, NOW), [
    { label: 'plan', usedPercent: 40, resetInSec: 3600 },
    { label: '5h', usedPercent: 25 },
    { label: '5h', usedPercent: 90 },
    { label: '7d', usedPercent: 0 },
  ])
})

test('Kimi legacy reset timestamps accept seconds and milliseconds without guessing unknown durations', () => {
  assert.deepEqual(parseKimiWindows({ limits: [
    { window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' }, detail: { limit: 100, used: 10, resetTime: NOW / 1000 + 3600 } },
    { window: { duration: 5, timeUnit: 'UNKNOWN' }, detail: { limit: 100, remaining: 80, resetTime: NOW + 3600000 } },
    { detail: { limit: 100, used: 30, resetTime: 0 } },
  ] }, NOW), [
    { label: '5h', usedPercent: 10, resetInSec: 3600 },
    { label: 'window', usedPercent: 20, resetInSec: 3600 },
    { label: 'window', usedPercent: 30 },
  ])
})

test('Kimi legacy missing and nonnumeric quota details are unavailable', () => {
  for (const detail of [null, {}, { limit: 0, used: 0 }, { limit: 100 }, { limit: true, used: 1 }, { limit: 100, remaining: null }]) {
    assert.equal(parseKimiWindows({ limits: [{ detail }] }, NOW), null)
  }
})

test('Z.ai parses current credits and legacy token windows using explicit units, not reset order', () => {
  for (const type of ['CREDIT_LIMIT', 'TOKENS_LIMIT']) {
    for (const weeklyNumber of [1, 7]) {
      assert.deepEqual(parseZaiWindows(zai([
        { type, unit: 6, number: weeklyNumber, percentage: 42, nextResetTime: NOW + 3600000 },
        { type, unit: 3, number: 5, percentage: '1', nextResetTime: NOW + 18000000 },
        { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 99 },
      ]), NOW), [
        { label: '7d', usedPercent: 42, resetInSec: 3600 },
        { label: '5h', usedPercent: 1, resetInSec: 18000 },
      ])
    }
  }
})

test('Z.ai calculates used percentage from credits only when an explicit percentage is absent', () => {
  assert.deepEqual(parseZaiWindows(zai([
    { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: '2000', currentValue: '500' },
    { type: 'TOKENS_LIMIT', unit: 6, number: 7, usage: 1000, currentValue: 0 },
    { type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 12, usage: 2000, currentValue: 500 },
  ]), NOW), [
    { label: '5h', usedPercent: 25 },
    { label: '7d', usedPercent: 0 },
    { label: '5h', usedPercent: 12 },
  ])
  for (const amounts of [{ usage: 0, currentValue: 0 }, { usage: 100 }, { usage: true, currentValue: 20 }, { usage: 100, currentValue: null }]) {
    assert.equal(parseZaiWindows(zai([{ type: 'CREDIT_LIMIT', unit: 3, number: 5, ...amounts }]), NOW), null)
  }
})

test('Z.ai rejects HTTP-success business errors even if a payload includes valid-looking quota data', () => {
  const limits = [{ type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 20 }]
  for (const extra of [{ success: false }, { code: 401 }, { code: '403' }, { code: 500, msg: 'No coding plan' }]) {
    assert.equal(parseZaiWindows(zai(limits, extra), NOW), null)
  }
  assert.deepEqual(parseZaiWindows(zai(limits, { code: '200' }), NOW), [{ label: '5h', usedPercent: 20 }])
})

test('Z.ai unknown window types, units and malformed responses do not become model quotas', () => {
  for (const limits of [
    [{ type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 50 }],
    [{ type: 'CREDIT_LIMIT', unit: 9, number: 1, percentage: 50 }],
    [{ type: 'UNKNOWN', unit: 3, number: 5, percentage: 50 }],
    [{ type: 'CREDIT_LIMIT', unit: 3, number: 0, percentage: 50 }],
    [null, true, {}],
  ]) assert.equal(parseZaiWindows(zai(limits), NOW), null)
  for (const value of [null, '', true, false, -1, 101, 'NaN']) {
    assert.equal(parseZaiWindows(zai([{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: value }]), NOW), null)
  }
  for (const payload of [null, [], {}, { data: { limits: {} } }, { limits: [] }]) {
    assert.equal(parseZaiWindows(payload, NOW), null)
  }
})

test('sanitizeConfig adds official account presets with credential references and raw Z.ai auth', () => {
  const providers = __test.sanitizeConfig({}).providers
  for (const [id, apiKeyEnv, url, mode] of [
    ['deepseek', 'DEEPSEEK_API_KEY', 'https://api.deepseek.com/user/balance', 'deepseek-balance'],
    ['kimi-code', 'KIMI_API_KEY', 'https://api.kimi.com/coding/v1/usages', 'kimi-usage'],
    ['zai', 'ZAI_API_KEY', 'https://api.z.ai/api/monitor/usage/quota/limit', 'zai-quota'],
    ['zhipu', 'ZAI_CODING_CN_API_KEY', 'https://open.bigmodel.cn/api/monitor/usage/quota/limit', 'zai-quota'],
  ]) {
    const provider = providers.find(item => item.id === id)
    assert.ok(provider, id)
    assert.equal(provider.apiKeyEnv, apiKeyEnv)
    assert.equal(provider.endpoints[0].url, url)
    assert.equal(provider.endpoints[0].parse.mode, mode)
    assert.equal(provider.enabled, true)
    assert.equal(provider.onTurn, true)
    if (mode === 'zai-quota') assert.equal(provider.endpoints[0].auth, 'raw')
  }
  assert.ok(providers.find(item => item.id === 'zhipu').match.providerExact.includes('zai-coding-cn'))
  assert.ok(providers.find(item => item.id === 'deepseek').match.providerExact.includes('deepseek-official'))
})

test('sanitizeConfig merges partial preset overrides and keeps explicit custom providers first', () => {
  const custom = {
    id: 'custom-meter', label: 'Custom', apiKeyEnv: 'CUSTOM_CREDENTIAL', style: 'balance',
    endpoints: [{ url: 'https://meter.example.com/balance', parse: { remainingPath: 'data.balance', currency: 'USD' } }],
    match: { providerExact: ['custom-route'] },
  }
  const config = { providers: [custom, { id: 'deepseek', enabled: false, onTurn: false, apiKeyEnv: 'MY_DEEPSEEK_KEY' }, { id: 'zhipu', label: 'GLM CN' }] }
  const original = JSON.stringify(config)
  const providers = __test.sanitizeConfig(config).providers
  assert.equal(providers[0].id, 'custom-meter')
  assert.deepEqual(providers[0].endpoints, custom.endpoints)
  assert.deepEqual(providers[0].match.providerExact, ['custom-route'])
  const ds = providers.find(item => item.id === 'deepseek')
  assert.equal(ds.enabled, false)
  assert.equal(ds.onTurn, false)
  assert.equal(ds.apiKeyEnv, 'MY_DEEPSEEK_KEY')
  assert.equal(ds.endpoints[0].parse.mode, 'deepseek-balance')
  assert.equal(providers.find(item => item.id === 'zhipu').label, 'GLM CN')
  assert.equal(providers.find(item => item.id === 'zhipu').endpoints[0].auth, 'raw')
  assert.equal(providers.filter(item => item.id === 'deepseek').length, 1)
  assert.equal(JSON.stringify(config), original, 'sanitizing must not mutate the caller configuration')
})

test('sanitizeConfig preserves an existing custom parser on a built-in provider id', () => {
  const endpoint = { url: 'https://api.z.ai/api/paas/v4/balance', parse: { remainingPath: 'data.total_balance', currency: 'CNY' } }
  const zaiProvider = __test.sanitizeConfig({ providers: [{
    id: 'zai', style: 'balance', apiKeyEnv: 'CUSTOM_ZAI_KEY', endpoints: [endpoint],
    match: { providerSub: ['custom-zai-route'] },
  }] }).providers.find(item => item.id === 'zai')
  assert.equal(zaiProvider.style, 'balance')
  assert.equal(zaiProvider.apiKeyEnv, 'CUSTOM_ZAI_KEY')
  assert.deepEqual(zaiProvider.endpoints, [endpoint])
  assert.deepEqual(zaiProvider.match.providerSub, ['custom-zai-route'])
})
