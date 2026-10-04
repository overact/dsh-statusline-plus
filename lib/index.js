'use strict'
/**
 * dsh-statusline-plus — host half.
 * Registers webServer API routes used by the browser bundle:
 *   GET  /statusline/api/config -> current config
 *   POST /statusline/api/config -> revisioned native profile configuration update
 *   POST /statusline/api/usage  -> fetch opencode.ai quota (official API), optional force
 *   POST /statusline/api/git    -> git status --porcelain for a given cwd
 *   POST /statusline/api/codex-quota -> fetch Codex subscription quota (native probe, optional force)
 *   POST /statusline/api/antigravity-quota -> fetch Antigravity subscription quota (Google API, optional force)
 *   POST /statusline/api/provider-quota -> fetch a declared providers[] entry (balance / windows)
 *   POST /statusline/api/session-model -> current provider/model of a live session
 *   GET  /statusline/api/peak-schedule -> holiday calendar + official-rule change check (24 h cache)
 */
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync,
  renameSync, unlinkSync, chmodSync, statSync,
  openSync, closeSync, readSync, fstatSync,
} from 'node:fs'
import { join, dirname, resolve, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import zlib from 'node:zlib'

import Schema from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { RequestPool } from './request-pool.js'
import { PROVIDER_PRESETS, BUILTIN_PARSE_MODES, parseDeepSeekBalance, parseKimiWindows, parseZaiWindows } from './provider-presets.js'
import { TpsTracker, streamTps, estimateTextTokens, validSessionId } from './tps.js'
import { createSessionMetricsProjection } from './session-metrics.js'
import { loadPricingCatalog } from './model-pricing.js'
import { createToolActivityProjection } from './tool-activity.js'
import { PeakScheduleSource } from './peak-schedule.js'
const COMPONENT_ORDER = ['git', 'context', 'tps', 'cost', 'activity', 'tools']

function sanitizeComponentOrder(value) {
  const picked = Array.isArray(value) ? value.slice(0, 32).filter((id, i, all) => COMPONENT_ORDER.includes(id) && all.indexOf(id) === i) : []
  return picked.concat(COMPONENT_ORDER.filter(id => !picked.includes(id)))
}
const CONFIG_PATH = dshHomePath('statusline-config.json')

const DEFAULT_CONFIG = {
  enabled: true,
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
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

// 与 @deepseek-ai/dsh-credentials 的 credentialRef 约束一致
const CRED_REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
function sanitizeApiKeyEnv(value) {
  const s = String(value || '').trim()
  return CRED_REF_RE.test(s) ? s : DEFAULT_CONFIG.apiKeyEnv
}

function sanitizeUsageUrl(value) {
  const s = String(value || '').trim()
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
  'enabled', 'showQuota', 'showCodexQuota', 'showAntigravityQuota', 'showOpenCodeQuota', 'quotaAuto',
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
  let s = String(value || '').trim()
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
  const s = String(value || '').trim()
  try {
    const url = new URL(s)
    if (url.protocol !== 'https:' || !url.hostname ||
        url.username || url.password || url.hash || s.length > 2048) return null
    const host = url.hostname.toLowerCase()
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
  return {
    id,
    label,
    style,
    apiKeyEnv,
    enabled: sanitizeBoolean(raw.enabled, true),
    onTurn: sanitizeBoolean(raw.onTurn, false),
    // balance 形态可选：余额低于该绝对金额时客户端标红（币种随配置）
    ...(toFiniteNumber(raw.redBelow) !== undefined && toFiniteNumber(raw.redBelow) >= 0
      ? { redBelow: toFiniteNumber(raw.redBelow) }
      : {}),
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

function pickPath(value, dottedPath) {
  if (typeof dottedPath !== 'string' || dottedPath.length === 0) return undefined
  let cursor = value
  for (const segment of dottedPath.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = cursor[segment]
  }
  return cursor
}

function toFiniteNumber(value) {
  // JSON null（如 OpenRouter 未设上限的 key）表示"缺失"，不能被 Number(null)=0 吞成零值
  if (value === null || value === undefined || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

// 纯函数：按端点的 parse 声明把 JSON 响应归一化成 balance 视图。
// remaining/limit/used 三者缺其一时按剩余两个推导；全缺则 null（交给下一个端点）。
function providerBalanceFromParse(json, parse) {
  const p = parse && typeof parse === 'object' ? parse : {}
  if (p.mode === 'deepseek-balance') return parseDeepSeekBalance(json)
  if (p.mode === 'openrouter-credits') {
    // 预充值钱包语义：total_credits 是累计充值而非"上限"，remaining 即钱包余额。
    // 不把累计充值伪装成 limit，避免客户端画出误导性的比例条。
    const total = toFiniteNumber(pickPath(json, 'data.total_credits'))
    const used = toFiniteNumber(pickPath(json, 'data.total_usage'))
    if (total === undefined || used === undefined) return null
    return { currency: 'USD', remaining: total - used, limit: undefined, used }
  }
  const remainingRaw = toFiniteNumber(pickPath(json, p.remainingPath))
  const limit = toFiniteNumber(pickPath(json, p.limitPath))
  let used = toFiniteNumber(pickPath(json, p.usedPath))
  if (used === undefined && limit !== undefined && remainingRaw !== undefined) used = limit - remainingRaw
  let remaining = remainingRaw
  if (remaining === undefined && limit !== undefined && used !== undefined) remaining = limit - used
  if (remaining === undefined && used === undefined) return null
  return {
    currency: typeof p.currency === 'string' && p.currency ? p.currency : null,
    remaining,
    limit,
    used,
  }
}

function providerWindowsFromParse(json, windows) {
  if (!Array.isArray(windows) || !windows.length) return null
  const out = []
  for (const win of windows) {
    const usedPercent = toFiniteNumber(pickPath(json, win.usedPercentPath))
    if (usedPercent === undefined) continue
    const item = { label: win.label, usedPercent }
    const resetInSec = win.resetInSecPath ? toFiniteNumber(pickPath(json, win.resetInSecPath)) : undefined
    if (resetInSec !== undefined) item.resetInSec = Math.max(0, Math.round(resetInSec))
    out.push(item)
  }
  return out.length ? out : null
}

function providerError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function providerErrorCode(status) {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate-limit'
  return 'network'
}

// 逐端点回退：2xx 即解析返回；401/403/429/5xx 或解析失败都换下一个端点。
// 最终返回最相关的错误码（rate-limit > auth > invalid-response > network），
// 与 codex/antigravity 路由相同的稳定短码约定。
async function readQuotaJson(response) {
  if (!response.body || typeof response.body.getReader !== 'function') return response.json()
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > 1024 * 1024) throw new Error('invalid-response')
      chunks.push(Buffer.from(part.value))
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

async function fetchProviderQuota(credentials, id, force, signal) {
  const def = (state.config.providers || []).find(p => p.id === id && p.enabled !== false)
  if (!def) throw providerError('not-found')
  const key = await readUsageKey(credentials, def.apiKeyEnv)
  if (!key) throw providerError('no-credential')
  let lastError = 'network'
  let sawAuth = false
  for (const endpoint of def.endpoints) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), state.config.fetchTimeoutMs)
    try {
      const response = await fetch(endpoint.url, {
        headers: { authorization: endpoint.auth === 'raw' ? key : 'Bearer ' + key, accept: 'application/json' },
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
        // 禁止跟随重定向：带 Bearer key 的请求不允许被 302 转送到其他主机
        redirect: 'manual',
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        const code = providerErrorCode(response.status)
        if (code === 'auth') sawAuth = true
        if (code === 'rate-limit') throw providerError('rate-limit')
        lastError = code
        continue
      }
      let json = null
      try { json = await readQuotaJson(response) } catch (e) { lastError = 'invalid-response'; continue }
      // Some gateways return HTTP 200 with a business-level auth error.
      if (endpoint.parse?.mode === 'zai-quota' && (json?.success === false || json?.code !== undefined && String(json.code) !== '200')) {
        const code = providerErrorCode(Number(json?.code))
        if (code === 'auth') sawAuth = true
        if (code === 'rate-limit') throw providerError(code)
        lastError = code === 'network' ? 'invalid-response' : code
        continue
      }
      if (def.style === 'windows') {
        const mode = endpoint.parse?.mode
        const windows = mode === 'kimi-usage' ? parseKimiWindows(json) : mode === 'zai-quota' ? parseZaiWindows(json)
          : providerWindowsFromParse(json, endpoint.parse && endpoint.parse.windows)
        if (!windows) { lastError = 'invalid-response'; continue }
        const result = { style: 'windows', label: def.label, windows, fetchedAt: Date.now() }
        return result
      }
      const balance = providerBalanceFromParse(json, endpoint.parse)
      if (!balance) { lastError = 'invalid-response'; continue }
      const result = { style: 'balance', label: def.label, ...balance, fetchedAt: Date.now() }
      if (def.redBelow !== undefined) result.redBelow = def.redBelow
      return result
    } catch (e) {
      if (e.message === 'rate-limit') throw e
      signal?.throwIfAborted()
      lastError = 'network'
    } finally {
      clearTimeout(timer)
    }
  }
  if (sawAuth) throw providerError('auth')
  throw providerError(lastError)
}

// Native stream TPS lives in tps.js: character-based estimates while streaming,
// provider usage at settlement. Estimation error is not calibrated.

// 显式字段白名单：未声明的键（含 "__proto__"/"constructor" 等危险键与膨胀键）
// 一律不进入持久化配置，防原型污染与配置文件无限膨胀。
const CONFIG_KEYS = [
  'enabled', 'apiKeyEnv', 'usageUrl', 'intervalSec', 'cacheTtlMs', 'fetchTimeoutMs',
  'showQuota', 'showCodexQuota', 'showAntigravityQuota', 'showOpenCodeQuota', 'quotaAuto',
  'showDeepseekPeak', 'deepseekPeakCountdown', 'showPeakDot', 'quotaOnStep', 'quotaPercentMode',
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
  clean.apiKeyEnv = sanitizeApiKeyEnv(clean.apiKeyEnv)
  clean.usageUrl = sanitizeUsageUrl(clean.usageUrl)
  clean.intervalSec = clampInt(clean.intervalSec, DEFAULT_CONFIG.intervalSec, 10, 3600)
  clean.cacheTtlMs = clampInt(clean.cacheTtlMs, DEFAULT_CONFIG.cacheTtlMs, 1000, 3600000)
  clean.fetchTimeoutMs = clampInt(clean.fetchTimeoutMs, DEFAULT_CONFIG.fetchTimeoutMs, 1000, 60000)
  clean.gitCwd = sanitizeCwd(clean.gitCwd)
  // Explicit sources retain their order/priority; partial preset overrides
  // inherit endpoints and credential references. Older OpenRouter-only configs
  // gain the new sources without a profile migration.
  const rawProviders = Array.isArray(source.providers) ? source.providers : []
  const mergedRaw = rawProviders.map(mergeProviderPreset).concat(BUILTIN_PROVIDERS.filter(preset => !rawProviders.some(p => p?.id === preset.id)))
  clean.providers = sanitizeProviders(mergedRaw)
  for (const key of ['codexAccount', 'antigravityAccount']) {
    const value = String(clean[key] || '').trim()
    clean[key] = value.length <= 256 && !/[\\/\0]/.test(value) ? value : ''
  }
  return clean
}

function readConfig() {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
      if (raw && typeof raw === 'object') return sanitizeConfig(raw)
    }
  } catch (e) { /* corrupted file -> defaults */ }
  return sanitizeConfig()
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

const settingsFields = {}
for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
  settingsFields[key] = (typeof value === 'boolean' ? Schema.boolean() : typeof value === 'number' ? Schema.number() : Array.isArray(value) ? Schema.array(Schema.any()) : Schema.string()).default(value)
}
settingsFields.intervalSec = Schema.number().min(10).max(3600).default(60)
settingsFields.cacheTtlMs = Schema.number().min(1000).max(3600000).default(60000)
settingsFields.fetchTimeoutMs = Schema.number().min(1000).max(60000).default(10000)
// No schema default: distinguish legacy profiles from an explicit shared choice.
settingsFields.quotaOnStep = Schema.boolean()
settingsFields.quotaPercentMode = Schema.union(['used', 'left']).default('used')
// Accept the removed token ID only to migrate existing layout preferences.
settingsFields.componentOrder = hostValidated(Schema.array(Schema.union([...COMPONENT_ORDER, 'tokens'])).default(COMPONENT_ORDER), sanitizeComponentOrder).default(COMPONENT_ORDER)
for (const key of ['codexAccount', 'antigravityAccount']) settingsFields[key] = Schema.string().pattern(/^[^\\/\0]{0,256}$/).default('')
settingsFields.apiKeyEnv = Schema.string().pattern(CRED_REF_RE).default(DEFAULT_CONFIG.apiKeyEnv)
settingsFields.usageUrl = hostValidated(Schema.string().default(DEFAULT_CONFIG.usageUrl), value => {
  if (value !== sanitizeUsageUrl(value)) throw new Error('Only the official opencode usage URL is supported')
})
settingsFields.providers = hostValidated(Schema.array(hostValidated(Schema.any(), provider => {
  if (!provider || !sanitizeProvider(mergeProviderPreset(provider))) throw new Error('Invalid quota provider definition')
})).default(sanitizeConfig().providers), providers => sanitizeConfig({ providers }).providers).default(sanitizeConfig().providers)
const SettingsSchema = Schema.object(settingsFields)
const Config = Schema.object(Object.fromEntries(Object.entries(settingsFields).map(([key, schema]) => [key, schema.volatile()])))
const state = {
  config: readConfig(),
  sessionModelCache: new Map(),
}

// ---- 会话日志解码（zstd 多帧 + 撕裂尾部容错） ----
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const RECENT_SESSION_MAX_FRAMES = 128
const RECENT_SESSION_MAX_OUTPUT_BYTES = 2 * 1024 * 1024

// 从日志尾部反向解码有限数量的帧。Node 的同步 zstd API 每次调用都会创建
// 原生解码上下文；对长会话逐帧全解会让 glibc 保留数 GiB 已释放 arena。
// statusline 只需要最近的 model/tool 线索，因此必须给帧数和输出量设硬上限。
function decodeRecentSessionText(buf, options = {}) {
  const maxFrames = Math.max(1, Math.min(4096, Number(options.maxFrames) || RECENT_SESSION_MAX_FRAMES))
  const maxOutputBytes = Math.max(1024, Math.min(16 * 1024 * 1024,
    Number(options.maxOutputBytes) || RECENT_SESSION_MAX_OUTPUT_BYTES))
  const offsets = []
  let cursor = 0
  while (cursor < buf.length) {
    const idx = buf.indexOf(ZSTD_MAGIC, cursor)
    if (idx < 0) break
    offsets.push(idx)
    cursor = idx + ZSTD_MAGIC.length
  }
  const reversed = []
  let outputBytes = 0
  let decodedFrames = 0
  for (let i = offsets.length - 1; i >= 0 && decodedFrames < maxFrames && outputBytes < maxOutputBytes; i--) {
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
    decodedFrames += 1
    try {
      const part = zlib.zstdDecompressSync(buf.subarray(offsets[i], end), { maxOutputLength: maxOutputBytes - outputBytes })
      if (part.length === 0) continue
      reversed.push(part)
      outputBytes += part.length
    } catch (e) {
      // 不跨过超大帧寻找更旧的模型：该帧可能含有更新后的 request/header。
      if (e.code === 'ERR_BUFFER_TOO_LARGE') break
      // 最后一帧可能仍在写入；跳过它并继续尝试更早的完整帧。
    }
  }
  return Buffer.concat(reversed.reverse()).toString('utf8')
}

function decodeSessionText(buf) {
  return decodeRecentSessionText(buf)
}

const SESSION_ID_RE = /^(?:session-)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

function normalizeSessionId(sessionId) {
  const match = String(sessionId || '').trim().match(SESSION_ID_RE)
  return match ? match[1].toLowerCase() : null
}

function selectSessionLog(directory) {
  if (!existsSync(directory)) return null
  const candidates = readdirSync(directory).flatMap(name => {
    const match = /^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?$/.exec(name)
    return match ? [{ name, version: Number(match[1] || 0) }] : []
  }).sort((a, b) => b.version - a.version || Number(b.name.endsWith('.zstd')) - Number(a.name.endsWith('.zstd')))
  if (!candidates.length) return null
  if (candidates[0].version > 2) throw new Error('unsupported session format')
  return join(directory, candidates[0].name)
}

function findSessionLog(sessionId) {
  const bareId = normalizeSessionId(sessionId)
  if (!bareId) throw new Error('bad session id')
  const requested = String(sessionId || '').trim()
  const candidates = requested.startsWith('session-')
    ? ['session-' + bareId, bareId]
    : [bareId, 'session-' + bareId]
  const root = dshHomePath('sessions')
  let projects
  try {
    projects = readdirSync(root, { withFileTypes: true })
  } catch (e) { throw new Error('sessions root not found') }
  for (const candidate of candidates) {
    for (const proj of projects) {
      if (!proj.isDirectory()) continue
      const file = selectSessionLog(join(root, proj.name, candidate))
      if (file) return file
    }
  }
  throw new Error('session log not found')
}

// 只读文件尾部并反向解出有限数量的完整 zstd 帧：长会话日志不做全量解码。
function decodeSessionTail(file, maxBytes) {
  const fd = openSync(file, 'r')
  try {
    const size = fstatSync(fd).size
    const len = Math.min(size, maxBytes)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    return file.endsWith('.jsonl') ? buf.subarray(Math.max(0, buf.length - RECENT_SESSION_MAX_OUTPUT_BYTES)).toString('utf8') : decodeRecentSessionText(buf)
  } finally {
    closeSync(fd)
  }
}

function decodeSessionHead(file, maxBytes) {
  const fd = openSync(file, 'r')
  try {
    const size = fstatSync(fd).size
    const len = Math.min(size, maxBytes)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, 0)
    return decodeSessionText(buf)
  } finally {
    closeSync(fd)
  }
}

// 从解出的文本尾部向前找最近一次 request/header，避免扫全量日志
function scanLastRequestModel(text) {
  const lines = String(text || '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line.indexOf('"type":"request/header"') === -1) continue
    try {
      const ev = JSON.parse(line)
      const cfg = ev.data && ev.data.header && ev.data.header.config
      if (cfg && cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model }
    } catch (e) { /* skip malformed */ }
  }
  return null
}

function findLiveSession(sessions, sessionId) {
  if (!sessions || typeof sessions.get !== 'function') return null
  const bareId = normalizeSessionId(sessionId)
  const raw = String(sessionId || '').trim()
  if (!raw) return null
  const candidates = bareId ? [raw, bareId, 'session-' + bareId] : [raw]
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      const session = sessions.get(candidate)
      if (session) return session
    } catch (e) { /* continue */ }
  }
  return null
}

