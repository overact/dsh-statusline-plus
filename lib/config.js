'use strict'
/**
 * Settings model: defaults, tolerant sanitation of stored values, the native
 * settings schema, and the strict pre-persistence validator for edits.
 */
import Schema from '@deepseek-ai/schemastery'
import { join, resolve, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { PROVIDER_PRESETS, BUILTIN_PARSE_MODES } from './provider-presets.js'

const COMPONENT_ORDER = ['git', 'context', 'tps', 'cost', 'activity', 'tools']

function sanitizeQuotaSource(value) {
  return value === 'magpie' || value === 'cpa' ? value : 'auto'
}

function sanitizeComponentOrder(value) {
  const picked = Array.isArray(value) ? value.slice(0, 32).filter((id, i, all) => COMPONENT_ORDER.includes(id) && all.indexOf(id) === i) : []
  return picked.concat(COMPONENT_ORDER.filter(id => !picked.includes(id)))
}

const DEFAULT_CONFIG = {
  enabled: true,
  hideBottomOnNarrow: false,
  // Native profile Config owns live values; credential fields contain references.
  apiKeyEnv: 'OPENCODE_GO_API_KEY',
  usageUrl: 'https://opencode.ai/zen/go/v1/usage',
  intervalSec: 60,
  cacheTtlMs: 60000,
  fetchTimeoutMs: 10000,
  showQuota: true,
  showCodexQuota: true,
  showAntigravityQuota: true,
  showOpenCodeQuota: true,
  showDeepseekPeak: true,
  deepseekPeakCountdown: true,
  showPeakDot: true,
  quotaAuto: true,
  quotaOnStep: true,
  // Quota percentages read as consumed ('used') or remaining ('left'), in chips and details alike.
  quotaPercentMode: 'used',
  // Which gateway the quota fetchers read: auto (a live Magpie first), magpie or cpa.
  quotaSource: 'auto',
  // Show every enabled subscription side by side instead of selecting one by model.
  quotaShowAll: false,
  codexQuotaOnTurn: true,
  antigravityQuotaOnTurn: true,
  showGit: true,
  showContext: true,
  showCwd: true,
  showTps: false,
  showActivity: true,
  showTools: true,
  showCost: true,
  componentOrder: COMPONENT_ORDER,
  gitCwd: '',
  codexAccount: '',
  antigravityAccount: '',
  // Account balance / Coding Plan sources are supplied by built-in presets;
  // providers[] contains optional overrides and custom declarative sources.
  providers: [],
}

function clampInt(value, fallback, min, max) {
  const n = asNumber(value)
  if (n === undefined) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

// 与 @deepseek-ai/dsh-credentials 的 credentialRef 约束一致
const CRED_REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
// Coerce a stored JSON value to a string without ever throwing. String({toString:1}) and
// String(Object.create(null)) both raise "Cannot convert object to primitive value"; the
// tolerant read path must not let a bad stored value become a crash inside apply().
function asString(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}
// Number({toString:1}) and Number(Object.create(null)) throw instead of returning NaN, so
// every numeric read of stored JSON goes through this guard too.
function asNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}
function sanitizeApiKeyEnv(value) {
  const s = asString(value).trim()
  return CRED_REF_RE.test(s) ? s : DEFAULT_CONFIG.apiKeyEnv
}

function sanitizeUsageUrl(value) {
  const s = asString(value).trim()
  try {
    const url = new URL(s)
    // The host sends the resolved API key to this URL. Keep the endpoint
    // intentionally narrow instead of treating an arbitrary HTTPS URL as safe.
    if (url.protocol !== 'https:' || url.hostname !== 'opencode.ai' || url.port ||
        url.username || url.password || url.pathname !== '/zen/go/v1/usage' ||
        url.search || url.hash) return DEFAULT_CONFIG.usageUrl
    return url.toString()
  } catch (e) {
    return DEFAULT_CONFIG.usageUrl
  }
}

const BOOLEAN_CONFIG_KEYS = [
  'enabled', 'hideBottomOnNarrow', 'showQuota', 'showCodexQuota', 'showAntigravityQuota', 'showOpenCodeQuota', 'quotaAuto', 'quotaShowAll',
  'showDeepseekPeak', 'deepseekPeakCountdown', 'showPeakDot', 'quotaOnStep',
  'codexQuotaOnTurn', 'antigravityQuotaOnTurn', 'showGit', 'showContext',
  'showCwd', 'showTps', 'showActivity', 'showTools', 'showCost',
]

function sanitizeBoolean(value, fallback) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value !== 0
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase()
    if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true
    if (s === 'false' || s === '0' || s === 'no' || s === 'off' || s === '') return false
  }
  return fallback
}

