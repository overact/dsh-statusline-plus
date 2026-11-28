# Cost estimate

Shows an estimate of this session's cost at the model vendor's public API prices, with an
OpenRouter reference for models the vendor does not price. Its panel breaks it down into
input, cache and output, with an hourly average and coverage notes.

**It is a reference, not a bill.** Subscriptions, gateways and local deployments use the
same reference prices, and the view states `billingVerified: false`. Keep that framing in
any wording.

## Code

`createSessionMetricsProjection`, `quoteUsage` in
`lib/session-metrics.js`; `loadPricingCatalog`, `pricingModelId`, `pricingModelIdentity`,
`pricingModelAlias`, `quoteCatalogUsage`, `FALLBACK` and `REFERENCE_PROVIDER` in
`lib/model-pricing.js`; `CostRow`, `estimateCost`,
`costPerHour`, `costReasons`, `costBreakdownTables` in `lib/client.js`. Setting: `showCost`.

## How a price is chosen

The model identity selects the card, whatever the route provider, gateway prefix or display
name. Two catalogs are indexed by identity:

- **official** — the eight vendor namespaces in `OFFICIAL_PROVIDERS`. A vendor namespace is
  trusted for its own models only: a model whose vendor is known and different (Mistral
  listing GLM or DeepSeek, Bedrock listing Claude) is skipped, because that card is a channel
  price.
- **openrouter** — a resale reference for models without a first-party card.

Every other pi-ai namespace (cloud marketplaces, coding plans, token plans) is a channel
price and is never indexed.

Resolution order:

1. Official card, when the vendor prices the model.
2. `openrouter` reference, when the vendor publishes no card for it.
3. `FALLBACK` for models both catalogs lack. An offline table, never an online query; each
   entry records `kind` (`official` or `reference`), `asOf` and `url`.
4. `RATES` for DeepSeek, by peak and off-peak tariff, in CNY.

An unrecognized model stays unpriced. When the vendor lists the model with an all-zero
placeholder, the answer is unknown, not a resale price: a vendor listing without a price is
still a verdict.

`pricingModelIdentity` only does mechanical cleanup: the route prefix after the final `/`,
Bedrock's `<region>.<vendor>.` prefix and `-v1:0` revision suffix, `_`/`:` separators and the
fireworks `v4p1` spelling. It never drops a trailing qualifier, so `:batch` keeps its own
identity and a non-DeepSeek variant is priced only by its own card; the explicit DeepSeek
family rule below is the one place that folds qualifiers.

`MODEL_ALIASES` keeps the verified non-DeepSeek aliases, and `pricingModelAlias` folds
DeepSeek's plan and snapshot spellings to the vendor card: `deepseek-v4.1-flash`,
`deepseek-v4-1-flash-1017`, `deepseek-v4p1-flash`, `deepseek-v4.1-flash-sg`,
`deepseek-flash-latest` and a later `deepseek-v4.2-flash`/`deepseek-v5-flash` all use
`deepseek-flash`; `deepseek-v4-pro`, `deepseek-v4.1-pro` and `deepseek-pro-latest` use
`deepseek-v4-pro`. Every DeepSeek trailing qualifier is ignored, including tiers such as
`-fast`, `-spot`, `-free`, `:batch`, `-vision` and `-exp`; those can cost 2x or 0.7x, so the
result stays a reference estimate rather than a bill.

The version stays in the identity. V4 Flash (no minor) is the previous generation at a lower
price, so the version gate keeps it out of the V4.1 Flash card; it is not collapsed into
`deepseek-flash`, and therefore still reaches its own V4 card in the reference catalog.

Local and self-hosted routes are not special-cased: the model identity decides the price, so
a `llamacpp/...` route is estimated the same way and marked with the source it used.

## Scope

Only this session's own requests count: no child sessions, no inherited fork history
(`event.seq < inheritedEventCount`) and no extra fees.

## Rules

- **Money is integers.** Amounts are stored in 1e-8 units, so no floating-point error
  accumulates in the fold. USD and CNY stay separate and are never converted.
- **Billing instant.** The first compact stream record fixes the tariff for the whole
  request: a request dispatched just before a peak/off-peak switch and answered after it is
  priced at the tariff in effect when the stream starts, so one request always gets one
  amount. Quotes, totals and the view therefore carry a single amount per currency
  (`units`, `cnyUnits`/`usdUnits`, `amountCny`/`amountUsd`); there is no min/max range.
  The hourly span still starts at `step/start` or `llm/retry-started`. No generated
  content is inspected.
