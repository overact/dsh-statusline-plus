'use strict'
/** Claude subscription quota: Magpie, then CPA, then the Claude Code login file. */
import { readAllCredentials } from './cpa-credentials.js'
import { deadlineSignal, providerErrorCode, quotaFetch, readQuotaJson } from './quota-http.js'
import { readClaudeLogin } from './quota-login-files.js'
import { magpieTier, pickMagpieSubscription } from './quota-magpie.js'
import { quotaPinOf, readInOrder } from './quota-order.js'
import { quotaWindow, secondsUntil } from './quota-window.js'

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const CLAUDE_WINDOWS = [
  ['five_hour', '5h'], ['seven_day', '7d'],
  ['seven_day_opus', 'Opus 7d'], ['seven_day_sonnet', 'Sonnet 7d'],
]

/** Pure: `utilization` is already a used percentage (0–100). Absent is not 0%. */
function parseClaudeUsage(json, now) {
  const windows = []
  for (const [field, label] of CLAUDE_WINDOWS) {
    const bucket = json && json[field]
    const used = bucket && typeof bucket.utilization === 'number' && Number.isFinite(bucket.utilization) ? bucket.utilization : null
    if (used === null) continue
    windows.push(quotaWindow({ label }, used, secondsUntil(bucket.resets_at, now)))
  }
  return windows.length ? windows : null
}

async function readClaudeUsage(token, signal, dispatcher) {
  const deadline = deadlineSignal(signal, 15000)
  try {
    const response = await quotaFetch(CLAUDE_USAGE_URL, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', 'anthropic-beta': 'oauth-2025-04-20' },
      signal: deadline.signal,
    }, 'claude', dispatcher)
    if (response.status !== 200) throw new Error(providerErrorCode(response.status))
    let json = null
    try { json = await readQuotaJson(response) } catch {}
    const now = Date.now()
    const windows = parseClaudeUsage(json, now)
    if (!windows) throw new Error('invalid-response')
    return { style: 'windows', label: 'Claude', windows, chipWindows: 2, fetchedAt: now }
  } finally { deadline.clear() }
}

function fetchClaudeQuota(config, signal, dispatcher) {
  return readInOrder([
    magpieTier(config, pickMagpieSubscription(['claude', 'claude-code', 'anthropic']), signal, dispatcher),
    { id: 'cpa', read: async () => {
      const token = readAllCredentials('claude')[0]?.access_token
      if (!token) throw new Error('no-credential')
      return readClaudeUsage(token, signal, dispatcher)
    } },
    { id: 'official', read: async () => readClaudeUsage(readClaudeLogin(), signal, dispatcher) },
  ], quotaPinOf(config, 'claude'))
}

export { parseClaudeUsage, fetchClaudeQuota }
