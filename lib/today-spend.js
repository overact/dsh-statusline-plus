'use strict'
// Today's spend across every session, Host side.
//
// The per-session projection answers "what has this conversation cost". This
// answers "what has today cost", which cannot be derived from it: the projection
// keeps no day bucket, and re-deriving one would invalidate every stored row.
//
// Cost is bounded instead. A session's log is append-only, so a log whose file
// was not touched since local midnight contains no event from today; only the
// touched ones are read, through the Host's own replay (`sessionQuery.readSession`)
// rather than a decoder of ours. Fork prefixes are skipped: a fork that inherited
// yesterday's events must not be charged for them twice.
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { lastStreamUsage, normalizeSessionId } from './session-records.js'
import { timeOf } from './session-fold.js'
import { quoteUsage, MONEY_UNITS } from './session-metrics.js'

// One refresh reads at most this many logs: the corpus here has a handful of
// today-touched files, but a busier machine must not turn a cost line into a
// multi-second stall. What is left out is reported, never silently dropped.
const MAX_SESSIONS = 40

// The log file in one session directory, whichever format the Host writes. Its
// contents are decoded by the Host, not here, so the version only picks a file.
const LOG_NAME = /^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?$/

function logFileIn(directory) {
  let names
  try {
    names = readdirSync(directory)
  } catch (_) {
    return null
  }
  let best = null
  for (const name of names) {
    const match = LOG_NAME.exec(name)
    if (!match) continue
    const candidate = { name, version: Number(match[1] || 0), compressed: name.endsWith('.zstd') }
    if (!best || candidate.version > best.version || candidate.version === best.version && candidate.compressed && !best.compressed) best = candidate
  }
  return best ? join(directory, best.name) : null
}

function startOfLocalDay(now) {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  return start.getTime()
}

// The logs that can contain an event from `since`. Cheap: two directory reads and
// one stat per session, no event decoding.
function touchedLogs(root, since) {
  const found = []
  let projects
  try {
    projects = readdirSync(root, { withFileTypes: true })
  } catch (_) {
    return found
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    let sessions
    try {
      sessions = readdirSync(join(root, project.name), { withFileTypes: true })
    } catch (_) {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const id = normalizeSessionId(session.name)
      if (!id) continue
      const file = logFileIn(join(root, project.name, session.name))
      if (!file) continue
      let info = null
      try {
        info = statSync(file)
      } catch (_) {
        continue
      }
      if (info.mtimeMs < since) continue
      found.push({ id, file, bytes: info.size, mtime: info.mtimeMs })
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime)
}

// `assistant/attempt` is a retry that may have consumed tokens and produced no
// message. Counting both would charge a retried step twice, so an attempt is
// priced only when no message followed it for the same step.
function billableEvents(events, inherited, since = -Infinity) {
  const messaged = new Set()
  for (let i = inherited; i < events.length; i++) {
    const event = events[i]
    if (event && event.type === 'assistant/message') {
      const data = event.data || {}
      messaged.add(String(data.turn) + ':' + String(data.step))
    }
  }
  const billable = []
  // A message carries its own route; a retry carries none, so it inherits the
  // route in force when it was sent (`request/header`), exactly like the Host's
  // per-session fold. Without this an attempt would be "unpriced" and the day
  // would read low.
  //
  // The route scan runs over the whole log (a header older than `since` still
  // describes the first request after it), while an event is billed only when
  // its own timestamp falls inside the window. A log touched today holds every
  // earlier day too: a session that ran past midnight must not carry yesterday's
  // spend into today.
  let route = null
  for (let i = inherited; i < events.length; i++) {
    const event = events[i]
    if (!event) continue
    if (event.type === 'request/header') {
      route = routeOf((event.data || {}).header?.config) || route
      continue
    }
    const time = timeOf(event.time)
    if (time === null || time < since) continue
    if (event.type === 'assistant/message') {
      billable.push({ event, route: routeOf(((event.data || {}).message || {}).source) || route })
    } else if (event.type === 'assistant/attempt') {
      const data = event.data || {}
      if (!messaged.has(String(data.turn) + ':' + String(data.step))) billable.push({ event, route })
    }
  }
  return billable
}

function usageOf(event) {
  const data = event.data || {}
  if (event.type === 'assistant/message' && data.usage && typeof data.usage === 'object') return data.usage
  return lastStreamUsage(data.stream)
}

function routeOf(source) {
  if (!source || typeof source !== 'object') return null
  const provider = typeof source.provider === 'string' ? source.provider : null
  const model = typeof source.model === 'string' ? source.model : null
  if (!provider && !model) return null
  return { provider, model }
}

// The request's own instant: a request is paid at the tariff in force when it was
// sent, not at the one in force when this total is computed.
function observedAtOf(event) {
  const stream = (event.data || {}).stream
  if (Array.isArray(stream)) {
    for (const chunk of stream) {
      const time = chunk && typeof chunk.time === 'number' ? chunk.time : null
      if (time !== null) return time
    }
  }
  return typeof event.time === 'number' ? event.time : null
}

// { supported, start, sessions, counted, skipped, unpriced, cnyUnits, usdUnits }
async function todaySpend({ query, catalog, schedule, now = Date.now(), root = dshHomePath('sessions'), log = () => {} } = {}) {
  if (!query || typeof query.readSession !== 'function') return { supported: false }
  const start = startOfLocalDay(now)
  const logs = touchedLogs(root, start)
  const picked = logs.slice(0, MAX_SESSIONS)
  let cnyUnits = 0, usdUnits = 0, counted = 0, unpriced = 0, skipped = 0
  for (const entry of picked) {
    let snapshot = null, lastError = null
    // The directory name is the persistence id; the corpus may key the same
    // session with a `session-` prefix (0.2.x does). Try both before calling it
    // unreadable.
    for (const id of [entry.id, 'session-' + entry.id]) {
      try {
        snapshot = await query.readSession(id)
        break
      } catch (error) {
        lastError = error
      }
    }
    if (!snapshot) {
      // A torn log or a format this Host cannot replay: count it as uncounted
      // rather than as free.
      skipped++
      log('today spend: ' + entry.id + ': ' + (lastError && lastError.message))
      continue
    }
    if (!snapshot || !Array.isArray(snapshot.events)) {
      skipped++
      continue
    }
    const inherited = Number.isInteger(snapshot.inheritedEventCount) ? snapshot.inheritedEventCount : 0
    let contributed = false
    for (const { event, route } of billableEvents(snapshot.events, inherited, start)) {
      const quote = quoteUsage({
        route,
        usage: usageOf(event),
        observedAt: observedAtOf(event),
        catalog,
        schedule,
      })
      if (!quote || quote.reason) {
        unpriced++
        continue
      }
      if (quote.currency === 'USD') usdUnits += quote.units
      else cnyUnits += quote.units
      contributed = true
    }
    if (contributed) counted++
  }
  return {
    supported: true,
    start,
    sessions: logs.length,
    counted,
    skipped,
    unpriced,
    // Same unit as the per-session figure: 1e-8 of the currency.
    cnyUnits,
    usdUnits,
    complete: logs.length <= MAX_SESSIONS && skipped === 0 && unpriced === 0,
  }
}

export { todaySpend, touchedLogs, billableEvents, startOfLocalDay, MAX_SESSIONS, MONEY_UNITS }