function sanitizeCwd(value) {
  let s = asString(value).trim()
  if (!s) return ''
  if (s === '~') s = homedir()
  else if (s.startsWith('~/')) s = join(homedir(), s.slice(2))
  if (!isAbsolute(s) || Buffer.byteLength(s, 'utf8') > 1024 || s.indexOf('\0') !== -1) return ''
  return resolve(s)
}

// ---- 通用额度源（providers）----
// 借鉴 dsh-usage-stats 的 scheme 思路：每个额度源 = 端点列表（依次回退）+ 声明式
// JSON 路径提取，归一化成 balance（remaining/limit/used）或 windows（usedPercent）。
// 密钥只在宿主侧经 credentials 服务解析并放进 Authorization 头，绝不下发浏览器。

const PROVIDER_ID_RE = /^[\w-]{1,64}$/
const PROVIDER_PATH_RE = /^[A-Za-z0-9_]{1,64}(\.[A-Za-z0-9_]{1,64}){0,7}$/
const PROVIDER_MATCH_RE = /^[\w@./+:-]{1,80}$/

// 端点 URL 清洗：仅 https、禁止 userinfo、屏蔽链路本地/云元数据地址。
// 这是把用户 API key 发过去的目标地址，配置作者需对主机名自行负责。
function sanitizeProviderEndpointUrl(value) {
  const s = asString(value).trim()
  try {
    const url = new URL(s)
    if (url.protocol !== 'https:' || !url.hostname ||
        url.username || url.password || url.hash || s.length > 2048) return null
    // A trailing dot is the fully-qualified spelling of the same name, so "localhost." and
    // "svc.local." slipped past the suffix checks below. Normalise it away first.
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    if (host === 'localhost' || host.endsWith('.localhost') ||
        host.endsWith('.local') || host.endsWith('.internal') ||
        /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
        /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
        host === '0.0.0.0' || host === '[::]' || host === '[::1]') return null
    // IPv6 字面量：拦回环、IPv4-mapped 私网、链路本地与 ULA
    if (host.startsWith('[') && host.endsWith(']')) {
      const bare = host.slice(1, -1).split('%')[0].toLowerCase()
      if (bare === '::' || bare === '::1' || bare.startsWith('fe8') || bare.startsWith('fe9') ||
          bare.startsWith('fea') || bare.startsWith('feb') || bare.startsWith('fc') || bare.startsWith('fd') ||
          bare.startsWith('::ffff:127.') || bare.startsWith('::ffff:10.') ||
          bare.startsWith('::ffff:192.168.') || bare.startsWith('::ffff:169.254.')) return null
      // URL canonicalises a mapped address to hex ([::ffff:a9fe:a9fe]), which none of the
      // dotted prefixes above can match. Decode the mapped IPv4 and re-apply its rules.
      const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare)
      if (mapped) {
        const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16)
        const ipv4 = [(high >> 8) & 255, high & 255, (low >> 8) & 255, low & 255].join('.')
        if (ipv4 === '0.0.0.0' || /^(127|10|169\.254)\./.test(ipv4) ||
            /^192\.168\./.test(ipv4) || /^172\.(1[6-9]|2\d|3[01])\./.test(ipv4)) return null
      }
    }
    return url.toString()
  } catch (e) {
    return null
  }
}