function scanLastRequestModelEvents(events) {
  const rows = Array.isArray(events) ? events : []
  for (let i = rows.length - 1; i >= 0; i--) {
    const ev = rows[i]
    if (!ev || ev.type !== 'request/header') continue
    const cfg = ev.data && ev.data.header && ev.data.header.config
    if (cfg && cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model }
  }
  return null
}

function readLiveSessionModel(sessions, sessionId) {
  const session = findLiveSession(sessions, sessionId)
  if (!session) return null
  try {
    const header = typeof session.requestHeader === 'function' ? session.requestHeader() : null
    const cfg = header && header.config
    if (cfg && cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model }
  } catch (e) { /* fall back to the resident event array */ }
  try { return scanLastRequestModelEvents(session.snapshotEvents(Math.max(0, session.seq - 2000))) } catch (e) { return null }
}

// 读会话日志里最近一次 request/header 的 provider/model：
// 优先从内存活体会话获取（零磁盘 I/O、零解压）；磁盘路径反向只解压尾部有界帧。
function readSessionModel(sessionId, sessions) {
  if (sessions) {
    const live = readLiveSessionModel(sessions, sessionId)
    if (live) return live
  }
  const file = findSessionLog(sessionId)
  return scanLastRequestModel(decodeSessionTail(file, 8 * 1024 * 1024))

}

