'use strict'
// Subscription reset notices, Host side.
//
// AIHOT (aihot.news) watches the official accounts that announce provider-wide
// quota resets and reset cards. These are not the user's own rolling windows:
// those come from each subscription's quota source. The feed is anonymous and
// read-only. Each subscription is read at most once per POLL_MS, with the last
// ETag, so an unchanged feed costs a 304 with an empty body.
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs'

// Grok has no subscription source in this plugin, so it is opt-in only.
const RESET_KINDS = ['codex', 'antigravity', 'claude', 'grok']
const DEFAULT_RESET_KINDS = ['codex', 'antigravity', 'claude']
const FEED_PATHS = { codex: 'codex-resets', antigravity: 'antigravity-resets', claude: 'claude-resets', grok: 'grok-bot-resets' }
const FEED_URL = kind => `https://aihot.news/api/v1/${FEED_PATHS[kind]}/recent`
// The feed scans about every 10 minutes and asks clients not to poll faster.
const POLL_MS = 10 * 60000
const ERROR_RETRY_MS = 5 * 60000
const MAX_RETRY_AFTER_MS = 6 * 3600000
const FETCH_TIMEOUT_MS = 8000
const DAY_MS = 24 * 3600000
// Clock tolerance for a confirmation stamped slightly ahead of the Host.
const SKEW_MS = 5 * 60000
const MAX_EVENTS = 40
const MAX_CACHE_AGE_MS = 7 * DAY_MS

const TYPES = ['direct_reset', 'reset_credit']
const PRECISIONS = ['exact', 'approximate', 'deadline', 'date', 'window']
// Past its window without a confirmation: no longer "about to happen".
const STALE_PRESENTATION = ['expired_unconfirmed', 'likely_completed']

function text(value, max) {
  return typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null
}
function time(value) {
  if (typeof value !== 'string' || value.length > 40) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}
// Links go to the page that cites the event, or to the post itself; anything
// else in the feed is dropped rather than rendered as a clickable link.
function link(value, hosts) {
  const s = text(value, 512)
  if (!s) return null
  try {
    const url = new URL(s)
    return url.protocol === 'https:' && hosts.includes(url.hostname) && !url.username && !url.password ? url.toString() : null
  } catch (_) { return null }
}
function span(raw, precisions) {
  if (!raw || typeof raw !== 'object') return null
  const from = time(raw.from), through = time(raw.through)
  if (from === null && through === null) return null
  const precision = precisions ? (PRECISIONS.includes(raw.precision) ? raw.precision : null) : 'estimate'
  if (!precision) return null
  return { precision, from: from ?? through, through: through ?? from }
}

// One validated event. Unknown shapes are dropped, never guessed.
function normalizeResetEvent(raw, kind) {
  if (!raw || typeof raw !== 'object') return null
  const id = text(raw.id, 200)
  if (!id || !TYPES.includes(raw.type) || (raw.status !== 'announced' && raw.status !== 'confirmed')) return null
  const createdAt = time(raw.createdAt)
  if (createdAt === null) return null
  const presentation = raw.presentation && typeof raw.presentation === 'object' ? raw.presentation : {}
  const posts = Array.isArray(raw.posts) ? raw.posts : []
  let postUrl = null
  for (let i = posts.length - 1; i >= 0 && !postUrl; i--) postUrl = link(posts[i]?.url, ['x.com', 'twitter.com'])
  return {
    id, kind, type: raw.type, status: raw.status,
    stage: typeof presentation.status === 'string' ? presentation.status : null,
    createdAt, confirmedAt: time(raw.confirmedAt),
    schedule: span(raw.schedule, true),
    estimate: raw.status === 'announced' ? span(raw.estimate, false) : null,
    scope: text(presentation.scopeLabel, 80),
    url: link(raw.url, ['aihot.news']),
    postUrl,
  }
}

function parseResetFeed(json, kind) {
  if (!json || typeof json !== 'object' || json.schemaVersion !== 1 || !Array.isArray(json.events)) return null
  return json.events.slice(0, MAX_EVENTS).map(event => normalizeResetEvent(event, kind)).filter(Boolean)
}

// The notices worth showing at `now`: a reset confirmed in the last 24 h, or an
// announced one whose window overlaps the next 24 h. Older history never shows.
// Many resets are confirmed by the same post that announces them, so a rule
// limited to announcements would miss most of them.
function pickResetNotices(events, now) {
  const notices = []
  for (const event of events || []) {
    if (event.status === 'confirmed') {
      const at = event.confirmedAt
      if (at !== null && at >= now - DAY_MS && at <= now + SKEW_MS) notices.push({ ...event, phase: 'confirmed', at })
      continue
    }
    if (STALE_PRESENTATION.includes(event.stage)) continue
    const window = event.schedule || event.estimate
    if (window) {
      // "Before <deadline>" may land any time from the announcement on.
      const start = window.precision === 'deadline' ? Math.min(event.createdAt, window.from) : window.from
      if (window.through >= now && start <= now + DAY_MS) notices.push({ ...event, phase: 'announced', at: null, window })
    } else if (event.createdAt >= now - DAY_MS) {
      notices.push({ ...event, phase: 'announced', at: null, window: null })
    }
  }
  // Upcoming first by start, then confirmations newest first.
  return notices.sort((a, b) => (a.phase === b.phase ? 0 : a.phase === 'announced' ? -1 : 1) ||
    (a.phase === 'announced' ? (a.window?.from ?? a.createdAt) - (b.window?.from ?? b.createdAt) : b.at - a.at))
}

