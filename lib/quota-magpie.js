'use strict'
/**
 * Magpie gateway quota source: the subscriptions magpie already keeps fresh.
 *
 * magpie serves `/v1/magpie/quotas` on its local gateway and refreshes every
 * account it manages. When CPA is no longer running (or its saved access
 * tokens have gone stale), that endpoint is the only place with live numbers;
 * the CPA files under ~/.cli-proxy-api stop being refreshed.
 */
import { deadlineSignal, providerError, providerErrorCode, quotaFetch, quotaNetworkDetails, readQuotaJson } from './quota-http.js'
import { antigravityStatus, antigravityWindows, quotaWindow, secondsUntil } from './quota-window.js'

const DEFAULT_MAGPIE_URL = 'http://127.0.0.1:3425'

// The gateway lives on loopback, so a stopped magpie refuses the connection
// immediately. The deadline only covers a busy gateway: the first Antigravity
// read after a restart refreshes three accounts and has been observed taking
// over 3 s, longer than the previous 2.5 s cap (a timeout there used to fall
// through to a stale CPA mirror and surface as an auth failure).
const MAGPIE_TIMEOUT_MS = 8000

function magpieBase() {
  return String(process.env.MAGPIE_GATEWAY_URL || DEFAULT_MAGPIE_URL).replace(/\/+$/, '')
}

// Every subscription reads the same response. The plugin passes a shared reader
// so one refresh of several chips is one request to a possibly busy gateway.
function fetchMagpieQuotas(config, signal, dispatcher) {
  return config && config.readMagpie ? config.readMagpie(signal) : requestMagpieQuotas(signal, dispatcher)
}

async function requestMagpieQuotas(signal, dispatcher) {
  const deadline = deadlineSignal(signal, MAGPIE_TIMEOUT_MS)
  try {
    const response = await quotaFetch(magpieBase() + '/v1/magpie/quotas', {
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
    // Refused means Magpie is not running here, the same as not having it. Any
    // other failure may be a busy gateway, which is worth retrying.
    if (quotaNetworkDetails(error).codes.includes('ECONNREFUSED')) throw providerError('no-credential')
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

// magpie window names are localized ("Gemini · 7 days", "Claude & GPT · 5 hours").
// Match on the two facts that matter: which pool, and whether it resets in 5h or 7d.
function windowKind(name) {
  const label = String(name || '')
  const pool = /gemini/i.test(label) ? 'gemini' : /claude|gpt|third/i.test(label) ? 'third' : null
  const period = /5\s*hour|5h/i.test(label) ? '5h' : /7\s*day|week|7d/i.test(label) ? 'weekly' : null
  return pool && period ? { pool, period } : null
}

/** Pure: map magpie's antigravity rows onto the statusline's account shape. */
function parseMagpieAntigravity(rows, now) {
  const accounts = []
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.provider !== 'antigravity') continue
    const entries = []
    for (const win of Array.isArray(row.windows) ? row.windows : []) {
      const kind = windowKind(win && win.name)
      const used = percent(win && win.used)
      if (kind && used !== null) entries.push({ ...kind, used, resetInSec: secondsUntil(win.resetsAt, now) })
    }
    const windows = antigravityWindows(entries)
    if (!windows.length) continue
    accounts.push({ fetchedAt: now, email: row.user || undefined, fileName: row.user ? 'magpie:' + row.user : 'magpie',
      priority: 0, windows, status: antigravityStatus(windows) })
  }
  if (!accounts.length) return null
  const selected = accounts.find(a => a.status === 'available') || accounts[0]
  return { ...selected, style: 'windows', chipWindows: 2, selectedFileName: selected.fileName, accounts }
}

function windowMinutes(name) {
  const match = /(\d+(?:\.\d+)?)\s*(hour|day|week)/i.exec(String(name || ''))
  if (!match) return undefined
  const unit = match[2].toLowerCase()
  return Math.round(Number(match[1]) * (unit === 'hour' ? 60 : unit === 'day' ? 1440 : 10080))
}

/** Pure: magpie's codex row, shortest window first. A known length is named locally. */
function parseMagpieCodex(rows, now) {
  const row = (Array.isArray(rows) ? rows : []).find(entry => entry && entry.provider === 'codex')
  const windows = rowWindows(row, now)
    .map(({ label, short, ...win }) => win.minutes === undefined ? { label, short, ...win } : win)
    .sort((left, right) => (left.minutes ?? Number.MAX_SAFE_INTEGER) - (right.minutes ?? Number.MAX_SAFE_INTEGER))
  if (!windows.length) return null
  return { style: 'windows', chipWindows: 2, windows, fetchedAt: now,
    ...(row.plan !== undefined && row.plan !== null ? { plan: String(row.plan) } : {}) }
}

const MAX_SUBSCRIPTION_WINDOWS = 12

// "Gemini · 5 hours" stays readable in the panel; a chip only has room for "5h".
function shortWindowLabel(name) {
  const label = String(name || '')
  const match = /(\d+(?:\.\d+)?)\s*(hour|day|week)/i.exec(label)
  return match ? match[1] + match[2][0].toLowerCase() : label.slice(0, 10)
}

function rowWindows(row, now) {
  const out = []
  for (const win of Array.isArray(row && row.windows) ? row.windows : []) {
    const used = percent(win && win.used)
    if (used === null) continue
    const minutes = windowMinutes(win.name)
    out.push(quotaWindow({ label: String(win.name || '').slice(0, 60), short: shortWindowLabel(win.name), ...(minutes === undefined ? {} : { minutes }) },
      used, secondsUntil(win.resetsAt, now)))
    if (out.length >= MAX_SUBSCRIPTION_WINDOWS) break
  }
  return out
}

/**
 * Pure: every subscription this user's Magpie reports, whatever it is called.
 * The list differs per user, so no provider name is assumed here. A row Magpie
 * could not read (an `error`, or no measured window) is not shown as a quota.
 * Several accounts of one provider show the first with quota left.
 */
function parseMagpieSubscriptions(rows, now) {
  const groups = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = row && typeof row.provider === 'string' ? row.provider.trim().toLowerCase() : ''
    if (!id || row.error) continue
    const windows = rowWindows(row, now)
    if (!windows.length) continue
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id).push({ row, windows })
  }
  return [...groups].map(([id, accounts]) => {
    const { row, windows } = accounts.find(item => item.windows.every(win => !win.exhausted)) || accounts[0]
    return {
      id, style: 'windows', label: typeof row.name === 'string' && row.name.trim() ? row.name.trim().slice(0, 40) : id,
      ...(typeof row.plan === 'string' && row.plan ? { plan: row.plan.slice(0, 60) } : {}),
      accountCount: accounts.length, windows, chipWindows: 2, fetchedAt: now,
    }
  })
}