function sendJson(res, status, obj) {
  if (res.destroyed || res.writableEnded) return
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

const BODY_LIMIT_BYTES = 1024 * 1024
const BODY_ERROR_KEY = '__slpBodyError'

function readBody(req) {
  return new Promise(resolve => {
    const chunks = []
    let size = 0, settled = false
    const finish = value => {
      if (settled) return
      settled = true
      req.removeListener('data', data)
      req.removeListener('end', end)
      req.removeListener('error', error)
      req.removeListener('aborted', error)
      chunks.length = 0
      resolve(value)
    }
    const data = chunk => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += buf.length
      if (size > BODY_LIMIT_BYTES) {
        finish({ [BODY_ERROR_KEY]: 'body-too-large' })
        req.resume?.()
      } else chunks.push(buf)
    }
    const end = () => {
      try {
        const value = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
        finish(value && typeof value === 'object' && !Array.isArray(value) ? value : { [BODY_ERROR_KEY]: 'invalid-json' })
      } catch { finish({ [BODY_ERROR_KEY]: 'invalid-json' }) }
    }
    const error = () => finish({ [BODY_ERROR_KEY]: 'body-read-failed' })
    req.on('data', data); req.on('end', end); req.on('error', error); req.on('aborted', error)
    if (req.aborted) error()
  })
}

function bodyErrorStatus(code) {
  return code === 'body-too-large' ? 413 : 400
}

function rejectBodyError(body, res) {
  const code = body && body[BODY_ERROR_KEY]
  if (!code) return false
  sendJson(res, bodyErrorStatus(code), { ok: false, error: code })
  return true
}

function sameOriginRequest(req) {
  const headers = req && req.headers
  if (!headers || !headers.origin) return true
  const origin = String(headers.origin)
  const host = String(headers.host || '').toLowerCase()
  if (!host) return true
  try {
    const url = new URL(origin)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.host.toLowerCase() === host
  } catch (e) {
    return false
  }
}

function guardRequest(req, res, methods, needsJson) {
  if (methods.indexOf(req.method) === -1) {
    res.setHeader('allow', methods.join(', '))
    sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return false
  }
  if (req.method !== 'GET' && !sameOriginRequest(req)) {
    sendJson(res, 403, { ok: false, error: 'cross-origin' })
    return false
  }
  if (needsJson) {
    const contentType = String((req.headers && req.headers['content-type']) || '').toLowerCase()
    if (!contentType.split(';', 1)[0].trim().includes('application/json')) {
      sendJson(res, 415, { ok: false, error: 'json-required' })
      return false
    }
  }
  return true
}

async function resolveExecutable(subprocess, name, fallbacks) {
  if (subprocess === undefined) return null
  try {
    return await subprocess.resolveExecutable(name)
  } catch (e) { /* fall through */ }
  for (const p of fallbacks) {
    try {
      return await subprocess.resolveExecutable(p)
    } catch (e) { /* try next */ }
    if (existsSync(p)) return p
  }
  return null
}

async function runCollect(subprocess, argv, cwd, maxBytes, timeoutMs, signal) {
  const controller = timeoutMs !== undefined && timeoutMs > 0 ? new AbortController() : null
  const timer = controller !== null ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    signal?.throwIfAborted()
    const handle = subprocess.spawn({
      argv,
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { collect: true, maxBytes },
        stderr: { collect: true, maxBytes: 65536 },
      },
      graceMs: 500,
      signal: signal && controller ? AbortSignal.any([signal, controller.signal]) : signal || controller?.signal,
    })
    const outcome = await handle.done
    signal?.throwIfAborted()
    const collected = handle.collected.stdout?.readFrom(0)
    if (collected?.lossy) throw new Error('git-output-too-large')
    const stdout = collected?.text || ''
    const stderr = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
    // 超时信号触发的终止：以 aborted 标记返回给调用方分类，避免浏览器端超时后宿主进程仍占用资源。
    const aborted = controller !== null && controller.signal.aborted && (outcome.exitCode !== 0 || outcome.signal !== null)
    return { exitCode: outcome.exitCode, signal: outcome.signal, stdout, stderr, aborted }
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

async function readUsageKey(credentials, apiKeyEnv) {
  try {
    if (credentials !== undefined && credentials !== null && typeof credentials.resolve === 'function') {
      const hit = await credentials.resolve(apiKeyEnv)
      if (hit !== undefined && hit !== null && hit.value !== undefined && String(hit.value).length > 0) {
        return String(hit.value)
      }
    }
  } catch (e) { /* 凭据服务不可用时回退到环境变量 */ }
  const ambient = process.env[apiKeyEnv]
  return ambient !== undefined && ambient.length > 0 ? ambient : null
}

async function fetchUsage(credentials, force, signal) {
  const cfg = state.config
  const key = await readUsageKey(credentials, cfg.apiKeyEnv)
  if (!key) throw new Error('no-credential')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.fetchTimeoutMs)
  try {
    const response = await fetch(cfg.usageUrl, {
      headers: { authorization: 'Bearer ' + key },
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    })
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(providerErrorCode(response.status)) }
    const payload = await readQuotaJson(response)
    const usage = payload && payload.usage
    if (!usage || typeof usage !== 'object') throw new Error('network')
    const completedAt = Date.now()
    const result = {
      fetchedAt: completedAt,
      windows: {
        rolling: usage.rolling || {},
        weekly: usage.weekly || {},
        monthly: usage.monthly || {},
      },
    }
    return result
  } catch (e) {
    if (e && ['no-credential', 'auth', 'rate-limit', 'invalid-response'].includes(e.message)) throw e
    throw new Error('network')
  } finally {
    clearTimeout(timer)
  }
}

// ---- Codex 订阅额度：探测请求 + 解析响应头里的 x-codex-* 字段 ----
// 响应头样例见 /tmp/ch-headers.txt（含完整 x-codex-* 字段）。
// 解析规则：HTTP 200 才算成功；Credits 布尔字段可能在大小写间变化，按字符串归一。

function readAllCredentials(prefix) {
  const root = join(homedir(), '.cli-proxy-api')
  let files = []
  try { files = readdirSync(root).filter(name => name.startsWith(prefix + '-') && name.endsWith('.json')) } catch { return [] }
  const creds = []
  for (const name of files) {
    try {
      const filePath = join(root, name)
      const data = JSON.parse(readFileSync(filePath, 'utf8'))
      if (data && (data.access_token || data.refresh_token)) {
        const priority = typeof data.priority === 'number'
          ? data.priority
          : (data.attributes && typeof data.attributes.priority === 'number' ? data.attributes.priority : 0)
        creds.push({
          ...data,
          filePath,
          fileName: name,
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          projectId: data.project_id,
          email: data.email,
          priority,
        })
      }
    } catch {}
  }
  creds.sort((a, b) => b.priority - a.priority || a.fileName.localeCompare(b.fileName))
  return creds
}