// OpenRouter 内置预设：管理 key 走 /api/v1/credits（total_credits - total_usage），
// 普通 key 对它 403，于是回退到 /api/v1/key（limit_remaining）。用户可用同 id
// 覆盖（例如只写 { id: 'openrouter', enabled: false } 停用）。
const OPENROUTER_PROVIDER_PRESET = {
  id: 'openrouter',
  label: 'OpenRouter',
  style: 'balance',
  apiKeyEnv: 'OPENROUTER_API_KEY',
  enabled: true,
  onTurn: true,
  match: { providerSub: ['openrouter'], modelPrefix: [] },
  endpoints: [
    {
      url: 'https://openrouter.ai/api/v1/credits',
      parse: { mode: 'openrouter-credits', currency: 'USD' },
    },
    {
      url: 'https://openrouter.ai/api/v1/key',
      parse: { remainingPath: 'data.limit_remaining', limitPath: 'data.limit', usedPath: 'data.usage', currency: 'USD' },
    },
  ],
}

const BUILTIN_PROVIDERS = [OPENROUTER_PROVIDER_PRESET, ...PROVIDER_PRESETS]
function mergeProviderPreset(raw) {
  const preset = BUILTIN_PROVIDERS.find(provider => provider.id === raw?.id)
  return preset ? { ...preset, ...raw } : raw
}

function sanitizeProviderMatchList(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value.slice(0, 8)) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed || !PROVIDER_MATCH_RE.test(trimmed)) continue
    if (!out.includes(trimmed)) out.push(trimmed)
  }
  return out
}

function sanitizeProvider(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!PROVIDER_ID_RE.test(id)) return null
  // 无效 env 名直接丢弃该额度源：静默回退到 opencode 的 key 会发错凭据。
  const apiKeyEnv = typeof raw.apiKeyEnv === 'string' ? raw.apiKeyEnv.trim() : ''
  if (!CRED_REF_RE.test(apiKeyEnv)) return null
  const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 40) : id
  const style = raw.style === 'windows' ? 'windows' : 'balance'
  const endpoints = []
  for (const ep of (Array.isArray(raw.endpoints) ? raw.endpoints : []).slice(0, 4)) {
    if (!ep || typeof ep !== 'object') continue
    const url = sanitizeProviderEndpointUrl(ep.url)
    if (!url) continue
    const parseRaw = ep.parse && typeof ep.parse === 'object' && !Array.isArray(ep.parse) ? ep.parse : {}
    const parse = {}
    if (parseRaw.mode === 'openrouter-credits' || BUILTIN_PARSE_MODES.includes(parseRaw.mode)) parse.mode = parseRaw.mode
    if (ep.auth !== undefined && ep.auth !== 'bearer' && ep.auth !== 'raw') continue
    for (const key of ['remainingPath', 'limitPath', 'usedPath']) {
      const value = parseRaw[key]
      if (typeof value === 'string' && PROVIDER_PATH_RE.test(value)) parse[key] = value
    }
    if (typeof parseRaw.currency === 'string' && parseRaw.currency.trim()) parse.currency = parseRaw.currency.trim().slice(0, 8)
    const windows = []
    for (const win of (Array.isArray(parseRaw.windows) ? parseRaw.windows : []).slice(0, 6)) {
      if (!win || typeof win !== 'object') continue
      if (typeof win.usedPercentPath !== 'string' || !PROVIDER_PATH_RE.test(win.usedPercentPath)) continue
      const item = {
        label: typeof win.label === 'string' && win.label.trim() ? win.label.trim().slice(0, 12) : 'win',
        usedPercentPath: win.usedPercentPath,
      }
      if (typeof win.resetInSecPath === 'string' && PROVIDER_PATH_RE.test(win.resetInSecPath)) item.resetInSecPath = win.resetInSecPath
      windows.push(item)
    }
    if (windows.length) parse.windows = windows
    const hasBalanceParse = parse.mode === 'openrouter-credits' || parse.mode === 'deepseek-balance' || parse.remainingPath !== undefined || parse.usedPath !== undefined
    const hasWindowParse = parse.mode === 'kimi-usage' || parse.mode === 'zai-quota' || parse.windows
    if (!hasBalanceParse && !hasWindowParse) continue
    endpoints.push({ url, parse, ...(ep.auth ? { auth: ep.auth } : {}) })
  }
  if (!endpoints.length) return null
  const matchRaw = raw.match && typeof raw.match === 'object' && !Array.isArray(raw.match) ? raw.match : {}
  const redBelow = toFiniteNumber(raw.redBelow)
  return {
    id,
    label,
    style,
    apiKeyEnv,
    enabled: sanitizeBoolean(raw.enabled, true),
    onTurn: sanitizeBoolean(raw.onTurn, false),
    // balance 形态可选：余额低于该绝对金额时客户端标红（币种随配置）
    ...(redBelow !== undefined && redBelow >= 0 ? { redBelow } : {}),
    match: {
      providerExact: sanitizeProviderMatchList(matchRaw.providerExact),
      providerSub: sanitizeProviderMatchList(matchRaw.providerSub),
      modelPrefix: sanitizeProviderMatchList(matchRaw.modelPrefix),
    },
    endpoints,
  }
}

