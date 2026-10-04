'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const vm = require('node:vm')
const { peakTariffAt, PeakScheduleSource } = require('../lib/peak-schedule')

function loadPeakHelpers() {
  let exported
  const React = { createElement() {} }
  const source = readFileSync(require.resolve('../lib/client.js'), 'utf8')
    .replace('return module.exports', 'return { deepseekPeakStatus, peakCountdown, isDeepseekBilling }')
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(spec) { exported = spec.factory(() => React) } } },
    console,
  })
  return exported
}

const helpers = loadPeakHelpers()
const beijing = time => Date.parse(time + '+08:00')
const status = time => JSON.parse(JSON.stringify(helpers.deepseekPeakStatus(beijing(time))))

test('pricing and peak indicator agree on the same cached windows, holidays and unknown years', () => {
  const source = new PeakScheduleSource({ fetch() { throw new Error('no extra schedule query') } })
  source.data.holidays[2027] = { published: true, off: ['2027-02-10'], work: ['2027-02-27'], names: {} }
  for (const schedule of [undefined, source.snapshot()]) {
    for (const date of ['2025-01-01', '2026-10-02', '2026-10-08', '2026-10-10', '2027-02-10', '2027-02-11', '2027-02-27']) {
      for (const clock of ['08:59:59', '09:00:00', '11:59:59', '12:00:00', '14:00:00', '18:00:00']) {
        const time = beijing(date + 'T' + clock), displayed = helpers.deepseekPeakStatus(time, schedule)
        assert.equal(peakTariffAt(time, schedule), displayed.isPeak === null ? null : displayed.isPeak ? 'peak' : 'offPeak')
      }
    }
  }
})

test('DeepSeek peak windows include their starts and exclude their ends at second precision', () => {
  for (const [time, isPeak, nextTime] of [
    ['08:59:59', false, '09:00:00'],
    ['09:00:00', true, '12:00:00'],
    ['11:59:59', true, '12:00:00'],
    ['12:00:00', false, '14:00:00'],
    ['13:59:59', false, '14:00:00'],
    ['14:00:00', true, '18:00:00'],
    ['17:59:59', true, '18:00:00'],
  ]) {
    const now = beijing('2026-08-19T' + time)
    const next = beijing('2026-08-19T' + nextTime)
    const result = status('2026-08-19T' + time)
    assert.equal(result.isPeak, isPeak, time)
    assert.equal(result.calendarKnown, true)
    assert.equal(result.holiday, null)
    assert.equal(result.now, now)
    assert.equal(result.nextSwitchAt, next, time)
    assert.equal(result.remainingSec, (next - now) / 1000, time)
    assert.deepEqual(result.windows, [[9, 12], [14, 18]])
  }
  const evening = status('2026-08-19T18:00:00')
  assert.equal(evening.isPeak, false)
  assert.equal(evening.nextSwitchAt, beijing('2026-08-20T09:00:00'))
  assert.equal(evening.remainingSec, 15 * 3600)
})

test('Friday evening and weekend clocks skip to Monday morning', () => {
  const monday = beijing('2026-08-24T09:00:00')
  for (const time of ['2026-08-21T18:30:00', '2026-08-22T10:00:00', '2026-08-23T23:59:59']) {
    const result = status(time)
    assert.equal(result.isPeak, false)
    assert.equal(result.calendarKnown, true)
    assert.equal(result.nextSwitchAt, monday)
    assert.equal(result.remainingSec, (monday - beijing(time)) / 1000)
    if (!time.startsWith('2026-08-21')) assert.deepEqual(result.windows, [])
  }
})

test('National Day holiday blocks peak windows through the complete published vacation range', () => {
  const result = status('2026-10-02T10:30:00')
  assert.equal(result.isPeak, false)
  assert.equal(result.calendarKnown, true)
  assert.equal(result.holiday, '国庆节')
  assert.deepEqual(result.windows, [])
  assert.equal(result.nextSwitchAt, beijing('2026-10-08T09:00:00'))
  assert.equal(result.remainingSec, 142.5 * 3600)
  assert.equal(status('2026-10-08T09:00:00').isPeak, true)
})

test('Weekend make-up workdays remain off-peak instead of becoming business-day peak windows', () => {
  const result = status('2026-10-10T15:00:00')
  assert.equal(result.isPeak, false)
  assert.equal(result.calendarKnown, true)
  assert.equal(result.holiday, null)
  assert.deepEqual(result.windows, [])
  assert.equal(result.nextSwitchAt, beijing('2026-10-12T09:00:00'))
  assert.equal(result.remainingSec, 42 * 3600)
})

test('Both maintained calendars suppress weekday public holidays, including the long Spring Festival break', () => {
  for (const [time, nextTime, holiday] of [
    ['2025-01-01T10:00:00', '2025-01-02T09:00:00', '元旦'],
    ['2025-10-06T15:00:00', '2025-10-09T09:00:00', '国庆节 / 中秋节'],
    ['2026-02-16T10:00:00', '2026-02-24T09:00:00', '春节'],
    ['2026-09-25T15:00:00', '2026-09-28T09:00:00', '中秋节'],
  ]) {
    const result = status(time)
    assert.equal(result.calendarKnown, true)
    assert.equal(result.isPeak, false, time)
    assert.equal(result.holiday, holiday)
    assert.deepEqual(result.windows, [])
    assert.equal(result.nextSwitchAt, beijing(nextTime), time)
  }
})