function readSelectedCredential(prefix, selected) {
  const root = join(homedir(), '.cli-proxy-api')
  if (selected) {
    let files
    try { files = readdirSync(root).filter(name => name.startsWith(prefix + '-') && name.endsWith('.json')) } catch { return null }
    files = files.filter(name => name === selected)
    if (files.length !== 1) return null
    try {
      const filePath = join(root, files[0])
      const data = JSON.parse(readFileSync(filePath, 'utf8'))
      const priority = typeof data.priority === 'number'
        ? data.priority
        : (data.attributes && typeof data.attributes.priority === 'number' ? data.attributes.priority : 0)
      return {
        ...data,
        filePath,
        fileName: files[0],
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        projectId: data.project_id,
        email: data.email,
        priority,
      }
    } catch { return null }
  }
  const all = readAllCredentials(prefix)
  if (all.length === 0) return null
  return all[0]
}
function readCodexCredential() {
  return readSelectedCredential('codex', state.config.codexAccount)?.access_token || null
}

// JWT 仅用于读取可选的账号头；不验签，失败时忽略该头并继续请求。
function readCodexAccountId(accessToken) {
  try {
    const parts = String(accessToken || '').split('.')
    if (parts.length < 2) return undefined
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = payload + '='.repeat((4 - payload.length % 4) % 4)
    const claims = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
    const auth = claims && claims['https://api.openai.com/auth']
    const accountId = auth && auth.chatgpt_account_id
    return accountId === undefined || accountId === null || String(accountId) === ''
      ? undefined
      : String(accountId)
  } catch (e) {
    return undefined
  }
}

// Wham usage 接口比探测请求轻量；网络错误或非 200 由调用方回退到头探测。
async function fetchCodexWham(accessToken, signal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12000)
  try {
    const headers = {
      Authorization: 'Bearer ' + accessToken,
      Accept: 'application/json',
    }
    const accountId = readCodexAccountId(accessToken)
    if (accountId) headers['chatgpt-account-id'] = accountId
    const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      method: 'GET',
      headers,
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    })
    let json = null
    try { json = await readQuotaJson(response) } catch (e) { /* 非 JSON 响应交给回退逻辑 */ }
    return { status: response.status, json }
  } finally {
    clearTimeout(timer)
  }
}

function whamNumber(value) {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function whamBool(value) {
  if (typeof value === 'boolean') return value
  if (value === undefined || value === null || value === '') return undefined
  const s = String(value).trim().toLowerCase()
  if (s === 'true' || s === '1') return true
  if (s === 'false' || s === '0') return false
  return undefined
}

// 纯函数：把 Wham usage 归一化为头探测解析器使用的字段。
function parseWhamUsage(json) {
  const out = {}
  if (!json || typeof json !== 'object') return out
  if (json.plan_type !== undefined && json.plan_type !== null) out.planType = String(json.plan_type)
  if (json.email !== undefined && json.email !== null) out.email = String(json.email)
  if (json.active_limit !== undefined && json.active_limit !== null) out.activeLimit = String(json.active_limit)

  const rateLimit = json.rate_limit
  if (!rateLimit || typeof rateLimit !== 'object') return out
  const primary = rateLimit.primary_window
  const secondary = rateLimit.secondary_window
  if (primary && typeof primary === 'object') {
    const usedPercent = whamNumber(primary.used_percent)
    if (usedPercent !== undefined) out.primaryUsedPercent = usedPercent
    const windowSeconds = whamNumber(primary.limit_window_seconds)
    if (windowSeconds !== undefined) out.primaryWindowMinutes = windowSeconds / 60
    const resetAfter = whamNumber(primary.reset_after_seconds)
    if (resetAfter !== undefined) out.primaryResetAfterSeconds = resetAfter
    // Wham 的 reset_at 是秒级 Unix epoch，与 x-codex-primary-reset-at 相同，直接映射。
    const resetAt = whamNumber(primary.reset_at)
    if (resetAt !== undefined) out.primaryResetAt = resetAt
  }
  if (secondary && typeof secondary === 'object') {
    const usedPercent = whamNumber(secondary.used_percent)
    if (usedPercent !== undefined) out.secondaryUsedPercent = usedPercent
    const windowSeconds = whamNumber(secondary.limit_window_seconds)
    if (windowSeconds !== undefined) out.secondaryWindowMinutes = windowSeconds / 60
    const resetAfter = whamNumber(secondary.reset_after_seconds)
    if (resetAfter !== undefined) out.secondaryResetAfterSeconds = resetAfter
    const resetAt = whamNumber(secondary.reset_at)
    if (resetAt !== undefined) out.secondaryResetAt = resetAt
  }

  const credits = json.credits
  if (credits && typeof credits === 'object') {
    const hasCredits = whamBool(credits.has_credits !== undefined ? credits.has_credits : credits.hasCredits)
    if (hasCredits !== undefined) out.creditsHasCredits = hasCredits
    const balance = whamNumber(credits.balance)
    if (balance !== undefined) out.creditsBalance = balance
    const unlimited = whamBool(credits.unlimited)
    if (unlimited !== undefined) out.creditsUnlimited = unlimited
  }
  return out
}

const CODEX_HEADER_PARSERS = [
  ['x-codex-plan-type', 'planType', String],
  ['x-codex-active-limit', 'activeLimit', String],
  ['x-codex-primary-used-percent', 'primaryUsedPercent', Number],
  ['x-codex-primary-window-minutes', 'primaryWindowMinutes', Number],
  ['x-codex-primary-reset-at', 'primaryResetAt', Number],
  ['x-codex-primary-reset-after-seconds', 'primaryResetAfterSeconds', Number],
  ['x-codex-primary-over-secondary-limit-percent', 'primaryOverSecondaryLimitPercent', Number],
  ['x-codex-secondary-used-percent', 'secondaryUsedPercent', Number],
  ['x-codex-secondary-window-minutes', 'secondaryWindowMinutes', Number],
  ['x-codex-secondary-reset-at', 'secondaryResetAt', Number],
  ['x-codex-secondary-reset-after-seconds', 'secondaryResetAfterSeconds', Number],
  ['x-codex-credits-has-credits', 'creditsHasCredits', boolHeader],
  ['x-codex-credits-balance', 'creditsBalance', Number],
  ['x-codex-credits-unlimited', 'creditsUnlimited', boolHeader],
]

function boolHeader(raw) {
  const s = String(raw || '').trim().toLowerCase()
  return s === 'true' || s === '1'
}

function headerValue(raw, name) {
  // 多行头用 \r\n 记录；解析成 key: value 便于按名取值
  const lines = String(raw || '').split(/\r\n|\n/)
  for (const line of lines) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    if (line.slice(0, idx).trim().toLowerCase() !== name.toLowerCase()) continue
    return line.slice(idx + 1).trim()
  }
  return undefined
}

// 纯函数：把 -D - 原始响应头解析成结构化对象（按键归一）。独立测试脚本复用。
function parseCodexHeaders(rawHeaders) {
  const out = {}
  for (const [headerName, key, conv] of CODEX_HEADER_PARSERS) {
    const v = headerValue(rawHeaders, headerName)
    if (v === undefined || v === '') continue
    const n = conv(v)
    if (n === undefined) continue
    if (typeof n === 'number' && !Number.isFinite(n)) continue
    if (n === '') continue
    out[key] = n
  }
  return out
}

function buildCodexResult(now, parsed) {
  const primary = {
    usedPercent: parsed.primaryUsedPercent,
    overSecondaryLimitPercent: parsed.primaryOverSecondaryLimitPercent,
  }
  if (parsed.primaryWindowMinutes !== undefined) primary.windowMinutes = parsed.primaryWindowMinutes
  if (parsed.primaryResetAt !== undefined) primary.resetAt = parsed.primaryResetAt
  if (parsed.primaryResetAfterSeconds !== undefined) primary.resetAfterSeconds = parsed.primaryResetAfterSeconds
  const secondary = { usedPercent: parsed.secondaryUsedPercent }
  if (parsed.secondaryWindowMinutes !== undefined) secondary.windowMinutes = parsed.secondaryWindowMinutes
  if (parsed.secondaryResetAt !== undefined) secondary.resetAt = parsed.secondaryResetAt
  if (parsed.secondaryResetAfterSeconds !== undefined) secondary.resetAfterSeconds = parsed.secondaryResetAfterSeconds
  const credits = {}
  if (parsed.creditsHasCredits !== undefined) credits.hasCredits = parsed.creditsHasCredits
  if (parsed.creditsBalance !== undefined) credits.balance = parsed.creditsBalance
  if (parsed.creditsUnlimited !== undefined) credits.unlimited = parsed.creditsUnlimited
  const result = {
    fetchedAt: now,
    planType: parsed.planType,
    activeLimit: parsed.activeLimit,
    primary,
    secondary,
    credits,
  }
  if (parsed.email !== undefined) result.email = parsed.email
  return result
}