function sanitizeProviders(list) {
  const out = []
  const seen = new Set()
  for (const raw of (Array.isArray(list) ? list : []).slice(0, 16)) {
    const provider = sanitizeProvider(raw)
    if (!provider || seen.has(provider.id)) continue
    seen.add(provider.id)
    out.push(provider)
  }
  return out
}

function toFiniteNumber(value) {
  // JSON null（如 OpenRouter 未设上限的 key）表示"缺失"，不能被 Number(null)=0 吞成零值
  if (value === null || value === undefined || value === '') return undefined
  return asNumber(value)
}

// 显式字段白名单：未声明的键（含 "__proto__"/"constructor" 等危险键与膨胀键）
// 一律不进入持久化配置，防原型污染与配置文件无限膨胀。
const CONFIG_KEYS = [
  'enabled', 'hideBottomOnNarrow', 'apiKeyEnv', 'usageUrl', 'intervalSec', 'cacheTtlMs', 'fetchTimeoutMs',
  'showQuota', 'showCodexQuota', 'showAntigravityQuota', 'showOpenCodeQuota', 'quotaAuto', 'quotaShowAll',
  'showDeepseekPeak', 'deepseekPeakCountdown', 'showPeakDot', 'quotaOnStep', 'quotaPercentMode', 'quotaSource',
  'codexQuotaOnTurn', 'antigravityQuotaOnTurn', 'showGit', 'showContext',
  'showCwd', 'showTps', 'showActivity', 'showTools', 'showCost', 'componentOrder', 'gitCwd', 'providers', 'codexAccount', 'antigravityAccount',
]

