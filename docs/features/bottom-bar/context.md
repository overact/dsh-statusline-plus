# Context chip

Shows used and total context tokens. Its panel adds the percentage bar, the remaining
tokens, the session's token split with cache hit rate and request-level cache misses, and
the number of compactions.

## Code

`ContextProjection`, `ContextRow`, `ContextPanel`, `contextUsage` in `lib/client.js`.
Setting: `showContext`.

## Data

The chip reads projections and has no route of its own.

| Projection | Owner | Used for |
| --- | --- | --- |
| `contextPressure` | Host | `projectedTokens`, or `pressureTokens`, and `contextWindow` |
| `tokenUsage` | Host's token meter | Input, cache read, cache write and output split |
| `statuslineMetrics` | This plugin | `compactions`, `session.cacheMisses` |

## Rules

- `tokenUsage` is missing on older Hosts, so each read sits in its own `try` and the panel
  drops only the breakdown. Without valid pressure numbers the chip renders nothing.
- The chip shows counts, not a percentage, because the native ring beside it already shows
  one. The percentage is in the panel. `formatTokens` rounds first and then picks the unit,
  so `999,999` reads `1M` rather than the `1000K` that rounding in the smaller unit would
  produce.
- The percentage column adds up to 100. `largestRemainderPct` gives the leftover
  tenths to the largest fractional parts, so three equal thirds read 33.4 / 33.3 /
  33.3 rather than 33.3 × 3 = 99.9. Rounding each share independently is the classic
  way to print a table of parts that does not match its own total; the bar uses the
  same rounded widths so the drawing and the figures agree.
- Most providers never report cache writes, so that row appears only when it has tokens.
- **Cache misses are requests, not tokens.** A miss is one settled request with prompt
  input and no cache read, shown after the `Cache read` label as `(N misses)`, and only
  when the count is above zero. It uses the same session-only scope as cost, so
  fork-inherited history is excluded. A provider that never reports cache fields makes
  every request count as a miss; the number is a reading, never an inferred reason. A
  corrected settlement replaces the earlier miss instead of adding another.
- A failed compaction does not count: `compaction/end` with an error is ignored.

## Tests

`tests/client-lifecycle.test.js` (including the largest-remainder rule),
`tests/session-metrics.test.js`, and the `context-split` check in
`scripts/verify-ui.mjs`, which opens the real panel and asserts the column totals 100.
