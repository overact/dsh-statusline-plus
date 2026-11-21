'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createPricingCatalog, loadPricingCatalog, pricingModelAlias, quoteCatalogUsage } = require('../lib/model-pricing')
const { hostPiVersion } = require('./native-pricing-fixture.cjs')
const units = 100000000
const cost = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 }] }
const catalog = () => createPricingCatalog([{ provider: 'openai', model: 'gpt-6-sol', cost }, { provider: 'openai', model: 'gpt-6.1-sol', cost: { ...cost, input: 3 } }])

test('host catalog is read entirely offline through its public exported provider API', async t => {
  const previous = global.fetch; t.after(() => { global.fetch = previous })
  global.fetch = () => { throw new Error('price lookup must not use network') }
  const native = await loadPricingCatalog()
  assert.equal(native.info.version, hostPiVersion())
  assert.ok(native.info.generatedAt > 0)
  const card = native.resolve({ provider: 'codex', model: 'gpt-6-astra' })
  assert.equal(card.source, 'official'); assert.equal(card.cost.input, 10)
  assert.equal(native.resolve({ provider: 'antigravity', model: 'gemini-3.8-flash' }).source, 'official')
  assert.equal(native.resolve({ provider: 'kimi-code', model: 'k3' }).provider, 'moonshotai')
  assert.equal(native.resolve({ provider: 'kimi-code', model: 'kimi-for-coding' }), null, 'rolling alias has no matching vendor API card')
  const go = native.resolve({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
  assert.equal(go.provider, 'deepseek'); assert.equal(go.model, 'deepseek-flash')
  assert.equal(go.cost.input, 0.3)
  // A resale reference covers models without a first-party card, and it is a
  // separate step from the official catalog.
  assert.ok(native.info.reference && native.info.reference.models > 0)
  assert.equal(native.resolve({ provider: 'llamacpp', model: 'qwen3.8-27b' }).source, 'openrouter')
  // The version stays in the identity, so V4 finds its own card and never the V4.1 one.
  assert.equal(native.resolve({ provider: 'x', model: 'deepseek-v4-flash' }).model, 'deepseek-v4-flash')
  assert.equal(native.resolve({ provider: 'llamacpp', model: 'qwen3.8-flash-next' }).source, 'fallback-reference')
})

test('all channels use the vendor model card and never borrow subscription or gateway prices', () => {
  const goPrice = { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 }
  const zenPrice = { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 }
  const direct = { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 }
  const c = createPricingCatalog([
    { provider: 'opencode-go', model: 'deepseek-v4.1-flash', cost: goPrice },
    { provider: 'opencode', model: 'deepseek-v4-flash', cost: zenPrice },
    { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', cost: zenPrice },
    { provider: 'deepseek', model: 'deepseek-flash', cost: direct },
  ])
  const go = c.resolve({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
  assert.equal(go.cost, direct)
  assert.equal(quoteCatalogUsage(go, { inputTokens: 1000000, outputTokens: 1000000, cacheReadTokens: 1000000 }, units).units / units, 1.506)
  assert.equal(c.resolve({ provider: 'opencode', model: 'deepseek-v4-flash' }), null, 'V4 is not silently relabeled V4.1')
  assert.equal(c.resolve({ provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' }).cost, direct)
  assert.equal(c.resolve({ provider: 'deepseek', model: 'deepseek-v4.1-flash' }).cost, direct)
  assert.equal(c.resolve({ provider: 'custom', model: 'deepseek-v4.1-flash' }).cost, direct)
  assert.equal(c.resolve({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }), go, 'model resolution is reused')
  assert.equal(createPricingCatalog([{ provider: 'opencode-go', model: 'deepseek-v4.1-flash', cost: goPrice }]).resolve({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }), null)
})

test('a card is found through its namespace identity, not by guessing the vendor prefix', () => {
  const openaiAlias = { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 }
  const c = createPricingCatalog([
    { provider: 'openai', model: 'chat-latest', cost: openaiAlias },
    { provider: 'mistral', model: 'pixtral-12b', cost: { input: 0.15, output: 0.15 } },
    { provider: 'google', model: 'deep-research-preview-04-2026', cost: { input: 2, output: 12 } },
    // A vendor namespace reselling another vendor's model is a channel price.
    { provider: 'mistral', model: 'glm-5-2', cost: { input: 9, output: 9 } },
    { provider: 'google', model: 'gemma-4-31b-it', cost: { input: 0, output: 0 } },
  ])
  assert.deepEqual(c.resolve({ provider: 'openai', model: 'chat-latest' }).cost, openaiAlias)
  assert.equal(c.resolve({ provider: 'any', model: 'pixtral-12b' }).provider, 'mistral')
  assert.equal(c.resolve({ provider: 'any', model: 'deep-research-preview-04-2026' }).cost.input, 2)
  assert.equal(c.resolve({ provider: 'any', model: 'glm-5-2' }), null, 'a resold card is not the model public price')
  assert.equal(c.resolve({ provider: 'any', model: 'gemma-4-31b-it' }), null, 'an all-zero card stays unknown')
})

test('bedrock and hosted spellings resolve to the same identity', () => {
  const c = createPricingCatalog([
    { provider: 'anthropic', model: 'claude-sonnet-5', cost: { input: 2, output: 10 } },
    { provider: 'openai', model: 'gpt-6-sol', cost },
  ])
  for (const model of ['anthropic.claude-sonnet-5', 'us.anthropic.claude-sonnet-5-v1:0', 'anthropic/claude-sonnet-5']) {
    assert.equal(c.resolve({ provider: 'amazon-bedrock', model }).provider, 'anthropic', model)
  }
  assert.equal(c.resolve({ provider: 'bedrock', model: 'qwen.qwen3.8-27b' }), null)
})

test('the reference catalog is a second step: official wins, other gateways never price', () => {
  const official = { input: 0.75, output: 3.75, cacheRead: 0.075 }
  const c = createPricingCatalog([
    { provider: 'google', model: 'gemini-3.8-flash', cost: official },
    { provider: 'openrouter', model: 'google/gemini-3.8-flash', cost: { input: 0.825, output: 4.125 } },
    { provider: 'openrouter', model: 'qwen/qwen3.8-27b', cost: { input: 0.15, output: 1.875 } },
    { provider: 'vercel-ai-gateway', model: 'alibaba/qwen3.8-27b', cost: { input: 0.06, output: 2.3 } },
    { provider: 'openrouter', model: 'qwen/qwen3.8-27b:batch', cost: { input: 0.16, output: 2 } },
    { provider: 'openrouter', model: 'qwen/qwen3.8-flash:free', cost: { input: 0, output: 0 } },
  ])
  assert.deepEqual(c.resolve({ provider: 'custom', model: 'gemini-3.8-flash' }).cost, official, 'official card wins')
  const qwen = c.resolve({ provider: 'llamacpp', model: 'qwen3.8-27b' })
  assert.equal(qwen.source, 'openrouter'); assert.equal(qwen.provider, 'openrouter'); assert.equal(qwen.model, 'qwen3.8-27b')
  assert.equal(qwen.vendor, 'qwen', 'the vendor names the model, the provider names the channel')
  assert.equal(c.resolve({ provider: 'anything', model: 'qwen3.8-27b:batch' }).cost.input, 0.16, 'a variant keeps its own identity')
  assert.equal(c.resolve({ provider: 'anything', model: 'qwen3.8-27b:free' }), null, 'an all-zero reference card is unknown')
})

test('a version keeps its own identity and reaches its own reference card', () => {
  const v41 = { input: 0.3, output: 1.2, cacheRead: 0.006 }
  const v4 = { input: 0.091, output: 0.182 }
  const c = createPricingCatalog([
    { provider: 'deepseek', model: 'deepseek-flash', cost: v41 },
    { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', cost: v4 },
  ])
  assert.deepEqual(c.resolve({ provider: 'x', model: 'deepseek-v4.1-flash' }).cost, v41)
  const old = c.resolve({ provider: 'x', model: 'deepseek-v4-flash' })
  assert.deepEqual(old.cost, v4)
  assert.equal(old.model, 'deepseek-v4-flash', 'V4 must not collapse into the V4.1 card identity')
  assert.equal(old.source, 'openrouter')
})

test('a model missing from both catalogs falls back to a labelled snapshot entry', () => {
  const c = createPricingCatalog([{ provider: 'openrouter', model: 'qwen/qwen3.8-27b', cost: { input: 0.15, output: 1.875 } }])
  const next = c.resolve({ provider: 'llamacpp', model: 'qwen3.8-flash-next' })
  assert.equal(next.source, 'fallback-reference'); assert.equal(next.cost.input, 0.2); assert.equal(next.vendor, 'qwen')
  assert.equal(createPricingCatalog().resolve({ provider: 'llamacpp', model: 'qwen3.8-flash-next' }).source, 'fallback-reference')
  // A real card always wins over the snapshot.
  const real = createPricingCatalog([{ provider: 'openrouter', model: 'qwen/qwen3.8-flash-next', cost: { input: 0.25, output: 0.6 } }])
  assert.equal(real.resolve({ provider: 'llamacpp', model: 'qwen3.8-flash-next' }).source, 'openrouter')
})

test('native prices precede snapshots and subscriptions/custom routes use exact public model identity', () => {
  const c = catalog()
  assert.equal(c.resolve({ provider: 'codex', model: 'gpt-6.1-sol' }).cost.input, 3)
  assert.equal(c.resolve({ provider: 'custom', model: 'openai/gpt-6-sol' }).source, 'official')
  assert.equal(c.resolve({ provider: 'codex', model: 'gpt-6-sol-fast' }), null)
  assert.equal(c.resolve({ provider: 'custom', model: 'constructor' }), null)
  assert.equal(createPricingCatalog().resolve({ provider: 'codex', model: 'gpt-6.1-sol' }).source, 'fallback')
  assert.equal(createPricingCatalog([{ provider: 'zai', model: 'glm-5.3-highspeed', cost: { input: 0, output: 0 } }]).resolve({ provider: 'zai', model: 'glm-5.3-highspeed' }), null)
})

test('gateway namespaces do not change the model reference card or its exact version', () => {
  const direct = { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 }
  const c = createPricingCatalog([
    { provider: 'deepseek', model: 'deepseek-flash', cost: direct },
    { provider: 'openai', model: 'gpt-6-sol', cost },
  ])
  const flash = c.resolve({ provider: 'deepseek', model: 'deepseek-v4.1-flash' })
  for (const prefix of ['workbuddy-ai/', 'custom-gateway/', 'openai/', 'magpie/workbuddy-ai/']) {
    assert.equal(c.resolve({ provider: 'magpie-workbuddy', model: prefix + 'deepseek-v4.1-flash' }), flash)
    assert.equal(c.resolve({ provider: 'anything', model: prefix + 'gpt-6-sol' }).cost, cost)
    assert.equal(c.resolve({ provider: 'anything', model: prefix + 'gpt-6.1-sol' }).source, 'fallback')
    for (const unknown of ['deepseek-v4-flash', 'deepseek-v4.1-flashlight', 'gpt-6-sol-fast', 'unknown', '']) {
      assert.equal(c.resolve({ provider: 'deepseek', model: prefix + unknown }), null)
    }
  }
  assert.equal(c.resolve({ provider: 'custom', model: 'WORKBUDDY-AI/DEEPSEEK-V4.1-FLASH' }), flash)
})

test('DeepSeek plan, snapshot and tier spellings all fold to the standard vendor card', () => {
  const direct = { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 }
  const pro = { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 }
  const c = createPricingCatalog([
    { provider: 'deepseek', model: 'deepseek-flash', cost: direct },
    { provider: 'deepseek', model: 'deepseek-v4-pro', cost: pro },
  ])
  const flash = c.resolve({ provider: 'deepseek', model: 'deepseek-v4.1-flash' })
  assert.deepEqual(flash.cost, direct)
  assert.equal(pricingModelAlias('DeepSeek-V4p1-Flash-1017-SG'), 'deepseek-flash')
  assert.equal(pricingModelAlias('deepseek-v4.1-flash-fast'), 'deepseek-flash')
  for (const model of ['deepseek-v4.1-flash', 'deepseek-v4.1-flash-1017', 'deepseek-v4-1-flash-1017',
    'deepseek-v4p1-flash', 'deepseek-v4p1-flash-1017', 'deepseek-v4.1-flash-sg', 'deepseek-v4.1-flash-1103',
    'deepseek_v4.1_flash', 'deepseek-v4.1-flash-1017-sg', 'deepseek-v4.1-flash-latest', 'deepseek-v4.1-flash-thinking',
    'deepseek-v4.2-flash', 'deepseek-v5-flash', 'deepseek-flash-latest', 'DeepSeek-V4.1-Flash',
    'deepseek-v4.1-flash-fast', 'deepseek-v4.1-flash-1017-fast', 'deepseek-v4.1-flash-spot',
    'deepseek-v4.1-flash-1017-spot', 'deepseek-v4p1-flash-spot', 'deepseek-v4.1-flash-free',
    'deepseek-v4.1-flash:batch', 'deepseek-v4.1-flash-vision-exp', 'deepseek-v4.1-flash-preview',
    'deepseek-v4.1-flash-lite', 'deepseek-v4.1-flash-vl']) {
    assert.deepEqual(c.resolve({ provider: 'magpie-workbuddy', model: 'mistral-vibe/' + model }).cost, direct, model)
  }
  const v4Pro = c.resolve({ provider: 'deepseek', model: 'deepseek-v4-pro' })
  for (const model of ['deepseek-v4-pro', 'deepseek-v4-pro-0813', 'deepseek-v4.1-pro', 'deepseek-pro-latest']) {
    assert.deepEqual(c.resolve({ provider: 'magpie-workbuddy', model }).cost, v4Pro.cost, model)
  }
  for (const model of ['deepseek-v4-flash', 'deepseek-v4-flash-0731', 'deepseek-v4-flash-vision-exp',
    'deepseek-v3-pro', 'deepseek-chat', 'deepseek-reasoner', 'deepseek-v4.1-flashlight']) {
    assert.equal(c.resolve({ provider: 'magpie-workbuddy', model }), null, model)
  }
})

test('quotes account for disjoint caches, long prompt thresholds and malformed catalog rates', () => {
  const card = catalog().resolve({ provider: 'codex', model: 'gpt-6-sol' })
  const quote = usage => quoteCatalogUsage(card, usage, units)
  assert.equal(quote({ inputTokens: 100, cacheReadTokens: 200000, cacheWriteTokens: 100000, outputTokens: 10 }).units / units, 0.58055)
  const parts = quote({ inputTokens: 100, cacheReadTokens: 200000, cacheWriteTokens: 100000, outputTokens: 10 }).breakdown
  assert.equal(parts.input.units / units, 0.0004)
  assert.equal(parts.cache.units / units, 0.58, 'cache combines reads and writes at the long-context tier')
  assert.equal(parts.output.units / units, 0.00015)
    assert.equal(quote({ inputTokens: 272000, outputTokens: 0 }).units / units, 0.544)
  assert.equal(quote({ inputTokens: 272001, outputTokens: 0 }).units / units, 1.088004)
  assert.equal(quoteCatalogUsage({ cost: { input: 2, output: 10, cacheWrite: 0 } }, { inputTokens: 100, outputTokens: 10, cacheWriteTokens: 1 }, units).reason, 'cache-write-rate-unknown')
  assert.equal(quoteCatalogUsage({ cost: { input: -1, output: 10 } }, { inputTokens: 100, outputTokens: 10 }, units).reason, 'usage-overflow')
  assert.equal(quote({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 }).reason, 'usage-overflow')
})

test('a cached prompt with no catalog read rate is refused instead of silently priced at zero', () => {
  const usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 1000 }
  for (const [label, cost] of [['absent', { input: 2, output: 10 }], ['zero', { input: 2, output: 10, cacheRead: 0 }]]) {
    const result = quoteCatalogUsage({ cost }, usage, units)
    assert.equal(result.reason, 'cache-read-rate-unknown', 'a ' + label + ' cache-read rate must refuse the quote')
    assert.equal(result.units, undefined, 'and it must not report an amount')
  }
  assert.equal(quoteCatalogUsage({ cost: { input: 2, output: 10 } }, { inputTokens: 100, outputTokens: 10, cacheWriteTokens: 1000 }, units).reason,
    'cache-write-rate-unknown', 'an absent cache-write rate is refused the same way')
  const priced = quoteCatalogUsage({ cost: { input: 2, output: 10, cacheRead: 0.2 } }, usage, units)
  assert.equal(priced.reason, null, 'a real cache-read rate must still be priced')
  assert.equal(priced.breakdown.cache.units / units, 0.0002)
})

test('native DeepSeek rates take the one tariff of the request, like the CNY fallback', () => {
  const card = { cost: { input: 0.3, output: 1.2, cacheRead: 0.006 }, source: 'official' }
  const usage = { inputTokens: 1000000, outputTokens: 1000000, cacheReadTokens: 1000000 }
  assert.equal(quoteCatalogUsage(card, usage, units, 'peak').units / units, 1.506)
  assert.equal(quoteCatalogUsage(card, usage, units, 'offPeak').units / units, 0.753)
})