function sanitizeConfig(cfg) {
  const source = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {}
  const clean = {}
  for (const key of CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) clean[key] = source[key]
  }
  for (const key of BOOLEAN_CONFIG_KEYS) clean[key] = sanitizeBoolean(clean[key], DEFAULT_CONFIG[key])
  clean.componentOrder = sanitizeComponentOrder(clean.componentOrder)
  // Older profiles have per-source refresh preferences. Until the shared
  // switch is saved, retain a conservative combined preference.
  if (source.quotaOnStep === undefined) clean.quotaOnStep =
    clean.codexQuotaOnTurn && clean.antigravityQuotaOnTurn &&
    !(Array.isArray(source.providers) && source.providers.some(p => p?.onTurn === false))
  clean.quotaPercentMode = clean.quotaPercentMode === 'left' ? 'left' : 'used'
  clean.quotaSource = sanitizeQuotaSource(clean.quotaSource)
  clean.apiKeyEnv = sanitizeApiKeyEnv(clean.apiKeyEnv)
  clean.usageUrl = sanitizeUsageUrl(clean.usageUrl)
  clean.intervalSec = clampInt(clean.intervalSec, DEFAULT_CONFIG.intervalSec, 10, 3600)
  clean.cacheTtlMs = clampInt(clean.cacheTtlMs, DEFAULT_CONFIG.cacheTtlMs, 1000, 3600000)
  clean.fetchTimeoutMs = clampInt(clean.fetchTimeoutMs, DEFAULT_CONFIG.fetchTimeoutMs, 1000, 60000)
  clean.gitCwd = sanitizeCwd(clean.gitCwd)
  // Explicit sources retain their order/priority; partial preset overrides
  // inherit endpoints and credential references. Older OpenRouter-only configs
  // gain the new sources without a profile migration.
  // Filter before merging. An entry that survives only as a malformed override must not
  // count as "the user mentioned this id": otherwise the builtin preset is withheld on the
  // first pass and re-appended on the next, so sanitizeConfig(sanitizeConfig(x)) != the
  // first result. Dropping it here makes this primitive idempotent and gives a malformed
  // builtin its default in a single pass.
  const rawProviders = (Array.isArray(source.providers) ? source.providers : []).filter(provider => sanitizeProvider(mergeProviderPreset(provider)))
  const mergedRaw = rawProviders.map(mergeProviderPreset).concat(BUILTIN_PROVIDERS.filter(preset => !rawProviders.some(p => p?.id === preset.id)))
  clean.providers = sanitizeProviders(mergedRaw)
  for (const key of ['codexAccount', 'antigravityAccount']) {
    const value = asString(clean[key]).trim()
    clean[key] = value.length <= 256 && !/[\\/\0]/.test(value) ? value : ''
  }
  return clean
}

// The published Schemastery 3.18.3 has no .check() API. Keep Host-only
// predicates executable here, but expose only their declarative input schema
// to ConfigForms: closure callbacks cannot survive JSON transport.
function hostValidated(schema, validate) {
  const checked = Schema.transform(schema, value => {
    const result = validate(value)
    return result === undefined ? value : result
  }, true)
  const wireSchemas = new WeakMap()
  checked.toJSON = function () {
    // default()/volatile() clone the wrapper. Keep its metadata on the
    // declarative wire form, or an array edit remounts the plugin and removes
    // its currently selected Settings section. Cache for stable schema UIDs.
    let wire = wireSchemas.get(this)
    if (!wire) {
      wire = Schema(schema)
      wire.meta = { ...schema.meta, ...this.meta }
      wireSchemas.set(this, wire)
    }
    return Schema.prototype.toJSON.call(wire)
  }
  return checked
}

