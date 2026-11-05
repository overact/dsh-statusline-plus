# Architecture

The package is one dual-face Cordis row, `statusline-plus`, declared in
`cordis.patch.yml`. The host half (`lib/index.js`) serves routes and registers session
projections. The browser half (`lib/client.js`) is loaded through `dsh.client` in
`package.json` and renders into Host slots.

## Module map

`lib/index.js` holds only `apply()`, routes, listeners and pools.

| Area | Modules |
| --- | --- |
| Settings | `config.js` |
| Quota | `quota-order.js`, `quota-window.js`, `quota-magpie.js`, `quota-codex.js`, `quota-antigravity.js`, `quota-claude.js`, `quota-providers.js`, `provider-presets.js`, `quota-deepseek-account.js`, `quota-login-files.js`, `cpa-credentials.js`, `quota-http.js`, `quota-transport.js` |
| Git | `git-status.js` |
| Session | `session-log.js`, `session-metrics.js`, `model-pricing.js`, `tool-activity.js`, `tps.js` |
| Peak | `peak-schedule.js` |
| Update | `update.js` |
| Shared | `request-pool.js`, `http-route.js` |

`lib/client.js` is a single large file. Find a component by searching for its name; the
feature pages name the ones they own.

## Browser slots

| Slot | Content |
| --- | --- |
| `conversation.composer.dock` | `StatusPanel`, the bottom row |
| `conversation.session.header.actions` | `HeaderChip`: quotas and the peak chip |
| `sidebar.footer.action` | `PeakFooterDot` |
| `settings.section` | `SettingsPage` |

`dsh.client.inject` in `package.json` lists the Host client modules the bundle needs.

## Routes

All live under `/statusline/api/`.

| Route | Method | Purpose |
| --- | --- | --- |
| `usage` | POST | OpenCode Go quota |
| `codex-quota`, `antigravity-quota`, `claude-quota` | POST | Subscription quota |
| `magpie-quota` | POST | One Magpie subscription by `id`, or all without it |
| `provider-quota` | POST | One `providers[]` entry |
| `session-model` | POST | Provider and model of a session |
| `git` | POST | Git status for a `cwd` |
| `tps` | GET | Server-sent speed events for one session |
| `peak-schedule` | GET | Holiday calendar and official-rule check |
| `version` | GET, POST | Update check, and install |

Every route passes `connection.admit` inside `register`, because named routes bypass
the built-in `/api` transport and its authentication. Handlers then call `guardRequest`
from `http-route.js`. Quota routes answer HTTP 200 with `{ ok: false, error }`, and
`quotaRoute` turns any error outside its allow-list into `network`, so raw exception
text stays on the Host. A new stable error code must be added to
`ACCOUNT_QUOTA_ERRORS` or `PROVIDER_QUOTA_ERRORS` and to the client's error text. The
`git` route has its own list, `GIT_ERRORS`. The `usage` route does not use `quotaRoute` and
returns the error message as it is.

## Request pools

`RequestPool` shares in-flight requests, caches results, and aborts a request only when
all its subscribers have gone. Errors are cached for at least 15 s even on `force`, which
is why a manual refresh cannot hammer a failing service.

| Pool | Deadline | Used for |
| --- | --- | --- |
| `quotaPool` | 20 s | Quota results, TTL `max(15000, cacheTtlMs)` |
| `accountPool` | 15 s | One CPA account read |
| `magpiePool` | 10 s | The local Magpie read, TTL 3 s, shared by all chips |
| `gitPool` | 8.5 s | Git status, TTL 1 s |

`settings/document-updated` clears only the pools that the changed keys affect. A new
setting that changes a request's result must join the matching key list there, and the
client's `requestConfigKey` in `useQuotaResource` if it is a quota setting.

## Session projections

`statuslineMetrics` (`session-metrics.js`) and `statuslineToolActivity`
(`tool-activity.js`) are folds over session events, checkpointed natively by the Host.

- Changing what a fold computes or its state shape requires a `stateVersion` bump, or old
  checkpoints keep the old result. For `statuslineMetrics`, see
  [cost](features/bottom-bar/cost.md#when-prices-change).
- `registerSessionProjection` accepts both registration results: a disposer on DSH 0.2.1
  and an awaitable handle on 0.2.2 and later.

## Host version differences

`engines.dsh` has a floor and no ceiling, so a Host upgrade never disables the plugin.
Code against both sides of a known boundary.

- **Fiber config cells.** Since DSH 0.2.2, `fiber.config` is raw and the volatile cells
  are in `fiber.effectiveConfig`; earlier they are in `fiber.config`.
  `tests/native-settings-fixture.mjs` supports both.
- **Test versions.** `package.json` pins an older DSH devDependency than a developer's
  local `node_modules` may hold, and CI installs without a lockfile. A suite can pass
  locally and fail on the tag, so run the fresh-install check in
  [releasing.md](development/releasing.md).
- **Optional services.** Reach `deepseekAccount`, `hmr` and `clientModules` through
  `ctx.get()` inside `try`, and treat them as possibly absent. `sshRemoteHostBridge` is
  negotiated through `ctx.inject`.

## Lifecycle

Harness HMR can reload the plugin repeatedly. Release every route, listener, pool and
projection through `ctx.effect` or the `disposers` list so no handler is duplicated.
Before advising a Host restart, run `npm run dev:runtime`.

`SLP_TEST=1` exposes pure functions as `__test`. Tests use that instead of a real Host,
except the integration tests, where `DSH_PACKAGE_DIR` selects an installed runtime.
