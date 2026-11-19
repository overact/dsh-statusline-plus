'use strict'
/**
 * Out-of-process DSH update runner.
 *
 * The Host starts this file as a transient systemd user service through
 * `systemd-run`, so it survives the stop of the Host's own unit. It stops the
 * unit, installs one pinned global version, refreshes the profile's package
 * tree, starts the unit again and waits for a stable process. Any failure after
 * the install rolls the previous version back and starts it, so the browser
 * always has a Host to reconnect to.
 *
 * Keeping npm outside the running Host matters: npm replaces the package tree
 * the Host executes from, and a stop-install-start sequence is the supported
 * upgrade order. The runner writes its progress to one JSON file; the new Host
 * reads it through the restart route, which is how the page follows the update
 * across the bounce.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const UNIT_RE = /^[A-Za-z0-9@._\\:-]+\.service$/
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const ID_RE = /^[A-Za-z0-9._-]+$/
const MAX_OUTPUT = 4096
const HEALTH_STABLE_MS = 10000
const HEALTH_POLL_MS = 1000
const DEFAULTS = {
  stopMs: 30000,
  installMs: 5 * 60 * 1000,
  reconcileMs: 5 * 60 * 1000,
  startMs: 30000,
  healthMs: 90000,
  rollbackMs: 5 * 60 * 1000,
}

/** A fixed, public failure code plus the child's output tail for the log. */
function failure(code, output = '') {
  return Object.assign(new Error(code), { code, output: String(output || '').slice(-MAX_OUTPUT) })
}

/**
 * Validate the Host-written spec before touching systemd or npm. Every field
 * that reaches a command line is checked here, because the spec crosses a
 * process boundary and must not trust its writer.
 */
function validateSpec(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('invalid-spec')
  const spec = { ...DEFAULTS, ...input }
  if (!ID_RE.test(String(spec.id || ''))) throw failure('invalid-spec')
  if (!VERSION_RE.test(String(spec.version || ''))) throw failure('invalid-version')
  if (spec.previousVersion !== null && spec.previousVersion !== undefined && !VERSION_RE.test(String(spec.previousVersion))) throw failure('invalid-version')
  if (!UNIT_RE.test(String(spec.unit || ''))) throw failure('invalid-unit')
  for (const key of ['node', 'npm', 'systemctl']) {
    if (typeof spec[key] !== 'string' || spec[key] === '') throw failure('invalid-spec')
  }
  for (const key of ['root', 'jobPath', 'logPath']) {
    if (typeof spec[key] !== 'string' || !isAbsolute(spec[key])) throw failure('invalid-spec')
  }
  if (spec.prefix !== undefined && (typeof spec.prefix !== 'string' || !isAbsolute(spec.prefix))) throw failure('invalid-spec')
  if (spec.reconcile === true) {
    if (!PROFILE_RE.test(String(spec.profile || '')) || spec.profile === 'desktop') throw failure('invalid-profile')
    if (typeof spec.profileDir !== 'string' || !isAbsolute(spec.profileDir)) throw failure('invalid-profile')
  }
  if (spec.env !== undefined && (typeof spec.env !== 'object' || spec.env === null || Array.isArray(spec.env))) throw failure('invalid-spec')
  for (const key of Object.keys(DEFAULTS)) {
    if (!Number.isFinite(spec[key]) || spec[key] <= 0) throw failure('invalid-spec')
  }
  return spec
}

/**
 * Run one command with a bounded deadline and a bounded output tail.
 * The runner never needs a shell: every argument is passed as an argv entry.
 * @returns {Promise<{code: number, signal?: string, output: string, timedOut?: boolean}>}
 */
function runCommand(command, args, options = {}) {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: 127, output: String((error && error.message) || error) })
      return
    }
    let output = ''
    let settled = false
    let killTimer = null
    let timedOut = false
    const keep = chunk => { output = (output + String(chunk)).slice(-MAX_OUTPUT) }
    const finish = (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      resolve({ code, signal, output: output.slice(-MAX_OUTPUT), timedOut })
    }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      killTimer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } }, 5000)
      killTimer.unref?.()
    }, options.timeoutMs || DEFAULTS.installMs)
    timer.unref?.()
    child.once('error', error => {
      output = (output + String((error && error.message) || error)).slice(-MAX_OUTPUT)
      finish(127)
    })
    child.once('close', (code, signal) => finish(code ?? 124, signal))
  })
}