// Declarative field shapes: exactly what the settings form sees (type, default, volatile).
// They carry no closures, so they survive JSON transport and repeated toJSON stays stable.
const declarativeFields = {}
for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
  declarativeFields[key] = (typeof value === 'boolean' ? Schema.boolean() : typeof value === 'number' ? Schema.number() : Array.isArray(value) ? Schema.array(Schema.any()) : Schema.string()).default(value)
}
declarativeFields.intervalSec = Schema.number().min(10).max(3600).default(60)
declarativeFields.cacheTtlMs = Schema.number().min(1000).max(3600000).default(60000)
declarativeFields.fetchTimeoutMs = Schema.number().min(1000).max(60000).default(DEFAULT_CONFIG.fetchTimeoutMs)
// No schema default: distinguish legacy profiles from an explicit shared choice.
declarativeFields.quotaOnStep = Schema.boolean()
declarativeFields.quotaPercentMode = Schema.union(['used', 'left']).default('used')
declarativeFields.quotaSource = Schema.union(['auto', 'magpie', 'cpa']).default('auto')
// Accept the removed token ID only to migrate existing layout preferences.
declarativeFields.componentOrder = hostValidated(Schema.array(Schema.union([...COMPONENT_ORDER, 'tokens'])).default(COMPONENT_ORDER), sanitizeComponentOrder).default(COMPONENT_ORDER)
for (const key of ['codexAccount', 'antigravityAccount']) declarativeFields[key] = Schema.string().pattern(/^[^\\/\0]{0,256}$/).default('')
declarativeFields.apiKeyEnv = Schema.string().pattern(CRED_REF_RE).default(DEFAULT_CONFIG.apiKeyEnv)
declarativeFields.usageUrl = hostValidated(Schema.string(), value => {
  if (value !== sanitizeUsageUrl(value)) throw new Error('Only the official opencode usage URL is supported')
}).default(DEFAULT_CONFIG.usageUrl)
// Malformed providers are dropped by the transform below, never thrown: the native
// settings layer resolves this schema against the stored profile, so throwing here
// would stop the plugin from loading at all. The transform is the only place that
// still sees the raw stored list, so the warning is emitted here. Dedup keeps a set of
// messages rather than one slot: settings describe() resolves the inherited defaults
// between reads, so a single slot would be cleared and the same fault re-warned forever.
// The editor's own gate. It rejects anything the sanitizer would silently alter, so a
// settings edit can never persist a literal secret or an internal endpoint. Relying on
// `sanitizeProvider() === null` is not enough: a provider with one valid and one blocked
// endpoint still sanitizes to a non-null value while the blocked URL is what gets stored.
// Structural gaps (a missing parse block) are not dangerous and stay tolerated everywhere.
function providerProblems(providers) {
  const problems = []
  for (const provider of (Array.isArray(providers) ? providers : [])) {
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) { problems.push('(invalid id)'); continue }
    const id = typeof provider.id === 'string' ? provider.id.trim() : ''
    if (!PROVIDER_ID_RE.test(id)) { problems.push(id || '(invalid id)'); continue }
    if (provider.apiKeyEnv !== undefined) {
      const ref = typeof provider.apiKeyEnv === 'string' ? provider.apiKeyEnv.trim() : ''
      if (!CRED_REF_RE.test(ref)) { problems.push(id); continue }
    }
    const endpoints = Array.isArray(provider.endpoints) ? provider.endpoints : []
    if (endpoints.some(endpoint => !endpoint || typeof endpoint !== 'object' || !sanitizeProviderEndpointUrl(endpoint.url))) problems.push(id)
  }
  return problems
}
function assertEditableProviders(providers) {
  const problems = providerProblems(providers)
  // Name the offending source: this gate sees the whole merged config, so a provider left
  // malformed in the stored profile would otherwise block an unrelated edit anonymously.
  if (problems.length) throw new Error('Invalid quota provider definition: ' + problems.join(', '))
}

// The single raw pre-persistence validator. The executable schema tolerates and normalises,
// so an edit can only be rejected HERE, on the raw value that is about to be written: the
// real editor validates the waterfall output but persists the original `next`
// (dsh-config-editor/lib/index.js:79-83 then :105-123). Both the internal/config hook and
// the HTTP config route call this. It reports field names and provider ids only, so a
// rejected literal secret is never echoed back.
function rawConfigProblems(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return ['(config)']
  const problems = []
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    if (typeof value === 'boolean' && raw[key] !== undefined && typeof raw[key] !== 'boolean') problems.push(key)
  }
  // quotaOnStep deliberately has no schema default, but when present it is still a boolean.
  if (raw.quotaOnStep !== undefined && typeof raw.quotaOnStep !== 'boolean') problems.push('quotaOnStep')
  const integerIn = (key, min, max) => {
    const value = raw[key]
    if (value === undefined) return
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) problems.push(key)
  }
  integerIn('intervalSec', 10, 3600)
  integerIn('cacheTtlMs', 1000, 3600000)
  integerIn('fetchTimeoutMs', 1000, 60000)
  if (raw.quotaPercentMode !== undefined && raw.quotaPercentMode !== 'used' && raw.quotaPercentMode !== 'left') problems.push('quotaPercentMode')
  if (raw.quotaSource !== undefined && !['auto', 'magpie', 'cpa'].includes(raw.quotaSource)) problems.push('quotaSource')
  // 'tokens' stays accepted for the documented migration of old layout preferences.
  if (raw.componentOrder !== undefined &&
      (!Array.isArray(raw.componentOrder) || raw.componentOrder.some(item => item !== 'tokens' && !COMPONENT_ORDER.includes(item)))) problems.push('componentOrder')
  if (raw.apiKeyEnv !== undefined) {
    const ref = typeof raw.apiKeyEnv === 'string' ? raw.apiKeyEnv.trim() : ''
    if (!CRED_REF_RE.test(ref)) problems.push('apiKeyEnv')
  }
  if (raw.usageUrl !== undefined && raw.usageUrl !== sanitizeUsageUrl(raw.usageUrl)) problems.push('usageUrl')
  if (raw.gitCwd !== undefined && typeof raw.gitCwd !== 'string') problems.push('gitCwd')
  for (const key of ['codexAccount', 'antigravityAccount']) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] !== 'string' || raw[key].length > 256 || /[\\/\0]/.test(raw[key])) problems.push(key)
  }
  if (raw.providers !== undefined) {
    // providerProblems() treats a non-array as empty, so the shape is checked explicitly.
    if (!Array.isArray(raw.providers)) problems.push('providers')
    else problems.push(...providerProblems(raw.providers).map(id => 'providers[' + id + ']'))
  }
  return problems
}
function assertRawConfig(raw) {
  const problems = rawConfigProblems(raw)
  if (problems.length) throw new Error('Invalid configuration: ' + problems.join(', '))
}

