'use strict'
// DeepSeek peak schedule support, Host side.
//
// Peak windows stay hard-coded in the client (the official wording is too
// loose to trust a parse). The official pricing page is only a change
// detector: if its rule sentence stops matching EXPECTED_RULE, the UI flags
// "rules may have changed". Chinese holidays and make-up workdays come from
// NateScarlet/holiday-cn (jsDelivr first: reachable from mainland China),
// with the client's built-in calendar as the floor.
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs'

const PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'
const HOLIDAY_URLS = [
  year => `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`,
  year => `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`,
]
// What the client hard-codes, in the page's own terms.
const EXPECTED_RULE = { windows: ['09:00-12:00', '14:00-18:00'], phrases: ['周一至周五', '法定节假日', '周末'] }
const PEAK_WINDOWS = EXPECTED_RULE.windows.map(window => window.split('-').map(time => {
  const [hours, minutes] = time.split(':').map(Number)
  return hours + minutes / 60
}))
// The peak indicator's offline calendar, also used by the pricing snapshot.
const BUILTIN_HOLIDAYS = {
  2025: [['01-01', '01-01'], ['01-28', '02-04'], ['04-04', '04-06'], ['05-01', '05-05'], ['05-31', '06-02'], ['10-01', '10-08']],
  2026: [['01-01', '01-03'], ['02-15', '02-23'], ['04-04', '04-06'], ['05-01', '05-05'], ['06-19', '06-21'], ['09-25', '09-27'], ['10-01', '10-07']],
}
const TTL_MS = 24 * 3600000
const RETRY_MS = 3600000
const MAX_CACHE_AGE_MS = 90 * 24 * 3600000
const FETCH_TIMEOUT_MS = 5000

function peakTariffAt(time, schedule) {
  if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) return null
  if (['changed', 'unreadable'].includes(schedule?.rule?.status)) return null
  const beijing = new Date(time + 8 * 3600000)
  if (!Number.isFinite(beijing.getTime())) return null
  const day = beijing.getUTCDay(), seconds = beijing.getUTCHours() * 3600 + beijing.getUTCMinutes() * 60 + beijing.getUTCSeconds()
  const windows = schedule?.windows || PEAK_WINDOWS
  if (day === 0 || day === 6 || !windows.some(([start, end]) => seconds >= start * 3600 && seconds < end * 3600)) return 'offPeak'
  const year = beijing.getUTCFullYear(), date = beijing.toISOString().slice(0, 10)
  const fetched = schedule?.holidays?.[year]
  if (fetched?.published && Array.isArray(fetched.off)) return fetched.off.includes(date) ? 'offPeak' : 'peak'
  const ranges = BUILTIN_HOLIDAYS[year]
  if (!ranges) return null
  return ranges.some(([start, end]) => date.slice(5) >= start && date.slice(5) <= end) ? 'offPeak' : 'peak'
}

// Pricing folds require a stable local snapshot: refreshes must not silently
// change already-folded money. No get()/fetch occurs during projection startup.
function peakScheduleSnapshot(data = {}) {
  return JSON.parse(JSON.stringify({ holidays: data.holidays || {}, rule: data.rule || null,
    fetchedAt: data.fetchedAt || null, windows: PEAK_WINDOWS }))
}

function peakPricingSnapshot(data = {}) {
  return { windows: (data.windows || PEAK_WINDOWS).map(window => [...window]),
    rule: data.rule ? { status: data.rule.status } : null,
    holidays: Object.fromEntries(Object.entries(data.holidays || {}).sort(([a], [b]) => Number(a) - Number(b))
      .map(([year, calendar]) => [year, { published: !!calendar.published, off: [...(calendar.off || [])].sort() }])) }
}

function pad(n) { return String(n).padStart(2, '0') }
function normalizeTime(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text)
  if (!m || Number(m[1]) > 24 || Number(m[2]) > 59) return null
  return pad(Number(m[1])) + ':' + m[2]
}

// match: the page still states our rule. changed: the rule sentence exists
// but differs. unreadable: the sentence is gone (page restructured) — also
// worth a look, so the UI treats it like changed.
function checkOfficialRule(html) {
  const text = String(html || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ')
  const m = /北京时间([^。]{0,160}?)为高峰时段([^。]{0,160})/.exec(text)
  if (!m) return { status: 'unreadable', excerpt: null }
  const sentence = (m[0]).trim()
  const windows = []
  const re = /(\d{1,2}:\d{2})\s*[-–~～至]\s*(\d{1,2}:\d{2})/g
  let w
  while ((w = re.exec(m[1])) !== null) {
    const a = normalizeTime(w[1]), b = normalizeTime(w[2])
    if (a && b) windows.push(a + '-' + b)
  }
  const sameWindows = windows.length === EXPECTED_RULE.windows.length && windows.every((x, i) => x === EXPECTED_RULE.windows[i])
  const samePhrases = EXPECTED_RULE.phrases.every(p => sentence.includes(p))
  return { status: sameWindows && samePhrases ? 'match' : 'changed', windows, excerpt: sentence.slice(0, 200) }
}

// Validated holiday-cn year: off days, make-up workdays and names.
// `days: []` means "not published yet", never "no holidays".
function parseHolidayYear(json, year) {
  if (!json || typeof json !== 'object' || Number(json.year) !== year || !Array.isArray(json.days)) return null
  if (!json.days.length) return { year, published: false, off: [], work: [], names: {} }
  const off = [], work = [], names = {}
  for (const day of json.days) {
    if (!day || typeof day.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day.date) || !day.date.startsWith(year + '-')) return null
    if (typeof day.isOffDay !== 'boolean') return null
    ;(day.isOffDay ? off : work).push(day.date)
    if (typeof day.name === 'string' && day.name.length <= 20) names[day.date] = day.name
  }
  // Every real calendar has ~25-30 off days; a short list is a broken file.
  if (off.length < 20) return null
  return { year, published: true, off: off.sort(), work: work.sort(), names }
}

