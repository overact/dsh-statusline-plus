# Git chip

Shows the repository path, branch, ahead/behind, staged, unstaged, untracked and conflict
counts, and added/deleted lines for the session's workspace, locally or over SSH.

## Code

`GitLine` and the refresh logic in `LiveStatusPanel` (`lib/client.js`); `fetchGitStatus`,
`resolveGitRepo`, `parseGitStatusV2`, `parseNumstat`, `createGitLookups`
(`lib/git-status.js`); the `git` route (`lib/index.js`).

Settings: `showGit`, `showCwd`, `gitCwd`.

## Which directory

`gitCwd` if set, then the session summary's `cwd`, then the workspace containing the
session. The current directory is authoritative: the plugin never infers a repository
from history.

## When it refreshes

There is no timer. It refreshes on mount, on a change of session or directory, when a step
ends (`sessionStats.steps` rises), when the page regains visibility or focus, and on manual
retry. Requests for one session and directory merge, and at most one runs per second; a
trailing refresh runs after the current one.

## Rules

- **Stay out of the user's way.** Every command runs with `--no-optional-locks` and
  `core.fsmonitor=false`, so a status check never takes the index lock or starts a daemon.
  Keep this in `gitCommand` for any new command.
- **Line counts** come from `git diff HEAD --numstat --no-ext-diff`, one round trip for
  staged and unstaged together. A repository with no commits has no `HEAD`, so it uses
  `--cached`. Binary files report `-` and are left out; untracked files appear only in the
  untracked count.
- **Partial failure.** If only the line count fails, the rest still shows with
  `lineStatsError`. If a refresh fails, the old data stays and is marked stale.

## SSH

With a negotiated `sshRemoteHostBridge`, commands go through its routed subprocess.
`repoRoot` stays the local anchor path, used for links, while the label uses
`remote.host` and `remote.root`. A root outside the workspace anchor is an error. The
bridge appearing or leaving clears the Git caches.

## Caching

Each spawn is a round trip over SSH and status runs after every step, so `createGitLookups`
keeps found roots and the Git path for 60 s. Only found roots are kept, so a new `git init`
shows at once. A root that stops working is resolved again. A repository nested inside a
cached one waits for the TTL or a manual refresh.

## Errors

The chip does not display error text. With no data it renders nothing, and with old data it
adds a stale mark. The route's response is the place to look when debugging. Its messages are
raw, some in Chinese.

| Situation | Route result | Chip with no earlier data |
| --- | --- | --- |
| Not a repository, or the directory is gone | `isRepo: false` | Hidden, as intended |
| `safe.directory` refusal, corrupt `.git/HEAD` | `isRepo: false` | Hidden |
| Corrupt `.git/index` | Error | Hidden |
| Status output over 262144 bytes, such as 12000 untracked files | `git-output-too-large` | Hidden |
| Git hangs past the deadline | `git-timeout` | Hidden |
| No Git executable | Error | Hidden |

**Known gap:** `resolveGitRepo` treats every `rev-parse` failure as "not a repository", so the
second row is indistinguishable from the first, even on the Host. A hidden chip also has no
retry button, though later refreshes still run. The only recovery signal is the chip
returning.

## Tests

`tests/statusline.test.js`, `tests/client-lifecycle.test.js`.
