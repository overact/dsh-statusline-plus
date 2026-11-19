'use strict'
/**
 * Update DSH itself (`@deepseek-ai/dsh`), the same job as `npm install -g`.
 *
 * Offered only where it is safe to do from the browser:
 *   - the running Host was started from the global npm install of DSH, and
 *   - that global root is writable by this user, and
 *   - the Host runs in a systemd user unit, because new DSH code always needs a
 *     full restart.
 * A desktop app, a pnpm/npx/linked Host or a root-owned prefix reports a reason
 * and the page shows no update.
 *
 * The update itself never runs npm in the Host. It starts `host-update-runner.js`
 * as a transient systemd user service, which survives the stop of the Host's own
 * unit and writes the job file the page follows. See that file for the sequence.
 */
import { execFile } from 'node:child_process'
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { compareVersions, DEFAULT_REGISTRY } from './update.js'

export const HOST_PACKAGE = '@deepseek-ai/dsh'
// The read is one ~70-byte JSON. DSH releases are rare, so an answer is reused
// for ten minutes across tabs and reloads; a failed read is retried after one.
const CHECK_TTL_MS = 10 * 60 * 1000
const FAILURE_TTL_MS = 60 * 1000
const FETCH_TIMEOUT_MS = 8000
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const UNIT_RE = /^[A-Za-z0-9@._\\:-]+\.service$/
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const JOB_ID_RE = /^[A-Za-z0-9._-]+$/
const HELPER_START_TIMEOUT_MS = 15000

/**
 * The version a dist-tag points at, from the registry's dist-tags document
 * (`{"latest":"x",...}`, under 100 bytes) instead of a full manifest.
 */
export async function fetchDistTag({ registry = DEFAULT_REGISTRY, tag = 'latest', signal } = {}) {
  const base = String(registry || DEFAULT_REGISTRY).replace(/\/+$/, '')
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const response = await fetch(`${base}/-/package/${HOST_PACKAGE}/dist-tags`, {
    headers: { accept: 'application/json' },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  if (!response.ok) throw new Error(`registry ${response.status}`)
  const tags = await response.json()
  return { version: tags && typeof tags === 'object' ? tags[tag] : undefined }
}

function readPackage(dir) {
  try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) } catch { return null }
}

/** The DSH package directory the running Host was started from, or null. */
export function hostPackageDir(entry = process.argv[1]) {
  if (typeof entry !== 'string' || entry === '') return null
  let dir
  try { dir = dirname(realpathSync(entry)) } catch { return null }
  for (let depth = 0; depth < 4; depth += 1) {
    if (readPackage(dir)?.name === HOST_PACKAGE) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** npm beside the running node first: the systemd PATH may differ from a shell's. */
export function npmCommand(execPath = process.execPath) {
  const sibling = join(dirname(execPath), 'npm')
  return existsSync(sibling) ? sibling : 'npm'
}

// `npm root -g` costs a node process (about 0.1 s and 65 MB here) and cannot change
// for a running Host without a config edit, so it is asked once per process.
const npmRoots = new Map()

function run(command, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(String(stdout).trim()))
  })
}

/**
 * Whether this Host can update itself, and from where.
 * @returns {Promise<{supported: true, dir: string, root: string, version: string} | {supported: false, reason: string}>}
 */
export async function resolveHostInstall({ entry = process.argv[1], npm = npmCommand(), exec = run, access = accessSync } = {}) {
  const dir = hostPackageDir(entry)
  if (!dir) return { supported: false, reason: 'not-npm-host' }
  let root
  const key = exec === run ? npm : null
  try {
    root = key !== null && npmRoots.has(key) ? npmRoots.get(key) : await exec(npm, ['root', '-g'], 5000)
    if (key !== null) npmRoots.set(key, root)
  } catch { return { supported: false, reason: 'no-npm' } }
  let globalDir
  try { globalDir = realpathSync(join(root, ...HOST_PACKAGE.split('/'))) } catch { return { supported: false, reason: 'not-global' } }
  if (globalDir !== dir) return { supported: false, reason: 'not-global' }
  try { access(root, constants.W_OK) } catch { return { supported: false, reason: 'not-writable' } }
  const version = readPackage(dir)?.version
  if (typeof version !== 'string') return { supported: false, reason: 'not-npm-host' }
  return { supported: true, dir, root, version }
}

