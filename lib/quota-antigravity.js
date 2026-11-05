'use strict'
/** Antigravity (Google Cloud Code) subscription quota across CPA accounts. */
import { readAllCredentials, readSelectedCredential } from './cpa-credentials.js'
import { deadlineSignal, quotaFetch, readQuotaJson } from './quota-http.js'
import { readAntigravityLogin } from './quota-login-files.js'
import { magpieTier, parseMagpieAntigravity } from './quota-magpie.js'
import { quotaPinOf, readInOrder } from './quota-order.js'
import { antigravityStatus, antigravityWindows, secondsUntil } from './quota-window.js'

const ANTIGRAVITY_HOST = 'daily-cloudcode-pa.googleapis.com'
// This path only reads: an expired token is reported, never refreshed or written
// back, because the file belongs to CPA or the official tool. It also does not
// present another client's identity; the service may then omit the Gemini group
// (see geminiHidden).

function parseAntigravityQuotaSummary(now, cred, summaryJson) {
  const groups = summaryJson && Array.isArray(summaryJson.groups) ? summaryJson.groups : []
  const entries = []
  for (const group of groups) {
    if (!group || !Array.isArray(group.buckets)) continue
    const groupName = String(group.displayName || '').toLowerCase()
    const pool = groupName.includes('gemini') ? 'gemini' : /claude|gpt|third.party/.test(groupName) ? 'third' : null
    if (!pool) continue
    for (const bucket of group.buckets) {
      if (!bucket) continue
      const rem = bucket.remainingFraction
      if (typeof rem !== 'number' || !Number.isFinite(rem) || rem < 0 || rem > 1) continue
      const period = bucket.window === '5h' || String(bucket.bucketId || '').includes('5h') ? '5h'
        : bucket.window === 'weekly' || String(bucket.bucketId || '').includes('weekly') ? 'weekly' : null
      if (period) entries.push({ pool, period, used: (1 - rem) * 100, resetInSec: secondsUntil(bucket.resetTime, now) })
    }
  }
  const windows = antigravityWindows(entries)
  if (!windows.length) return null
  return {
    fetchedAt: now,
    fileName: cred.fileName,
    email: cred.email || undefined,
    projectId: cred.projectId || undefined,
    windows,
  }
}
function hasErrorReason(json, reason) {
  const details = json && json.error && Array.isArray(json.error.details) ? json.error.details : []
  return details.some(detail => detail && detail.reason === reason)
}

async function fetchAntigravityQuotaForCred(cred, now, signal, dispatcher) {
  const accessToken = cred?.accessToken || cred?.access_token
  const projectId = cred?.projectId || cred?.project_id
  if (!cred || !accessToken) return null

  async function requestEndpoint(token, endpoint) {
    const deadline = deadlineSignal(signal, 12000)
    try {
      const body = projectId ? JSON.stringify({ project: projectId }) : JSON.stringify({})
      const res = await quotaFetch(`https://${ANTIGRAVITY_HOST}/v1internal:` + endpoint, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body,
        signal: deadline.signal,
      }, 'antigravity', dispatcher)
      let json = null
      try { json = await readQuotaJson(res) } catch (e) {}
      return { status: res.status, json }
    } finally {
      deadline.clear()
    }
  }

  let resp
  try {
    resp = await requestEndpoint(accessToken, 'retrieveUserQuotaSummary')
  } catch (e) {
    throw new Error('network')
  }

  // The token is fine but this request found no subscription: signing in again
  // would not help, so it must not read as an expired login.
  if (resp.status === 403 && hasErrorReason(resp.json, 'SUBSCRIPTION_REQUIRED')) throw new Error('no-credential')
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
  const deadline = deadlineSignal(signal, timeoutMs, new Error('timeout'))
  const combined = deadline.signal
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
        accounts[index] = { ...quota, ...identity, status: antigravityStatus(quota.windows) }
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
    return { ...selected, style: 'windows', chipWindows: 2, selectedFileName: selected.fileName, accounts }
  } finally { deadline.clear() }
}
async function fetchAntigravityFromCpa(config, force, signal, accountPool, dispatcher) {
  const creds = config.antigravityAccount
    ? [readSelectedCredential('antigravity', config.antigravityAccount)].filter(Boolean)
    : readAllCredentials('antigravity')
  if (!creds.length) throw new Error('no-credential')
  return collectAntigravityQuotas(creds, (cred, subscriberSignal) => accountPool.run(
    cred.fileName,
    requestSignal => fetchAntigravityQuotaForCred(cred, Date.now(), requestSignal, dispatcher),
    { force, signal: subscriberSignal, ttlMs: Math.max(15000, config.cacheTtlMs) },
  ), signal)
}

// CPA and the official login may both report only the Claude/GPT group; say so.
function markHiddenGemini(quota) {
  return quota.windows.some(win => win.group === 'gemini') ? quota : { ...quota, geminiHidden: true }
}

// An explicitly chosen CPA account is a pin on CPA.
async function fetchAntigravityQuota(config, force, signal, accountPool, dispatcher) {
  return readInOrder([
    magpieTier(config, parseMagpieAntigravity, signal, dispatcher),
    { id: 'cpa', read: async () => markHiddenGemini(await fetchAntigravityFromCpa(config, force, signal, accountPool, dispatcher)) },
    { id: 'official', read: async () => {
      const cred = { fileName: 'antigravity-oauth-token', accessToken: readAntigravityLogin() }
      return markHiddenGemini(await collectAntigravityQuotas([cred], (item, requestSignal) => fetchAntigravityQuotaForCred(item, Date.now(), requestSignal, dispatcher), signal))
    } },
  ], quotaPinOf(config, 'antigravity') || (config.antigravityAccount ? 'cpa' : null))
}

export { ANTIGRAVITY_HOST, parseAntigravityQuotaSummary, fetchAntigravityQuotaForCred, collectAntigravityQuotas, fetchAntigravityQuota }
