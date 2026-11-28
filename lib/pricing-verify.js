'use strict'
// Official rate verification, Host side.
//
// The peak/off-peak *rule* has its own detector in peak-schedule.js, which reads
// wording. Wording is not money: a price cut, a changed discount, or a new model
// row leaves the sentence intact and the estimate silently wrong. This module
// reads the numbers out of the same page the rule check already fetched, and
// compares them to the built-in card.
//
// It never writes the card. A scraped page is an observation, not authority:
// the result is a status the UI can report ("the official table disagrees with
// the built-in one; check it"), and promoting a number stays a human edit. That
// is deliberate — a positional parser on a marketing page is exactly the thing
// that broke a comparable plugin, which then served a 2.5x-too-high table for
// months without noticing.

// One page cell is 元 per 1M tokens. The built-in card stores 1e-8 CNY per
// token, so a page value times 100 is the card's unit.
const YUAN_TO_CARD = 100
// A leg that moves by more than this is worth reporting; below it, rounding.
const REPORT_EPSILON = 0.005
// A leg outside this band is not "a price change", it is a parse that went
// wrong — a decimal point lost, a column misread. Reject the reading entirely.
const PLAUSIBLE_RATIO = [0.2, 5]

const LEG_KEYS = ['hit', 'miss', 'out']
const ROW_LABELS = [['缓存未命中', 'miss'], ['缓存命中', 'hit'], ['输出', 'out']]
const WINDOW_LABELS = [['空闲时段', 'offPeak'], ['高峰时段', 'peak']]

function cellTexts(row) {
  const cells = []
  const re = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi
  let match
  while ((match = re.exec(row)) !== null) {
    const text = match[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
    cells.push(text)
  }
  return cells
}

function yuanValue(text) {
  const m = /^(\d+(?:\.\d+)?)\s*元$/.exec(String(text || '').trim())
  return m ? Number(m[1]) : null
}

function modelOrder(html) {
  // The header row names the models and the price rows list them in the same
  // order, then every price row ends with one 元 cell per model. Header and price
  // rows carry different leading cells (the leg label only exists in price
  // rows), so the only stable position is from the end.
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
  let match
  while ((match = rowRe.exec(html)) !== null) {
    const cells = cellTexts(match[1])
    const names = cells.filter(text => /deepseek/i.test(text))
    if (names.length < 2) continue
    const flash = names.findIndex(text => /flash/i.test(text))
    const pro = names.findIndex(text => /pro/i.test(text))
    if (flash === -1 || pro === -1 || flash === pro) continue
    return flash < pro ? ['flash', 'pro'] : ['pro', 'flash']
  }
  return null
}

// Which leg a row describes. The label cell carries a rowspan, so the second row
// of a pair has no label of its own: the caller keeps the last one it saw.
function labelLeg(cells) {
  for (const [needle, leg] of ROW_LABELS) {
    if (cells.some(text => text.indexOf(needle) !== -1)) return leg
  }
  return null
}

function windowOf(cells) {
  for (const [needle, window] of WINDOW_LABELS) {
    if (cells.some(text => text === needle)) return window
  }
  return null
}

function discountOf(text) {
  const m = /空闲时段价格为高峰时段价格的([^。；]{1,8})/.exec(text)
  if (!m) return null
  const phrase = m[1].replace(/\s/g, '')
  if (phrase === '一半' || phrase === '二分之一' || phrase === '50%' || phrase === '5折') return 0.5
  const percent = /^(\d+(?:\.\d+)?)%$/.exec(phrase)
  if (percent) return Number(percent[1]) / 100
  const tenth = /^(\d+(?:\.\d+)?)折$/.exec(phrase)
  if (tenth) return Number(tenth[1]) / 10
  if (phrase === '四成') return 0.4
  if (phrase === '三成') return 0.3
  const cheng = /^(\d)成$/.exec(phrase)
  return cheng ? Number(cheng[1]) / 10 : null
}

// { rates: { flash: { peak: {hit,miss,out}, offPeak: {…} }, pro: {…} }, discount }
// or null when the page is not shaped like a rate table any more.
function parseOfficialRates(html) {
  const source = String(html || '')
  if (!source) return null
  const order = modelOrder(source) || ['flash', 'pro']
  const table = { flash: { peak: {}, offPeak: {} }, pro: { peak: {}, offPeak: {} } }
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
  let match, carry = null, rows = 0
  while ((match = rowRe.exec(source)) !== null) {
    const cells = cellTexts(match[1])
    const window = windowOf(cells)
    if (!window) continue
    // The leg label carries a rowspan, so the second row of a pair has none.
    const leg = labelLeg(cells) || carry
    if (!leg) continue
    const prices = cells.filter(text => /元$/.test(text)).map(yuanValue)
    if (prices.length !== 2 || prices.some(value => value === null)) continue
    carry = leg
    table[order[0]][window][leg] = prices[0]
    table[order[1]][window][leg] = prices[1]
    rows++
  }
  if (rows < 6) return null
  for (const model of ['flash', 'pro']) {
    for (const window of ['peak', 'offPeak']) {
      for (const leg of LEG_KEYS) {
        const value = table[model][window][leg]
        if (typeof value !== 'number' || !Number.isFinite(value)) return null
      }
    }
  }
  const text = source.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ')
  return { rates: table, discount: discountOf(text) }
}

function sameLeg(a, b) {
  if (a === b) return true
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-9)
  return Math.abs(a - b) / scale <= REPORT_EPSILON
}

