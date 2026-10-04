import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

// Only models absent in the tested pi-ai catalog. USD / million tokens.
// This is a fallback, never an online query. Native entries take precedence.
const FALLBACK_AS_OF = '2026-10-04T02:15:47Z'
const FALLBACK = {
  'gpt-6.1-sol': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5,
    tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }],
    url: 'https://developers.openai.com/api/docs/pricing' },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5,
    url: 'https://platform.claude.com/docs/en/about-claude/pricing' },
}
const OFFICIAL_PROVIDERS = ['openai', 'anthropic', 'google', 'zai', 'moonshotai', 'deepseek', 'xai', 'mistral']
// Verified model identities, not prices or subscription quota multipliers.
// kimi-for-coding is a rolling alias; no older model's price is assumed.
const MODEL_ALIASES = {
  k3: 'kimi-k3', 'k3-256k': 'kimi-k3',
  'kimi-for-coding-highspeed': 'kimi-k2.7-code-highspeed',
}
const canonicalProvider = model => /^gpt-|^o[134](?:-|$)/.test(model) ? 'openai'
  : model.startsWith('claude-') ? 'anthropic' : model.startsWith('gemini-') ? 'google'
  : model.startsWith('glm-') ? 'zai' : model.startsWith('kimi-') ? 'moonshotai'
  : model.startsWith('deepseek-') ? 'deepseek'
  : model.startsWith('grok-') ? 'xai'
  : /^(mistral|magistral|codestral|devstral|ministral)-/.test(model) ? 'mistral' : null

export function createPricingCatalog(entries = [], metadata = {}) {
  const officialEntries = entries.filter(entry => OFFICIAL_PROVIDERS.includes(entry.provider))
  const cards = new Map(officialEntries.map(entry => [entry.provider + ':' + entry.model, entry.cost]))
  const matches = new Map()
  const info = { version: metadata.version || null, generatedAt: metadata.generatedAt || null,
    fallbackAsOf: FALLBACK_AS_OF }
  // A host catalog upgrade changes the native projection checkpoint version,
  // so existing sessions are repriced by replay without touching their logs.
  const revision = parseInt(createHash('sha256').update(JSON.stringify([4, officialEntries, info, FALLBACK, MODEL_ALIASES])).digest('hex').slice(0, 7), 16) + 2
  return { info, revision, resolve(route) {
    if (!route) return null
    const model = String(route.model).toLowerCase()
    if (matches.has(model)) return matches.get(model)
    const remember = card => {
      if (matches.size >= 512) matches.clear()
      matches.set(model, card)
      return card
    }
    const namespace = /^(openai|anthropic|google|moonshotai|z-ai|deepseek)\/(.+)$/.exec(model)
    let normalized = namespace ? namespace[2] : model
    if (normalized.startsWith('claude-')) normalized = normalized.replace(/(\d)\.(\d)/g, '$1-$2')
    if (Object.hasOwn(MODEL_ALIASES, normalized)) normalized = MODEL_ALIASES[normalized]
    const models = [...new Set([model, normalized,
      ...(normalized.startsWith('claude-') ? [normalized.replace(/-\d{8}$/, '')] : []),
      ...(/^deepseek-v4\.1-flash$/.test(normalized) ? ['deepseek-flash'] : []),
    ])]
    const lookup = (candidate, id) => {
      const cost = cards.get(candidate + ':' + id)
      // Native all-zero entries also stand for missing prices. Do not invent
      // free usage from those placeholders; retain an explicit unknown.
      return cost && [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].some(n => n > 0)
        ? { cost, model: id, provider: candidate, source: 'pi-ai' } : null
    }
    // Value the underlying model at its vendor's public API price, including
    // subscription usage. Never substitute a gateway/subscription rate card.
    for (const id of models) {
      const owner = canonicalProvider(id), match = owner && lookup(owner, id)
      if (match) return remember(match)
    }
    for (const id of models) {
      if (Object.hasOwn(FALLBACK, id)) return remember({ cost: FALLBACK[id], model: id, provider: canonicalProvider(id), source: 'fallback' })
    }
    return remember(null)
  } }
}

