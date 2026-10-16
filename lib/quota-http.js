'use strict'
/** Shared quota transport: deadlines, logged fetch, bounded JSON reads and stable error codes. */

// One request deadline joined with the caller's (route/pool) cancellation.
// `clear()` must run in a finally block; the timer is not left pending.
function deadlineSignal(signal, timeoutMs, reason) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(reason), timeoutMs)
  return {
    signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    clear: () => clearTimeout(timer),
  }
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

const LOGGED_NETWORK_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID'])
// Keep connection diagnostics useful without logging URLs, headers, accounts,
// exception messages or stacks, any of which may carry credentials.
function quotaNetworkDetails(error, signal) {
  const codes = new Set(), seen = new Set(), queue = [error]
  for (let n = 0; queue.length && n < 32; n++) {
    const entry = queue.shift()
    if (!entry || typeof entry !== 'object' || seen.has(entry)) continue
    seen.add(entry)
    if (LOGGED_NETWORK_CODES.has(entry.code)) codes.add(entry.code)
    if (entry.cause) queue.push(entry.cause)
    if (Array.isArray(entry.errors)) queue.push(...entry.errors.slice(0, 8))
  }
  const list = [...codes]
  const reason = list.some(code => code === 'ETIMEDOUT' || code.includes('TIMEOUT')) || signal?.aborted || error?.name === 'TimeoutError' ? 'timeout'
    : list.some(code => code === 'ENOTFOUND' || code === 'EAI_AGAIN') ? 'dns'
      : list.includes('ECONNREFUSED') ? 'connection-refused'
        : list.some(code => code.includes('CERT') || code.startsWith('ERR_TLS') || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') ? 'tls'
          : list.length ? 'connection' : 'unknown'
  return { reason, codes: list }
}

async function quotaFetch(url, options, source, dispatcher) {
  const startedAt = Date.now()
  try {
    const response = await fetch(url, dispatcher ? { ...options, dispatcher } : options)
    if (response.status >= 500) console.warn('[statusline-plus] quota network', JSON.stringify({
      source, reason: 'http', status: response.status, elapsedMs: Date.now() - startedAt,
    }))
    return response
  } catch (error) {
    // Expected client/scope cancellation is not an outbound network failure.
    if (!['client-disconnected', 'request-cancelled', 'request-invalidated'].includes(options?.signal?.reason?.message)) {
      console.warn('[statusline-plus] quota network', JSON.stringify({ source,
        elapsedMs: Date.now() - startedAt, ...quotaNetworkDetails(error, options?.signal) }))
    }
    throw error
  }
}

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

export { deadlineSignal, providerError, providerErrorCode, quotaNetworkDetails, quotaFetch, readQuotaJson, readUsageKey }