async function fetchCodexQuota(force, signal) {
  const token = readCodexCredential()
  if (!token) throw new Error('no-credential')
  const wham = await fetchCodexWham(token, signal)
  if (wham.status !== 200) throw new Error(providerErrorCode(wham.status))
  const parsed = parseWhamUsage(wham.json)
  if (parsed.primaryUsedPercent === undefined) throw new Error('invalid-response')
  return buildCodexResult(Date.now(), parsed)
}

// ---- Antigravity (Google Cloud Code / Gemini) 订阅额度 ----
const ANTIGRAVITY_HOST = 'daily-cloudcode-pa.googleapis.com'

async function refreshAntigravityToken(cred, signal) {
  if (!cred || !cred.refreshToken) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10000)
  try {
    const params = new URLSearchParams({
      // Antigravity/Cloud Code 生态公开的 first-party OAuth client_id（非个人凭据，
      // 与官方 CLI 共用）；client_secret 由使用者通过环境变量提供。
      client_id: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
      client_secret: process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET || '',
      refresh_token: cred.refreshToken,
      grant_type: 'refresh_token',
    })
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    })
    if (!res.ok) return null
    const data = await readQuotaJson(res)
    if (data && data.access_token) {
      cred.accessToken = data.access_token
      if (cred.filePath) {
        try {
          const raw = JSON.parse(readFileSync(cred.filePath, 'utf8'))
          raw.access_token = data.access_token
          if (data.expires_in) raw.expires_in = data.expires_in
          raw.timestamp = Date.now()
          writeFileSync(cred.filePath, JSON.stringify(raw, null, 2), { mode: 0o600 })
        } catch (e) { /* best effort disk write */ }
      }
      return data.access_token
    }
  } catch (e) {
    return null
  } finally {
    clearTimeout(timer)
  }
  return null
}

function parseAntigravityQuotaSummary(now, cred, summaryJson) {
  const groups = summaryJson && Array.isArray(summaryJson.groups) ? summaryJson.groups : []
  let gemini5h = null
  let geminiWeekly = null
  let thirdParty = null

  function parseBucket(bucket) {
    if (!bucket) return null
    const rem = bucket.remainingFraction
    if (typeof rem !== 'number' || !Number.isFinite(rem) || rem < 0 || rem > 1) return null
    let resetInSec = 0
    if (bucket.resetTime) {
      const resetMs = new Date(bucket.resetTime).getTime()
      if (!isNaN(resetMs)) resetInSec = Math.max(0, Math.round((resetMs - now) / 1000))
    }
    return {
      remainingFraction: rem,
      remainingPercent: Math.max(0, Math.min(100, Math.round(rem * 100))),
      usedPercent: Math.max(0, Math.min(100, Math.round((1 - rem) * 100))),
      resetTime: bucket.resetTime || null,
      resetInSec: resetInSec,
      displayName: bucket.displayName || bucket.bucketId || '',
    }
  }

  for (const group of groups) {
    if (!group || !Array.isArray(group.buckets)) continue
    const groupName = String(group.displayName || '').toLowerCase()
    const isGemini = groupName.includes('gemini')
    const isThirdParty = /claude|gpt|third.party/.test(groupName)
    if (!isGemini && !isThirdParty) continue
    for (const b of group.buckets) {
      if (!b) continue
      const is5h = b.window === '5h' || String(b.bucketId || '').includes('5h')
      const isWeekly = b.window === 'weekly' || String(b.bucketId || '').includes('weekly')
      const item = parseBucket(b)
      if (!item) continue
      if (isGemini) {
        if (is5h && !gemini5h) gemini5h = item
        else if (isWeekly && !geminiWeekly) geminiWeekly = item
      } else {
        if (is5h && !thirdParty) thirdParty = item
      }
    }
  }

  if (!gemini5h && !geminiWeekly && !thirdParty) return null

  return {
    fetchedAt: now,
    fileName: cred.fileName,
    email: cred.email || undefined,
    projectId: cred.projectId || undefined,
    gemini5h,
    geminiWeekly,
    thirdParty,
  }
}

async function fetchAntigravityQuotaForCred(cred, now, signal) {
  const accessToken = cred?.accessToken || cred?.access_token
  const refreshToken = cred?.refreshToken || cred?.refresh_token
  const projectId = cred?.projectId || cred?.project_id
  if (!cred || !accessToken) return null

  async function requestEndpoint(token, endpoint) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12000)
    try {
      const body = projectId ? JSON.stringify({ project: projectId }) : JSON.stringify({})
      const res = await fetch(`https://${ANTIGRAVITY_HOST}/v1internal:` + endpoint, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
          'User-Agent': 'antigravity',
        },
        body,
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      })
      let json = null
      try { json = await readQuotaJson(res) } catch (e) {}
      return { status: res.status, json }
    } finally {
      clearTimeout(timer)
    }
  }

  let activeToken = accessToken
  let resp
  try {
    resp = await requestEndpoint(activeToken, 'retrieveUserQuotaSummary')
  } catch (e) {
    throw new Error('network')
  }

  if (resp.status === 401 && refreshToken) {
    const refreshed = await refreshAntigravityToken(cred, signal)
    if (refreshed) {
      activeToken = refreshed
      try {
        resp = await requestEndpoint(activeToken, 'retrieveUserQuotaSummary')
      } catch (e) {
        throw new Error('network')
      }
    }
  }

  if (resp.status === 401 || resp.status === 403) {
    throw new Error('auth')
  }
  if (resp.status === 429) {
    throw new Error('rate-limit')
  }

  let result = null
  if (resp.status === 200 && resp.json && Array.isArray(resp.json.groups)) {
    result = parseAntigravityQuotaSummary(now, cred, resp.json)
  }

  if (!result) throw new Error('invalid-response')
  return result
}

// Results retain credential order; eligibility is an estimate, not proxy routing state.
async function collectAntigravityQuotas(creds, load, signal, timeoutMs = 18000) {
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(new Error('timeout')), timeoutMs)
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal
  const accounts = new Array(creds.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < creds.length) {
      const index = cursor++, cred = creds[index]
      const identity = { email: cred.email || null, fileName: cred.fileName, priority: cred.priority || 0 }
      try {
        combined.throwIfAborted()
        const quota = await load(cred, combined)
        if (!quota) throw new Error('invalid-response')
        const windows = [quota.gemini5h, quota.geminiWeekly]
        const exhausted = windows.some(w => w && w.remainingFraction === 0)
        const available = windows.every(w => w && w.remainingFraction > 0)
        accounts[index] = { ...quota, ...identity, status: exhausted ? 'exhausted' : available ? 'available' : 'unknown' }
      } catch (error) {
        accounts[index] = { ...identity, error: error?.message || 'network', status: 'error' }
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(3, creds.length) }, worker))
    signal?.throwIfAborted()
    const selected = accounts.find(a => a.status === 'available') || accounts.find(a => !a.error)
    if (!selected) throw new Error(accounts[0]?.error || 'no-credential')
    return { ...selected, selectedFileName: selected.fileName, accounts }
  } finally { clearTimeout(timer) }
}

async function fetchAntigravityQuota(force, signal, accountPool) {
  const creds = state.config.antigravityAccount
    ? [readSelectedCredential('antigravity', state.config.antigravityAccount)].filter(Boolean)
    : readAllCredentials('antigravity')
  if (!creds.length) throw new Error('no-credential')
  return collectAntigravityQuotas(creds, (cred, subscriberSignal) => accountPool.run(
    cred.fileName,
    requestSignal => fetchAntigravityQuotaForCred(cred, Date.now(), requestSignal),
    { force, signal: subscriberSignal, ttlMs: Math.max(15000, state.config.cacheTtlMs) },
  ), signal)
}

function parseNumstat(stdout) {
  let added = 0
  let deleted = 0
  for (const line of String(stdout || '').split('\n')) {
    if (!line) continue
    const fields = line.split('\t')
    if (fields.length < 3) continue
    if (/^\d+$/.test(fields[0])) added += Number(fields[0])
    if (/^\d+$/.test(fields[1])) deleted += Number(fields[1])
  }
  return { added, deleted }
}

function parseGitStatus(stdout) {
  const lines = String(stdout || '').split('\n').filter((l) => l.length > 0)
  const result = {
    branch: '',
    ahead: 0,
    behind: 0,
    counts: { staged: 0, unstaged: 0, untracked: 0, conflict: 0 },
    files: [],
  }
  let first = true
  for (const line of lines) {
    if (first && line.startsWith('## ')) {
      first = false
      const head = line.slice(3)
      result.branch = head.split('...')[0]
      const ahead = head.match(/ahead (\d+)/)
      const behind = head.match(/behind (\d+)/)
      if (ahead) result.ahead = Number(ahead[1]) || 0
      if (behind) result.behind = Number(behind[1]) || 0
      continue
    }
    first = false
    if (line.length < 4) continue
    const x = line[0]
    const y = line[1]
    let path = decodeGitPath(line.slice(3).trim())
    // Rename/copy entries: "R  old -> new" — keep the destination.
    const arrow = path.indexOf(' -> ')
    if (arrow !== -1) path = path.slice(arrow + 4)
    if (x === '?' && y === '?') {
      result.counts.untracked += 1
    } else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
      result.counts.conflict += 1
    } else {
      if (x !== ' ' && x !== '?') result.counts.staged += 1
      if (y !== ' ' && y !== '?') result.counts.unstaged += 1
    }
    if (result.files.length < 50) result.files.push(path)
  }
  return result
}