/** The npm global prefix that owns a `npm root -g` directory. */
export function globalPrefix(root) {
  const parent = dirname(root)
  return basename(parent) === 'lib' ? dirname(parent) : parent
}

/** The job, spec and log paths beside the other statusline state. */
export function defaultPaths(homePath = dshHomePath) {
  try {
    return {
      job: homePath('statusline-host-update.json'),
      spec: homePath('statusline-host-update.spec.json'),
      log: homePath('statusline-host-update.log'),
    }
  } catch { return null }
}

/** The PATH the transient helper's child commands need, including ~/.local/bin. */
export function updatePath(env = process.env, execPath = process.execPath) {
  const parts = String(env.PATH || '').split(delimiter).filter(Boolean)
  const extras = [env.HOME && join(env.HOME, '.local', 'bin'), dirname(execPath), '/usr/local/bin', '/usr/bin', '/bin']
  for (const dir of extras) if (dir && !parts.includes(dir)) parts.push(dir)
  return parts.join(delimiter)
}

/** Resolve the transient helper once; a Host without systemd-run cannot update. */
export function systemdRunAvailable({ exec = run } = {}) {
  return Promise.resolve().then(() => exec('systemd-run', ['--version'], 3000)).then(() => true, () => false)
}

/** One `execFile` with its exit code and a bounded diagnostic tail. */
function runCommand(command, args, timeout) {
  return new Promise(resolve => {
    execFile(command, args, { timeout, encoding: 'utf8' }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
      resolve({ code, output: String(stderr || stdout || '') })
    })
  })
}

/** A same-directory atomic JSON write with owner-only permissions. */
function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
  try { chmodSync(path, 0o600) } catch { /* best effort */ }
}

/**
 * Cached update check plus the update start itself.
 * @param {object} [options]
 * @param {Function} [options.resolve] resolveHostInstall replacement for tests.
 * @param {Function} [options.latest] registry lookup replacement for tests.
 * @param {Function} [options.exec] systemd-run and npm-root command replacement for tests.
 * @param {Function} [options.runCommand] transient helper launcher replacement for tests.
 * @param {object|null} [options.paths] job/spec/log paths; null disables updates.
 */
