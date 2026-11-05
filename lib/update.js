'use strict'
/**
 * Self-update: the installed version, the version the registry publishes, and
 * an in-place overlay install.
 *
 * The check asks the registry directly instead of a market plugin, so the
 * settings page can offer an update on any host that runs this plugin. The
 * install uses the host's own CLI or its own pnpm, else `pnpm` from PATH, as an
 * overlay, not a remove-then-install: unloading this plugin to replace it kills the
 * request that asked for the update. `hotApplyUpdate` in index.js then swaps the
 * new copy in through HMR; a profile without HMR loads it on the next start.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_NAME = 'dsh-statusline-plus'
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const DEFAULT_TTL_MS = 60 * 1000
const FETCH_TIMEOUT_MS = 8000
const INSTALL_TIMEOUT_MS = 180000
const OUTPUT_LIMIT = 4000

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** The manifest of the copy that is actually running (installed or linked). */
export function readInstalled() {
  try {
    const manifest = readJson(fileURLToPath(new URL('../package.json', import.meta.url)))
    return {
      name: typeof manifest.name === 'string' ? manifest.name : PACKAGE_NAME,
      version: typeof manifest.version === 'string' ? manifest.version : null,
      engines: manifest.engines,
    }
  } catch (error) {
    return { name: PACKAGE_NAME, version: null, engines: undefined }
  }
}

/** The version this module was loaded from. A hot swap evaluates the module again. */
const LOADED_VERSION = readInstalled().version

/**
 * Where this copy lives.
 *
 * A profile install is `<DSH_HOME>/profiles/<profile>/node_modules/<name>`, so
 * the profile directory can be recovered from the running module's own path.
 * A linked checkout (development, or `dsh plugin add ./dir`) resolves to the
 * source tree instead; that copy is not the registry's to replace.
 */
export function resolveInstall() {
  const file = fileURLToPath(new URL('../package.json', import.meta.url))
  const parts = file.split(sep)
  const at = parts.lastIndexOf('profiles')
  if (at > 0 && parts[at + 2] === 'node_modules' && parts[at + 3] === PACKAGE_NAME) {
    return { linked: false, profile: parts[at + 1], dir: parts.slice(0, at + 2).join(sep) }
  }
  return { linked: true, profile: null, dir: null }
}

/** Numeric semver comparison; a release sorts above its own prereleases. */
export function compareVersions(left, right) {
  const parse = value => {
    const [core, pre = ''] = String(value || '').split('-', 2)
    const numbers = core.split('.').map(part => Number.parseInt(part, 10) || 0)
    return { numbers, pre }
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.numbers[index] || 0) - (b.numbers[index] || 0)
    if (difference !== 0) return difference > 0 ? 1 : -1
  }
  if (a.pre === b.pre) return 0
  if (a.pre === '') return 1
  if (b.pre === '') return -1
  return a.pre > b.pre ? 1 : -1
}

/**
 * The running DSH version, or null when it cannot be established.
 *
 * `@deepseek-ai/dsh-app-boot` carries the runtime version the compatibility
 * gate compares against, so reading it keeps this check in step with the gate
 * that would refuse the install.
 */
export function hostVersion() {
  const fromEnv = process.env.DSH_VERSION
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  try {
    const required = createRequire(import.meta.url)
    return readJson(required.resolve('@deepseek-ai/dsh-app-boot/package.json')).version
  } catch (error) { /* not resolvable from this copy */ }
  const bin = process.argv[1]
  if (typeof bin === 'string' && bin !== '') {
    // .../node_modules/@deepseek-ai/dsh/lib/bin.js -> .../node_modules/@deepseek-ai/dsh
    try {
      return readJson(join(dirname(dirname(bin)), 'package.json')).version
    } catch (error) { /* a host launched from somewhere else */ }
  }
  return null
}

/**
 * Whether `range` admits `version`.
 *
 * Only the operators this plugin's own manifest uses are understood (`>=`,
 * `>`, `<=`, `<`, `^`, exact, space-separated conjunctions). An unreadable
 * range answers null — unknown, which must not hide an update.
 */
