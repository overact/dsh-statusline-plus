# Header quota chips

A chip in the session header shows the balance or usage windows of the subscription
paying for the current model. Clicking it opens a panel with every window, reset times,
the data source and a refresh button.

This page covers what the browser shows and when it refreshes. Where the numbers come
from is in [sources.md](sources.md).

## Code

| Part | Location |
| --- | --- |
| Chip selection | `HeaderChip` in `lib/client.js` |
| Model to subscription | `primarySubscriptionKind`, `magpieSubscriptionHint`, `looksLikeSubscription`, `providerMatchesModel` |
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

Plain `anthropic` is deliberately not Claude in step 4: it is usually an API key, which
has no subscription quota.

**One model, one subscription.** When its source has no data, the chip says so. It never
carries over to another subscription, because a Codex figure beside a Gemini model would
read as that model's quota.

`quietAbsent` covers step 5 when the model does not look like a subscription: having no
such subscription is normal, so nothing shows until there is data.

## Refresh

Expiry alone never polls. A refresh comes from one of:

- a mount, or a change of request settings;
- a turn starting or a step ending, when `quotaOnStep` is on (cached results may answer);
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
| `invalid-response` | The response did not parse | Code, if the service changed |
| `disabled`, `not-found` | Switched off, or no such source | Settings |
| `signed-out`, `no-account` | DeepSeek signed-in account only | User signs in |

`QUOTA_ABSENT_ERRORS` are the codes a `subscriptionOnly` chip reports as "subscription not
found" rather than as a failure.

## Pitfalls

- **Percentages.** `exhausted` is judged before rounding, so 99.9% used is still
  available. `quotaPercentMode` changes only the display.
- **Clock skew.** `fetchedAt` comes from the Host and the browser may run behind it.
  `quotaFreshness` tolerates skew and shows 0 s rather than "unknown".
- **Chip width.** The header slot sizes from its content inside a clipping parent, so
  container queries have no width to read. `ChipFold` tries each form from fullest down
  and keeps the first that fits.
- **Two gates.** A subscription switch is checked by `enabledKinds` in the browser and
  again by `quota()` on the Host. Update both for a new subscription.

## Adding a subscription

1. Write the fetcher returning the shape in `lib/quota-window.js`, reading through
   `readInOrder`, and add a section to [sources.md](sources.md).
2. Add the route and gate in `lib/index.js`, and the setting in `lib/config.js`.
3. Add it to `QUOTA_KINDS`, `primarySubscriptionKind`, `enabledKinds` and
   `DEDICATED_SUBSCRIPTION_RE` in `lib/client.js`, and give it a source card.
4. Add parser tests with invented values, shaped like a real response.

## Tests

`tests/magpie-quota.test.js`, `tests/provider-quota.test.js`, `tests/antigravity.test.js`,
`tests/statusline.test.js`, `tests/client-lifecycle.test.js`.
