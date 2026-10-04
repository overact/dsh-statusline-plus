'use strict'

// Official account endpoints; credentials stay in the Host. These presets
// match billing routes, never model names offered by a reseller.
const PROVIDER_PRESETS = [
  {
    id: 'deepseek', label: 'DeepSeek', style: 'balance', apiKeyEnv: 'DEEPSEEK_API_KEY',
    enabled: true, onTurn: true,
    match: { providerExact: ['deepseek-official', 'deepseek'] },
    endpoints: [{ url: 'https://api.deepseek.com/user/balance', parse: { mode: 'deepseek-balance' } }],
  },
  {
    id: 'kimi-code', label: 'Kimi Code', style: 'windows', apiKeyEnv: 'KIMI_API_KEY',
    enabled: true, onTurn: true,
    match: { providerExact: ['kimi-coding', 'kimi-code', 'kimi-for-coding'] },
    endpoints: [{ url: 'https://api.kimi.com/coding/v1/usages', parse: { mode: 'kimi-usage' } }],
  },
  {
    id: 'zai', label: 'Z.ai', style: 'windows', apiKeyEnv: 'ZAI_API_KEY',
    enabled: true, onTurn: true,
    match: { providerExact: ['zai', 'z.ai', 'zai-coding-plan'] },
    endpoints: [{ url: 'https://api.z.ai/api/monitor/usage/quota/limit', auth: 'raw', parse: { mode: 'zai-quota' } }],
  },
  {
    id: 'zhipu', label: 'Z.ai CN', style: 'windows', apiKeyEnv: 'ZAI_CODING_CN_API_KEY',
    enabled: true, onTurn: true,
    match: { providerExact: ['zai-coding-cn', 'zhipu', 'zhipu-coding', 'glm-coding', 'bigmodel'] },
    endpoints: [{ url: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit', auth: 'raw', parse: { mode: 'zai-quota' } }],
  },
]

const BUILTIN_PARSE_MODES = ['deepseek-balance', 'kimi-usage', 'zai-quota']

function number(value) {
  if (typeof value !== 'number' && typeof value !== 'string' ||
      typeof value === 'string' && !value.trim()) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function percent(value) {
  const n = number(value)
  return n !== undefined && n >= 0 && n <= 100 ? n : undefined
}

function resetSeconds(value, now) {
  // Also accept older Kimi epoch seconds/milliseconds; zero is no reset.
  const numeric = number(value)
  const at = numeric !== undefined ? (numeric <= 0 ? NaN : numeric < 1e12 ? numeric * 1000 : numeric)
    : typeof value === 'string' && value.trim() ? Date.parse(value) : NaN
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : undefined
}

function parseDeepSeekBalance(json) {
  if (!json || !Array.isArray(json.balance_infos) || typeof json.is_available !== 'boolean') return null
  const balances = []
  for (const info of json.balance_infos.slice(0, 8)) {
    if (!info || typeof info.currency !== 'string' || !/^[A-Z]{3}$/.test(info.currency)) continue
    const remaining = number(info.total_balance)
    if (remaining === undefined) continue
    const entry = { currency: info.currency, remaining }
    const granted = number(info.granted_balance), toppedUp = number(info.topped_up_balance)
    if (granted !== undefined) entry.granted = granted
    if (toppedUp !== undefined) entry.toppedUp = toppedUp
    balances.push(entry)
  }
  if (!balances.length) return null
  // A wallet has no spending cap. Never derive "spent" from granted credit.
  return { currency: balances[0].currency, remaining: balances[0].remaining, isAvailable: json.is_available, balances }
}

function windowEntry(label, usedPercent, reset, now) {
  if (usedPercent === undefined) return null
  const entry = { label, usedPercent }
  const resetInSec = resetSeconds(reset, now)
  if (resetInSec !== undefined) entry.resetInSec = resetInSec
  return entry
}

function legacyPercent(detail) {
  if (!detail || typeof detail !== 'object') return undefined
  const limit = number(detail.limit)
  if (limit === undefined || limit <= 0) return undefined
  const used = number(detail.used), remaining = number(detail.remaining)
  return percent(used !== undefined ? used / limit * 100 : remaining !== undefined ? (limit - remaining) / limit * 100 : undefined)
}

function kimiWindowLabel(window) {
  if (!window || typeof window !== 'object') return 'window'
  const duration = number(window.duration)
  const unit = String(window.timeUnit || '').replace(/^TIME_UNIT_/, '')
  const factor = { SECOND: 1, MINUTE: 60, HOUR: 3600, DAY: 86400 }[unit]
  if (!duration || !factor) return 'window'
  const seconds = duration * factor
  if (seconds % 86400 === 0) return seconds / 86400 + 'd'
  if (seconds % 3600 === 0) return seconds / 3600 + 'h'
  if (seconds % 60 === 0) return seconds / 60 + 'm'
  return seconds + 's'
}

function parseKimiWindows(json, now = Date.now()) {
  if (!json || typeof json !== 'object') return null
  const windows = []
  // New official kimi-code schema (used_ratio is a fraction, not a percent).
  if (json.usages && typeof json.usages === 'object' && !Array.isArray(json.usages)) {
    for (const [key, label] of [['limit_5h', '5h'], ['limit_7d', '7d'], ['limit_month_total', 'month'], ['limit_month_code', 'code month']]) {
      const detail = json.usages[key]
      const ratio = number(detail?.used_ratio)
      const entry = windowEntry(label, ratio !== undefined ? percent(ratio * 100) : undefined, detail?.reset_time, now)
      if (entry) windows.push(entry)
    }
    return windows.length ? windows : null
  }
  // Older Coding Plan response: subscription usage plus rate-limit windows.
  const usage = windowEntry('plan', legacyPercent(json.usage), json.usage?.resetTime, now)
  if (usage) windows.push(usage)
  for (const limit of (Array.isArray(json.limits) ? json.limits : []).slice(0, 6)) {
    const entry = windowEntry(kimiWindowLabel(limit?.window), legacyPercent(limit?.detail), limit?.detail?.resetTime, now)
    if (entry) windows.push(entry)
  }
  return windows.length ? windows : null
}

function parseZaiWindows(json, now = Date.now()) {
  if (!json || json.success === false || json.code !== undefined && String(json.code) !== '200' || !Array.isArray(json.data?.limits)) return null
  const windows = []
  for (const limit of json.data.limits.slice(0, 12)) {
    if (!limit || !['TOKENS_LIMIT', 'CREDIT_LIMIT'].includes(String(limit.type || '').toUpperCase())) continue
    const unit = number(limit.unit), count = number(limit.number)
    // unit 6 denotes the weekly bucket; older payloads use number=7, newer
    // ones number=1. TIME_LIMIT is monthly MCP calls, not model allowance.
    const label = unit === 6 ? '7d' : unit === 3 && count > 0 ? count + 'h' : null
    if (!label) continue
    const cap = number(limit.usage), used = number(limit.currentValue)
    const usedPercent = limit.percentage === undefined || limit.percentage === null
      ? percent(cap > 0 && used !== undefined ? used / cap * 100 : undefined) : percent(limit.percentage)
    const entry = windowEntry(label, usedPercent, number(limit.nextResetTime), now)
    if (entry) windows.push(entry)
  }
  return windows.length ? windows : null
}

export { PROVIDER_PRESETS, BUILTIN_PARSE_MODES, parseDeepSeekBalance, parseKimiWindows, parseZaiWindows }
