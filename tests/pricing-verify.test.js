'use strict'
// The official rate page read numerically. The fixture is a trimmed copy of the
// real page (see tests/fixtures/deepseek-pricing.html); every case below is a
// transformation of it, so the parser is exercised against real markup rather
// than a shape invented by this file.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { parseOfficialRates, verifyOfficialRates } = require('../lib/pricing-verify.js')
const { RATES } = require('../lib/session-metrics.js')

const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'deepseek-pricing.html'), 'utf8')

test('the built-in card and the official page agree today', () => {
  const parsed = parseOfficialRates(fixture)
  assert.ok(parsed, 'the page was not recognised as a rate table')
  // 元 per million tokens, as the page states them.
  assert.deepEqual(parsed.rates.flash.peak, { hit: 0.04, miss: 2, out: 8 })
  assert.deepEqual(parsed.rates.flash.offPeak, { hit: 0.02, miss: 1, out: 4 })
  assert.deepEqual(parsed.rates.pro.peak, { hit: 0.3, miss: 9, out: 27 })
  assert.deepEqual(parsed.rates.pro.offPeak, { hit: 0.15, miss: 4.5, out: 13.5 })
  assert.equal(parsed.discount, 0.5)
  const result = verifyOfficialRates(fixture, RATES)
  assert.equal(result.status, 'match', 'the card must match the page exactly: ' + JSON.stringify(result.changes))
  assert.deepEqual(result.changes, [])
})

test('a price cut the wording cannot see is reported, not absorbed', () => {
  // The failure this exists for: the rule sentence is unchanged, the numbers moved.
  const cut = fixture.replace('<td>8元</td>', '<td>4元</td>')
  assert.ok(cut !== fixture)
  const result = verifyOfficialRates(cut, RATES)
  assert.equal(result.status, 'implausible', 'halving one leg alone breaks the page\'s own half-price rule')
  // A cut across both legs keeps the page self-consistent and is a real change.
  const both = fixture.replace('<td>空闲时段</td><td>0.02元</td>', '<td>空闲时段</td><td>0.01元</td>')
    .replace('<td>高峰时段</td><td>0.04元</td>', '<td>高峰时段</td><td>0.02元</td>')
  const changed = verifyOfficialRates(both, RATES)
  assert.equal(changed.status, 'changed')
  assert.equal(changed.changes.length, 2, 'one entry per moved leg: ' + JSON.stringify(changed.changes))
  assert.deepEqual(changed.changes.map(change => change.what).sort(), ['deepseek-flash.offPeak.hit', 'deepseek-flash.peak.hit'])
  assert.equal(changed.changes[0].from, 0.04)
})

test('a changed discount is caught even when every leg still halves', () => {
  const text = fixture.replace('为高峰时段价格的一半', '为高峰时段价格的四成')
  assert.ok(text !== fixture)
  const result = verifyOfficialRates(text, RATES)
  assert.equal(result.status, 'changed')
  assert.deepEqual(result.changes, [{ what: 'discount', from: 0.5, to: 0.4 }])
})

test('columns are mapped by model name, so a reordered page is not a price change', () => {
  const swapped = fixture
    .replace('<td>deepseek-flash<sup>(1)</sup></td><td>deepseek-v4-pro</td>', '<td>deepseek-v4-pro</td><td>deepseek-flash<sup>(1)</sup></td>')
    .replace(/<td>空闲时段<\/td><td>([\d.]+)元<\/td><td>([\d.]+)元<\/td>/g, '<td>空闲时段</td><td>$2元</td><td>$1元</td>')
    .replace(/<td>高峰时段<\/td><td>([\d.]+)元<\/td><td>([\d.]+)元<\/td>/g, '<td>高峰时段</td><td>$2元</td><td>$1元</td>')
  const result = verifyOfficialRates(swapped, RATES)
  assert.equal(result.status, 'match', 'a swapped header and body must still read as the same table')
})

test('a page that is no longer a rate table is unreadable, never a guess', () => {
  assert.equal(parseOfficialRates(''), null)
  assert.equal(parseOfficialRates('<html><body>maintenance</body></html>'), null)
  const stripped = fixture.replace(/元/g, ' per M')
  assert.equal(verifyOfficialRates(stripped, RATES).status, 'unreadable')
  // One missing row is not "a cheap model", it is an incomplete table.
  const short = fixture.replace('<tr><td>高峰时段</td><td>8元</td><td>27.0元</td></tr>', '')
  assert.equal(verifyOfficialRates(short, RATES).status, 'unreadable')
})

test('the page is validated against itself before it is compared to our card', () => {
  // Cache read above cache miss cannot be a real table.
  const crossed = fixture.replace('<td>空闲时段</td><td>0.02元</td><td>0.15元</td>', '<td>空闲时段</td><td>9元</td><td>0.15元</td>')
    .replace('<td>高峰时段</td><td>0.04元</td><td>0.30元</td>', '<td>高峰时段</td><td>18元</td><td>0.30元</td>')
  const result = verifyOfficialRates(crossed, RATES)
  assert.equal(result.status, 'implausible')
  assert.equal(result.reason, 'hit-not-below-miss')
  // A decimal point lost: 8 becomes 800, a 100x move. Report nothing, trust nothing.
  const shifted = fixture.replace('<td>8元</td>', '<td>800元</td>').replace('<td>4元</td>', '<td>400元</td>')
  assert.equal(verifyOfficialRates(shifted, RATES).status, 'implausible')
  assert.equal(verifyOfficialRates(shifted, RATES).reason, 'ratio-out-of-band')
})

test('without a card to compare against, the page is still checked for sanity', () => {
  const parsed = parseOfficialRates(fixture)
  assert.equal(verifyOfficialRates(fixture, null).status, 'match')
  assert.deepEqual(verifyOfficialRates(fixture, null).rates, parsed.rates)
})
