import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

// Reference prices, USD / million tokens. Offline only: never an online query.
//
// Two catalogs are indexed, and both are keyed by the model identity, never by
// the route provider:
//   - `official`  the vendor's own pi-ai namespace (see OFFICIAL_PROVIDERS);
//   - `openrouter` a resale reference used only when no official card exists.
// Everything else pi-ai carries (cloud marketplaces, coding plans, token plans)
// is a channel price, not the model's public API price, and is never indexed.
const REFERENCE_PROVIDER = 'openrouter'
// Only models a host's bundled catalog may lack. This table exists because
// `dsh >= 0.2.0-rc.2` can pair with an older pi-ai snapshot than the newest one:
// a model a current snapshot prices still needs a card for the hosts behind it.
// An entry is redundant only once every supported host knows the model, which is
// a judgement no local test can make. `kind` keeps an official card
// distinguishable from a third-party reference; `asOf` records verification.
const FALLBACK_AS_OF = '2026-11-21T21:55:29Z'
export const FALLBACK = {
  // Gemini 4 Hydrogen shipped after the bundled pi-ai snapshot; this official
  // card is the offline fallback until the host catalog includes it. Flat
  // AI Studio price, no long-context tier (1M context).
  'gemini-4-hydrogen': { input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 0,
    kind: 'official', asOf: '2026-11-27T00:00:00Z', url: 'https://ai.google.dev/gemini-api/docs/pricing#gemini-4-hydrogen' },
  // Qwen publishes no first-party pi-ai namespace, and the bundled snapshot
  // predates this model, so the OpenRouter reference card is the only offline
  // price until either catalog learns it.
  'qwen3.8-flash-next': { input: 0.2, output: 0.5, cacheRead: 0.05, cacheWrite: 0,
    kind: 'reference', asOf: '2026-11-21T21:55:29Z', url: 'https://openrouter.ai/qwen/qwen3.8-flash-next' },
}
const OFFICIAL_PROVIDERS = ['openai', 'anthropic', 'google', 'zai', 'moonshotai', 'deepseek', 'xai', 'mistral']
// Verified model identities, not prices or subscription quota multipliers.
// kimi-for-coding is a rolling alias; no older model's price is assumed.
const MODEL_ALIASES = {
  k3: 'kimi-k3', 'k3-256k': 'kimi-k3',
  'kimi-for-coding-highspeed': 'kimi-k2.7-code-highspeed',
}
// DeepSeek spells the same card differently across plans and snapshots, and
// subscription tiers add suffixes such as `-fast`, `-spot`, `-free`, `:batch`
// or `-vision-exp`. Treat every trailing qualifier as the standard card: this
// is a reference estimate, not a bill. The version gate still keeps the older,
// cheaper V4 Flash out of the V4.1 Flash card, so V4 keeps its own identity
// and can still reach its V4 reference card below.
const DEEPSEEK_CARD_FAMILIES = [
  { family: 'flash', card: 'deepseek-flash', minMajor: 4, minMinor: 1 },
  { family: 'pro', card: 'deepseek-v4-pro', minMajor: 4, minMinor: 0 },
]

function deepSeekCard(model) {
  // `v4p1` is the fireworks spelling of `v4.1`; `_` and `:` separate plan
  // qualifiers in some catalogs.
  const id = model.replace(/(\d)p(\d)/g, '$1.$2').replace(/[:_]/g, '-')
  const match = /^deepseek-(?:v(\d+)(?:[.-](\d+))?-)?(flash|pro)(?:-.*)?$/.exec(id)
  if (!match) return null
  const rule = DEEPSEEK_CARD_FAMILIES.find(entry => entry.family === match[3])
  const major = match[1] === undefined ? null : Number(match[1])
  const minor = match[2] === undefined ? 0 : Number(match[2])
  if (major !== null && (major < rule.minMajor || major === rule.minMajor && minor < rule.minMinor)) return null
  return rule.card
}
// Share the alias rules with the offline fallback in session-metrics so both
// paths agree on model identity.
export const pricingModelAlias = model => {
  const id = String(model).toLowerCase()
  return Object.hasOwn(MODEL_ALIASES, id) ? MODEL_ALIASES[id] : deepSeekCard(id) || id
}

