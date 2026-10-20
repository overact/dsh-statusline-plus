'use strict'
/** Declarative quota sources (providers[]) and the OpenCode Go usage endpoint. */
import { parseDeepSeekBalance, parseKimiWindows, parseZaiWindows } from './provider-presets.js'
import { toFiniteNumber } from './config.js'
import { deadlineSignal, providerError, providerErrorCode, quotaFetch, readQuotaJson, readUsageKey } from './quota-http.js'
import { fetchDeepseekAccountBalance } from './quota-deepseek-account.js'

function pickPath(value, dottedPath) {
  if (typeof dottedPath !== 'string' || dottedPath.length === 0) return undefined
  let cursor = value
  for (const segment of dottedPath.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = cursor[segment]
  }
  return cursor
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

// `options.modelProvider` is the live session's billing provider. DeepSeek models
// served by the signed-in Platform account (`deepseek-account`) have no API key;
// they read the Host account service instead of `/user/balance`, so the two
// billing route types never borrow each other's credential or balance.
async function fetchProviderQuota(credentials, config, id, signal, dispatcher, options = {}) {
  const def = (config.providers || []).find(p => p.id === id && p.enabled !== false)
  if (!def) throw providerError('not-found')
  if (def.id === 'deepseek' && options.modelProvider === 'deepseek-account') {
    const balance = await fetchDeepseekAccountBalance(options.account, options.client)
    return {
      ...balance,
      label: def.label,
      ...(def.redBelow !== undefined ? { redBelow: def.redBelow } : {}),
    }
  }
  const key = await readUsageKey(credentials, def.apiKeyEnv)
  if (!key) throw providerError('no-credential')
  // 逐端点回退：2xx 即解析返回；401/403/429/5xx 或解析失败都换下一个端点。
  // 最终返回最相关的错误码（rate-limit > auth > invalid-response > network），
  // 与 codex/antigravity 路由相同的稳定短码约定。
  let lastError = 'network'
  let sawAuth = false
  for (const endpoint of def.endpoints) {
    const deadline = deadlineSignal(signal, config.fetchTimeoutMs)
    try {
      const response = await quotaFetch(endpoint.url, {
        headers: { authorization: endpoint.auth === 'raw' ? key : 'Bearer ' + key, accept: 'application/json' },
        signal: deadline.signal,
        // 禁止跟随重定向：带 Bearer key 的请求不允许被 302 转送到其他主机
        redirect: 'manual',
      }, 'provider', dispatcher)
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
        return { style: 'windows', label: def.label, windows, fetchedAt: Date.now() }
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
      deadline.clear()
    }
  }
  if (sawAuth) throw providerError('auth')
  throw providerError(lastError)
}

async function fetchUsage(credentials, config, signal, dispatcher) {
  const key = await readUsageKey(credentials, config.apiKeyEnv)
  if (!key) throw new Error('no-credential')
  const deadline = deadlineSignal(signal, config.fetchTimeoutMs)
  try {
    const response = await quotaFetch(config.usageUrl, {
      headers: { authorization: 'Bearer ' + key },
      signal: deadline.signal,
    }, 'opencode', dispatcher)
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(providerErrorCode(response.status)) }
    const payload = await readQuotaJson(response)
    const usage = payload && payload.usage
    if (!usage || typeof usage !== 'object') throw new Error('network')
    return {
      fetchedAt: Date.now(),
      windows: {
        rolling: usage.rolling || {},
        weekly: usage.weekly || {},
        monthly: usage.monthly || {},
      },
    }
  } catch (e) {
    if (e && ['no-credential', 'auth', 'rate-limit', 'invalid-response'].includes(e.message)) throw e
    throw new Error('network')
  } finally {
    deadline.clear()
  }
}

export { pickPath, providerBalanceFromParse, providerWindowsFromParse, fetchProviderQuota, fetchUsage }
