# Cost estimate

Shows an estimate of this session's cost at the model vendor's public API prices. Its panel
breaks it down into input, cache and output, with an hourly average and coverage notes.

**It is a reference, not a bill.** Subscriptions and gateways use the same reference prices,
and the view states `billingVerified: false`. Keep that framing in any wording.

## Code

`createSessionMetricsProjection`, `quoteUsage`, `possibleTariffs` in
`lib/session-metrics.js`; `loadPricingCatalog`, `pricingModelId`, `quoteCatalogUsage` and
`FALLBACK` in `lib/model-pricing.js`; `CostRow`, `estimateCost`, `costPerHour`,
`costReasons`, `costBreakdownTables` in `lib/client.js`. Setting: `showCost`.

## How a price is chosen

The model ID after the final `/` selects the card, whatever the route provider, gateway
prefix or display name.

1. The pi-ai catalog, when it knows the model.
2. `FALLBACK` for models pi-ai lacks. This is an offline table, never an online query.
3. `RATES` for DeepSeek, by peak and off-peak tariff, in CNY.

An unrecognized model stays unpriced.

## Scope

Only this session's own requests count: no child sessions, no inherited fork history
(`event.seq < inheritedEventCount`) and no extra fees.

## Rules

- **Money is integers.** Amounts are stored in 1e-8 units, so no floating-point error
  accumulates in the fold. USD and CNY stay separate and are never converted.
- **Peak ranges.** A request that may span a tariff switch is quoted across every tariff
  between its start and its first stream record, so the result can be a range. Timing comes
  from `step/start` or `llm/retry-started`. No generated content is inspected.
- **Unknown stays unknown.** Each unpriced message records a reason, and the panel lists
  them. A reason added to `quoteUsage` also needs a label in `costReasons`.
- **No cache-write guess.** The DeepSeek card has no cache-creation rate, so a request with
  cache writes stays unpriced rather than being priced as a read.
- **Coverage start.** `RATES` applies from `PRICING_AS_OF`, a verified snapshot date rather
  than a historical effective date. Earlier requests read `historical-price-unknown`.
- **Stable calendar.** The fold uses the peak snapshot taken at `apply()`, so a refresh
  during a run cannot change money already folded. A different snapshot at the next load
  changes `stateVersion`, and sessions refold once. See [peak hours](../peak-hours.md).
- **Short spans.** The hourly average needs at least 5 minutes of request span, because
  shorter ones swing too much.

## When prices change

`stateVersion` is a hash of a hand-written number, the catalog revision and the peak
snapshot, so new catalog or calendar data refolds by itself. The hash does not see `RATES`,
`FALLBACK` or the fold's code. After changing those, raise the hand-written number in
`createSessionMetricsProjection` and say why in its comment, or native checkpoints keep the
old semantics.

Update the as-of date with the table. `viewSchema` pins `PRICING_AS_OF`, and the preview
sample in `LayoutPreview` carries the date too.

## Tests

`npm run verify -- --files lib/session-metrics.js --ui cost`.
`tests/session-metrics.test.js`, `tests/model-pricing.test.js`,
`tests/dsh-integration.test.js`.