// Vendors whose own namespace can carry a model's public API price. This is a
// veto, not a selector: a namespace is trusted for its own models, and a model
// that belongs to another vendor is skipped, because a vendor namespace can
// resell someone else's model (Mistral lists GLM and DeepSeek, Bedrock lists
// Claude). Every card is still found through its identity, never by guessing a
// namespace from a prefix.
const vendorOf = model => /^(?:gpt-|chat-latest$|o[134](?:-|$))/.test(model) ? 'openai'
  : /^(?:claude|fable)-/.test(model) ? 'anthropic'
  : /^(?:gemini|gemma|deep-research)-/.test(model) ? 'google'
  : /^(?:glm|zai)-/.test(model) ? 'zai'
  : model.startsWith('kimi-') ? 'moonshotai'
  : model.startsWith('deepseek-') ? 'deepseek'
  : model.startsWith('grok-') ? 'xai'
  : /^(?:mistral|magistral|codestral|devstral|ministral|pixtral|voxtral|open-mistral|labs)-/.test(model) ? 'mistral'
  : model.startsWith('qwen') ? 'qwen' : null

// Gateway/provider namespaces select a route, not the underlying model price.
// Share this identity rule with the offline fallback in session-metrics.
export const pricingModelId = model => String(model).toLowerCase().split('/').at(-1)

// Mechanical identity cleanup only: route prefixes, Bedrock's region/vendor
// dots and revision suffix, separator spellings. No trailing qualifier is
// dropped here, so `:batch` and friends keep their own identity and can only
// become the standard card through the explicit DeepSeek family rule.
const HOSTED = /^(?:(?:us|eu|apac|au|ca|sa|me|af|ap|jp|us-gov)\.)?(?:openai|anthropic|google|amazon|meta|mistral|deepseek|qwen)\./
export const pricingModelIdentity = model => {
  // `-v1:0` and `-v1` are Bedrock revisions. Stripping a trailing `-vN` can only
  // lose a match (unknown), never invent a price, so the loose form is safe.
  let id = pricingModelId(model).replace(HOSTED, '').replace(/-v\d+(?::\d+)?$/, '')
  id = id.replace(/[:_]/g, '-').replace(/(\d)p(\d)/g, '$1.$2')
  return id.startsWith('claude-') ? id.replace(/(\d)\.(\d)/g, '$1-$2') : id
}
// Native all-zero entries stand for missing prices. Do not invent free usage
// from those placeholders; retain an explicit unknown.
const hasPrice = cost => !!cost && [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].some(n => n > 0)