function retryAfterMs(response, now) {
  const value = response.headers?.get?.('retry-after')
  if (!value) return null
  const seconds = Number(value)
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : null
}

class ResetFeed {
  constructor({ fetch: fetchImpl = globalThis.fetch, now = Date.now, cachePath = null, userAgent = 'dsh-statusline-plus', log = () => {} } = {}) {
    this.fetch = fetchImpl
    this.now = now
    this.cachePath = cachePath
    this.userAgent = userAgent
    this.log = log
    this.entries = this.readCache()
  }

  // The cache keeps the feed's own events, so reading it back goes through the
  // same parser as a live response: no second format to keep in step.
  readCache() {
    const entries = {}
    if (!this.cachePath || !existsSync(this.cachePath)) return entries
    try {
      const raw = JSON.parse(readFileSync(this.cachePath, 'utf8'))
      for (const kind of RESET_KINDS) {
        const entry = raw?.[kind]
        if (!entry || typeof entry.fetchedAt !== 'number' || this.now() - entry.fetchedAt > MAX_CACHE_AGE_MS) continue
        const events = parseResetFeed({ schemaVersion: 1, events: entry.raw }, kind)
        if (!events) continue
        entries[kind] = { raw: entry.raw, events, etag: typeof entry.etag === 'string' && entry.etag.length <= 200 ? entry.etag : null,
          fetchedAt: entry.fetchedAt, retryAt: 0, inflight: null }
      }
    } catch (_) { /* start empty */ }
    return entries
  }

  writeCache() {
    if (!this.cachePath) return
    const data = {}
    for (const [kind, entry] of Object.entries(this.entries)) {
      if (entry.fetchedAt) data[kind] = { etag: entry.etag, fetchedAt: entry.fetchedAt, raw: entry.raw }
    }
    const tmp = this.cachePath + '.tmp-' + process.pid
    try {
      writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
      renameSync(tmp, this.cachePath)
    } catch (error) {
      try { unlinkSync(tmp) } catch (_) {}
      this.log('reset cache write failed: ' + error.message)
    }
  }

  entry(kind) {
    if (!this.entries[kind]) this.entries[kind] = { raw: [], events: [], etag: null, fetchedAt: 0, retryAt: 0, inflight: null }
    return this.entries[kind]
  }

  async refresh(kind) {
    const entry = this.entry(kind)
    const headers = { 'user-agent': this.userAgent, accept: 'application/json' }
    if (entry.etag) headers['if-none-match'] = entry.etag
    const response = await this.fetch(FEED_URL(kind), { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    const now = this.now()
    if (response.status === 304) {
      entry.fetchedAt = now
      this.writeCache()
      return
    }
    if (!response.ok) {
      const wait = retryAfterMs(response, now)
      entry.retryAt = now + Math.max(wait ?? 0, response.status === 429 ? POLL_MS : ERROR_RETRY_MS)
      throw new Error('http-' + response.status)
    }
    const json = await response.json()
    const events = parseResetFeed(json, kind)
    if (!events) {
      entry.retryAt = now + ERROR_RETRY_MS
      throw new Error('invalid-response')
    }
    entry.raw = json.events.slice(0, MAX_EVENTS)
    entry.events = events
    entry.etag = response.headers?.get?.('etag') || null
    entry.fetchedAt = now
    this.writeCache()
  }

  // Lazy and shared: a stale subscription refreshes once for every caller; a
  // closing tab never cancels it for the others.
  async load(kind) {
    const entry = this.entry(kind), now = this.now()
    if (now - entry.fetchedAt >= POLL_MS && now >= entry.retryAt) {
      if (!entry.inflight) {
        entry.inflight = this.refresh(kind).catch(error => {
          if (!entry.retryAt || entry.retryAt <= this.now()) entry.retryAt = this.now() + ERROR_RETRY_MS
          this.log('reset feed ' + kind + ' failed: ' + (error?.message || error))
        }).finally(() => { entry.inflight = null })
      }
      await entry.inflight
    }
    return entry
  }

  async notices(kinds) {
    const wanted = RESET_KINDS.filter(kind => kinds.includes(kind))
    const entries = await Promise.all(wanted.map(kind => this.load(kind)))
    const now = this.now()
    // When the Host will next read the feed. The browser asks again just after
    // it, so a change is seen within one poll instead of two stacked ones.
    const due = entries.map(entry => Math.max(entry.fetchedAt + POLL_MS, entry.retryAt))
    return {
      notices: pickResetNotices(entries.flatMap(entry => entry.events), now).map(publicNotice),
      nextCheckAt: due.length ? Math.max(now, Math.min(...due)) : null,
    }
  }
}

function publicNotice(notice) {
  return {
    id: notice.id, kind: notice.kind, type: notice.type, phase: notice.phase, at: notice.at,
    window: notice.window, scope: notice.scope, url: notice.url, postUrl: notice.postUrl,
  }
}
function sanitizeResetKinds(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  return RESET_KINDS.filter(kind => list.includes(kind))
}

export { ResetFeed, RESET_KINDS, DEFAULT_RESET_KINDS, FEED_URL, POLL_MS, normalizeResetEvent, parseResetFeed, pickResetNotices, sanitizeResetKinds }