// Resolve the host's exported pi-ai provider-catalog entry, including a nested
// dependency. No private DSH adapter state and no credential/network access.
export async function loadPricingCatalog() {
  try {
    // A linked plugin may have its own development DSH copy. Resolve from the
    // booting executable first, so production prices belong to the real host.
    const origins = process.env.DSH_PACKAGE_DIR ? [join(process.env.DSH_PACKAGE_DIR, 'package.json')]
      : [process.argv[1] && resolve(process.argv[1])].filter(Boolean)
    if (!process.env.DSH_PACKAGE_DIR) {
      try { origins.push(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh/package.json'))) } catch (_) {}
    }
    let root
    for (const origin of origins) {
      const host = createRequire(origin), resolvers = [host]
      try { resolvers.push(createRequire(host.resolve('@deepseek-ai/dsh-llm-pi-ai'))) } catch (_) {}
      root = resolvers.flatMap(resolver => resolver.resolve.paths('@earendil-works/pi-ai') || [])
        .map(base => join(base, '@earendil-works/pi-ai')).find(base => existsSync(join(base, 'package.json')))
      if (root) break
    }
    if (!root) return createPricingCatalog()
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const entry = manifest.exports?.['./providers/*']?.import?.replace('*', 'all')
    if (!entry) return createPricingCatalog()
    const pi = await import(pathToFileURL(join(root, entry)).href)
    const entries = pi.getBuiltinProviders().filter(provider => OFFICIAL_PROVIDERS.includes(provider)).flatMap(provider => pi.getBuiltinModels(provider)
      .map(model => ({ provider, model: model.id.toLowerCase(), cost: model.cost })))
    return createPricingCatalog(entries, { version: manifest.version, generatedAt: pi.getBuiltinModelDataGeneratedAt?.() })
  } catch (_) { return createPricingCatalog() }
}

export function quoteCatalogUsage(card, usage, units, tariffs) {
  const read = usage.cacheReadTokens ?? 0, write = usage.cacheWriteTokens ?? 0
  const prompt = usage.inputTokens + read + write, base = card.cost
  let selected = null
  for (const tier of base.tiers || []) {
    if (!Number.isFinite(tier.inputTokensAbove)) return { reason: 'invalid-price' }
    if (prompt > tier.inputTokensAbove && (!selected || tier.inputTokensAbove > selected.inputTokensAbove)) selected = tier
  }
  const rate = selected ? { ...base, ...selected } : base
  if (read && !(rate.cacheRead > 0)) return { reason: 'cache-read-rate-unknown' }
  if (write && !(rate.cacheWrite > 0)) return { reason: 'cache-write-rate-unknown' }
  const values = [rate.input, rate.output, rate.cacheRead ?? 0, rate.cacheWrite ?? 0]
  if (values.some(n => !Number.isFinite(n) || n < 0)) return { reason: 'usage-overflow' }
  const minFactor = tariffs?.includes('offPeak') ? 0.5 : 1
  const maxFactor = tariffs && !tariffs.includes('peak') ? 0.5 : 1
  const breakdown = {}
  for (const [key, value] of [
    ['input', usage.inputTokens * rate.input], ['cache', read * values[2] + write * values[3]],
    ['output', usage.outputTokens * rate.output],
  ]) {
    breakdown[key] = { minUnits: Math.round(value * units / 1000000 * minFactor),
      maxUnits: Math.round(value * units / 1000000 * maxFactor) }
  }
  const minUnits = breakdown.input.minUnits + breakdown.cache.minUnits + breakdown.output.minUnits
  const maxUnits = breakdown.input.maxUnits + breakdown.cache.maxUnits + breakdown.output.maxUnits
  if (![minUnits, maxUnits].every(n => Number.isSafeInteger(n) && n >= 0)) return { reason: 'usage-overflow' }
  return { minUnits, maxUnits, breakdown, currency: 'USD', source: card.source, reason: null }
}