/** Merge one phase into the job file through a same-directory atomic rename. */
function jobStore(path) {
  let current = null
  const read = () => {
    if (current) return current
    try { current = JSON.parse(readFileSync(path, 'utf8')) } catch { current = null }
    return current
  }
  const write = patch => {
    current = { ...(current || read() || {}), ...patch, updatedAt: new Date().toISOString() }
    try { mkdirSync(dirname(path), { recursive: true }) } catch { /* the Host made it */ }
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(current, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, path)
    try { chmodSync(path, 0o600) } catch { /* best effort */ }
    return current
  }
  return { read, write }
}

/** Append a timestamped line to the local log; the job keeps a short tail. */
function logFile(path) {
  let tail = ''
  try { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, '', { mode: 0o600 }) } catch { /* diagnostics must not break the update */ }
  const write = line => {
    const text = `[${new Date().toISOString()}] ${line}`
    tail = (tail + text + '\n').slice(-MAX_OUTPUT)
    try {
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, text + '\n', { mode: 0o600 })
    } catch { /* diagnostics must not break the update */ }
  }
  return { write, tail: () => tail }
}

function parseShow(output) {
  const fields = {}
  for (const line of String(output || '').split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1)
  }
  return fields
}

function prefixOf(root) {
  const parent = dirname(root)
  return basename(parent) === 'lib' ? dirname(parent) : parent
}

/** Official DSH plugins are profile dependencies, not global DSH dependencies. */
const OFFICIAL_PLUGIN_RE = /^@deepseek-ai\/dsh-/
const NON_REGISTRY_SPEC_RE = /^(?:link:|file:|workspace:|portal:|catalog:|git\+|https?:|github:)/i

function registrySpec(value) {
  return typeof value === 'string' && value !== '' && !NON_REGISTRY_SPEC_RE.test(value)
}

/**
 * The official profile plugins whose versions track the DSH release. A linked
 * or file dependency belongs to the developer and must never be rewritten by
 * the updater; only registry specs are eligible.
 */
function officialProfilePlugins(profileDir) {
  let manifest
  try { manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) } catch { return [] }
  const dependencies = manifest && manifest.dependencies
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) return []
  return Object.keys(dependencies)
    .filter(name => OFFICIAL_PLUGIN_RE.test(name) && registrySpec(dependencies[name]))
    .sort()
}

function profileSnapshot(profileDir) {
  const read = path => {
    try { return readFileSync(path, 'utf8') } catch { return null }
  }
  const packagePath = join(profileDir, 'package.json')
  const lockPath = join(profileDir, 'pnpm-lock.yaml')
  return { packagePath, lockPath, packageJson: read(packagePath), lock: read(lockPath) }
}

/**
 * `pnpm update` rewrites the lockfile and can leave the old CLI reading a tree
 * built for the new version. Restore the files before the rollback reconcile
 * so a DSH rollback also restores the profile it was running against.
 */
function restoreProfile(snapshot, log) {
  if (!snapshot) return
  try {
    if (snapshot.packageJson !== null) writeFileSync(snapshot.packagePath, snapshot.packageJson, { mode: 0o600 })
    if (snapshot.lock !== null) writeFileSync(snapshot.lockPath, snapshot.lock, { mode: 0o600 })
    else {
      try { unlinkSync(snapshot.lockPath) } catch { /* no lock to remove */ }
    }
    log.write('restored profile package.json and pnpm-lock.yaml')
  } catch (error) {
    log.write('profile snapshot restore failed: ' + String((error && error.message) || error))
  }
}