// A hint may be a model namespace (`workbuddy`) for a provider `workbuddy-ai`, or
// the reverse. An exact name always wins over a prefix.
function matchMagpieSubscription(list, hints) {
  const names = hints.map(hint => String(hint || '').trim().toLowerCase()).filter(Boolean)
  return list.find(item => names.includes(item.id)) ||
    list.find(item => names.some(name => item.id.startsWith(name + '-') || name.startsWith(item.id + '-'))) || null
}

async function fetchMagpieSubscriptions(config, signal, dispatcher) {
  return parseMagpieSubscriptions(await fetchMagpieQuotas(config, signal, dispatcher), Date.now())
}

// The Magpie step of a subscription's reading order. `pick` maps the rows to this
// subscription's result, or null when Magpie does not have it.
function magpieTier(config, pick, signal, dispatcher) {
  return { id: 'magpie', tool: true, read: async () => {
    const hit = pick(await fetchMagpieQuotas(config, signal, dispatcher), Date.now())
    if (!hit) throw providerError('no-credential')
    return hit
  } }
}

function pickMagpieSubscription(hints) {
  return (rows, now) => matchMagpieSubscription(parseMagpieSubscriptions(rows, now), hints)
}

export {
  DEFAULT_MAGPIE_URL,
  magpieBase,
  fetchMagpieQuotas,
  fetchMagpieSubscriptions,
  parseMagpieSubscriptions,
  matchMagpieSubscription,
  magpieTier,
  pickMagpieSubscription,
  requestMagpieQuotas,
  parseMagpieAntigravity,
  parseMagpieCodex,
  windowKind,
  windowMinutes,
}
