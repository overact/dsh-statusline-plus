'use strict'
/** Codex subscription quota from the ChatGPT Wham usage endpoint. */
import { readSelectedCredential } from './cpa-credentials.js'
import { deadlineSignal, providerErrorCode, quotaFetch, readQuotaJson } from './quota-http.js'

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

// 非 200 状态由调用方映射为稳定错误码；非 JSON 响应按 invalid-response 处理。
async function fetchCodexWham(accessToken, signal, dispatcher) {
  // Leave room for TLS and the response after the 5s address-attempt window.
  const deadline = deadlineSignal(signal, 15000)
  try {
    const headers = {
      Authorization: 'Bearer ' + accessToken,
      Accept: 'application/json',
    }
    const accountId = readCodexAccountId(accessToken)
    if (accountId) headers['chatgpt-account-id'] = accountId
    const response = await quotaFetch('https://chatgpt.com/backend-api/wham/usage', {
      method: 'GET',
      headers,
      signal: deadline.signal,
    }, 'codex', dispatcher)
    let json = null
    try { json = await readQuotaJson(response) } catch (e) { /* 非 JSON 响应交给回退逻辑 */ }
    return { status: response.status, json }
  } finally {
    deadline.clear()
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

// Wham window field -> normalized suffix and divisor (seconds become minutes).
// Wham 的 reset_at 是秒级 Unix epoch，直接映射。
const WHAM_WINDOW_FIELDS = [
  ['used_percent', 'UsedPercent', 1],
  ['limit_window_seconds', 'WindowMinutes', 60],
  ['reset_after_seconds', 'ResetAfterSeconds', 1],
  ['reset_at', 'ResetAt', 1],
]

// 纯函数：把 Wham usage 归一化为扁平字段（primaryUsedPercent、creditsBalance 等）。
function parseWhamUsage(json) {
  const out = {}
  if (!json || typeof json !== 'object') return out
  if (json.plan_type !== undefined && json.plan_type !== null) out.planType = String(json.plan_type)
  if (json.email !== undefined && json.email !== null) out.email = String(json.email)
  if (json.active_limit !== undefined && json.active_limit !== null) out.activeLimit = String(json.active_limit)

  const rateLimit = json.rate_limit
  if (!rateLimit || typeof rateLimit !== 'object') return out
  for (const name of ['primary', 'secondary']) {
    const win = rateLimit[name + '_window']
    if (!win || typeof win !== 'object') continue
    for (const [field, suffix, divisor] of WHAM_WINDOW_FIELDS) {
      const value = whamNumber(win[field])
      if (value !== undefined) out[name + suffix] = value / divisor
    }
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

function codexWindow(parsed, name) {
  const win = { usedPercent: parsed[name + 'UsedPercent'] }
  for (const [key, suffix] of [['windowMinutes', 'WindowMinutes'], ['resetAt', 'ResetAt'], ['resetAfterSeconds', 'ResetAfterSeconds']]) {
    if (parsed[name + suffix] !== undefined) win[key] = parsed[name + suffix]
  }
  return win
}

function buildCodexResult(now, parsed) {
  const credits = {}
  if (parsed.creditsHasCredits !== undefined) credits.hasCredits = parsed.creditsHasCredits
  if (parsed.creditsBalance !== undefined) credits.balance = parsed.creditsBalance
  if (parsed.creditsUnlimited !== undefined) credits.unlimited = parsed.creditsUnlimited
  const result = {
    fetchedAt: now,
    planType: parsed.planType,
    activeLimit: parsed.activeLimit,
    primary: codexWindow(parsed, 'primary'),
    secondary: codexWindow(parsed, 'secondary'),
    credits,
  }
  if (parsed.email !== undefined) result.email = parsed.email
  return result
}

async function fetchCodexQuota(account, signal, dispatcher) {
  const token = readSelectedCredential('codex', account)?.access_token || null
  if (!token) throw new Error('no-credential')
  const wham = await fetchCodexWham(token, signal, dispatcher)
  if (wham.status !== 200) throw new Error(providerErrorCode(wham.status))
  const parsed = parseWhamUsage(wham.json)
  if (parsed.primaryUsedPercent === undefined) throw new Error('invalid-response')
  return buildCodexResult(Date.now(), parsed)
}

export { readCodexAccountId, parseWhamUsage, buildCodexResult, fetchCodexQuota }
