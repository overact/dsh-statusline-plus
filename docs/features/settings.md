# Settings page

The **Statusline** section under DSH Web settings. Settings are saved under
`statusline-plus` in the native profile. The user-facing table is in the
[root README](../../README.md#settings).

## Code

`SettingsPage`, `apiSetConfig`, `apiResetConfig`, `useConfigSnapshot`, `RESET_KEYS` in
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

## Tests

`npm run verify -- --files lib/config.js lib/client.js --ui responsive`.
`tests/statusline.test.js`, `tests/dsh-integration.test.js`,
`tests/client-lifecycle.test.js`.
