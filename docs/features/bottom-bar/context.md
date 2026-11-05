# Context chip

Shows used and total context tokens. Its panel adds the percentage bar, the remaining
tokens, the session's token split with cache hit rate, and the number of compactions.

## Code

`ContextProjection`, `ContextRow`, `ContextPanel`, `contextUsage` in `lib/client.js`.
Setting: `showContext`.

## Data

The chip reads projections and has no route of its own.

| Projection | Owner | Used for |
| --- | --- | --- |
| `contextPressure` | Host | `projectedTokens`, or `pressureTokens`, and `contextWindow` |
| `tokenUsage` | Host's token meter | Input, cache read, cache write and output split |
| `statuslineMetrics` | This plugin | `compactions` |

## Rules

- `tokenUsage` is missing on older Hosts, so each read sits in its own `try` and the panel
  drops only the breakdown. Without valid pressure numbers the chip renders nothing.
- The chip shows counts, not a percentage, because the native ring beside it already shows
  one. The percentage is in the panel.
- Most providers never report cache writes, so that row appears only when it has tokens.
- A failed compaction does not count: `compaction/end` with an error is ignored.

## Tests

`tests/client-lifecycle.test.js`, `tests/session-metrics.test.js`. There is no dedicated
browser smoke panel, so check a panel change in a real page.