export function enginesAllow(range, version) {
  if (typeof range !== 'string' || range.trim() === '') return null
  if (typeof version !== 'string' || version.trim() === '') return null
  for (const term of range.trim().split(/\s+/)) {
    const match = /^(>=|>|<=|<|\^|=)?\s*v?(\d+)\.(\d+)\.(\d+)/.exec(term)
    if (match === null) return null
    const difference = compareVersions(version, `${match[2]}.${match[3]}.${match[4]}`)
    const operator = match[1] || '='
    const satisfied = operator === '>='
      ? difference >= 0
      : operator === '>'
        ? difference > 0
        : operator === '<='
          ? difference <= 0
          : operator === '<'
            ? difference < 0
            : operator === '^'
              ? difference >= 0
              : difference === 0
    if (!satisfied) return false
  }
  return true
}

/** The registry's `latest` manifest, bounded by its own deadline. */
export async function fetchLatest(options = {}) {
  const registry = String(options.registry || DEFAULT_REGISTRY).replace(/\/+$/, '')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(`${registry}/${PACKAGE_NAME}/latest`, {
      headers: { accept: 'application/json' },
      signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal,
    })
    if (!response.ok) throw new Error(`registry ${response.status}`)
    const manifest = await response.json()
    if (manifest === null || typeof manifest !== 'object' || typeof manifest.version !== 'string') {
      throw new Error('registry manifest has no version')
    }
    return { version: manifest.version, engines: manifest.engines }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * What the settings page needs, cached for a minute.
 *
 * The page asks once per visit; the minute keeps a quick section switch from
 * asking the registry again, while a release published a moment ago still shows
 * up on the next visit.
 *
 * A registry failure is reported as `error` with the installed version intact:
 * the page hides the button instead of claiming the plugin is current.
 *
 * Only the registry's answer is cached. Everything that depends on the installed
 * copy is worked out on each call, because an install changes it inside the
 * minute. `installed` is what is on disk and `loaded` is what is running, so
 * `restartRequired` stays true until the new copy is really in use.
 */
export function createUpdateChecker(options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_TTL_MS
  const now = typeof options.now === 'function' ? options.now : Date.now
  const log = typeof options.log === 'function' ? options.log : () => {}
  const installedVersion = typeof options.installedVersion === 'function' ? options.installedVersion : () => readInstalled().version
  const loaded = options.loadedVersion === undefined ? LOADED_VERSION : options.loadedVersion
  let cached = null
  return async function check(input = {}) {
    const installed = installedVersion()
    const install = resolveInstall()
    const host = hostVersion()
    const stamp = now()
    const local = {
      installed,
      loaded,
      restartRequired: installed !== null && loaded !== null && compareVersions(installed, loaded) > 0,
      install,
      host,
    }
    if (input.force === true || cached === null || stamp - cached.at >= ttlMs) {
      try {
        cached = { at: stamp, latest: await fetchLatest({ registry: options.registry, signal: input.signal }) }
      } catch (error) {
        log('update check failed: ' + ((error && error.message) || String(error)))
        return {
          latest: null,
          latestEngines: null,
          compatible: null,
          updateAvailable: false,
          checkedAt: new Date(stamp).toISOString(),
          error: 'registry',
          ...local,
        }
      }
    }
    const { latest, at } = cached
    return {
      latest: latest.version,
      latestEngines: (latest.engines && latest.engines.dsh) || null,
      compatible: enginesAllow(latest.engines && latest.engines.dsh, host),
      updateAvailable: installed !== null && compareVersions(latest.version, installed) > 0,
      checkedAt: new Date(at).toISOString(),
      error: null,
      ...local,
    }
  }
}

/** The DSH CLI entry the running host was started from, when it can be identified. */
function hostCliEntry() {
  const entry = process.argv[1]
  if (typeof entry !== 'string' || entry === '') return null
  try {
    // A host started through the `dsh` command reports that symlink, not bin.js.
    const real = realpathSync(entry)
    if (!/@deepseek-ai[\\/]dsh[\\/]/.test(real)) return null
    return statSync(real).isFile() ? real : null
  } catch (error) {
    return null
  }
}

/**
 * The pnpm a host ships for its own plugin management, from `profileContext`.
 *
 * A desktop build runs it through its own executable, so the prefix arguments
 * and the environment are as necessary as the command. Absent on a host that
 * uses `pnpm` from PATH, or that predates this field.
 * @param {object} ctx plugin context.
 * @returns {{command: string, args: string[], env: object|undefined}|null} the package manager, or null.
 */
export function hostPackageManager(ctx) {
  let manager
  try {
    manager = typeof ctx?.get === 'function' ? ctx.get('profileContext')?.packageManager : undefined
  } catch (error) {
    return null
  }
  if (typeof manager?.command !== 'string' || manager.command === '') return null
  const args = Array.isArray(manager.args) ? manager.args.filter(arg => typeof arg === 'string') : []
  const env = manager.env !== null && typeof manager.env === 'object' ? manager.env : undefined
  return { command: manager.command, args, env }
}

/**
 * The installs to try, most specific first.
 *
 * Only an installer already on this machine is used. Fetching pnpm with `npx`
 * is deliberately absent: it installs an unpinned pnpm, and npm 12 can leave
 * that copy without its native entry, so the install fails before it starts.
 * @param {object} subprocess host subprocess service.
 * @param {string} profile profile name the running copy belongs to.
 * @param {string} version version to install.
 * @param {{command: string, args: string[], env: object|undefined}|null} [packageManager] the host's own pnpm.
 * @returns {Promise<Array<{label: string, argv: string[], env: (object|undefined)}>>} installs to attempt, in order.
 */
async function installPlans(subprocess, profile, version, packageManager) {
  const spec = `${PACKAGE_NAME}@${version}`
  const plans = []
  const entry = hostCliEntry()
  if (entry !== null && typeof profile === 'string' && profile !== '') {
    plans.push({ label: 'dsh plugin', argv: [process.execPath, entry, 'plugin', '--profile', profile, 'add', spec] })
  }
  if (packageManager) {
    plans.push({ label: 'host pnpm', argv: [packageManager.command, ...packageManager.args, 'add', spec], env: packageManager.env })
  }
  let resolved
  try {
    resolved = await subprocess.resolveExecutable('pnpm')
  } catch (error) {
    resolved = undefined
  }
  if (typeof resolved === 'string' && resolved !== '') {
    plans.push({ label: 'pnpm', argv: [resolved, 'add', spec] })
  }
  return plans
}

/** Run one installer and collect its output, without letting it outlive the deadline. */
async function runInstall(plan, input) {
  const { profileDir, subprocess, signal } = input
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), INSTALL_TIMEOUT_MS)
  try {
    let handle
    try {
      handle = subprocess.spawn({
        argv: plan.argv,
        cwd: profileDir,
        ...(plan.env ? { env: plan.env } : {}),
        stdio: {
          stdin: 'ignore',
          stdout: { collect: true, maxBytes: 262144 },
          stderr: { collect: true, maxBytes: 262144 },
        },
        graceMs: 500,
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      })
    } catch (error) {
      return { exitCode: 127, output: String((error && error.message) || error), manager: plan.label, spawnFailed: true }
    }
    const outcome = await handle.done
    const stdout = handle.collected?.stdout?.readFrom(0)?.text || ''
    const stderr = handle.collected?.stderr?.readFrom(0)?.text || ''
    const output = `${stdout}\n${stderr}`.trim()
    return {
      exitCode: typeof outcome.exitCode === 'number' ? outcome.exitCode : 1,
      output: output.length > OUTPUT_LIMIT ? output.slice(-OUTPUT_LIMIT) : output,
      manager: plan.label,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Install `version` over the running copy.
 *
 * This only puts the files on disk. Loading them is a separate step: see
 * `hotApplyUpdate` in index.js.
 */
export async function applyUpdate(input) {
  const { version, profileDir, profile, subprocess, signal, packageManager } = input || {}
  if (typeof profileDir !== 'string' || profileDir === '') throw new Error('no-profile')
  if (subprocess === undefined || subprocess === null) throw new Error('no-subprocess')
  const plans = await installPlans(subprocess, profile, version, packageManager)
  if (plans.length === 0) throw new Error('no-package-manager')
  let firstFailure = null
  for (const plan of plans) {
    const result = await runInstall(plan, { profileDir, subprocess, signal })
    if (result.exitCode === 0) return result
    // An installer that could not start at all is not an answer; a real failure is.
    if (firstFailure === null && result.spawnFailed !== true) firstFailure = result
  }
  return firstFailure || { exitCode: 127, output: 'no installer could run', manager: plans[plans.length - 1].label }
}
