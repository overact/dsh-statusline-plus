# Settings page

The **Statusline** section under DSH Web settings. Settings are saved under
`statusline-plus` in the native profile. The user-facing table is in the
[root README](../../README.md#settings).

## Code

The header shows the running plugin version from the same `/statusline/api/version`
check that drives the update button.

`SettingsPage`, `useSettingsForm`, `apiSetConfig`, `apiResetConfig`, `useConfigSnapshot`, `RESET_KEYS` in
`lib/client.js`; `DEFAULT_CONFIG`, `sanitizeConfig`, `SettingsSchema`, `rawConfigProblems`,
`assertRawConfig` in `lib/config.js`; the `internal/config` and `settings/document-updated`
listeners in `lib/index.js`.

## Sections

Display (layout editor), Header, Workspace, Sources (a card per quota source, with its pin)
and Advanced.

## Saving

Edits collect in `dirtyPatch` and save after 700 ms, or on leaving the page. A save sends
only the changed keys. Reset is two steps: the first click arms it for 4 s.

Reset covers display, layout and refresh preferences. It deliberately keeps credential
references, account files, repository paths and per-source switches, so `RESET_KEYS` is an
explicit list. It unsets the keys and lets the Host schema supply defaults, so no default is
duplicated in the browser.

## Two kinds of validation

| Path | Behavior | Why |
| --- | --- | --- |
| Reading a stored profile | Tolerant: `sanitizeConfig` drops what is bad, with one warning | A malformed entry must never stop the plugin from loading |
| Writing an edit | Strict: `assertRawConfig` rejects it | A typo is reported where it is made, and a literal secret or internal endpoint never reaches disk |

The strict check runs in the `internal/config` hook, which is registered inside `apply()`,
so it is absent during the plugin's own activation. Cordis wraps fibers in tracing proxies,
so scope that hook by `uid`, never by object identity.

## Rules

- **Credential references, never literal keys.** Settings hold environment variable names.
  The test button saves first, then tests the saved config, so a value just typed is not
  misreported as unconfigured.
- **`usageUrl` accepts only the official OpenCode endpoint**, and provider endpoints pass
  `sanitizeProviderEndpointUrl`, because a stored URL receives a credential.
- **A new setting starts at its default.** `CONFIG_KEYS` and `BOOLEAN_CONFIG_KEYS` are
  derived from `DEFAULT_CONFIG`, so adding the default is what admits the key and coerces a
  boolean. Add a schema entry only for a non-plain shape or range, and add a display setting
  to `RESET_KEYS`.
- **Stored config is frozen.** `Schema.dict` assigns into it and throws, which is why
  `quotaSources` is `Schema.any().default({})`. Avoid `Schema.dict` for new settings.
- **Invalid pins.** The Host accepts `{ "claude": "bogus" }`, and `quotaPinOf` drops it on
  read.
- **Live updates.** A settings change clears only the affected pools.
  See [architecture](../architecture.md#request-pools).

## Adding a setting

1. Add the default and schema in `lib/config.js`, plus sanitizing and a strict check when it
   can hold a URL or credential reference.
2. Add it to `RESET_KEYS` if it is a preference, and leave it out if it is the user's own
   data.
3. Add it to a pool-clearing key list if it changes a request's result.
4. Add the control, locale strings and a row in the root README's settings table.

## Filling a provider from DSH

A user who configured a provider on DSH's own Models page has already told the Host its
base URL and which credential holds its key. "Fill from DSH" reads that instead of
asking for it twice.

`POST /statusline/api/provider-defaults` answers with `{ apiKeyEnv, baseURL, source }`
for one route, read through `settings.describe()`:

- A `llm-pi-ai` section contributes `providers[route].{baseURL, apiKeyEnv}`.
- The DeepSeek row answers only for DeepSeek's own route ids.
- A base URL is reduced to its origin: the configured DeepSeek URL is the
  Anthropic-compatible `/anthropic` endpoint, which answers no balance call.
- An unknown route answers `no-settings`. The plugin never fills a form from another
  provider's settings.

The button only fills the form. Nothing is written to the profile, and the user still
saves. `lib/provider-defaults.js` is pure; the route is a thin wrapper around it.

## Tests

`npm run verify -- --files lib/config.js lib/client.js --ui responsive`.
`tests/statusline.test.js`, `tests/dsh-integration.test.js`,
`tests/client-lifecycle.test.js`.
