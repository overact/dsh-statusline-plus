'use strict'
/**
 * Update DSH itself (`@deepseek-ai/dsh`), the same job as `npm install -g`.
 *
 * Offered only where it is safe to do from the browser:
 *   - the running Host was started from the global npm install of DSH, and
 *   - that global root is writable by this user, and
 *   - the Host runs in a systemd user unit (checked by the caller), because new
 *     DSH code always needs a full restart.
 * A desktop app, a pnpm/npx/linked Host or a root-owned prefix reports a reason
 * and the page shows no update.
 */
import { execFile, spawn } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { compareVersions, DEFAULT_REGISTRY } from './update.js'

export const HOST_PACKAGE = '@deepseek-ai/dsh'
// The read is one ~70-byte JSON, so a page load may ask again after a minute;
// the cooldown only stops a burst of tabs or reloads from repeating it.
const CHECK_TTL_MS = 60 * 1000
const FAILURE_TTL_MS = 60 * 1000
const FETCH_TIMEOUT_MS = 8000
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000
const OUTPUT_LIMIT = 4000
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

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

/**
 * Cached update check plus the install itself.
 * @param {object} [options]
 * @param {Function} [options.resolve] resolveHostInstall replacement for tests.
 * @param {Function} [options.latest] registry lookup replacement for tests.
 * @param {Function} [options.spawn] spawn replacement for tests.
 */
export function createHostUpdater({ registry, resolve = resolveHostInstall, latest = signal => fetchDistTag({ registry, signal }), spawn: spawnFn = spawn, now = Date.now } = {}) {
  let cached = null
  let pending = null

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

  /** The update state; a minute of cooldown between registry reads. */
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

  /**
   * Install exactly the version the last check offered. Resolves with null on
   * success, or an Error whose message is a fixed code.
   */
  async function install(version) {
    const state = cached && cached.value
    if (!state || !state.available || state.latest !== version || !VERSION_RE.test(version)) return new Error('not-offered')
    const target = await resolve()
    if (!target.supported) return new Error(target.reason)
    const outcome = await new Promise(done => {
      let child
      let output = ''
      try {
        child = spawnFn(npmCommand(), ['install', '-g', `${HOST_PACKAGE}@${version}`, '--no-fund', '--no-audit'], { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        done({ code: 127, output: String(error && error.message) })
        return
      }
      const keep = chunk => { output = (output + chunk).slice(-OUTPUT_LIMIT) }
      child.stdout?.on('data', keep)
      child.stderr?.on('data', keep)
      // npm rolls back a failed reify, so stopping it never leaves half a package.
      const timer = setTimeout(() => child.kill('SIGTERM'), INSTALL_TIMEOUT_MS)
      child.once('error', error => { clearTimeout(timer); done({ code: 127, output: String(error && error.message) }) })
      child.once('close', code => { clearTimeout(timer); done({ code: code ?? 1, output }) })
    })
    cached = null
    if (outcome.code !== 0) return Object.assign(new Error('install-failed'), { output: outcome.output })
    const installed = readPackage(target.dir)?.version
    if (installed !== version) return Object.assign(new Error('version-mismatch'), { output: `installed ${installed}` })
    return null
  }

  return { check, install }
}