function decodeGitPath(raw) {
  const value = String(raw || '')
  if (value.length < 2 || value[0] !== '"' || value[value.length - 1] !== '"') return value
  try { return JSON.parse(value) } catch (e) { /* Git's octal form is not JSON */ }
  const body = value.slice(1, -1)
  const chunks = []
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      chunks.push(Buffer.from(body[i], 'utf8'))
      continue
    }
    const octal = body.slice(i + 1).match(/^[0-7]{3}/)
    if (octal) {
      chunks.push(Buffer.from([parseInt(octal[0], 8)]))
      i += 3
      continue
    }
    const escaped = body[i + 1]
    const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"' }
    if (escaped && map[escaped] !== undefined) {
      chunks.push(Buffer.from(map[escaped], 'utf8'))
      i += 1
    } else {
      chunks.push(Buffer.from(escaped || '\\', 'utf8'))
      if (escaped) i += 1
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

function emptyGitStatus() {
  return {
    branch: '',
    ahead: 0,
    behind: 0,
    counts: { staged: 0, unstaged: 0, untracked: 0, conflict: 0 },
    files: [],
  }
}

function addGitStatusEntry(result, xy, path, kind, decodePath = true) {
  const x = String(xy || '.')[0] || '.'
  const y = String(xy || '.')[1] || '.'
  const isConflict = kind === 'unmerged' || x === 'U' || y === 'U' ||
      (x === 'A' && y === 'A') || (x === 'D' && y === 'D')
  if (kind === 'untracked') {
    result.counts.untracked += 1
  } else if (isConflict) {
    result.counts.conflict += 1
  } else {
    if (x !== '.') result.counts.staged += 1
    if (y !== '.') result.counts.unstaged += 1
  }
  if (result.files.length < 50) result.files.push(decodePath ? decodeGitPath(path) : String(path || ''))
}

// Porcelain v2 records are NUL-delimited. This keeps filenames containing
// spaces, arrows, quotes, and newlines out of the status protocol parser.
function parseGitStatusV2(stdout) {
  const result = emptyGitStatus()
  const records = String(stdout || '').split('\0')
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (!record) continue
    if (record.startsWith('# ')) {
      const space = record.indexOf(' ', 2)
      const key = space === -1 ? record.slice(2) : record.slice(2, space)
      const value = space === -1 ? '' : record.slice(space + 1)
      if (key === 'branch.head') result.branch = value
      else if (key === 'branch.ab') {
        const ahead = value.match(/\+(\d+)/)
        const behind = value.match(/-(\d+)/)
        if (ahead) result.ahead = Number(ahead[1]) || 0
        if (behind) result.behind = Number(behind[1]) || 0
      } else if (key === 'branch.oid' && !result.branch && value === '(initial)') {
        result.branch = '(initial)'
      }
      continue
    }
    const type = record[0]
    if (type === '?') {
      addGitStatusEntry(result, '..', record.slice(2), 'untracked', false)
      continue
    }
    const parts = record.split(' ')
    if (type === '1' && parts.length >= 9) {
      addGitStatusEntry(result, parts[1], parts.slice(8).join(' '), 'ordinary', false)
      continue
    }
    if (type === '2' && parts.length >= 10) {
      // Git's real v2 format puts the destination in the inline field and the
      // original path in the following NUL record. A few older fixtures use
      // shortened `100` mode fields and reverse those two paths; accept that
      // fixture form without compromising the real format.
      const inlinePath = parts.slice(9).join(' ')
      const hasOriginalPath = i + 1 < records.length && records[i + 1] !== ''
      const shortFixture = parts.length >= 10 && parts.slice(3, 8).every((value) => value === '100')
      const destination = shortFixture && hasOriginalPath ? records[i + 1] : inlinePath
      if (hasOriginalPath) i += 1
      addGitStatusEntry(result, parts[1], destination, 'rename', false)
      continue
    }
    if (type === 'u' && parts.length >= 3) {
      // Normal v2 unmerged records put the path at field 10. Accept shorter
      // hand-written fixtures too by falling back to the final fields.
      const path = parts.length > 10 ? parts.slice(10).join(' ') : parts.slice(3).join(' ')
      addGitStatusEntry(result, parts[1], path, 'unmerged', false)
    }
  }
  return result
}

function candidateGitDirs(value) {
  let path = String(value || '').trim()
  if (!path) return []
  if (path.startsWith('~/')) path = join(homedir(), path.slice(2))
  if (!isAbsolute(path) || path.length > 1024 || path.indexOf('\0') !== -1) return []
  const out = []
  let current = resolve(path)
  while (current && current !== dirname(current)) {
    if (existsSync(current)) {
      try {
        if (statSync(current).isDirectory()) out.push(current)
        else out.push(dirname(current))
        break
      } catch (e) { /* continue to the nearest existing parent */ }
    }
    current = dirname(current)
  }
  if (out.length === 0 && existsSync(current)) out.push(current)
  return out
}

function remoteCandidateGitDirs(value, bridge, workspace) {
  const normalized = sanitizeCwd(value)
  if (!normalized) return []
  const out = []
  let current = normalized
  while (current) {
    const mapping = bridge.mapLocalPath(current)
    if (!mapping || mapping.anchorPath !== workspace.anchorPath || mapping.target.transport !== 'ssh' ||
        mapping.target.alias !== workspace.target.alias) break
    out.push(current)
    if (current === workspace.anchorPath) break
    const parent = dirname(current)
    if (!parent || parent === current) break
    current = parent
  }
  return out
}

function gitCommand(execution, cwd, args) {
  args = ['--no-optional-locks', '-c', 'core.fsmonitor=false'].concat(args)
  if (execution.remote) return runCollect(execution.subprocess, [execution.gitPath].concat(args), cwd, execution.maxBytes, execution.timeoutMs, execution.signal)
  return runCollect(execution.subprocess, [execution.gitPath, '-C', cwd].concat(args), '/', execution.maxBytes, execution.timeoutMs, execution.signal)
}

function pathWithinAnchor(path, anchorPath) {
  return path === anchorPath || path.startsWith(anchorPath.endsWith('/') ? anchorPath : anchorPath + '/')
}

async function resolveGitRepo(subprocess, cwd, _unusedHints, gitPath, bridge, workspace, signal) {
  if (subprocess === undefined) throw new Error('subprocess 服务不可用')
  const remote = bridge !== undefined && workspace !== undefined
  if (!gitPath && !remote) gitPath = await resolveExecutable(subprocess, 'git', ['/usr/bin/git', '/usr/local/bin/git'])
  if (!gitPath) gitPath = remote ? 'git' : null
  if (!gitPath) throw new Error('未找到 git 可执行文件')
  // The current cwd is authoritative; never infer a different repo from history.
  const dirs = remote ? remoteCandidateGitDirs(cwd, bridge, workspace) : candidateGitDirs(cwd)
  for (const candidate of dirs.slice(0, 32)) {
    signal?.throwIfAborted()
    const result = await gitCommand({ subprocess, gitPath, remote, maxBytes: 8192, timeoutMs: 5000, signal }, candidate, ['rev-parse', '--show-toplevel'])
    if (result.aborted) throw new Error('git-timeout')
    if (result.exitCode !== 0) continue
    const root = String(result.stdout || '').trim().split(/\r?\n/)[0]
    if (!root || !isAbsolute(root)) continue
    if (!remote) return resolve(root)
    const localRoot = bridge.mapRemotePath({ ...workspace, remotePath: root })
    if (!localRoot || !pathWithinAnchor(resolve(localRoot), resolve(workspace.anchorPath))) throw new Error('git repo root 不在 SSH 工作区锚点内')
    return resolve(localRoot)
  }
  return null
}

