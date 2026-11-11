#!/usr/bin/env node
/**
 * Gate before creating a release tag.
 *
 * 0.1.16 was tagged in the same push that first sent its commits to CI. The
 * tag's run was then the first full browser check of that code, it failed, and
 * the only ways forward were a force-moved tag or a skipped version. This gate
 * makes the full CI run on the exact commit happen, and pass, before any tag
 * exists, so a tag is only ever created for code that already passed.
 *
 * It checks, in order: version metadata, a clean tree on main that is already
 * on origin, no existing tag or npm version, and a successful `Verify` run for
 * HEAD in which the browser smoke step actually ran.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { badgeVersion, changelogSection } from './release-check.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
export const BROWSER_STEP = 'Offline browser smoke check'
export const FULL_RUN_COMMAND = 'gh workflow run Verify --ref main -f full=true'

/**
 * Whether a Verify run proves HEAD: it succeeded and its browser step ran and
 * passed. A plain push may skip that step when no UI file changed, and a skipped
 * step proves nothing about the release.
 * @param {{conclusion: string, jobs?: Array<{steps?: Array<{name: string, conclusion: string}>}>}} run
 * @returns {{ok: boolean, detail: string}}
 */
export function runProvesBrowser(run) {
  if (!run) return { ok: false, detail: 'no Verify run for this commit' }
  if (run.status && run.status !== 'completed') return { ok: false, detail: 'Verify still running' }
  if (run.conclusion !== 'success') return { ok: false, detail: 'Verify ' + (run.conclusion || 'unknown') }
  const steps = (run.jobs || []).flatMap(job => job.steps || [])
  const browser = steps.find(step => step.name === BROWSER_STEP)
  if (!browser) return { ok: false, detail: 'browser step not found in the run' }
  if (browser.conclusion !== 'success') return { ok: false, detail: 'browser step ' + (browser.conclusion || 'unknown') }
  return { ok: true, detail: 'browser checks passed' }
}

/**
 * The best evidence among Verify runs for one commit: any run that proves the
 * browser checks wins; otherwise the newest run explains what is missing.
 */
export function bestRun(runs) {
  const list = Array.isArray(runs) ? runs : []
  return list.find(run => runProvesBrowser(run).ok) || list[0] || null
}

function run(command, args) {
  return execFileSync(command, args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function tryRun(command, args) {
  try { return { ok: true, value: run(command, args) } } catch (error) {
    return { ok: false, value: '', error: String((error && error.stderr) || (error && error.message) || error).trim() }
  }
}

function main() {
  const checks = []
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail || '' })
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'))
  const version = String(pkg.version || '')
  const tag = 'v' + version

  add('package.json version', VERSION_PATTERN.test(version), version)
  const badge = badgeVersion(readFileSync(resolve(REPO_ROOT, 'README.md'), 'utf8'))
  add('README version badge', badge === version, 'badge ' + (badge || 'not found'))
  add('CHANGELOG notes', changelogSection(readFileSync(resolve(REPO_ROOT, 'CHANGELOG.md'), 'utf8'), version) !== null, '## ' + version)

  const dirty = tryRun('git', ['status', '--porcelain'])
  add('clean working tree', dirty.ok && dirty.value === '', dirty.ok ? (dirty.value ? 'uncommitted changes' : 'clean') : dirty.error)
  const branch = tryRun('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
  add('on main', branch.value === 'main', branch.value || branch.error)
  tryRun('git', ['fetch', '--quiet', 'origin', 'main', '--tags'])
  const head = tryRun('git', ['rev-parse', 'HEAD']).value
  const remote = tryRun('git', ['rev-parse', 'origin/main']).value
  add('HEAD pushed to origin/main', head && head === remote, head === remote ? head.slice(0, 7) : 'push main first: git push origin main')

  const local = tryRun('git', ['tag', '--list', tag]).value
  add('tag ' + tag + ' not yet created', local !== tag, local === tag ? 'exists; bump the version instead of moving a tag' : 'free')
  const npm = tryRun('npm', ['view', pkg.name + '@' + version, 'version'])
  add('version not on npm', !(npm.ok && npm.value === version), npm.ok && npm.value === version ? 'already published' : 'unpublished')

  let evidence = { ok: false, detail: 'gh unavailable' }
  const list = tryRun('gh', ['run', 'list', '--workflow', 'Verify', '--commit', head, '--json', 'databaseId,status,conclusion', '--limit', '10'])
  if (list.ok) {
    const runs = JSON.parse(list.value || '[]').map(item => {
      const view = tryRun('gh', ['run', 'view', String(item.databaseId), '--json', 'jobs'])
      return { ...item, jobs: view.ok ? JSON.parse(view.value).jobs : [] }
    })
    evidence = runProvesBrowser(bestRun(runs))
  }
  add('CI browser checks on HEAD', evidence.ok, evidence.ok ? evidence.detail : evidence.detail + '; run: ' + FULL_RUN_COMMAND)

  for (const check of checks) console.log((check.ok ? '✓ ' : '✗ ') + check.name + ' — ' + check.detail)
  const ok = checks.every(check => check.ok)
  console.log(ok
    ? `PASS: tag with  git tag -a ${tag} -m ${tag} && git push origin ${tag}`
    : 'FAIL: fix the items above; do not create the tag. See docs/development/releasing.md.')
  return ok ? 0 : 1
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exitCode = main()
