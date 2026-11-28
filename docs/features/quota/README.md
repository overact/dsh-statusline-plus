# Header quota chips

A chip in the session header shows the balance or usage windows of the subscription
paying for the current model. Clicking it opens a panel with every window, reset times,
the data source and a refresh button.

The chip carries the subscription name; the header slot is narrow, so Antigravity reads
as `Agy` there (the reset drawer uses the same label). The details panel keeps the full
name in its heading and messages.

This page covers what the browser shows and when it refreshes. Where the numbers come
from is in [sources.md](sources.md).

## Code

| Part | Location |
| --- | --- |
| Chip selection | `HeaderChip` in `lib/client.js` |
| Model to subscription | `modelQuotaSource` (the one resolver, also used by the model seat), `quotaKindEnabled`, `primarySubscriptionKind`, `SUBSCRIPTIONS`, `magpieSubscriptionHint`, `looksLikeSubscription`, `providerMatchesModel` |
| Fetch, retry, freshness | `useQuotaResource`, `quotaFreshness` |
| Rendering | `QuotaChip`, `QuotaLine`, `ChipFold`, `windowsView`, `balanceView` |
| Host gate and cache | `quota()` and `quotaRoute` in `lib/index.js` |

## Settings

`showQuota`, `quotaAuto`, `quotaShowAll`, `quotaOnStep`, `quotaPercentMode`,
`quotaSources`, `showCodexQuota`, `showAntigravityQuota`, `showClaudeQuota`,
`showOpenCodeQuota`, `providers`, `cacheTtlMs`, `fetchTimeoutMs`, `codexAccount`,
`antigravityAccount`, `apiKeyEnv`, `usageUrl`. Defaults are in `DEFAULT_CONFIG`
(`lib/config.js`).

## Which chip appears

`HeaderChip` takes the model from the native `modelSelection` projection, whose `next`
is known before any request exists. The `session-model` route is only a fallback. Then
the first matching case applies:

1. `quotaShowAll` shows every enabled subscription, plus anything else Magpie reports.
2. `quotaAuto` off shows OpenCode only.
3. An enabled `providers[]` entry matching the model shows that provider.
4. A model recognized by `primarySubscriptionKind` shows that subscription, if enabled.
5. A model with a Magpie hint asks Magpie for that subscription.
6. A model that looks like a gateway subscription shows "subscription not found".
7. Anything else shows no chip.

`sanitizeConfig` merges `BUILTIN_PROVIDERS` into `providers`, so step 3 also covers
DeepSeek, Kimi Code, Z.ai, Zhipu and OpenRouter when nothing is configured.

Steps 3–5 are `modelQuotaSource` in `lib/client.js`; steps 6–7 are what the chip does when
it returns `null`. The model seat's quota rail reads the same function
([model-quota-bar.md](../model-quota-bar.md)), so the chip and the rail cannot disagree
about which subscription a model uses, and a rail simply stays empty where the chip would
report an absence. `quotaShowAll` and the `quotaAuto === false` OpenCode-only mode are
chip-only branches; a picker row can only speak for its own model.

Plain `anthropic` is deliberately not Claude in step 4: it is usually an API key, which
has no subscription quota.

**One model, one subscription.** When its source has no data, the chip says so. It never
carries over to another subscription, because a Codex figure beside a Gemini model would
read as that model's quota.

`quietAbsent` covers step 5 when the model does not look like a subscription: having no
such subscription is normal, so nothing shows until there is data.

A source that exists but is switched off (`showCodexQuota` and its siblings) is **not**
"not found": step 4 skips it, and step 6 checks whether any reader claims the model at all
before printing the placeholder. A disabled source shows nothing, so the placeholder keeps
meaning only what it says.

## Refresh

Expiry alone never polls. A refresh comes from one of:

- a mount, or a change of request settings;
- a turn starting or a step ending, when `quotaOnStep` is on: at most once per
  `max(15s, cacheTtlMs)`, and never while a failure retry is pending. A step inside the
  cache window, or while a retry is scheduled, sends nothing; an in-flight request
  coalesces at most one trailing refresh;
- the page becoming visible or coming back online;
- the refresh button, which bypasses a successful cache but still respects error backoff.

Failures retry at most three times: after 15/30/60 s for `network`, and 60/120/240 s for
`rate-limit`, so the browser stays behind the Host's 15 s error cache. Going offline
pauses recovery. Data already on screen stays during retries and is marked stale.

## Errors and absence