export function createPricingCatalog(entries = [], metadata = {}) {
  const officialCards = new Map(), referenceCards = new Map(), officialSeen = new Set()
  for (const entry of entries) {
    if (!entry || typeof entry.model !== 'string') continue
    const identity = pricingModelIdentity(entry.model)
    if (entry.provider === REFERENCE_PROVIDER) {
      // `~` marks a listing alias in the reference catalog, not a public model.
      if (entry.model.startsWith('~') || entry.model.includes('/~') || !hasPrice(entry.cost)) continue
      referenceCards.set(identity, { cost: entry.cost, vendor: REFERENCE_PROVIDER })
    } else if (OFFICIAL_PROVIDERS.includes(entry.provider)) {
      // A vendor namespace may resell someone else's model; that card is that
      // vendor's channel price, not the model's public API price.
      const owner = vendorOf(identity)
      if (owner && owner !== entry.provider) continue
      // Listing the model without a price (an all-zero placeholder) is still a
      // verdict: the vendor does not publish one, so a resale card must not
      // stand in for it.
      officialSeen.add(identity)
      if (hasPrice(entry.cost)) officialCards.set(identity, { cost: entry.cost, vendor: entry.provider })
    }
  }
  const matches = new Map()
  const info = { version: metadata.version || null, generatedAt: metadata.generatedAt || null,
    fallbackAsOf: FALLBACK_AS_OF,
    reference: referenceCards.size ? { provider: REFERENCE_PROVIDER, models: referenceCards.size } : null }
  // A host catalog upgrade changes the native projection checkpoint version,
  // so existing sessions are repriced by replay without touching their logs.
  const revision = parseInt(createHash('sha256').update(JSON.stringify([8, entries, info, FALLBACK, MODEL_ALIASES,
    DEEPSEEK_CARD_FAMILIES])).digest('hex').slice(0, 7), 16) + 2
  return { info, revision, resolve(route) {
    if (!route || typeof route.model !== 'string') return null
    const key = pricingModelId(route.model)
    if (matches.has(key)) return matches.get(key)
    const remember = card => {
      if (matches.size >= 512) matches.clear()
      matches.set(key, card)
      return card
    }
    const identity = pricingModelIdentity(route.model)
    const models = [...new Set([identity, pricingModelAlias(identity),
      ...(identity.startsWith('claude-') ? [identity.replace(/-\d{8}$/, '')] : []),
    ])]
    const pick = (table, source) => {
      for (const id of models) {
        const card = table.get(id)
        if (!card) continue
        // `provider` is the channel that supplied the card; `vendor` is who owns
        // the model. The panel shows the vendor, the details show the channel.
        return remember({ cost: card.cost, model: id, provider: card.vendor,
          vendor: source === REFERENCE_PROVIDER ? vendorOf(id) || REFERENCE_PROVIDER : card.vendor, source })
      }
      return null
    }
    // The owning vendor comes from the index, never from the route provider.
    const card = pick(officialCards, 'official')
    if (card) return card
    // The vendor listed the model without a price: keep the explicit unknown
    // instead of substituting a resale rate for it.
    if (models.some(id => officialSeen.has(id))) return remember(null)
    const reference = pick(referenceCards, 'openrouter')
    if (reference) return reference
    for (const id of models) {
      if (!Object.hasOwn(FALLBACK, id)) continue
      const entry = FALLBACK[id]
      return remember({ cost: entry, model: id, provider: vendorOf(id),
        vendor: vendorOf(id) || (entry.kind === 'reference' ? REFERENCE_PROVIDER : null),
        source: entry.kind === 'reference' ? 'fallback-reference' : 'fallback' })
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
    const wanted = [...OFFICIAL_PROVIDERS, REFERENCE_PROVIDER]
    const entries = pi.getBuiltinProviders().filter(provider => wanted.includes(provider)).flatMap(provider => pi.getBuiltinModels(provider)
      .map(model => ({ provider, model: model.id.toLowerCase(), cost: model.cost })))
    return createPricingCatalog(entries, { version: manifest.version, generatedAt: pi.getBuiltinModelDataGeneratedAt?.() })
  } catch (_) { return createPricingCatalog() }
}

// `tariff` is DeepSeek's 'peak' or 'offPeak' for the request; other vendors pass
// none. One request is priced at one tariff, so the quote is a single amount.
export function quoteCatalogUsage(card, usage, units, tariff) {
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
  const factor = tariff === 'offPeak' ? 0.5 : 1
  const breakdown = {}
  for (const [key, value] of [
    ['input', usage.inputTokens * rate.input], ['cache', read * values[2] + write * values[3]],
    ['output', usage.outputTokens * rate.output],
  ]) {
    breakdown[key] = { units: Math.round(value * units / 1000000 * factor) }
  }
  const total = breakdown.input.units + breakdown.cache.units + breakdown.output.units
  if (!Number.isSafeInteger(total) || total < 0) return { reason: 'usage-overflow' }
  return { units: total, breakdown, currency: 'USD', source: card.source, vendor: card.vendor, reason: null }
}
