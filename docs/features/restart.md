# Reload, restart and DSH update

A power button in the sidebar footer, beside the peak dot, applies plugin and config
changes to the running Host, cheapest first, and updates DSH itself where that is safe.
A DSH update runs in a transient systemd user service, so the running Host never
replaces its own package tree. The page keeps a progress panel across the bounce and
reloads once the new process is ready. It replaces the separate `dsh-restart-button`
plugin.

## Code

| Area | Symbols |
| --- | --- |
| Reload and restart | `createRestartController`, `reconcileProfile`, `planAfterReload`, `activeSessionCount`, `restartUnit`, `systemdUnitOf` in `lib/restart.js` |
| DSH update check and start | `createHostUpdater`, `resolveHostInstall`, `fetchDistTag`, `hostPackageDir`, `systemdRunAvailable` in `lib/host-update.js` |
| Out-of-process update | `runHostUpdate` in `lib/host-update-runner.js` |
| Route | `restart` route, `hostReady`, `hostUpdater`, `profileContext` in `lib/index.js` |
| Page | `RestartFooterButton`, `useRestartCaps`, `openRestartDialog`, `runRestart`, `restartStep`, `restartProgressSteps`, `updateRestartProgress`, `restartPollDelay` in `lib/client.js` |

## What each environment gets

| Host | Reload | Full restart | DSH update |
| --- | --- | --- | --- |
| Linux or WSL, DSH as a systemd user service, global npm install writable by the user, `systemd-run` available | Yes | Yes | Yes |
| Same, but npm prefix owned by root, or DSH installed with pnpm, npx or `link:` | Yes | Yes | No |
| Same, but no `systemd-run` | Yes | Yes | No |
| Started from a terminal (no service manager) | With HMR | No | No |
| Windows, including the desktop app | With HMR | No | No |
| macOS desktop app | With HMR | No | No |

Every missing choice is hidden, not disabled. A Host offering none of them shows no button.
`GET restart?update=1` adds `update.helper`: false when the transient service cannot be
started, and the page then hides the update action. The page requires `helper === true`,
so an older Host without the field also hides it instead of running the old in-process
install.

Windows has no supervisor that starts DSH again after it exits, and it locks the files of
a running program, so `npm install -g` over a running Host typically fails with `EBUSY`.
The desktop apps update themselves.

## Three actions

| | Reload | Full restart | Update DSH |
| --- | --- | --- | --- |
| How | `hmr.runExclusive(() => hmr.reconcileProfile())` | `systemctl --user --no-block restart <unit>` | A transient `systemd-run --user` service runs stop → npm install → profile reconcile and official plugin update → start → health check, with rollback |
| Process | Same pid; changed modules are swapped | New process | New process |
| Sessions | Keep running | Interrupted | Interrupted for the whole update: the service is stopped before npm touches the package tree |
| Typical time | About a second | Stop (under a second here) plus a full boot | Depends on the download and profile update; the panel shows the real elapsed time. 15 minutes is a timeout, not an expectation |
| Needs | `hmr` in the profile | This process in a systemd user unit | A unit, a writable global npm install, `systemd-run`; pnpm for the profile reconcile |
| Covers | Plugin code, profile `package.json`, patch files | Everything, including DSH itself | A new DSH version, the profile's dependency tree, and official `@deepseek-ai/dsh-*` profile plugins |

`reconcileProfile` compares every loaded profile module with the disk, so it also catches a
change the file watcher missed or one outside the `hmr` roots, such as a package
reinstalled under `node_modules`. It cannot replace DSH's own modules. Its restart reasons
are `no-hmr`, `host-module`, `unmanaged-plugin`, `package-moved` and `module-comparison`; a
reconcile that throws means the replaced plugin may not be running.

### After a reload

`planAfterReload(outcome, canRestart, active)` decides:

- `done`: the soft reload covered everything;
- `restart`: a restart is needed and no session is running a turn, so it restarts at once;
- `confirm`: a restart is needed but a turn is running, or the Host cannot tell. The page
  asks "Restart now / Later". The user agreed to a reload, not to cutting off a turn;
- `manual`: a restart is needed but this Host cannot do it.

A full restart skips the soft step. Use it for a stuck process.

## Confirmation dialog and update progress

Buttons, left to right: Cancel (focused, so a reflexive Enter does nothing), Full restart,
Update DSH, Reload. Esc and a press that starts and ends on the backdrop cancel. Esc is
caught on `window` in the capture phase, because the Host binds Esc to stopping the turn.
Above the buttons:

- with an update, a line naming the target and the running version;
- where a full restart is possible and a session is running or the count is unknown, a
  warning that the restart interrupts those turns.

