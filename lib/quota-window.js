'use strict'
/**
 * The one shape a subscription's quota takes on its way to the browser:
 *   { style: 'windows', windows: [window], chipWindows?, plan?, accounts?, fetchedAt }
 *   window: { id?, group?, minutes?, label?, short?, usedPercent, remainingPercent, resetInSec, exhausted? }
 * A window with `minutes` and no `label` is named in the viewer's language.
 */

function secondsUntil(time, now) {
  const ms = time ? new Date(time).getTime() : NaN
  return Number.isFinite(ms) ? Math.max(0, Math.round((ms - now) / 1000)) : 0
}

// `exhausted` is judged before rounding: 99.9% used shows as 100% but still has quota.
function quotaWindow(fields, used, resetInSec = 0) {
  const exact = Math.max(0, Math.min(100, used))
  const usedPercent = Math.round(exact)
  return { ...fields, usedPercent, remainingPercent: 100 - usedPercent, resetInSec, ...(exact >= 100 ? { exhausted: true } : {}) }
}

const ANTIGRAVITY_WINDOWS = [
  ['gemini', '5h', 300], ['gemini', 'weekly', 10080],
  ['third', '5h', 300], ['third', 'weekly', 10080],
]

// `entries`: { pool, period, used, resetInSec }. The service reports one or two model
// groups with a 5-hour and a weekly window each; Gemini sorts first when present.
function antigravityWindows(entries) {
  const windows = []
  for (const [group, period, minutes] of ANTIGRAVITY_WINDOWS) {
    const entry = entries.find(item => item.pool === group && item.period === period)
    if (entry) windows.push(quotaWindow({ id: group + '-' + period, group, minutes }, entry.used, entry.resetInSec))
  }
  return windows
}

// Judged by the leading group: Gemini when the service reports it, otherwise the
// Claude/GPT pair. A group missing one of its two windows does not imply availability.
function antigravityStatus(windows) {
  const judged = windows.filter(win => win.group === windows[0]?.group)
  if (judged.some(win => win.exhausted)) return 'exhausted'
  return judged.length >= 2 ? 'available' : 'unknown'
}

export { secondsUntil, quotaWindow, antigravityWindows, antigravityStatus }