// Compare the page against the card we price with. `expected` is in the card's
// unit (1e-8 CNY per token); omit it to only validate the page against itself.
function verifyOfficialRates(html, expected) {
  const parsed = parseOfficialRates(html)
  if (!parsed) return { status: 'unreadable', changes: [], discount: null, checkedAt: null }
  const { rates, discount } = parsed
  // Structural sanity, independent of our card: the page's own arithmetic.
  for (const model of ['flash', 'pro']) {
    for (const window of ['peak', 'offPeak']) {
      const row = rates[model][window]
      if (!(row.hit > 0) || !(row.miss > 0) || !(row.out > 0)) {
        return { status: 'implausible', changes: [], discount, reason: 'non-positive-cell' }
      }
      if (row.hit >= row.miss) return { status: 'implausible', changes: [], discount, reason: 'hit-not-below-miss' }
    }
    // Every off-peak leg is stated as half the peak leg; if that stops holding,
    // either the discount moved or a row was misread. Either way: do not trust it.
    for (const leg of LEG_KEYS) {
      if (Math.abs(rates[model].offPeak[leg] * 2 - rates[model].peak[leg]) > 1e-9) {
        return { status: 'implausible', changes: [], discount, reason: 'half-rule-broken' }
      }
    }
  }
  if (discount !== null && Math.abs(discount - 0.5) > 1e-9) {
    return { status: 'changed', changes: [{ what: 'discount', from: 0.5, to: discount }], discount }
  }
  if (!expected) return { status: 'match', changes: [], discount, rates }
  const changes = []
  for (const model of Object.keys(expected)) {
    const modelKey = /flash/i.test(model) ? 'flash' : 'pro'
    for (const window of ['peak', 'offPeak']) {
      for (const leg of LEG_KEYS) {
        const ours = expected[model] && expected[model][window] && expected[model][window][leg === 'hit' ? 'read' : leg === 'miss' ? 'input' : 'output']
        if (typeof ours !== 'number' || !(ours > 0)) continue
        const theirs = rates[modelKey][window][leg]
        const ratio = theirs / (ours / YUAN_TO_CARD)
        if (!(ratio >= PLAUSIBLE_RATIO[0] && ratio <= PLAUSIBLE_RATIO[1])) {
          return { status: 'implausible', changes: [], discount, reason: 'ratio-out-of-band' }
        }
        const oursYuan = ours / YUAN_TO_CARD
        if (!sameLeg(theirs, oursYuan)) changes.push({ what: model + '.' + window + '.' + leg, from: oursYuan, to: theirs })
      }
    }
  }
  return { status: changes.length ? 'changed' : 'match', changes, discount, rates }
}

export { parseOfficialRates, verifyOfficialRates, YUAN_TO_CARD, PLAUSIBLE_RATIO, REPORT_EPSILON }