const warnedProviderDrops = new Set()
declarativeFields.providers = hostValidated(Schema.array(Schema.any()).default(sanitizeConfig().providers), providers => {
  const list = Array.isArray(providers) ? providers : []
  const valid = list.filter(provider => sanitizeProvider(mergeProviderPreset(provider)))
  const fallback = [], ignored = []
  for (const provider of list) {
    if (valid.includes(provider)) continue
    // A JSON value such as {toString:1} makes String()/join() throw, which would defeat
    // the tolerance this transform exists to provide. Never coerce an untrusted id.
    const id = provider && typeof provider.id === 'string' ? provider.id.trim() : null
    if (id && BUILTIN_PROVIDERS.some(preset => preset.id === id)) fallback.push(id)
    else ignored.push(id || '(invalid id)')
  }
  // Filter first, then sanitize. sanitizeConfig re-appends every builtin that the list it
  // receives does not mention, so handing it the raw list drops a malformed builtin on the
  // first pass and resurrects it on the next — and apply() normalises repeatedly
  // (Config -> SettingsSchema -> sanitizeConfig). Passing only the valid entries makes the
  // result stable, and gives a malformed builtin its default in a single pass.
  const kept = sanitizeConfig({ providers: valid }).providers
  const notes = []
  if (fallback.length) notes.push('using the built-in default for ' + fallback.join(', '))
  if (ignored.length) notes.push('ignoring invalid quota provider(s): ' + ignored.join(', '))
  const message = notes.length ? notes.join('; ') : null
  if (message && !warnedProviderDrops.has(message)) {
    // Bounded so a long-lived host cannot accumulate messages without limit; clearing
    // also lets the same fault warn again after a while.
    if (warnedProviderDrops.size >= 32) warnedProviderDrops.clear()
    warnedProviderDrops.add(message)
    console.warn('[statusline-plus] ' + message)
  }
  return kept
}).default(sanitizeConfig().providers)
const SettingsSchema = Schema.object(declarativeFields)
const Config = Schema.object(Object.fromEntries(Object.entries(declarativeFields).map(([key, schema]) => [key, schema.volatile()])))

export {
  COMPONENT_ORDER, DEFAULT_CONFIG, CRED_REF_RE, BUILTIN_PROVIDERS, OPENROUTER_PROVIDER_PRESET,
  Config, SettingsSchema, sanitizeConfig, sanitizeCwd, sanitizeUsageUrl, sanitizeProvider, sanitizeProviders,
  sanitizeProviderEndpointUrl, assertRawConfig, asString, toFiniteNumber,
}