class PeakScheduleSource {
  constructor({ fetch: fetchImpl = globalThis.fetch, now = Date.now, cachePath = null, log = () => {} } = {}) {
    this.fetch = fetchImpl
    this.now = now
    this.cachePath = cachePath
    this.log = log
    this.data = this.readCache()
    this.inflight = null
    this.retryAt = 0
  }

  readCache() {
    const empty = { holidays: {}, rule: null, fetchedAt: 0 }
    if (!this.cachePath || !existsSync(this.cachePath)) return empty
    try {
      const raw = JSON.parse(readFileSync(this.cachePath, 'utf8'))
      if (!raw || typeof raw.fetchedAt !== 'number' || this.now() - raw.fetchedAt > MAX_CACHE_AGE_MS) return empty
      const holidays = {}
      for (const [year, value] of Object.entries(raw.holidays || {})) {
        const parsed = value && value.published === false ? { year: Number(year), published: false, off: [], work: [], names: {} }
          : parseHolidayYear({ year: Number(year), days: (value.off || []).map(date => ({ date, isOffDay: true, name: value.names?.[date] })).concat((value.work || []).map(date => ({ date, isOffDay: false, name: value.names?.[date] }))) }, Number(year))
        if (parsed) holidays[year] = parsed
      }
      const rule = raw.rule && ['match', 'changed', 'unreadable'].includes(raw.rule.status) ? raw.rule : null
      return { holidays, rule, fetchedAt: raw.fetchedAt }
    } catch (_) { return empty }
  }

  writeCache() {
    if (!this.cachePath) return
    const tmp = this.cachePath + '.tmp-' + process.pid
    try {
      writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 })
      renameSync(tmp, this.cachePath)
    } catch (error) {
      try { unlinkSync(tmp) } catch (_) {}
      this.log('peak cache write failed: ' + error.message)
    }
  }

  async getText(url) {
    const response = await this.fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'user-agent': 'dsh-statusline-plus (peak schedule check)' } })
    if (!response.ok) throw new Error('http-' + response.status)
    return response.text()
  }

  async fetchHolidays(year) {
    for (const url of HOLIDAY_URLS) {
      try {
        const parsed = parseHolidayYear(JSON.parse(await this.getText(url(year))), year)
        if (parsed) return parsed
      } catch (_) { /* next mirror */ }
    }
    return null
  }

  async refresh() {
    const year = new Date(this.now() + 8 * 3600000).getUTCFullYear()
    const [current, next, html] = await Promise.all([
      this.fetchHolidays(year), this.fetchHolidays(year + 1),
      this.getText(PRICING_URL).catch(() => null),
    ])
    let changed = false
    for (const parsed of [current, next]) {
      // Never replace a published year with "not published".
      if (parsed && !(parsed.published === false && this.data.holidays[parsed.year]?.published)) {
        this.data.holidays[parsed.year] = parsed; changed = true
      }
    }
    if (html !== null) { this.data.rule = { ...checkOfficialRule(html), checkedAt: this.now() }; changed = true }
    if (!changed) throw new Error('all-sources-failed')
    for (const key of Object.keys(this.data.holidays)) if (Number(key) < year - 1) delete this.data.holidays[key]
    this.data.fetchedAt = this.now()
    this.writeCache()
  }

  // Lazy: refreshes only when asked and stale; concurrent callers share one fetch.
  // The shared refresh ignores any one caller's signal: a closing tab must
  // not cancel it for the others; each fetch has its own timeout.
  async get() {
    const now = this.now()
    if (now - this.data.fetchedAt >= TTL_MS && now >= this.retryAt) {
      if (!this.inflight) {
        this.inflight = this.refresh().catch(error => {
          this.retryAt = this.now() + RETRY_MS
          this.log('peak schedule refresh failed: ' + error.message)
        }).finally(() => { this.inflight = null })
      }
      await this.inflight
    }
    return this.snapshot()
  }

  snapshot() { return peakScheduleSnapshot(this.data) }
  pricingSnapshot() { return peakPricingSnapshot(this.data) }
}

export { PeakScheduleSource, checkOfficialRule, parseHolidayYear, EXPECTED_RULE, PRICING_URL,
  peakTariffAt, peakScheduleSnapshot, peakPricingSnapshot }