/** Update official registry plugins within their declared ranges. */
async function updateOfficialPlugins(spec, run, log) {
  const names = officialProfilePlugins(spec.profileDir)
  if (!names.length) return { names }
  log.write('updating official profile plugins: ' + names.join(', '))
  const bin = join(spec.root, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  // Use each package's own declared range. The target is deliberately not
  // pinned to the DSH version: official plugins have independent releases and
  // a plugin without a build for this exact DSH version must not block the
  // Host update. The one-command policy override lets pnpm resolve the profile
  // at all (its lock already contains entries newer than pnpm 12's cutoff);
  // it still uses the normal newest-in-range resolution, not a DSH pin.
  const updated = await run(spec.node, [bin, 'plugin', '--profile', spec.profile, 'update', ...names, '--config.minimumReleaseAge=0'],
    { cwd: spec.profileDir, timeoutMs: spec.reconcileMs, env: childEnv(spec) })
  if (updated.code === 127) return { names, skipped: 'pnpm-not-found' }
  if (updated.code !== 0) return { names, error: 'official-plugin-update-failed', output: updated.output }
  return { names }
}

/** Report compatibility warnings without letting a plugin's status fail the Host. */
async function officialPluginWarnings(spec, run, log) {
  const names = officialProfilePlugins(spec.profileDir)
  if (!names.length) return []
  const bin = join(spec.root, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const listed = await run(spec.node, [bin, 'plugin', '--profile', spec.profile, 'list'],
    { cwd: spec.profileDir, timeoutMs: spec.reconcileMs, env: childEnv(spec) })
  if (listed.code === 127) return []
  if (listed.code !== 0) {
    log.write('official plugin compatibility check failed: ' + listed.output)
    return []
  }
  const found = new Set()
  const pattern = /Plugin (@deepseek-ai\/dsh-[A-Za-z0-9._-]+)@[^\s]+ is incompatible with dsh /g
  let match
  while ((match = pattern.exec(listed.output)) !== null) found.add(match[1])
  return [...found].filter(name => names.includes(name))
}

function installedVersion(spec) {
  try {
    const manifest = JSON.parse(readFileSync(join(spec.root, '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch { return null }
}

function childEnv(spec) {
  return { ...process.env, ...(spec.env || {}) }
}

async function stopUnit(spec, run) {
  return run(spec.systemctl, ['--user', 'stop', spec.unit], { timeoutMs: spec.stopMs, env: childEnv(spec) })
}

async function startUnit(spec, run) {
  await run(spec.systemctl, ['--user', 'reset-failed', spec.unit], { timeoutMs: spec.stopMs, env: childEnv(spec) })
  const started = await run(spec.systemctl, ['--user', 'start', spec.unit], { timeoutMs: spec.startMs, env: childEnv(spec) })
  return { ok: started.code === 0, output: started.output }
}

/**
 * A process that stays active for ten seconds is treated as started. The unit's
 * Restart=on-failure produces a visible failed/activating cycle for a boot
 * failure, so a crash loop never reaches the stable window.
 */
async function waitForHealth(spec, run, sleep, now) {
  const deadline = now() + spec.healthMs
  let lastPid = 0
  let stableSince = null
  let lastOutput = ''
  let pids = 0
  while (now() < deadline) {
    const shown = await run(spec.systemctl, ['--user', 'show', '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID', spec.unit],
      { timeoutMs: 5000, env: childEnv(spec) })
    lastOutput = shown.output
    const fields = parseShow(shown.output)
    if (fields.ActiveState === 'failed') return { ok: false, output: lastOutput }
    if (fields.ActiveState === 'active' && fields.SubState === 'running') {
      const pid = Number(fields.MainPID) || 0
      if (pid > 0) {
        if (pid !== lastPid) {
          lastPid = pid
          stableSince = now()
          pids += 1
          if (pids > 4) return { ok: false, output: lastOutput }
        } else if (stableSince !== null && now() - stableSince >= HEALTH_STABLE_MS) {
          return { ok: true, output: lastOutput }
        }
      }
    }
    await sleep(HEALTH_POLL_MS)
  }
  return { ok: false, output: lastOutput || 'health timeout' }
}

/** Install the previous version and start it; the caller records the result. */
async function rollback(spec, run, sleep, now, log, snapshot) {
  const previous = spec.previousVersion
  try {
    restoreProfile(snapshot, log)
    log.write('rolling back to ' + (previous || 'the installed copy'))
    await stopUnit(spec, run)
    if (typeof previous !== 'string' || !VERSION_RE.test(previous)) return { ok: false, output: 'no previous version' }
    const installed = await run(spec.npm, ['install', '-g', `@deepseek-ai/dsh@${previous}`, '--prefix', spec.prefix || prefixOf(spec.root), '--no-fund', '--no-audit'],
      { timeoutMs: spec.rollbackMs, env: childEnv(spec) })
    if (installed.code !== 0) return { ok: false, output: installed.output }
    if (installedVersion(spec) !== previous) return { ok: false, output: 'rollback version mismatch' }
    // The failed attempt may already have rewritten the profile's dependency
    // tree with the new CLI. Run the old CLI's reconcile before starting it;
    // a failure is noted but the health check still decides, because a profile
    // reconcile can fail for a transient reason the old Host survives.
    let note = ''
    if (spec.reconcile === true && typeof spec.profile === 'string') {
      const bin = join(spec.root, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      const again = await run(spec.node, [bin, 'plugin', '--profile', spec.profile, 'install'],
        { cwd: spec.profileDir, timeoutMs: spec.reconcileMs, env: childEnv(spec) })
      if (again.code === 127) note = 'rollback profile reconcile skipped: pnpm-not-found'
      else if (again.code !== 0) note = 'rollback profile reconcile: ' + again.output
      if (note) log.write(note)
    }
    const started = await startUnit(spec, run)
    if (!started.ok) return { ok: false, output: [note, started.output].filter(Boolean).join('\n') }
    const health = await waitForHealth(spec, run, sleep, now)
    const output = [note, health.output].filter(Boolean).join('\n')
    return health.ok ? { ok: true, output } : { ok: false, output }
  } catch (error) {
    return { ok: false, output: String((error && error.message) || error) }
  }
}

/**
 * The whole update sequence. `deps` exists so tests can drive it without a real
 * systemd, npm install or npm registry.
 * @param {object} input Host-written spec.
 * @param {object} [deps] `run`, `sleep`, `now`, `job`, `log`.
 * @returns {Promise<{ok: boolean, rolledBack?: boolean, code?: string}>}
 */
async function runHostUpdate(input, deps = {}) {
  const spec = validateSpec(input)
  const run = deps.run || runCommand
  const sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const now = deps.now || Date.now
  const job = deps.job || jobStore(spec.jobPath)
  const log = deps.log || logFile(spec.logPath)
  const startedAt = new Date(now()).toISOString()
  job.write({
    id: spec.id,
    version: spec.version,
    previousVersion: spec.previousVersion || null,
    unit: spec.unit,
    profile: spec.profile || null,
    phase: 'stopping',
    startedAt,
    hostPid: spec.hostPid || null,
    pid: process.pid,
    logPath: spec.logPath,
    reconcile: spec.reconcile === true,
    error: null,
    output: '',
  })
  log.write(`starting update ${spec.previousVersion || '?'} -> ${spec.version} (${spec.unit})`)
  let installed = false
  let stopped = false
  let finished = false
  let snapshot = null
  const settle = outcome => {
    finished = true
    return outcome
  }

  try {
    // Let `systemd-run` return and the HTTP response leave before the unit that
    // owns both of them stops. The page is already showing the progress panel.
    await sleep(500)
    const stoppedResult = await stopUnit(spec, run)
    if (stoppedResult.code !== 0) throw failure('stop-failed', stoppedResult.output)
    stopped = true
    job.write({ phase: 'installing' })
    log.write('installing ' + spec.version)
    const install = await run(spec.npm, ['install', '-g', `@deepseek-ai/dsh@${spec.version}`, '--prefix', spec.prefix || prefixOf(spec.root), '--no-fund', '--no-audit'],
      { timeoutMs: spec.installMs, env: childEnv(spec) })
    if (install.code !== 0) throw failure('install-failed', install.output)
    installed = true
    const actual = installedVersion(spec)
    if (actual !== spec.version) throw failure('version-mismatch', `installed ${actual || 'nothing'}`)

    if (spec.reconcile === true) {
      snapshot = profileSnapshot(spec.profileDir)
      job.write({ phase: 'reconciling' })
      log.write('reconciling profile ' + spec.profile)
      const bin = join(spec.root, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      const reconciled = await run(spec.node, [bin, 'plugin', '--profile', spec.profile, 'install'],
        { cwd: spec.profileDir, timeoutMs: spec.reconcileMs, env: childEnv(spec) })
      if (reconciled.code === 127) {
        // A profile without pnpm can still boot the new version; the health
        // check below owns the failure decision.
        job.write({ reconcileSkipped: 'pnpm-not-found' })
        log.write('profile reconcile skipped: pnpm was not found')
      } else if (reconciled.code !== 0) {
        throw failure('profile-reconcile-failed', reconciled.output)
      } else {
        const official = await updateOfficialPlugins(spec, run, log)
        if (official.skipped) {
          job.write({ officialPlugins: official.names, officialPluginsSkipped: official.skipped })
          log.write('official profile plugin update skipped: pnpm was not found')
        } else if (official.error) {
          // A profile plugin is not the Host: restore the coherent old profile
          // and keep going. The Host update must not be rolled back because an
          // optional official plugin has no update or pnpm rejected the step.
          job.write({ officialPlugins: official.names, officialPluginsFailed: official.error })
          log.write('official profile plugin update failed; restoring the profile snapshot and continuing')
          restoreProfile(snapshot, log)
          const repaired = await run(spec.node, [bin, 'plugin', '--profile', spec.profile, 'install'],
            { cwd: spec.profileDir, timeoutMs: spec.reconcileMs, env: childEnv(spec) })
          if (repaired.code === 127) log.write('profile repair skipped: pnpm was not found')
          else if (repaired.code !== 0) log.write('profile repair failed: ' + repaired.output)
          else log.write('profile repaired with its previous dependencies')
        } else if (official.names.length) {
          job.write({ officialPluginsUpdated: official.names })
          log.write('updated official profile plugins: ' + official.names.join(', '))
        }
        const incompatible = await officialPluginWarnings(spec, run, log)
        if (incompatible.length) {
          job.write({ officialPluginsIncompatible: incompatible })
          log.write('official profile plugins still incompatible: ' + incompatible.join(', '))
        }
      }
    }

    job.write({ phase: 'starting' })
    log.write('starting ' + spec.unit)
    const started = await startUnit(spec, run)
    if (!started.ok) throw failure('start-failed', started.output)
    job.write({ phase: 'verifying' })
    const health = await waitForHealth(spec, run, sleep, now)
    if (!health.ok) throw failure('unhealthy', health.output)
    job.write({ phase: 'healthy', finishedAt: new Date(now()).toISOString(), output: log.tail(), error: null })
    log.write('update healthy')
    return settle({ ok: true })
  } catch (error) {
    const code = (error && error.code) || 'internal'
    const output = (error && error.output) || log.tail()
    log.write(`update failed: ${code}`)
    if (installed) {
      job.write({ phase: 'rolling-back', error: code, output, rolledBack: false })
      const restored = await rollback(spec, run, sleep, now, log, snapshot)
      if (restored.ok) {
        job.write({ phase: 'rolled-back', rolledBack: true, finishedAt: new Date(now()).toISOString(), error: code, output })
        log.write('rolled back')
        return settle({ ok: false, rolledBack: true, code })
      }
      job.write({ phase: 'failed', rolledBack: false, finishedAt: new Date(now()).toISOString(), error: 'rollback-failed', output: restored.output, originalError: code })
      log.write('rollback failed')
      return settle({ ok: false, rolledBack: false, code: 'rollback-failed' })
    }
    // The install never replaced the package tree. If the unit was stopped,
    // put the old copy back in service before reporting the failure.
    let restored = false
    // A timed-out stop may still have stopped the unit; restore it either way.
    if (stopped || code === 'stop-failed') {
      const started = await startUnit(spec, run)
      restored = started.ok && (await waitForHealth(spec, run, sleep, now)).ok
    }
    job.write({ phase: 'failed', restoring: stopped, restored, finishedAt: new Date(now()).toISOString(), error: code, output })
    log.write(restored ? 'old service restored' : 'update failed and the service is not confirmed running')
    return settle({ ok: false, rolledBack: false, code })
  } finally {
    if (!finished) {
      // A thrown non-Error path must not leave the unit down.
      try { await startUnit(spec, run) } catch { /* the journal has the rest */ }
    }
  }
}

function readSpecFile(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

const invokedAsMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch { return false }
})()

if (invokedAsMain) {
  const path = process.argv[2]
  if (!path) {
    process.stderr.write('host-update-runner: missing spec path\n')
    process.exitCode = 2
  } else {
    runHostUpdate(readSpecFile(path)).then(result => { process.exitCode = result.ok ? 0 : 1 }, error => {
      process.stderr.write('host-update-runner: ' + String((error && error.message) || error) + '\n')
      process.exitCode = 1
    })
  }
}

export { runHostUpdate, runCommand, validateSpec, installedVersion, waitForHealth, parseShow, officialProfilePlugins, officialPluginWarnings }