- **Unknown stays unknown.** Each unpriced message records a reason, and the panel lists
  them. A reason added to `quoteUsage` also needs a label in `costReasons`. A vendor
  namespace that lists a model with an all-zero placeholder counts as unknown, not as
  permission to use a resale card.
- **One ladder, labelled.** Every quote names its `source` (`official`, `openrouter`,
  `fallback`, `fallback-reference`) and its `vendor` (the model owner, not the channel), the
  fold counts both separately, and the panel's priced count lists the vendors in parentheses
  while the ⓘ details keep the per-source lines. Amounts from different sources are never
  merged into one "official" figure.
- **No cache-write guess.** The DeepSeek card has no cache-creation rate, so a request with
  cache writes stays unpriced rather than being priced as a read.
- **Coverage start.** `RATES` applies from `PRICING_AS_OF`, a verified snapshot date rather
  than a historical effective date. A request whose first stream record predates it reads
  `historical-price-unknown`.
- **Stable calendar.** The fold uses the peak snapshot taken at `apply()`, so a refresh
  during a run cannot change money already folded. A different snapshot at the next load
  changes `stateVersion`, and sessions refold once. See [peak hours](../peak-hours.md).
- **Short spans.** The hourly average needs at least 5 minutes of request span, because
  shorter ones swing too much.

## When prices change

`stateVersion` is a hash of a hand-written number, the catalog revision and the peak
snapshot, so new catalog or calendar data refolds by itself. The hash does not see `RATES`,
`FALLBACK`, the fold's code, the DeepSeek alias rules or the source labels. After changing
those, raise the hand-written number in `createSessionMetricsProjection` and say why in its
comment, or native checkpoints keep the old semantics.

Update the as-of date with the table. `viewSchema` pins `PRICING_AS_OF`, and the preview
sample in `LayoutPreview` carries the date too.

## Today's total

The chip and the panel price **this session**. "What has today cost" cannot come from
the same projection: it keeps no day bucket, and adding one would invalidate every
stored row on the next start.

So the Host answers it separately, in `lib/today-spend.js`, through
`GET /statusline/api/today-spend`:

- Only logs touched since local midnight are read. A session's log is append-only, so a
  file untouched today holds no event from today. The corpus here has a few such files,
  not a thousand.
- Each log is replayed by the Host (`sessionQuery.readSession`), not by a decoder of
  ours, and the fork prefix (`inheritedEventCount`) is skipped: a fork is not charged
  for yesterday's events a second time.
- Each request is priced at **its own** timestamp, with the tariff in force then, and a
  retry (`assistant/attempt` with no message for the same step) is charged once.
- An unpriceable request is counted as unpriced (shown on the line), an unreadable log as
  skipped (tooltip only), and the figure is a lower bound exactly when either exists.
- Both id forms are tried: a session's directory is named `session-<id>`, and the Host's
  corpus keys some of them with that prefix and some without.

The line reads `Today ¥1.23 · 3 sessions · (1 unpriced)` and is hidden when nothing could be
counted: a confident `¥0.00` for a day with unknown models would be a lie.

It stays **one line**, and the split is deliberate: a count (`1 unpriced`) is short enough
to read without hovering, while the prose that explains it — unread sessions, "the total is
a lower bound" — is the line's `title`. A wrapped second line costs more panel height than
that sentence is worth. `data-complete="false"` marks the incomplete case for tests.

- Limit: at most 40 logs per refresh, cached for 60 s and single-flighted, so two tabs
  never walk the same files.
- The day boundary is the local midnight of the machine running the Host, which is the
  same machine as the browser for every supported setup.

## Rate verification

The built-in cards are compared to the official page numerically — not only the
wording. A price cut or a changed discount leaves the peak sentence intact, so the
wording check alone would never see it. Results appear in the peak panel, next to the
rule warning, because that is the surface that already reports official-page drift. See
[peak-hours](../peak-hours.md#the-numbers-not-only-the-wording).

Tests: `tests/today-spend.test.js`, `tests/pricing-verify.test.js`.

## Tests

`npm run verify -- --files lib/session-metrics.js --ui cost`.
`tests/session-metrics.test.js`, `tests/model-pricing.test.js`,
`tests/dsh-integration.test.js`.