The footer button is a direct `<button>` with a direct `<svg>` power icon. A generic
footer-action normaliser such as `dsh-ui-tweaks` forces that button's colour to the grey
label token, so the update marker cannot use `currentColor`. It is a child
`.slp-rs-update-badge` with its own success colour and a small up arrow; the grey power
icon stays untouched. The badge and ring stop animating under `prefers-reduced-motion`.

Choosing Update DSH replaces the confirmation dialog with a modal progress panel, whose
first active step is already the stop (the request is accepted before the service goes
down):

1. stop the service;
2. download and install the new version;
3. refresh the profile dependencies;
4. start and verify.

The active step spins, completed steps get a check, and an indeterminate bar moves while
npm works. npm exposes no trustworthy percentage, so the page never invents one.
`已用时 N 秒` and the log path carry the real state. The panel stays open while the Host
is down: an unreachable probe keeps the last known step active instead of jumping ahead,
and the page reconnects on the same origin to read the runner's job. It reloads 500 ms
after the new process reports the requested version. Failure, `rolled-back`,
`stale-version` and `unknown` states keep the panel with recovery actions: Retry where the
Host is back, Copy log command when a log path is known, Reload now for an unknown result,
and Dismiss. The update deadline is 15 minutes.

## DSH update

Offered only when all of these hold:

- `resolveHostInstall` finds the running Host in the writable global npm prefix, from the
  `npm root -g` of this process;
- the Host runs as a systemd user service, because new DSH code always needs a full
  restart;
- `systemd-run` is available.

The availability read is a single ~70-byte registry dist-tags document, on each page load,
at most once every ten minutes; a failure is retried after one.

The update itself:

1. the route receives `{mode: "update", version}`; `createRestartController` writes a job
   id and answers 202 before it does anything;
2. `createHostUpdater.start` writes `statusline-host-update.json` (job) and
   `statusline-host-update.spec.json` (one pinned version, unit, root, profile),
   then starts `host-update-runner.js` as a transient `systemd-run --user` service;
3. the runner writes `phase: stopping`, waits 500 ms for the response and `systemd-run`
   to leave, then `systemctl --user stop <unit>`;
4. it runs `npm install -g @deepseek-ai/dsh@<version> --prefix <npm prefix>`
   (`--prefix` is the global prefix that owns `npm root -g`, not the `node_modules`
   directory itself) and verifies the installed manifest version;
5. with a valid `profileContext` (not `desktop`), it snapshots the profile's
   `package.json` and `pnpm-lock.yaml`, then runs the new CLI as
   `node <root>/@deepseek-ai/dsh/lib/bin.js plugin --profile <name> install` from the
   profile directory. A missing pnpm (exit 127) skips this step and records
   `reconcileSkipped: "pnpm-not-found"`; without a profile context the step is marked
   skipped as not needed; any other failure rolls back;
6. after the reconcile, it selects the profile's `@deepseek-ai/dsh-*` dependencies that
   are registry specs (never `link:`, `file:`, `workspace:` or catalog entries) and runs
   the new CLI with `plugin --profile <name> update <package>...` for each, **without**
   pinning them to the DSH version. Each official plugin keeps its own declared range and
   release cadence; a plugin that has no build for this exact DSH version is simply left
   at its newest available version. The command passes
   `--config.minimumReleaseAge=0` for this one update: pnpm 12 otherwise rejects the
   profile's existing lock because several entries are newer than its release-age cutoff.
   Linked, file and third-party dependencies are never selected. An update failure (or a
   missing pnpm) restores the snapshot, repairs the profile with `install`, records
   `officialPluginsFailed` or `officialPluginsSkipped`, and continues: a profile plugin
   must not roll back a healthy DSH update. Afterward it runs `plugin list` once more and
   records official packages that are still incompatible as `officialPluginsIncompatible`;
   that is a visible warning, not a start gate;
7. it runs `reset-failed` and `start`, then treats the unit as healthy after
   `ActiveState=active`, `SubState=running` and a stable `MainPID` for ten seconds;
8. any failure after the install stops the unit, restores the profile snapshot, reinstalls
   the previous pinned version, runs the old CLI's profile reconcile again (the failed
   attempt may already have rewritten the profile's dependency tree), starts it and
   verifies it. The job ends `rolled-back`. If the rollback itself fails, the job ends
   `failed` with `error: "rollback-failed"` and leaves the log path in the panel.

