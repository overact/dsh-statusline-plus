# Self-update

When npm publishes a newer version, the settings header shows a button naming it. One click
installs in place, and the Host swaps the new copy into the running profile.

## Code

`createUpdateChecker`, `applyUpdate`, `resolveInstall`, `enginesAllow`, `compareVersions` in
`lib/update.js`; the `version` route and `hotApplyUpdate` in `lib/index.js`; the update state
in `SettingsPage` (`lib/client.js`).

## Checking

The page asks once per settings visit, never on a timer, and the Host caches the registry
answer for a minute. The button stays hidden when:

- the install is linked, because a development checkout is not the registry's to replace;
- the registry failed, because an error must not read as "up to date";
- `compatible` is false for the running Host (null, meaning unknown, does not hide it);
- no newer version exists.

The check asks the registry directly, so it works on any Host running this plugin.
`STATUSLINE_REGISTRY` overrides the registry for tests.

## Installing

`POST version` refuses a linked install, a version not newer than the installed one, and a
concurrent install. Then `applyUpdate` tries installers in this order:

1. The running Host's own `dsh plugin add`. A desktop build ships its package manager
   internally, so this may be the only installer there.
2. `pnpm`, then `npx pnpm`, for Hosts on a plain Node install.

The first success ends the loop. If all fail, the first real failure is reported, ahead of
an installer that could not start. When no installer exists at all, the response names the
`dsh plugin` command to run by hand.

## Applying

The install is an overlay rather than remove-then-install, because unloading this plugin
would kill the request that asked for the update.

`hotApplyUpdate` then runs `hmr.reconcileProfile()` 80 ms after the response is sent, because
applying disposes this plugin's own fiber. The page learns the outcome by watching for a new
`instanceId` from the `version` route, and asks for a restart if none appears. A profile
without HMR applies the update on the next start.

## Rules

- The install is deliberately not tied to the request's signal: aborting because a tab closed
  would leave `node_modules` half-written.
- Installer output is capped by `OUTPUT_LIMIT`, and the whole install by `INSTALL_TIMEOUT_MS`.
- `resolveInstall` recognizes `<home>/profiles/<profile>/node_modules/dsh-statusline-plus`.
  Any other path counts as linked. Check this first if a Host changes its profile layout.

## Tests

`tests/update.test.js`, `tests/client-lifecycle.test.js`. Consumer verification is in
[releasing](../development/releasing.md).
