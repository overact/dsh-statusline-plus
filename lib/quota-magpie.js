'use strict'
/**
 * Magpie gateway quota source: the subscriptions magpie already keeps fresh.
 *
 * magpie serves `/v1/magpie/quotas` on its local gateway and refreshes every
 * account it manages. When CPA is no longer running (or its saved access
 * tokens have gone stale), that endpoint is the only place with live numbers;
 * the CPA files under ~/.cli-proxy-api stop being refreshed.
 */
import { deadlineSignal, providerError, providerErrorCode, quotaFetch, readQuotaJson } from './quota-http.js'

const DEFAULT_MAGPIE_URL = 'http://127.0.0.1:3425'

// The gateway lives on loopback; a short deadline keeps a stopped magpie from
// delaying the CPA path by more than a couple of seconds.
const MAGPIE_TIMEOUT_MS = 2500

function magpieBase(config) {
  const configured = config && typeof config.magpieUrl === 'string' ? config.magpieUrl.trim() : ''
  const raw = configured || process.env.MAGPIE_GATEWAY_URL || DEFAULT_MAGPIE_URL
  return String(raw).replace(/\/+$/, '')
}

// auto follows a live Magpie gateway; cpa/magpie pin one source for users who
// run the other gateway (or both) and want a deterministic answer.
function quotaSourceOf(config) {
  const value = config && config.quotaSource
  return value === 'magpie' || value === 'cpa' ? value : 'auto'
}

async function fetchMagpieQuotas(config, signal, dispatcher) {
  const deadline = deadlineSignal(signal, MAGPIE_TIMEOUT_MS)
  try {
    const response = await quotaFetch(magpieBase(config) + '/v1/magpie/quotas', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: deadline.signal,
    }, 'magpie', dispatcher)
    if (!response.ok) throw providerError(providerErrorCode(response.status))
    const json = await readQuotaJson(response)
    if (!json || !Array.isArray(json.data)) throw providerError('invalid-response')
    return json.data
  } catch (error) {
    if (error && error.code) throw error
    throw providerError('network')
  } finally {
    deadline.clear()
  }
}

function percent(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(100, n))
}

function windowFromMagpie(win, now) {
  const used = percent(win && win.used)
  if (used === null) return null
  const resetMs = win.resetsAt ? new Date(win.resetsAt).getTime() : NaN
  const resetInSec = Number.isFinite(resetMs) ? Math.max(0, Math.round((resetMs - now) / 1000)) : 0
  return {
    remainingFraction: Math.round((100 - used) * 100) / 10000,
    remainingPercent: Math.round(100 - used),
    usedPercent: Math.round(used),
    resetTime: win.resetsAt || null,
    resetInSec,
    displayName: win.name || '',
  }
}

// magpie window names are localized ("Gemini · 7 days", "Claude & GPT · 5 hours").
// Match on the two facts that matter: which pool, and whether it resets in 5h or 7d.
function windowKind(name) {
  const label = String(name || '')
  const pool = /gemini/i.test(label) ? 'gemini' : /claude|gpt|third/i.test(label) ? 'third' : null
  const period = /5\s*hour|5h/i.test(label) ? '5h' : /7\s*day|week|7d/i.test(label) ? 'weekly' : null
  return pool && period ? { pool, period } : null
}

function accountStatus(quota) {
  const windows = quota.gemini5h || quota.geminiWeekly ? [quota.gemini5h, quota.geminiWeekly] : [quota.thirdParty, quota.thirdPartyWeekly]
  const measured = windows.filter(Boolean)
  if (!measured.length) return 'unknown'
  if (measured.some(w => w.remainingFraction === 0)) return 'exhausted'
  if (measured.every(w => w.remainingFraction > 0)) return 'available'
  return 'unknown'
}

/** Pure: map magpie's antigravity rows onto the statusline's account shape. */
function parseMagpieAntigravity(rows, now) {
  const accounts = []
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.provider !== 'antigravity') continue
    const windows = Array.isArray(row.windows) ? row.windows : []
    const identity = {
      email: row.user || undefined,
      fileName: row.user ? 'magpie:' + row.user : 'magpie',
      priority: 0,
    }
    const quota = { fetchedAt: now, ...identity }
    for (const win of windows) {
      const kind = windowKind(win && win.name)
      const parsed = windowFromMagpie(win, now)
      if (!kind || !parsed) continue
      if (kind.pool === 'gemini') {
        if (kind.period === '5h' && !quota.gemini5h) quota.gemini5h = parsed
        else if (kind.period === 'weekly' && !quota.geminiWeekly) quota.geminiWeekly = parsed
      } else {
        if (kind.period === '5h' && !quota.thirdParty) quota.thirdParty = parsed
        else if (kind.period === 'weekly' && !quota.thirdPartyWeekly) quota.thirdPartyWeekly = parsed
      }
    }
    if (!quota.gemini5h && !quota.geminiWeekly && !quota.thirdParty && !quota.thirdPartyWeekly) continue
    accounts.push({ ...quota, status: accountStatus(quota) })
  }
  if (!accounts.length) return null
  const selected = accounts.find(a => a.status === 'available') || accounts.find(a => a.status !== 'error') || accounts[0]
  return { ...selected, selectedFileName: selected.fileName, accounts }
}

function codexWindowMinutes(name) {
  const label = String(name || '')
  const match = /(\d+(?:\.\d+)?)\s*(hour|day|week)/i.exec(label)
  if (!match) return undefined
  const value = Number(match[1])
  if (!Number.isFinite(value)) return undefined
  const unit = match[2].toLowerCase()
  return Math.round(value * (unit === 'hour' ? 60 : unit === 'day' ? 1440 : 10080))
}

function codexWindowFromMagpie(win, now) {
  const used = percent(win && win.used)
  if (used === null) return null
  const resetMs = win.resetsAt ? new Date(win.resetsAt).getTime() : NaN
  const item = { usedPercent: used }
  const minutes = codexWindowMinutes(win.name)
  if (minutes !== undefined) item.windowMinutes = minutes
  if (Number.isFinite(resetMs)) {
    item.resetAt = Math.round(resetMs / 1000)
    item.resetAfterSeconds = Math.max(0, Math.round((resetMs - now) / 1000))
  }
  return item
}

/** Pure: map magpie's codex row onto the wham-shaped result the UI expects. */
function parseMagpieCodex(rows, now) {
  const row = (Array.isArray(rows) ? rows : []).find(entry => entry && entry.provider === 'codex')
  if (!row) return null
  const windows = (Array.isArray(row.windows) ? row.windows : [])
    .map(win => ({ win, parsed: codexWindowFromMagpie(win, now) }))
    .filter(item => item.parsed)
    .map(item => ({ ...item, minutes: codexWindowMinutes(item.win.name) }))
    .sort((left, right) => (left.minutes ?? Number.MAX_SAFE_INTEGER) - (right.minutes ?? Number.MAX_SAFE_INTEGER))
  if (!windows.length) return null
  const primary = windows[0].parsed
  const secondary = windows.length > 1 ? windows[windows.length - 1].parsed : undefined
  const result = { fetchedAt: now, primary }
  if (secondary) result.secondary = secondary
  if (row.plan !== undefined && row.plan !== null) result.planType = String(row.plan)
  if (row.user !== undefined && row.user !== null) result.email = String(row.user)
  return result
}

export {
  DEFAULT_MAGPIE_URL,
  magpieBase,
  quotaSourceOf,
  fetchMagpieQuotas,
  parseMagpieAntigravity,
  parseMagpieCodex,
  windowKind,
  codexWindowMinutes,
}
