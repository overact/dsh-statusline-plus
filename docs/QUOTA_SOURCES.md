# Quota source protocol notes

These are internal, undocumented provider endpoints. They can change without
notice; the parser and its tests are authoritative for the current shape. This
page records the semantics that are easy to get wrong, plus how to verify a
live response without leaking credentials.

Last verified: 2026-10-24 (Antigravity against `agy` 1.4.7; the rest from the
live probes described below).

## Where the code lives

| Source | Fetcher | Parser / tests |
| --- | --- | --- |
| Antigravity | `lib/quota-antigravity.js` | `tests/antigravity.test.js`, `tests/statusline.test.js` |
| Codex | `lib/quota-codex.js` | `tests/dsh-integration.test.js` |
| Kimi Code, Z.ai / Zhipu | `lib/quota-providers.js` | `lib/provider-presets.js`, `tests/provider-quota.test.js` |
| OpenCode Go | `lib/quota-providers.js` (`fetchUsage`) | `tests/dsh-integration.test.js` |
| OpenRouter, custom providers | `lib/quota-providers.js` | `tests/provider-quota.test.js` |
| DeepSeek API key | `lib/provider-presets.js` | `tests/provider-quota.test.js` |
| DeepSeek signed-in account | `lib/quota-deepseek-account.js` | `tests/provider-quota.test.js` |

## Antigravity (CPA accounts)

- Read every `antigravity-*.json` under `~/.cli-proxy-api`; `priority` is a
  JSON string in the file and is sorted numerically. Accounts are queried
  concurrently (max 3), and the chip shows the first available account while
  the details panel lists all of them.
- Request: `POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`,
  JSON body `{ "project": "<project_id>" }`, bearer access token.
- **Client identity matters.** Send `User-Agent: antigravity/hub/2.9.1 <os>/<arch>`
  (for example `linux/amd64`). A bare `antigravity` User-Agent is treated as a
  legacy client and the response silently omits the whole `Gemini Models`
  group, leaving only an untouched Claude/GPT pool. `antigravity/1.4.7 ...`
  also behaves like the legacy identity; the `hub/<version>` compatibility
  identity is the one that returns both groups.
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
- A 401 refreshes the refresh token through `https://oauth2.googleapis.com/token`
  (`ANTIGRAVITY_OAUTH_CLIENT_SECRET` is required) and writes the new access
  token back to the CPA file.

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