export function createHostUpdater({
  registry,
  resolve = resolveHostInstall,
  latest = signal => fetchDistTag({ registry, signal }),
  exec = run,
  runCommand: launch = runCommand,
  now = Date.now,
  paths = defaultPaths(),
} = {}) {
  let cached = null
  let pending = null
  let helper = null

  async function compute(signal) {
    const install = await resolve()
    if (!install.supported) return { supported: false, reason: install.reason, available: false }
    try {
      const manifest = await latest(signal)
      const target = manifest && manifest.version
      if (typeof target !== 'string' || !VERSION_RE.test(target)) throw new Error('bad-version')
      return { supported: true, installed: install.version, latest: target, available: compareVersions(target, install.version) > 0 }
    } catch {
      // Unknown stays unknown: no glow, and no claim that DSH is current.
      return { supported: true, installed: install.version, latest: null, available: false, error: 'registry' }
    }
  }

  /** The update state; ten minutes between registry reads, one after a failure. */
  async function check({ force = false, signal } = {}) {
    if (!force && cached && now() < cached.until) return cached.value
    if (!pending) {
      pending = compute(signal).then(value => {
        cached = { value, until: now() + (value.error ? FAILURE_TTL_MS : CHECK_TTL_MS) }
        return value
      }).finally(() => { pending = null })
    }
    return pending
  }

  /** The latest job written by the runner, or null. */
  function readJob() {
    if (!paths || !paths.job) return null
    try { return JSON.parse(readFileSync(paths.job, 'utf8')) } catch { return null }
  }

  /** Whether a transient systemd service can be started on this Host. */
  function helperAvailable() {
    if (helper === null) helper = systemdRunAvailable({ exec })
    return helper
  }

  /**
   * Start the out-of-process update. The Host answers before the helper stops
   * it; the runner owns the remaining sequence and the job file.
   * @returns {Promise<{ok: true, jobId: string, jobPath: string} | {ok: false, error: string, output?: string}>}
   */
  async function start({ version, unit, profile = null, jobId = null, env = null } = {}) {
    const state = cached && cached.value
    if (!state || state.available !== true || state.latest !== version || typeof version !== 'string' || !VERSION_RE.test(version)) {
      return { ok: false, error: 'not-offered' }
    }
    const install = await resolve()
    if (!install.supported) return { ok: false, error: install.reason }
    if (compareVersions(version, install.version) <= 0) return { ok: false, error: 'not-newer' }
    if (typeof unit !== 'string' || !UNIT_RE.test(unit)) return { ok: false, error: 'no-unit' }
    if (!paths) return { ok: false, error: 'no-home' }
    if (!(await helperAvailable())) return { ok: false, error: 'no-systemd-run' }
    // One log per run: the panel and `Copy log command` must not show lines
    // from a previous update, and repeated updates must not grow it forever.
    try { writeFileSync(paths.log, '', { mode: 0o600 }) } catch { /* the runner creates it */ }
    const id = typeof jobId === 'string' && JOB_ID_RE.test(jobId) ? jobId : `${process.pid}-${now().toString(36)}`
    const profileName = profile && typeof profile.name === 'string' && PROFILE_RE.test(profile.name) && profile.name !== 'desktop'
      ? profile.name : null
    const profileDir = profileName && typeof profile.dir === 'string' && isAbsolute(profile.dir) ? profile.dir : null
    const reconcile = profileName !== null && profileDir !== null
    const startedAt = new Date(now()).toISOString()
    const job = {
      id, version, previousVersion: install.version, unit,
      profile: profileName, phase: 'queued', startedAt, updatedAt: startedAt,
      hostPid: process.pid, logPath: paths.log, reconcile, error: null, output: '',
    }
    const childEnv = {}
    for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'XDG_RUNTIME_DIR', 'LANG']) {
      if (typeof process.env[key] === 'string' && process.env[key] !== '') childEnv[key] = process.env[key]
    }
    // A systemd user service often starts with a PATH without ~/.local/bin;
    // the new CLI needs pnpm there to refresh the profile dependencies.
    childEnv.PATH = updatePath(process.env, process.execPath)
    Object.assign(childEnv, env && typeof env === 'object' ? env : {})
    const spec = {
      id, version, previousVersion: install.version, unit,
      profile: profileName, profileDir,
      root: install.root,
      prefix: globalPrefix(install.root),
      node: process.execPath,
      npm: npmCommand(),
      systemctl: 'systemctl',
      jobPath: paths.job,
      logPath: paths.log,
      reconcile,
      hostPid: process.pid,
      env: childEnv,
    }
    writeJsonAtomic(paths.spec, spec)
    // The job comes after the spec: a spec write failure must not leave a
    // queued job that the page would follow forever.
    writeJsonAtomic(paths.job, job)
    const runner = fileURLToPath(new URL('./host-update-runner.js', import.meta.url))
    const args = ['--user', '--quiet', '--collect', '--no-block', `--unit=statusline-update-${id}`, process.execPath, runner, paths.spec]
    const launched = await launch('systemd-run', args, 10000)
    if (launched.code !== 0) {
      const failed = { ...job, phase: 'failed', error: 'helper-start', output: launched.output, finishedAt: new Date(now()).toISOString() }
      writeJsonAtomic(paths.job, failed)
      return { ok: false, error: 'helper-start', output: launched.output }
    }
    // `--no-block` only queues the unit. If the helper never writes its first
    // phase, the Host is still alive and can tell the page instead of spinning.
    const watchdog = setTimeout(() => {
      const current = readJob()
      if (!current || current.id !== id || current.phase !== 'queued') return
      writeJsonAtomic(paths.job, {
        ...current,
        phase: 'failed',
        error: 'helper-start',
        output: 'the update service did not start',
        finishedAt: new Date(now()).toISOString(),
      })
    }, HELPER_START_TIMEOUT_MS)
    watchdog.unref?.()
    return { ok: true, jobId: id, jobPath: paths.job }
  }

  return { check, start, readJob, helperAvailable }
}
