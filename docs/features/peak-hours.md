# DeepSeek peak hours

Shows whether DeepSeek's peak tariff applies now: a header chip with a countdown and a
daily timeline panel, and a dot in the sidebar footer. The header chip appears only for
models billed by DeepSeek (`isDeepseekBilling`).

## Code

| Part | Location |
| --- | --- |
| Status and next switch | `deepseekPeakStatus` in `lib/client.js` |
| Display | `DeepseekPeakChip`, `PeakFooterDot`, `PeakPanel` |
| Calendar and rule check | `PeakScheduleSource` in `lib/peak-schedule.js` |
| Tariff for pricing | `peakTariffAt`, `peakPricingSnapshot` in `lib/peak-schedule.js` |

Settings: `showDeepseekPeak`, `deepseekPeakCountdown`, `showPeakDot`.

## Rule

All times are Beijing time, independent of the browser's timezone. A moment is peak when
it falls on a weekday inside a window in `EXPECTED_RULE` and is not a holiday. Weekends
stay off-peak even when they are make-up workdays: DeepSeek's wording covers every
weekend, so those days only earn a note in the panel.

| Situation | Result |
| --- | --- |
| Weekend, holiday, or outside the windows | Off-peak, in any year |
| Weekday inside a window, calendar known | Peak |
| Weekday inside a window, year not covered | Unknown, never guessed |

## Data sources

1. **Windows** are hard-coded. The official wording is too loose to parse safely.
2. **Calendar**: holiday-cn for this year and next, jsDelivr first because it is reachable
   from mainland China, then GitHub raw. A published fetched year wins. Otherwise the
   built-in 2025-2026 calendar applies.
3. **Official pricing page**: only a change detector. If the rule sentence differs or is
   gone, the indicator warns that rules may have changed next to its official link, and
   the schedule still applies.

The Host fetches lazily when asked and stale (24 h), retries after 1 h on failure, and
caches to `statusline-peak-cache.json` under the DSH home for up to 90 days. The browser
loads once per page and again after 6 h. Any failure falls back to the built-in data.

`days: []` from holiday-cn means "not published yet", never "no holidays". A published
year is never replaced by an unpublished one, and a list with under 20 off days is
treated as a broken file.

## Pitfalls

- **Three copies of the rule.** Windows are in `EXPECTED_RULE`, with `[[9, 12], [14, 18]]`
  as fallbacks in `lib/client.js` and `lib/session-metrics.js`. Holidays are in
  `BUILTIN_HOLIDAYS` (Host) and `PEAK_HOLIDAYS` (browser, with names). Change every copy
  together.
- **A new year needs a calendar.** Add it to both holiday tables once the State Council
  publishes it. Until then, a fetched calendar or "unknown" covers the year.
- **Pricing uses a snapshot.** `apply()` hands `pricingSnapshot()` to the cost projection
  once, so a calendar refresh during a run cannot silently change folded money. See
  [cost](bottom-bar/cost.md#rules).

## Tests

`tests/peak.test.js`, `tests/peak-schedule.test.js`. Peak display has no browser smoke
panel, so check a change to it in a real page.