| Code | Meaning | Who fixes it |
| --- | --- | --- |
| `no-credential` | No source has a login or key | User signs in or configures |
| `auth` | Login expired or rejected | The official tool signs in again |
| `rate-limit` | Service returned 429 | Automatic retry |
| `network` | Unreachable, timed out, or an unlisted error | Automatic retry |
| `invalid-response` | The response did not parse, or a route answered with plain text instead of JSON | Code, if the service changed; a version mismatch or proxy if the body is not JSON |
| `disabled`, `not-found` | The Host switched the source off, or does not know it | Settings; check the plugin/Host versions if the page shows it enabled |
| `unauthorized`, `forbidden` | The page's session, Host/Origin fence, or remote credential was rejected | Refresh or sign in; check the URL host and origin |
| `signed-out`, `no-account` | DeepSeek signed-in account only | User signs in |
| `aborted`, `busy` | The request was cancelled, or the Host was busy | Retry, refocus, or wait |

`QUOTA_REASON_KEYS` is the one place that turns a code into the chip's short label; every
known code has its own. The chip's tooltip appends the raw code in parentheses, so even
the `unavailable` fallback (an unknown code) can be traced.

`QUOTA_ABSENT_ERRORS` are the codes a `subscriptionOnly` chip reports as "subscription not
found" rather than as a failure.

That "not found" chip is a status, not a reading: it takes the shared chip metric
(`.slp-chip-metric`, 13px) and leaves after 10 s — a 10 s CSS fade plus a JS removal
at the same deadline, so it cannot stay in the header as a permanent sentence. A
different model remounts it (the key carries the model), which restarts the 10 s.
Under `prefers-reduced-motion` the animation is off but the removal still happens.

## Pitfalls

- **Percentages.** `exhausted` is judged before rounding, so 99.9% used is still
  available. `quotaPercentMode` changes only the display.
- **Clock skew.** `fetchedAt` comes from the Host and the browser may run behind it.
  `quotaFreshness` tolerates skew and shows 0 s rather than "unknown".
- **Chip width.** The header slot sizes from its content inside a clipping parent, so
  container queries have no width to read. `ChipFold` tries each form from fullest down
  and keeps the first that fits.
- **Detail panel placement.** Details portal to `document.body`, and the Host hook that
  placed them is gone from newer primitives. See *Anchored panels* in
  [architecture.md](../../architecture.md#host-version-differences). The panel caps its
  width at 380px, so a long provider error or account note wraps instead of stretching
  the anchored surface across the window.
- **Tooltip text.** A native `title` that changes while shown blinks. Chip buttons take
  their title through `useHeldTitle` (on a panel, `dismiss.titleProps(text, key)`), which holds the text while hovered
  until `key` changes. The key names state, never the clock: a new fetch, an error, a
  retry attempt or a peak switch updates at once. `slot` separates several tooltips in
  one chip. Users: the quota trigger, each window segment (reset countdown), the retry
  chip (retry countdown), the panel's "updated Ns ago" (`QuotaFreshness`), the header
  peak chip and the sidebar peak dot. A title built from `now` or a countdown needs it. The dot's
  clock sleeps while closed, so its key carries the hover time: entry re-renders and
  takes a current countdown before the tooltip shows, then holds it while the open
  panel ticks.
- **Two gates.** A subscription switch is checked by `enabledQuotaKinds` in the browser and
  again by `quota()` on the Host. Update both for a new subscription.

## Adding a subscription

1. Write the fetcher returning the shape in `lib/quota-window.js`, reading through
   `readInOrder`, and add a section to [sources.md](sources.md).
2. Add the route and gate in `lib/index.js`, and the setting in `lib/config.js`.
3. Add one entry to `SUBSCRIPTIONS` in `lib/client.js`: its name and label keys,
   tint, settings switch, model/provider match, reset coverage and aliases.
   `QUOTA_SUBSCRIPTION_KINDS`, `primarySubscriptionKind`,
   `quotaKindEnabled`, `DEDICATED_SUBSCRIPTION_RE` and the rail palette derive
   from that table. Give it a source card; the model seat's rail follows through
   `modelQuotaSource`.
4. Add parser tests with invented values, shaped like a real response.

## Advice, not only a reason

A failure code names what happened; it rarely says what to do. Every code that can reach
the panel therefore has one sentence of advice (`quotaAdvice`), shown under the status
line: `no-credential` points at the API key field, `rate-limit` suggests a longer
refresh interval, `forbidden` mentions the account or region, and an unknown code still
gets a sentence rather than a blank line.

The chip stays a reading. The advice lives in the details panel, where there is room for
it and where someone who opened it is already looking for a cause.

## Tests

`tests/magpie-quota.test.js`, `tests/provider-quota.test.js`, `tests/antigravity.test.js`,
`tests/statusline.test.js`, `tests/client-lifecycle.test.js`. The header chip's
"not found" state is covered in the browser by `verify-ui --panel chip`, and the
multi-account fallback by `verify-ui --panel magpie-accounts`.
