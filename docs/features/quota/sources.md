# Quota source protocol notes

These are internal, undocumented provider endpoints. They can change without
notice; the parser and its tests are authoritative for the current shape. This
page records the semantics that are easy to get wrong, plus how to verify a
live response without leaking credentials.

Last verified: 2026-10-26 (Antigravity against `agy` 1.4.7 and the live Magpie
gateway; the rest from the live probes described below). Verified 2026-11-05 with
real login files: Codex `auth.json` and Claude `.credentials.json` return quota, and
Claude needs no claimed client identity. The Antigravity login file does not yet: see
**Antigravity**.

## Result shape

Every subscription reaches the browser in one shape, described in
`lib/quota-window.js`: `{ style: 'windows', windows: [...], chipWindows?, plan?,
accounts?, source, fetchedAt }`. A window has `usedPercent`, `remainingPercent` and
`resetInSec`, plus optional `id`, `group`, `minutes`, `label`, `short` and
`exhausted`. A window with `minutes` and no `label` is named in the viewer's
language. The chip shows the leading group's windows, up to `chipWindows`; the
panel lists all of them. `exhausted` is judged before rounding, so 99.9% used still
counts as available. Wallets keep `style: 'balance'`. `lib/client.js` renders both
with one `QuotaLine`.

## Reading order

Every subscription uses `readInOrder` (`lib/quota-order.js`):

1. The user's pin, `quotaSources[<id>]`, default none. A pin is the only source
   read, with no fallback. A chosen CPA account file is a pin on CPA.
2. Tools: Magpie, then CPA.
3. Others: the official tool's login file, then the DSH login (Codex only), or the
   API key for API-key subscriptions.

| Subscription | Tools | Others | Pins |
| --- | --- | --- | --- |
| Codex | Magpie, CPA | `$CODEX_HOME/auth.json`, DSH login | `magpie` `cpa` `official` `dsh` |
| Claude | Magpie, CPA | `$CLAUDE_CONFIG_DIR/.credentials.json` | `magpie` `cpa` `official` |
| Antigravity | Magpie, CPA | `~/.gemini/antigravity-cli/antigravity-oauth-token` | `magpie` `cpa` `official` |
| OpenCode, Kimi Code, Z.ai | Magpie | API key | `magpie` `direct` |
| Anything else in Magpie | Magpie | none | none |

Rules:

- The next source is tried only for `no-credential` or `auth`. Network, server and
  decode failures of a real source are reported unchanged.
- Magpie is optional. A refused connection means it is not running and reads as
  absent. Any other Magpie failure also moves on, but stays the reported error if
  the later sources can only say `auth`, because it can recover by itself.
- Login files are only read: never refreshed, rewritten, logged or kept. Each token
  goes only to the fixed endpoint of its own service. An expired login reads as
  `auth`; signing in again belongs to the official tool.
- The plugin does not present another client's identity (see Antigravity).
- macOS keeps the Claude Code login in the Keychain, and the Antigravity CLI may use
  the system keyring. Those are not read, so such users need Magpie or CPA.

Shape sources: durandom/token-burn and steipete/CodexBar (Claude), raycast/extensions
`agent-usage` (Antigravity token file).

## Where the code lives

| Source | Fetcher | Parser / tests |
| --- | --- | --- |
| Antigravity | `lib/quota-antigravity.js` | `tests/antigravity.test.js`, `tests/statusline.test.js` |
| Codex | `lib/quota-codex.js` | `tests/dsh-integration.test.js` |
| Reading order | `lib/quota-order.js` | `tests/magpie-quota.test.js` |
| Magpie (any subscription it reports) | `lib/quota-magpie.js` | `tests/magpie-quota.test.js` |
| Claude | `lib/quota-claude.js` | `tests/magpie-quota.test.js` |
| Official login files | `lib/quota-login-files.js` | `tests/magpie-quota.test.js` |
| Kimi Code, Z.ai / Zhipu | `lib/quota-providers.js` | `lib/provider-presets.js`, `tests/provider-quota.test.js` |
| OpenCode Go | `lib/quota-providers.js` (`fetchUsage`) | `tests/dsh-integration.test.js` |
| OpenRouter, custom providers | `lib/quota-providers.js` | `tests/provider-quota.test.js` |
| DeepSeek API key | `lib/provider-presets.js` | `tests/provider-quota.test.js` |
| DeepSeek signed-in account | `lib/quota-deepseek-account.js` | `tests/provider-quota.test.js` |

## Claude

- Request: `GET https://api.anthropic.com/api/oauth/usage`, bearer token,
  `anthropic-beta: oauth-2025-04-20`. No client identity is claimed.
- Token: `claudeAiOauth.accessToken`, with `expiresAt` (epoch ms) and `scopes`. The
  endpoint needs `user:profile`; a token without it reads as `no-credential`.
