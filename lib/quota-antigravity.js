'use strict'
/** Antigravity (Google Cloud Code) subscription quota across CPA accounts. */
import { readFileSync, writeFileSync } from 'node:fs'
import { readAllCredentials, readSelectedCredential } from './cpa-credentials.js'
import { deadlineSignal, quotaFetch, readQuotaJson } from './quota-http.js'

const ANTIGRAVITY_HOST = 'daily-cloudcode-pa.googleapis.com'
async function refreshAntigravityToken(cred, signal, dispatcher) {
  if (!cred || !cred.refreshToken) return null
  const deadline = deadlineSignal(signal, 10000)
  try {
    const params = new URLSearchParams({
      // Antigravity/Cloud Code 生态公开的 first-party OAuth client_id（非个人凭据，
      // 与官方 CLI 共用）；client_secret 由使用者通过环境变量提供。
      client_id: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
      client_secret: process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET || '',
      refresh_token: cred.refreshToken,
      grant_type: 'refresh_token',
    })
    const res = await quotaFetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: deadline.signal,
    }, 'antigravity-auth', dispatcher)
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
    deadline.clear()
  }
  return null
}

function parseAntigravityQuotaSummary(now, cred, summaryJson) {
  const groups = summaryJson && Array.isArray(summaryJson.groups) ? summaryJson.groups : []
  let gemini5h = null
  let geminiWeekly = null
  let thirdParty = null
  let thirdPartyWeekly = null

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
        else if (isWeekly && !thirdPartyWeekly) thirdPartyWeekly = item
      }
    }
  }

  if (!gemini5h && !geminiWeekly && !thirdParty && !thirdPartyWeekly) return null

  return {
    fetchedAt: now,
    fileName: cred.fileName,
    email: cred.email || undefined,
    projectId: cred.projectId || undefined,
    gemini5h,
    geminiWeekly,
    thirdParty,
    thirdPartyWeekly,
  }
}
async function fetchAntigravityQuotaForCred(cred, now, signal, dispatcher) {
  const accessToken = cred?.accessToken || cred?.access_token
  const refreshToken = cred?.refreshToken || cred?.refresh_token
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
          'User-Agent': 'antigravity',
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

  let activeToken = accessToken
  let resp
  try {
    resp = await requestEndpoint(activeToken, 'retrieveUserQuotaSummary')
  } catch (e) {
    throw new Error('network')
  }

  if (resp.status === 401 && refreshToken) {
    const refreshed = await refreshAntigravityToken(cred, signal, dispatcher)
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
        // Judge by Gemini when the service reports it; accounts whose summary only
        // carries the Claude/GPT group (seen since 2026-10) are judged by that group.
        const windows = quota.gemini5h || quota.geminiWeekly ? [quota.gemini5h, quota.geminiWeekly] : [quota.thirdParty, quota.thirdPartyWeekly]
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
  } finally { deadline.clear() }
}
async function fetchAntigravityQuota(config, force, signal, accountPool, dispatcher) {
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

export { ANTIGRAVITY_HOST, parseAntigravityQuotaSummary, fetchAntigravityQuotaForCred, collectAntigravityQuotas, fetchAntigravityQuota }
