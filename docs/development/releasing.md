# Releasing

Maintainer notes for this plugin. User-facing installation stays in the README.

## Release order

A tag is created only for a commit that has already passed the full CI run, browser checks
included. 0.1.16 was tagged in the same push that first sent its code to CI; the tag's run
failed in the browser checks, and the version could only be skipped or the tag force-moved.

1. Bump `version` in `package.json`, the README version badge and the CHANGELOG heading; move
   the `Unreleased` notes under the new heading (leave no empty `Unreleased`).
2. Commit `chore(release): <version>` and push **main only**: `git push origin main`.
3. Request the full run on that commit and wait for it:
   `gh workflow run Verify --ref main -f full=true`, then `gh run watch <id> --exit-status`.
   A plain push may skip the browser step when no UI file changed, and a skipped step does not
   count.
4. Run `npm run release:preflight`. It requires version, badge and CHANGELOG notes to agree;
   a clean tree on `main` equal to `origin/main`; no existing tag and no npm version; and a
   successful `Verify` run for HEAD whose browser step ran. Fix anything it reports on `main`
   and go back to step 2; never tag past a failure.
5. Create and push the tag: `git tag -a v<version> -m v<version> && git push origin v<version>`.
6. The tag runs `.github/workflows/release.yml`, in this order, each step only if the last passed:
   1. **Verify:** the whole of `verify.yml` on that commit again, including the oldest supported
      DSH and the browser checks.
   2. **npm:** checks the tag against `package.json`, the README badge and the CHANGELOG, then
      publishes with provenance. A version already on npm is skipped.
   3. **GitHub Release:** builds the two byte-identical assets,
      `dsh-statusline-plus-<version>.tgz` and `dsh-statusline-plus.tgz`, and creates the latest
      release. Its notes are the version's CHANGELOG section. Edit them with `gh release edit`
      if the release deserves a better summary.
7. Run `npm run release:check` to confirm package, README badge, CHANGELOG, tag, npm dist-tag,
   Release assets and `releases/latest` all agree.

### A local UI smoke failure is not noise

On some machines a local smoke can fail for the environment. On the WSL development machine
the cost and Subagents clicks time out in Playwright's "stable" wait on the fixture page, while
plain pages and a forced click work and CI passes with the same Playwright. Never dismiss a
local UI failure as pre-existing from memory: compare the same panel on the base commit, and
treat CI's full run (step 3) as the deciding result. A different error from the known one is a
real failure.

### Fixture fidelity

`scripts/ui-fixture.mjs` stands in for the Host's slots. It renders every registration of a
slot in `order`, as the Host does, and mocks each route the client calls. A new slot
registration or route needs the fixture updated in the same change, with an assertion in
`scripts/verify-ui.mjs` that the new element appears beside the existing ones.

## When the tag run fails

- **Failed at Verify, or at npm's checks:** nothing was published. With the preflight this should not happen. If it does, prefer fixing on `main` and releasing the next patch version, with the failed version's notes moved under it; moving a pushed tag (`git tag -fa`, `git push -f origin v<version>`) rewrites a public ref and needs the maintainer's explicit go-ahead.
- **Failed at or after publishing:** never move the tag, because npm cannot republish a version. Re-run the workflow's failed jobs. A re-run skips what is already on npm, refreshes the assets and leaves the release notes alone. If the published code itself is wrong, release a new version.

## Fresh-install check

Optional, and worth running when the suite or the DSH dependency changed: it finds on your machine what would otherwise fail the tag run. The local `node_modules` can hold a newer DSH than the version `package.json` pins, and that pinned version is what CI tests. There is no lockfile, so CI always installs fresh. Run what CI runs on a committed copy of the release:

```sh
dir=$(mktemp -d)
git archive HEAD | tar x -C "$dir"
cd "$dir"
git init -q && git add -A && git -c user.name=check -c user.email=check@example.invalid commit -qm check
HOME="$dir/.home" npm install --ignore-scripts --no-audit --no-fund --no-package-lock
HOME="$dir/.home" npm run verify:all -- --ui none
```

The `git init` matters because Git tests read the checkout as a repository. The empty `HOME` keeps your login files out of the run. Delete the directory afterwards.

## npm trusted publishing

The workflow authenticates through OIDC trusted publishing; there is no `NPM_TOKEN` and no long-lived token in CI.

One-time setup on npmjs.com:

1. Open the package's [publishing access page](https://www.npmjs.com/package/dsh-statusline-plus/access).
2. Add a **Trusted Publisher** → **GitHub Actions**:
   - Organization or user: `overact`
   - Repository: `dsh-statusline-plus`
   - Workflow filename: `release.yml` (filename only)
   - Environment: leave empty
3. Under **Allowed actions**, enable **`npm publish`**. Configurations created after September 2026 allow only `npm stage publish` by default, so a missing direct-publish grant fails the workflow with 403.

npm removes bypass-2FA tokens for direct publishing in January 2027; OIDC trusted publishing is the supported replacement, not a temporary workaround.

### Stage-only alternative

To keep a manual approval before each publish, change the workflow step from `npm publish` to `npm stage publish`. Trusted publishers always allow staging, so no extra grant is needed. The tag run then leaves the version staged; publish it with 2FA through the npm website or `npm stage approve <id>`, and inspect pending items with `npm stage list`.

The `0.0.0-stage` entry that `npm view dsh-statusline-plus versions` shows is npm's staging placeholder (`stub: true`), not a release; it never occupies `latest`.

### Hardening after the first OIDC publish

On the same publishing access page, select **Require two-factor authentication and disallow tokens** and save. Manual publishes then use the 2FA code, and long-lived tokens can no longer publish.

## Checks

`npm run release:check` verifies the current package version against the README badge, changelog, git tag, npm dist-tags, GitHub Release assets and `releases/latest`. Use `--offline` to skip the npm and GitHub checks.