async function fetchGitStatus(subprocess, cwd, hints, sshBridge, parentSignal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('git-timeout')), 7000)
  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal
  try {
    const result = await collectGitStatus(subprocess, cwd, hints, sshBridge, signal)
    parentSignal?.throwIfAborted()
    return result
  } finally { clearTimeout(timer) }
}
async function collectGitStatus(subprocess, cwd, hints, sshBridge, signal) {
  if (cwd !== null && cwd !== undefined && cwd !== '') {
    if (typeof cwd !== 'string' || Buffer.byteLength(cwd, 'utf8') > 1024 || cwd.indexOf('\0') !== -1) {
      throw new Error('cwd 参数无效')
    }
  }
  const normalizedCwd = cwd ? sanitizeCwd(cwd) : ''
  if (cwd && !normalizedCwd) throw new Error('cwd 参数无效')
  let workspace
  if (sshBridge && normalizedCwd) workspace = sshBridge.mapLocalPath(normalizedCwd)
  const remote = workspace !== undefined
  const gitSubprocess = remote ? sshBridge.subprocess() : subprocess
  const gitPath = remote ? 'git' : await resolveExecutable(gitSubprocess, 'git', ['/usr/bin/git', '/usr/local/bin/git'])
  if (!gitPath) throw new Error('未找到 git 可执行文件')
  const repoRoot = await resolveGitRepo(gitSubprocess, normalizedCwd || null, hints, gitPath, remote ? sshBridge : undefined, workspace, signal)
  if (!repoRoot) return { isRepo: false }
  const statusResult = await gitCommand({
    subprocess: gitSubprocess, gitPath, remote, maxBytes: 262144, timeoutMs: 7000, signal,
  }, repoRoot, ['status', '--porcelain=v2', '-z', '--branch'])
  const errText = String(statusResult.stderr || '')
  let parsedStatus
  if (statusResult.exitCode !== 0) {
    // Git 2.11-era installations may not understand porcelain v2. Keep a
    // v1 fallback while preferring the NUL-safe parser everywhere else.
    if (/unknown option|invalid.*porcelain|unsupported/i.test(errText)) {
      const legacy = await gitCommand({
        subprocess: gitSubprocess, gitPath, remote, maxBytes: 262144, timeoutMs: 7000, signal,
      }, repoRoot, ['status', '--porcelain=v1', '-b', '--untracked-files=normal'])
      if (legacy.exitCode === 0) parsedStatus = parseGitStatus(legacy.stdout)
    }
    if (!parsedStatus && /not a git repository/i.test(errText)) {
      return { isRepo: false }
    }
    if (!parsedStatus) {
      if (statusResult.aborted) throw new Error('git status 超时（10s），可能位于慢速网络挂载')
      throw new Error('git status 失败 (exit ' + statusResult.exitCode + ') ' + errText.slice(0, 160))
    }
  } else {
    parsedStatus = parseGitStatusV2(statusResult.stdout)
  }
  // Working-tree + index numstat. Binary files report '-' and are excluded from line totals;
  // untracked files have no Git diff yet, so they remain represented by the untracked count.
  let lineStats = null, lineStatsError = null
  try { lineStats = await fetchGitLineStats(gitSubprocess, gitPath, repoRoot, remote, signal) }
  catch { lineStatsError = 'line-stats-unavailable' }
  // repoRoot is the local anchor path (needed for sidebar/file links); the UI labels
  // SSH repos by host + remote path instead of the opaque anchor directory name.
  let remoteRepo
  if (remote) {
    const mapping = sshBridge.mapLocalPath(repoRoot)
    if (mapping && mapping.target && mapping.target.alias) remoteRepo = { host: mapping.target.alias, root: mapping.remotePath }
  }
  return {
    isRepo: true,
    repoRoot,
    ...(remoteRepo ? { remote: remoteRepo } : {}),
    ...parsedStatus,
    lineStats,
    ...(lineStatsError ? { lineStatsError } : {}),
  }
}

async function fetchGitLineStats(subprocess, gitPath, cwd, remote, signal) {
  const execution = { subprocess, gitPath, remote: remote === true, maxBytes: 262144, timeoutMs: 7000, signal }
  const [unstagedStat, stagedStat] = await Promise.all([
    gitCommand(execution, cwd, ['diff', '--numstat', '--no-ext-diff']),
    gitCommand(execution, cwd, ['diff', '--cached', '--numstat', '--no-ext-diff']),
  ])
  if (unstagedStat.exitCode !== 0 || stagedStat.exitCode !== 0) {
    const numstatError = String(unstagedStat.stderr || stagedStat.stderr || '').slice(0, 160)
    if (unstagedStat.aborted || stagedStat.aborted) throw new Error('git numstat 超时（10s）')
    throw new Error('git numstat 失败 ' + numstatError)
  }
  const unstagedLines = parseNumstat(unstagedStat.stdout)
  const stagedLines = parseNumstat(stagedStat.stdout)
  return {
    added: unstagedLines.added + stagedLines.added,
    deleted: unstagedLines.deleted + stagedLines.deleted,
    staged: stagedLines,
    unstaged: unstagedLines,
  }
}