- Response: `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, each with
  `utilization` (already 0–100, used) and `resets_at`. A null bucket is absent, not 0%.
- A plain `anthropic` billing provider is usually an API key, so it does not select
  this chip; `claude/` model namespaces and `claude*` providers do.

## Antigravity (CPA accounts and the official login)

- Read every `antigravity-*.json` under `~/.cli-proxy-api`; `priority` is a
  JSON string in the file and is sorted numerically. Accounts are queried
  concurrently (max 3), and the chip shows the first available account while
  the details panel lists all of them.
- Request: `POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`,
  JSON body `{ "project": "<project_id>" }`, bearer access token.
- **Client identity matters.** The service keys its response on the User-Agent:
  a bare `antigravity` value silently omits the whole `Gemini Models` group, while
  `antigravity/hub/<version>` returns both groups. The plugin does not present
  another client's identity, so this path may return only the Claude/GPT group; it
  then sets `geminiHidden` and the panel says so. Magpie reports the full picture.
- With the official login file, an unexpired token and no claimed identity, this
  request answered 403 `SUBSCRIPTION_REQUIRED`, and `loadCodeAssist` returned no
  project or current tier, on an account `agy` could read earlier. That reads as
  `no-credential`, not as an expired login. Whether a client identity is the cause is
  untested, because the plugin does not claim one.
- Response: `groups[].displayName` is `Gemini Models` or `Claude and GPT
  models`; each group has `buckets[]` with `bucketId` (`gemini-weekly`,
  `gemini-5h`, `3p-weekly`, `3p-5h`), `window` (`weekly` / `5h`),
  `remainingFraction` (0–1) and `resetTime` (ISO). Weekly-only Starter accounts
  legitimately omit the 5h bucket.
- Semantics: `remainingFraction: 1` means untouched; used percent is
  `1 - remainingFraction`. Never treat a missing Gemini group as "no Gemini
  usage" without checking the request identity first.
- Independent check: `agy -p /usage --output-format json` prints the same
  groups and percentages. Compare the Gemini weekly/5h pair, not just the
  Claude/GPT pair.
- Read-only: a 401 is reported as `auth`. The plugin does not refresh the token or
  write to the CPA file, because that file belongs to CPA.

## Codex

- Request: `GET https://chatgpt.com/backend-api/wham/usage`, bearer token from
  the selected `codex-*.json`.
- An optional `chatgpt-account-id` header is decoded from the access-token JWT
  (`https://api.openai.com/auth.chatgpt_account_id`); do not verify the
  signature here.
- `rate_limit.primary_window` / `secondary_window` carry `used_percent`,
  `limit_window_seconds`, `reset_after_seconds` and `reset_at` (epoch seconds).
  `used_percent` is already a used percentage (0–100). Window length decides
  the chip label; do not assume primary is always the 5-hour window.
- `credits` is separate from the rate-limit windows.

## Magpie (preferred source)

- Request: `GET http://127.0.0.1:3425/v1/magpie/quotas` (loopback, no auth).
  `MAGPIE_GATEWAY_URL` overrides the base URL.
- Response: `{ "data": [ { "provider": "antigravity" | "codex", "user",
  "plan", "windows": [ { "name", "used", "remaining", "resetsAt" } ] } ] }`.
- `windows[].used` is already a percentage (0–100), unlike Antigravity's
  `remainingFraction` (0–1); `remaining` is the complement. `resetsAt` is ISO.
- Antigravity names: `Gemini · 5 hours`, `Gemini · 7 days`,
  `Claude & GPT · 5 hours`, `Claude & GPT · 7 days`. Starter accounts may list
  per-model rows alongside the aggregate pair; the parser only takes the
  aggregate names above.
- Codex names: `5 hours`, `7 days`; the parser sorts by the length parsed from
  the name, shortest first.
- Any provider is accepted. `parseMagpieSubscriptions` assumes no names, so each
  user's list works as it is. A row with `error` or no measured window is left out;
  several accounts of one provider show the first with quota left. Window `display`,
  `unit` and `pool` are not used; `used` is enough for credit-type windows too.
- `magpie-quota` answers one subscription by `id` (a model namespace or gateway
  provider, exact name first, then a `-` prefix either way) or the whole list.
- Selection is described in **Reading order**.
- DSH login: `credentials.readRecord('llm-pi-ai/openai-codex')`. The grant's shape
  is owned by the login plugin and unpublished, so an unexpected shape reads as
  `no-credential`. An expired grant reads as `auth`; it is never refreshed. DSH has
  no Antigravity login to read.
- A stopped Magpie refuses the loopback connection immediately, so the CPA path
  is still reachable when Magpie is not running. The 8-second deadline covers a
  gateway that is busy refreshing: the first Antigravity read after a restart
  renews all three accounts and has been observed taking over 3 seconds.
- Do not read a CPA fallback failure as the live state. When Magpie is reachable
  but slow, the CPA mirror can only answer `auth` (its saved access tokens have
  expired, and the plugin does not refresh them). The fetcher keeps
  Magpie's retryable failure in that case instead of turning it into a
  permanent "subscription missing" state.

## Subscription selection