test('Unknown calendar years never certify a weekday peak or fabricate its next transition', () => {
  for (const [time, expected] of [
    ['2027-01-01T08:59:59', false],
    ['2027-01-01T09:00:00', null],
    ['2027-01-01T11:59:59', null],
    ['2027-01-01T12:00:00', false],
    ['2027-01-01T14:00:00', null],
    ['2027-01-01T18:00:00', false],
    ['2027-01-02T10:00:00', false],
  ]) {
    const result = status(time)
    assert.equal(result.isPeak, expected, time)
    assert.equal(result.calendarKnown, false)
    assert.equal(result.nextSwitchAt, null)
    assert.equal(result.remainingSec, null)
  }
})

test('A known year does not manufacture a countdown across an uncovered year boundary', () => {
  const peak = status('2026-12-31T17:00:00')
  assert.equal(peak.isPeak, true)
  assert.equal(peak.nextSwitchAt, beijing('2026-12-31T18:00:00'))
  assert.equal(peak.remainingSec, 3600)
  const offPeak = status('2026-12-31T18:00:00')
  assert.equal(offPeak.calendarKnown, true)
  assert.equal(offPeak.isPeak, false)
  assert.equal(offPeak.nextSwitchAt, null)
  assert.equal(offPeak.remainingSec, null)
})

test('The final fraction of a second before a transition still shows one second remaining', () => {
  for (const [time, isPeak, nextTime] of [
    ['08:59:59.900', false, '09:00:00'],
    ['11:59:59.999', true, '12:00:00'],
    ['13:59:59.900', false, '14:00:00'],
    ['17:59:59.999', true, '18:00:00'],
  ]) {
    const result = status('2026-08-19T' + time)
    assert.equal(result.isPeak, isPeak)
    assert.equal(result.nextSwitchAt, beijing('2026-08-19T' + nextTime))
    assert.equal(result.remainingSec, 1)
  }
})

test('The Beijing date, clock and daily progress use UTC+8 independently of the host timezone', () => {
  const original = process.env.TZ
  try {
    let expected
    for (const timezone of ['UTC', 'America/New_York', 'Australia/Sydney']) {
      process.env.TZ = timezone
      const result = status('2026-08-20T00:30:00')
      assert.equal(result.beijingDate, '2026-08-20')
      assert.equal(result.beijingTime, '00:30:00')
      assert.equal(result.isPeak, false)
      assert.equal(result.nextSwitchAt, beijing('2026-08-20T09:00:00'))
      assert.ok(Math.abs(result.dayProgressPercent - 100 * 1800 / 86400) < 0.001)
      if (expected) assert.deepEqual(result, expected)
      expected = result
    }
  } finally {
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
  }
  assert.equal(status('2026-08-19T00:00:00').dayProgressPercent, 0)
  assert.equal(status('2026-08-19T12:00:00').dayProgressPercent, 50)
})

test('Invalid clocks stay unknown and cannot produce a usable countdown', () => {
  for (const now of [NaN, Infinity, -Infinity]) {
    const result = helpers.deepseekPeakStatus(now)
    assert.equal(result.isPeak, null)
    assert.equal(result.calendarKnown, false)
    assert.equal(result.nextSwitchAt, null)
    assert.equal(result.remainingSec, null)
  }
})

test('Peak billing detection accepts only the exact official provider, regardless of model name', () => {
  for (const provider of ['deepseek', 'deepseek-official', 'DEEPSEEK', 'DeepSeek-Official']) {
    assert.equal(helpers.isDeepseekBilling({ provider, model: 'anything' }), true)
  }
  for (const model of [
    null, {}, { model: 'deepseek-flash' },
    { provider: 'openrouter', model: 'deepseek/deepseek-v4-pro' },
    { provider: 'reseller-deepseek', model: 'deepseek-flash' },
    { provider: 'deepseek-custom' }, { provider: 'api.deepseek.com' },
    { provider: 'deepseek-official-backup' }, { provider: ' deepseek' },
  ]) assert.equal(helpers.isDeepseekBilling(model), false)
})

test('Peak countdown remains readable for seconds, hours and multi-day holiday waits', () => {
  for (const [seconds, expected] of [
    [0, '00:00:00'], [59, '00:00:59'], [60, '00:01:00'],
    [3600, '01:00:00'], [86399, '23:59:59'],
    [86400, '1d 00:00:00'], [2 * 86400 + 3600 + 2 * 60 + 3, '2d 01:02:03'],
  ]) assert.equal(helpers.peakCountdown(seconds), expected)
  for (const invalid of [NaN, Infinity, -1, null, '60']) assert.equal(helpers.peakCountdown(invalid), '—')
})