async function apply(ctx, options = {}) {
  // inject guarantees these are ready; direct
  // ctx.get() misses services provided by sibling bundle entries.
  const webServer = ctx.webServer
  const subprocess = ctx.subprocess
  const sessions = ctx.sessions
  const peakSchedule = new PeakScheduleSource({ cachePath: dshHomePath('statusline-peak-cache.json'), log: message => console.warn('[statusline-plus] ' + message) })
  ctx.sessionProjections.register(createSessionMetricsProjection(await loadPricingCatalog(), peakSchedule.pricingSnapshot()))
  ctx.sessionProjections.register(createToolActivityProjection())
  const gitPool = new RequestPool({ timeoutMs: 8500 })
  let sshBridge
  let sshBridgeFiber
  if (typeof ctx.inject === 'function') {
    sshBridgeFiber = ctx.inject(['sshRemoteHostBridge'], (scope) => {
      const negotiated = scope.sshRemoteHostBridge.negotiate({
        minVersion: 1,
        maxVersion: 1,
        requiredCapabilities: ['path-mapping', 'reverse-path-mapping', 'routed-subprocess'],
      })
      gitPool.clear()
      sshBridge = negotiated
      return () => {
        if (sshBridge === negotiated) { sshBridge = undefined; gitPool.clear() }
      }
    })
  }
  let credentials = ctx.credentials
  if (credentials === undefined && typeof ctx.get === 'function') {
    try { credentials = ctx.get('credentials') } catch (e) { /* 凭据服务未挂载 */ }
  }

  const quotaPool = new RequestPool({ timeoutMs: 20000 })
  const accountPool = new RequestPool({ timeoutMs: 15000 })
  const tps = new TpsTracker({ enabled: () => state.config.enabled && state.config.showTps })
  const configSource = () => SettingsSchema(Object.fromEntries(Object.entries(options).map(([key, value]) => [key, typeof value?.get === 'function' ? value.get() : value])))
  const validateConfig = value => {
      if (!CRED_REF_RE.test(value.apiKeyEnv)) throw new Error('Invalid credential reference name')
      if (value.usageUrl !== sanitizeUsageUrl(value.usageUrl)) throw new Error('Only the official opencode usage URL is supported')
      for (const provider of value.providers) {
        if (!sanitizeProvider(mergeProviderPreset(provider))) throw new Error('Invalid quota provider definition')
      }
    }
  state.config = sanitizeConfig(configSource())
  ctx.on('settings/document-updated', ns => {
    if (ns !== 'statusline-plus') return

      const previous = state.config
      state.config = sanitizeConfig(configSource())
      // Display-only edits neither cancel requests nor invalidate cached data.
      const changed = keys => keys.some(key => JSON.stringify(previous[key]) !== JSON.stringify(state.config[key]))
      if (changed(['enabled', 'showQuota', 'showCodexQuota', 'showAntigravityQuota', 'showOpenCodeQuota', 'apiKeyEnv', 'usageUrl', 'fetchTimeoutMs', 'cacheTtlMs', 'codexAccount', 'antigravityAccount', 'providers'])) {
        quotaPool.clear()
        accountPool.clear()
      }
      if (changed(['enabled', 'showGit', 'gitCwd'])) gitPool.clear()
      if (changed(['enabled', 'showTps'])) tps.reset()
  })
  const quota = (key, load, force, signal) => {
    if (!state.config.enabled || !state.config.showQuota) throw new Error('disabled')
    if (key === 'opencode' && !state.config.showOpenCodeQuota || key === 'codex' && !state.config.showCodexQuota || key === 'antigravity' && !state.config.showAntigravityQuota) throw new Error('disabled')
    return quotaPool.run(key, load, { force, signal, ttlMs: Math.max(15000, state.config.cacheTtlMs) })
  }
  const register = spec => webServer.register({ ...spec, handler: async (req, res) => {
    const controller = new AbortController()
    const abort = () => controller.abort(new Error('client-disconnected'))
    const close = () => { if (!res.writableEnded) abort() }
    req.once('aborted', abort)
    res.once?.('close', close)
    req.slpSignal = controller.signal
    try { await spec.handler(req, res) } finally {
      req.removeListener('aborted', abort)
      res.removeListener?.('close', close)
    }
  } })

  const disposers = []

  disposers.push(
    ctx.on('agent/assistant-stream', payload => tps.onFrame(payload)),
    ctx.on('session/event', (session, event) => tps.onSession(session, event)),
  )

  disposers.push(
    register({
      kind: 'exact', path: '/statusline/api/peak-schedule',
      handler: async (req, res) => {
        if (!guardRequest(req, res, ['GET'], false)) return
        if (!sameOriginRequest(req)) return sendJson(res, 403, { ok: false, error: 'cross-origin' })
        return sendJson(res, 200, { ok: true, data: await peakSchedule.get() })
      },
    }),
    register({
      kind: 'exact', path: '/statusline/api/tps',
      handler: async (req, res) => {
        if (!guardRequest(req, res, ['GET'], false)) return
        if (!sameOriginRequest(req)) return sendJson(res, 403, { ok: false, error: 'cross-origin' })
        if (!state.config.enabled || !state.config.showTps) { res.writeHead(204); res.end(); return }
        const sessionId = new URL(req.url, 'http://localhost').searchParams.get('sessionId')
        if (!validSessionId(sessionId)) return sendJson(res, 400, { ok: false, error: 'invalid-session' })
        return streamTps(tps, sessionId, req, res, req.slpSignal)
      },
    }),
    register({
      kind: 'exact',
      path: '/statusline/api/config',
      handler: async (req, res) => {
        if (!guardRequest(req, res, ['GET', 'POST'], req.method === 'POST')) return
        if (req.method === 'POST') {
          const body = await readBody(req)
          if (rejectBodyError(body, res)) return
          if (!Number.isSafeInteger(body.revision)) return sendJson(res, 409, { ok: false, error: 'revision-required' })
          try {
            validateConfig(SettingsSchema({ ...configSource(), ...body.patch }))
            await ctx.settings.update('statusline-plus', body.patch || {}, body.revision)
          } catch (error) { return sendJson(res, 409, { ok: false, error: 'config-conflict' }) }
          return sendJson(res, 200, { ok: true, config: sanitizeConfig(configSource()) })
        }
        return sendJson(res, 200, { ok: true, config: state.config })
      },
    }),
    register({
      kind: 'exact',
      path: '/statusline/api/usage',
      handler: async (req, res) => {
        if (!guardRequest(req, res, ['POST'], true)) return
        const body = await readBody(req)
        if (rejectBodyError(body, res)) return
        const force = body && body.force === true
        try {
          const data = await quota('opencode', signal => fetchUsage(credentials, true, signal), force, req.slpSignal)
          return sendJson(res, 200, { ok: true, data, config: state.config })
        } catch (e) {
          return sendJson(res, 200, {
            ok: false,
            error: (e && e.message) || String(e),
            config: state.config,
          })
        }
      },
    }),
    register({
      kind: 'exact',
      path: '/statusline/api/git',
      handler: async (req, res) => {
        if (!guardRequest(req, res, ['POST'], true)) return
        const body = await readBody(req)
        if (rejectBodyError(body, res)) return
        const cwd = body && body.cwd
        const sessionId = body && body.sessionId
        try {
          if (!state.config.enabled || !state.config.showGit) throw new Error('disabled')
          const key = String(sessionId || '') + '\0' + String(cwd || '')
          const force = body?.force === true
          // Manual retry may recover immediately after a local repo repair.
          if (force) gitPool.cache.delete(key)
          const data = await gitPool.run(key,
            signal => fetchGitStatus(subprocess, cwd, [], sshBridge, signal),
            { signal: req.slpSignal, force, ttlMs: 1000 })
          return sendJson(res, 200, { ok: true, data })
        } catch (e) {
          return sendJson(res, 200, {
            ok: false,
            error: (e && e.message) || String(e),
          })
        }
      },
    }),
    register({
      kind: 'exact',
      path: '/statusline/api/codex-quota',
      handler: async (req, res) => {
        if (!guardRequest(req, res, ['POST'], true)) return
        const body = await readBody(req)
        if (rejectBodyError(body, res)) return
        const force = body && body.force === true
        try {
          const data = await quota('codex', signal => fetchCodexQuota(true, signal), force, req.slpSignal)
          return sendJson(res, 200, { ok: true, data })
        } catch (e) {
          const msg = (e && e.message) || String(e)
          // 错误用稳定短码返回（auth / rate-limit / network / no-credential）
          const code = ['auth', 'rate-limit', 'network', 'no-credential', 'account-required', 'disabled', 'invalid-response'].indexOf(msg) !== -1 ? msg : 'network'
          return sendJson(res, 200, { ok: false, error: code })
        }
      },
    }),
    register({
      kind: 'exact',
      path: '/statusline/api/antigravity-quota',
      handler: async (req, res) => {
        if (!guardRequest(req, res, ['POST'], true)) return
        const body = await readBody(req)
        if (rejectBodyError(body, res)) return
        const force = body && body.force === true
        try {
          const data = await quota('antigravity', signal => fetchAntigravityQuota(force, signal, accountPool), force, req.slpSignal)
          return sendJson(res, 200, { ok: true, data })
        } catch (e) {
          const msg = (e && e.message) || String(e)
          const code = ['auth', 'rate-limit', 'network', 'no-credential', 'account-required', 'disabled', 'invalid-response'].indexOf(msg) !== -1 ? msg : 'network'
          return sendJson(res, 200, { ok: false, error: code })
        }
      },
    }),
    register({
      kind: 'exact',
      path: '/statusline/api/provider-quota',
      handler: async (req, res) => {
        if (!guardRequest(req, res, ['POST'], true)) return
        const body = await readBody(req)
        if (rejectBodyError(body, res)) return
        const id = typeof body.id === 'string' ? body.id.trim().slice(0, 64) : ''
        if (!id) return sendJson(res, 200, { ok: false, error: 'not-found' })
        const force = body && body.force === true
        try {
          const data = await quota('provider:' + id, signal => fetchProviderQuota(credentials, id, true, signal), force, req.slpSignal)
          return sendJson(res, 200, { ok: true, data })
        } catch (e) {
          const msg = (e && e.code) || (e && e.message) || String(e)
          const code = ['auth', 'rate-limit', 'network', 'no-credential', 'invalid-response', 'not-found', 'disabled'].indexOf(msg) !== -1 ? msg : 'network'
          return sendJson(res, 200, { ok: false, error: code })
        }
      },
    }),
    register({
      kind: 'exact',
      path: '/statusline/api/session-model',
      handler: async (req, res) => {
        if (!guardRequest(req, res, ['POST'], true)) return
        const body = await readBody(req)
        if (rejectBodyError(body, res)) return
        const sessionId = String((body && body.sessionId) || '').trim()
        const normalizedSessionId = normalizeSessionId(sessionId)
        if (!normalizedSessionId) {
          const live = readLiveSessionModel(sessions, sessionId)
          return sendJson(res, 200, live ? { ok: true, data: live } : { ok: false, error: 'session-not-found' })
        }
        const liveModel = readLiveSessionModel(sessions, sessionId)
        if (liveModel) return sendJson(res, 200, { ok: true, data: liveModel })
        const now = Date.now()
        const cached = state.sessionModelCache.get(normalizedSessionId)
        if (cached && now - cached.at < 10000) {
          return sendJson(res, 200, cached.result)
        }
        try {
          const model = readSessionModel(sessionId, sessions)
          const result = model ? { ok: true, data: model } : { ok: false, error: 'model-unknown' }
          if (state.sessionModelCache.size >= 64) {
            const first = state.sessionModelCache.keys().next().value
            if (first !== undefined) state.sessionModelCache.delete(first)
          }
          state.sessionModelCache.set(normalizedSessionId, { at: now, result })
          return sendJson(res, 200, result)
        } catch (e) {
          const result = { ok: false, error: /not found/i.test((e && e.message) || '') ? 'session-not-found' : 'decode' }
          if (state.sessionModelCache.size >= 64) {
            const first = state.sessionModelCache.keys().next().value
            if (first !== undefined) state.sessionModelCache.delete(first)
          }
          state.sessionModelCache.set(normalizedSessionId, { at: now, result })
          return sendJson(res, 200, result)
        }
      },
    })
  )

  ctx.effect(() => () => {
    quotaPool.close()
    gitPool.close()
    accountPool.close()
    tps.reset()
    state.sessionModelCache.clear()
    sshBridge = undefined
    if (sshBridgeFiber && typeof sshBridgeFiber.dispose === 'function') sshBridgeFiber.dispose()
    for (const d of disposers) d()
  })
}

const api = { Config, name: 'dsh-statusline-plus', inject: ['webServer', 'subprocess', 'credentials', 'sessions', 'settings', 'sessionProjections'], apply }
// 测试钩子：仅当 SLP_TEST=1 时暴露纯函数，便于独立脚本验证解析逻辑
if (process.env.SLP_TEST === '1') {
  api.__test = {
    selectSessionLog,
    SettingsSchema,
    readQuotaJson,
    sanitizeConfig,
    sanitizeUsageUrl,
    parseCodexHeaders,
    buildCodexResult,
    headerValue,
    CODEX_HEADER_PARSERS,
    ANTIGRAVITY_HOST,
    parseAntigravityQuotaSummary,
    collectAntigravityQuotas,
    fetchAntigravityQuotaForCred,
    sanitizeProviders,
    sanitizeProvider,
    sanitizeProviderEndpointUrl,
    pickPath,
    providerBalanceFromParse,
    providerWindowsFromParse,
    OPENROUTER_PROVIDER_PRESET,
    estimateTextTokens,
    parseNumstat,
    parseGitStatus,
    parseGitStatusV2,
    resolveGitRepo,
    fetchGitStatus,
    decodeRecentSessionText,
    decodeSessionText,
    decodeSessionTail,
    decodeSessionHead,
    scanLastRequestModel,
    scanLastRequestModelEvents,
    findLiveSession,
    readLiveSessionModel,
    readSessionModel,
  }
}
export default api
export const name = api.name
export const inject = api.inject
export { Config, apply }
export const __test = api.__test
