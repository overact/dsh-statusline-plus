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
   built-in 2025-2027 calendar applies, present in both halves: `PEAK_HOLIDAYS` /
   `PEAK_MAKEUP_DAYS` in the browser and `BUILTIN_HOLIDAYS` in the host, because a request
   is priced at its own instant and must still get a tariff with no network.
3. **Official pricing page**: only a change detector. If the rule sentence differs or is
   gone, the indicator warns that rules may have changed next to its official link, and
   the schedule still applies.

The Host fetches lazily when asked and stale (24 h), retries after 1 h on failure, and
caches to `statusline-peak-cache.json` under the DSH home for up to 90 days. The browser
loads once per page and again after 6 h. Any failure falls back to the built-in data.

`days: []` from holiday-cn means "not published yet", never "no holidays". A published
year is never replaced by an unpublished one, and a list with under 20 off days is
treated as a broken file.

The built-in floor is extended once the State Council publishes a year — not before, since
an invented holiday would become a wrong tariff for every request in it. Adding a year
means three edits (host ranges, browser ranges with names, make-up days) and moving the
tests that assert an *uncovered* year to one further out; they exist precisely so this
extension cannot silently turn "unknown" into a confident wrong answer.

## Pitfalls

- **Three copies of the rule.** Windows are in `EXPECTED_RULE`, with `[[9, 12], [14, 18]]`
  as fallbacks in `lib/client.js` and `lib/session-metrics.js`. Holidays are in
  `BUILTIN_HOLIDAYS` (Host) and `PEAK_HOLIDAYS` (browser, with names). Change every copy
  together.
- **A new year needs a calendar.** Add it to both holiday tables once the State Council
  publishes it. Until then, a fetched calendar or "unknown" covers the year.
- **Panel width.** The details panel is a reading column capped at 380px. The base
  `.slp-panel` rule sets a viewport-wide `max-width` later in the sheet, so the panel
  rule needs `.slp-panel.slp-peak-panel` to win; otherwise the long rule sentence runs
  on one line across the window (issue #2). The compact footer popover keeps its own
  240px cap.
- **Pricing uses a snapshot.** `apply()` hands `pricingSnapshot()` to the cost projection
  once, so a calendar refresh during a run cannot silently change folded money. See
  [cost](bottom-bar/cost.md#rules).

## The numbers, not only the wording

`checkOfficialRule` reads the *sentence*: if the peak windows or the discounted-period
phrasing change, it says so. It cannot see money. A price cut, a new model row or a
changed discount leaves that sentence untouched, so an estimate would keep using the old
numbers indefinitely.

`lib/pricing-verify.js` reads the same page — the one already fetched for the rule check,
so this costs no extra request — in the page's own terms (元 per million tokens):

- Columns are mapped by **model name** from the header row, not by position. A reordered
  page is not a price change.
- The page is validated against itself first: every cell positive, cache-hit below
  cache-miss, and every off-peak leg exactly half its peak leg. A page that fails this is
  reported as unreadable, never as a cheap model.
- Only then is it compared to the card we price with. A leg that moves beyond 0.5 % is
  reported with its path and both numbers; a leg outside 0.2×–5× is treated as a parse
  fault and the reading is dropped.
- A changed discount is reported as its own change, even when every leg still halves.

The card is **never written from the page**. The alert names the difference and asks a
human to check; promoting a scraped number automatically is how a comparable plugin
served a 2.5×-too-high table for months after the page was restructured.

`rule.checkedAt` is also rendered: a card nobody has checked for a week says so, which
is the only way to notice that the fetches have been failing.

Tests: `tests/pricing-verify.test.js` (fixture: a trimmed copy of the real page),
`tests/peak-schedule.test.js`.

## Tests

`tests/peak.test.js`, `tests/peak-schedule.test.js`. Peak display has no browser smoke
panel, so check a change to it in a real page.
