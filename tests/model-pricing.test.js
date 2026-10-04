'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createPricingCatalog, loadPricingCatalog, quoteCatalogUsage } = require('../lib/model-pricing')
const units = 100000000
const cost = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 }] }
const catalog = () => createPricingCatalog([{ provider: 'openai', model: 'gpt-6-sol', cost }, { provider: 'openai', model: 'gpt-6.1-sol', cost: { ...cost, input: 3 } }])

test('host catalog is read entirely offline through its public exported provider API', async t => {
  const previous = global.fetch; t.after(() => { global.fetch = previous })
  global.fetch = () => { throw new Error('price lookup must not use network') }
  const native = await loadPricingCatalog()
  assert.equal(native.info.version, '0.87.1')
  assert.ok(native.info.generatedAt > 0)
  const card = native.resolve({ provider: 'codex', model: 'gpt-6-astra' })
  assert.equal(card.source, 'pi-ai'); assert.equal(card.cost.input, 10)
  assert.equal(native.resolve({ provider: 'antigravity', model: 'gemini-3.8-flash' }).source, 'pi-ai')
  assert.equal(native.resolve({ provider: 'kimi-code', model: 'k3' }).provider, 'moonshotai')
  assert.equal(native.resolve({ provider: 'kimi-code', model: 'kimi-for-coding' }), null, 'rolling alias has no matching vendor API card')
  const go = native.resolve({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
  assert.equal(go.provider, 'deepseek'); assert.equal(go.model, 'deepseek-flash')
  assert.equal(go.cost.input, 0.3)
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
  assert.equal(quoteCatalogUsage(go, { inputTokens: 1000000, outputTokens: 1000000, cacheReadTokens: 1000000 }, units).maxUnits / units, 1.506)
  assert.equal(c.resolve({ provider: 'opencode', model: 'deepseek-v4-flash' }), null, 'V4 is not silently relabeled V4.1')
  assert.equal(c.resolve({ provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' }).cost, direct)
  assert.equal(c.resolve({ provider: 'deepseek', model: 'deepseek-v4.1-flash' }).cost, direct)
  assert.equal(c.resolve({ provider: 'custom', model: 'deepseek-v4.1-flash' }).cost, direct)
  assert.equal(c.resolve({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }), go, 'model resolution is reused')
  assert.equal(createPricingCatalog([{ provider: 'opencode-go', model: 'deepseek-v4.1-flash', cost: goPrice }]).resolve({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }), null)
})

test('native prices precede snapshots and subscriptions/custom routes use exact public model identity', () => {
  const c = catalog()
  assert.equal(c.resolve({ provider: 'codex', model: 'gpt-6.1-sol' }).cost.input, 3)
  assert.equal(c.resolve({ provider: 'custom', model: 'openai/gpt-6-sol' }).source, 'pi-ai')
  assert.equal(c.resolve({ provider: 'codex', model: 'gpt-6-sol-fast' }), null)
  assert.equal(c.resolve({ provider: 'custom', model: 'constructor' }), null)
  assert.equal(createPricingCatalog().resolve({ provider: 'codex', model: 'gpt-6.1-sol' }).source, 'fallback')
  assert.equal(createPricingCatalog([{ provider: 'zai', model: 'glm-5.3-highspeed', cost: { input: 0, output: 0 } }]).resolve({ provider: 'zai', model: 'glm-5.3-highspeed' }), null)
})

test('quotes account for disjoint caches, long prompt thresholds and malformed catalog rates', () => {
  const card = catalog().resolve({ provider: 'codex', model: 'gpt-6-sol' })
  const quote = usage => quoteCatalogUsage(card, usage, units)
  assert.equal(quote({ inputTokens: 100, cacheReadTokens: 200000, cacheWriteTokens: 100000, outputTokens: 10 }).maxUnits / units, 0.58055)
  const parts = quote({ inputTokens: 100, cacheReadTokens: 200000, cacheWriteTokens: 100000, outputTokens: 10 }).breakdown
  assert.equal(parts.input.maxUnits / units, 0.0004)
  assert.equal(parts.cache.maxUnits / units, 0.58, 'cache combines reads and writes at the long-context tier')
  assert.equal(parts.output.maxUnits / units, 0.00015)
  assert.equal(quote({ inputTokens: 272000, outputTokens: 0 }).minUnits / units, 0.544)
  assert.equal(quote({ inputTokens: 272000, outputTokens: 0 }).maxUnits / units, 0.544)
  assert.equal(quote({ inputTokens: 272001, outputTokens: 0 }).maxUnits / units, 1.088004)
  assert.equal(quoteCatalogUsage({ cost: { input: 2, output: 10, cacheWrite: 0 } }, { inputTokens: 100, outputTokens: 10, cacheWriteTokens: 1 }, units).reason, 'cache-write-rate-unknown')
  assert.equal(quoteCatalogUsage({ cost: { input: -1, output: 10 } }, { inputTokens: 100, outputTokens: 10 }, units).reason, 'usage-overflow')
  assert.equal(quote({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 }).reason, 'usage-overflow')
})

test('native DeepSeek rates honor the same peak/off-peak interval as the CNY fallback', () => {
  const card = { cost: { input: 0.3, output: 1.2, cacheRead: 0.006 }, source: 'pi-ai' }
  const usage = { inputTokens: 1000000, outputTokens: 1000000, cacheReadTokens: 1000000 }
  const q = quoteCatalogUsage(card, usage, units, ['peak', 'offPeak'])
  assert.equal(q.minUnits / units, 0.753); assert.equal(q.maxUnits / units, 1.506)
})