The updater does not keep a second DSH version on disk. `npm install -g` replaces the
global package directory in place, so there is no old version folder to delete. The job
keeps only `previousVersion`; rollback reinstalls that exact version from npm (the npm
cache may satisfy it). There is no local tarball backup, so a registry that can no longer
serve the previous version turns rollback into `rollback-failed`; the panel shows that and
keeps the log command. The job and spec are overwritten on every run, and the log is
truncated at the start, so repeated updates do not grow state files. The npm cache is
npm-managed and is not part of this plugin's cleanup.

`runHostUpdate` never shells out: every command is an argv array, the version is
`^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$`, the unit is a `.service` name, the profile name is
a plain identifier, and the profile directory, root, job and log paths are absolute. The
job file is written atomically with mode 0600.

The new process reports `hostVersion` in the restart status. `hostVersion` reads the
package that owns the running bin first, so a stale profile dependency cannot report an
older version than the process that is actually running. The page accepts `done` only
when the pid changed, `ready` is true, and `hostVersion` equals the requested version. A
new pid with an older version, or with no version at all, is `stale-version`; the panel
says to check the service unit's `ExecStart`. A rolled-back update returns the old
version and is not silently reloaded as success.

`npm install -g` is never run inside the Host: it replaces the package tree the process
executes from, and an interrupted install can leave the `dsh` command without regenerated
shims. The transient service also outlives the unit stop, so the same stop cannot kill the
installer or the health check.

### A plain restart

`restartUnit` runs `systemctl --user reset-failed <unit>` then
`systemctl --user --no-block restart <unit>`. The `systemctl` helper is a child of the
Host and therefore of the unit's cgroup; systemd may send it the same SIGTERM that stops
the unit. The job was queued before that stop began, so a SIGTERM here is accepted, not
reported as a failed restart. A real non-zero exit still becomes `failed` with reason
`systemctl`.

## Progress state

`restart.status()` carries `soft`, `full`, `unit`, `pid`, `hostVersion`, `profile`, the
run phase, the active-session count and the current `job`. `restartStep` maps a probe:

- same pid: follow the Host phase (`reloading`, `reloaded` → done, `confirm`, `manual`,
  `updating`, `restarting`, `failed`) and, during an update, the job phase (`queued` or
  `stopping`, `installing`, `reconciling`, `starting`, `verifying`, `healthy`). Before
  the helper's first job write, the Host's `updating` is shown as the stop step;
- connection refused: the bounce;
- a new pid: done only with HTTP 200 and `ready` (which waits for `loader.await()`, so the
  session list is loaded); a 503 or a missing route is still booting;
- an update adds `done` only with the expected `hostVersion`; otherwise `stale-version`,
  `rolled-back` or `failed`.

`runRestart` reads the pid, posts, then probes every 250 ms for 15 s and every second after
that. The update deadline is 15 minutes, long enough for stop, npm, profile reconcile,
start and rollback. `restartProgressSteps` is the pure four-step map used by the panel and
by the client tests.

## Settings

`showRestartButton` is on by default. Off hides the button, makes the Host answer `GET
restart` with only `{ disabled: true, pid, ready }` (no registry read; `ready` lets a
restart already in flight be observed), and makes `POST restart` answer 409. A reload is
offered only with `hmr`; a full restart only inside a systemd user unit. The update also
needs the conditions under [DSH update](#dsh-update).

## State and failure rules

The run's state lives on `globalThis[Symbol.for('dsh-statusline-plus.restart')]`, not in
this module: a soft reload can evict this module and dispose the fiber that started it,
and the replacement must still report the old copy's run.

The public phases are `idle`, `reloading`, `reloaded`, `confirm`, `manual`, `updating`,
`restarting`, `failed` (reason `systemctl` or `update-<code>`), and the update job's
`queued`/`stopping`/`installing`/`reconciling`/`starting`/`verifying`/`healthy`/
`rolling-back`/`rolled-back`/`failed`. A refused or failed service call releases the lock
so the user can retry.

After a self-update of this plugin whose hot apply failed, the settings header's "Restart
to apply" opens the same dialog where a full restart is available, and stays disabled
elsewhere. A successful hot apply records the reconciled version, so the prompt does not
return on the next settings visit.

## Tests

`tests/restart.test.js`, `tests/host-update.test.js`,
`tests/host-update-runner.test.js`, and the restart cases at the end of
`tests/client-lifecycle.test.js`. The UI smoke check `npm run verify -- --ui restart`
mounts the real footer button and dialog against an offline fetch fixture, asserts the
green badge survives a simulated footer `!important` colour rule, advances the four job
phases, checks the active-step animation and renders the rolled-back actions. No test runs
a real `systemctl stop`, npm install or DSH restart.