- The header chip picks a subscription from the model ID namespace first
  (`antigravity/`, `codex/`, `claude/`, `opencode/`), then from the provider name
  (`antigravity-sub`, `codex-sub`, `magpie-*`, ...).
- One model shows one subscription. If that subscription returns
  `no-credential`, `auth`, `invalid-response` or `not-found`, the chip says
  "Subscription not found" (the short reason stays in the tooltip); it never
  borrows another enabled subscription's numbers. A Gemini model therefore
  cannot silently display Codex quota.
- Transient failures (`network`, `timeout`, `rate-limit`) keep the retrying chip
  for the same subscription; they do not switch sources either.
- A model with no dedicated reader asks Magpie by its namespace. Nothing shows when
  Magpie has no such subscription, unless the model is on a subscription gateway,
  which still says "Subscription not found".
- `quotaShowAll` (default off) bypasses selection and renders every enabled
  subscription chip (Codex, Antigravity, Claude, OpenCode) side by side, then every
  other subscription Magpie reports.

## Kimi Code

- Request: `GET https://api.kimi.com/coding/v1/usages`, bearer API key.
- Two response shapes can arrive together:
  - Ratio pools: `usages.limit_5h`, `limit_7d`, `limit_month_total`,
    `limit_month_code`, each with `used_ratio` (0–1, **used**, not remaining)
    and `reset_time`.
  - Legacy counts: `usage` (`limit`, `used`, `remaining`, `resetTime`) and
    `limits[]` (`window.duration` / `timeUnit`, `detail` counts).
- Known inconsistency: a ratio pool can lag an exhausted quota. Upstream has
  observed `usages.limit_7d.used_ratio = 0` while the weekly quota was already
  exhausted and requests returned 403
  ([MoonshotAI/kimi-code#3951](https://github.com/MoonshotAI/kimi-code/issues/3951)).
  The parser pairs a legacy window with a ratio window of the same cadence and
  reset time (within 2 seconds) and keeps the higher used percentage.
- A response with neither shape is unavailable, not 0% used.

## Z.ai / Zhipu (GLM Coding Plan)

- Request: `GET https://api.z.ai/api/monitor/usage/quota/limit` (China:
  `https://open.bigmodel.cn/api/monitor/usage/quota/limit`). Auth is the raw
  API key, not a Bearer token.
- `data.limits[]`: only `TOKENS_LIMIT` and `CREDIT_LIMIT` are model quota.
  `percentage` is used percent; `usage` is the cap and `currentValue` the used
  amount when counts are supplied. `unit: 6` is the weekly bucket, `unit: 3`
  with `number > 0` is the 5-hour bucket; `nextResetTime` is epoch
  milliseconds. `TIME_LIMIT` is monthly MCP calls, not a model window.
- The current parser prefers `percentage` and falls back to the counts. When a
  live response disagrees with the counts, treat the counts as the more
  trustworthy view and add a fixture before changing the preference.

## OpenCode Go

- Request: `GET https://opencode.ai/zen/go/v1/usage`, bearer API key.
- `usage.rolling` / `weekly` / `monthly` each carry `{ status, percent,
  resetsAt }`. `percent` is **used** percent (0–100), not remaining; this
  matches `pi-opencode-go-usage`, an independent consumer of the same
  endpoint.

## OpenRouter

- `GET https://openrouter.ai/api/v1/credits` returns `data.total_credits`
  (lifetime purchased) and `data.total_usage` (lifetime used). The wallet
  balance is the difference; do not treat `total_credits` as a spending cap.
- `GET https://openrouter.ai/api/v1/key` returns `data.limit_remaining`,
  `limit` and `usage` for the **key-level** budget. That is not the account
  wallet; keep the two views separate.

## DeepSeek

- API key: `GET https://api.deepseek.com/user/balance` returns `is_available`
  and `balance_infos[]` (`currency`, `total_balance`, `granted_balance`,
  `topped_up_balance`). This is a wallet, not a percentage quota; never derive
  a cap from the granted balance.
- Signed-in Platform account (`deepseek-account`): read through the Host
  `deepseekAccount.getBalance()` service. `value` holds topped-up wallets and
  `bonusWallets` holds granted credit; no API key is involved. A signed-out
  account is a distinct state from a missing provider integration.

## Debugging without leaking data

- **Do not grep `~/.cli-proxy-api/logs`.** These error logs embed full request
  bodies, tool schemas and account data, and a broad grep can dump megabytes.
  Read the credential JSON and call the endpoint instead.
- Never print access tokens, refresh tokens, API keys or full account emails.
  Percentages, group names, bucket IDs and file names are enough for a report.
- For Antigravity, `agy -p /usage --output-format json` is the independent
  reference; the plugin and the CLI should agree.
- For a one-off check, put a short script under `scratch/` (ignored) and print
  only the normalized windows. If a live response contradicts a test, capture
  the smallest redacted payload and update the parser and its fixture
  together.
- Scope searches to this repository or a known file; a recursive grep across
  the home directory can spend minutes and still miss the relevant source.
