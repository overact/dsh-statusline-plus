'use strict'
/**
 * Reload and restart of the running DSH Host.
 *
 * Two levels, cheapest first:
 *   - Soft reload: `hmr.reconcileProfile()` swaps changed plugin modules and the
 *     profile composition inside the running process. Sessions keep running.
 *   - Full restart: `systemctl --user restart <unit>`, only when this process is
 *     the main process of a systemd user service. Every session is interrupted.
 *
 * The state lives on globalThis, not in this module: a soft reload can evict this
 * very module and dispose the fiber that started it, and the replacement must
 * still report what the old copy is doing (for example, escalating to a restart).
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const STATE_KEY = Symbol.for('dsh-statusline-plus.restart')
const UNIT_RE = /^[A-Za-z0-9@._\\:-]+\.service$/

/** Process-wide restart state, shared by every copy of this module in the process. */
function restartState() {
  if (!globalThis[STATE_KEY]) globalThis[STATE_KEY] = { seq: 0, phase: 'idle', mode: null, reason: null, at: 0 }
  return globalThis[STATE_KEY]
}

function setPhase(seq, phase, reason = null) {
  const state = restartState()
  // A newer request owns the state; a late callback from an older one must not rewrite it.
  if (state.seq !== seq) return
  state.phase = phase
  state.reason = reason
  state.at = Date.now()
}

/**
 * The systemd user unit whose cgroup holds this process, read from /proc/self/cgroup.
 * Returns null outside a user service: a desktop app, Windows, a terminal session,
 * or a system service (which a user cannot restart without privileges).
 * @param {string} cgroupText contents of /proc/self/cgroup.
 * @returns {string|null} the unit name, such as "dsh-web.service".
 */
function systemdUnitOf(cgroupText) {
  for (const line of String(cgroupText || '').split('\n')) {
    // cgroup v2 is "0::<path>"; v1 lines carry the same path under name=systemd.
    const path = line.split(':').slice(2).join(':')
    const segments = path.split('/')
    const manager = segments.findIndex(part => /^user@\d+\.service$/.test(part))
    if (manager === -1) continue
    const unit = segments.slice(manager + 1).reverse().find(part => part.endsWith('.service'))
    if (unit && UNIT_RE.test(unit)) return unit
  }
  return null
}

function detectUnit(read = () => readFileSync('/proc/self/cgroup', 'utf8')) {
  if (process.platform !== 'linux') return null
  try { return systemdUnitOf(read()) } catch { return null }
}

/**
 * Apply what changed on disk to the running profile, the same path the plugin
 * manager takes after an install.
 * @param {object} ctx a plugin context that can look up `hmr`.
 * @returns {Promise<{applied: boolean, reason?: string, pending?: object[]}>}
 */
async function reconcileProfile(ctx) {
  let hmr
  try {
    // Cordis refuses property access to a service that was not injected; get() works without it.
    hmr = typeof ctx.get === 'function' ? ctx.get('hmr') : undefined
  } catch {
    hmr = undefined
  }
  if (!hmr || typeof hmr.runExclusive !== 'function' || typeof hmr.reconcileProfile !== 'function') {
    return { applied: false, reason: 'no-hmr' }
  }
  try {
    const outcome = await hmr.runExclusive(() => hmr.reconcileProfile())
    const pending = outcome && Array.isArray(outcome.pending) ? outcome.pending : []
    const reason = (outcome && outcome.restartReason) || (pending[0] && pending[0].reason)
    return reason === undefined ? { applied: true } : { applied: false, reason: String(reason), pending }
  } catch (error) {
    return { applied: false, reason: String((error && error.message) || error), error: true }
  }
}

/**
 * Top-level sessions with a turn running right now, or null when the Host does not say.
 * Subagents are not counted separately: they belong to a running parent.
 * @param {object} ctx a plugin context that can look up `agents`.
 * @returns {number|null}
 */
function activeSessionCount(ctx) {
  let agents
  try {
    agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  } catch {
    return null
  }
  if (!agents) return null
  try {
    const list = typeof agents.roots === 'function' ? agents.roots() : typeof agents.list === 'function' ? agents.list() : null
    return Array.isArray(list) ? list.filter(agent => agent && agent.status === 'running').length : null
  } catch {
    return null
  }
}

/**
 * Decide what follows a soft reload.
 *
 * @param {{applied: boolean, reason?: string, error?: boolean, pending?: object[]}} outcome
 *   what `reconcileProfile` reported. `reason` is one of DSH's restart reasons:
 *   'no-hmr' (profile has no HMR), 'host-module' (a change reaches DSH's own code),
 *   'unmanaged-plugin', 'package-moved', 'module-comparison' (the disk could not be
 *   compared); `error: true` means the reconcile itself threw, and the replaced
 *   plugin may no longer be running at all.
 * @param {boolean} canRestart whether a full restart is available (systemd user unit).
 * @param {number|null} active top-level sessions running a turn now; null when unknown.
 * @returns {'done'|'restart'|'confirm'|'manual'} 'done' finishes after the soft
 *   reload, 'restart' escalates at once, 'confirm' asks the user before restarting,
 *   'manual' says a restart is needed but this plugin cannot perform it.
 */
function planAfterReload(outcome, canRestart, active) {
  if (outcome.applied) return 'done'
  if (!canRestart) return 'manual'
  // The user agreed to "reload", not to cutting off a running turn: ask first
  // whenever one may be running, including when the Host cannot tell.
  return active === 0 ? 'restart' : 'confirm'
}

/**
 * Restart the unit. `--no-block` returns as soon as systemd has queued the job,
 * so the exit code means "accepted" and the child is never caught in the stop
 * of its own cgroup. reset-failed first clears the start-rate counter, so
 * several manual restarts in a row are not refused by StartLimitBurst.
 */
function restartUnit(unit, spawnFn = spawn) {
  const run = args => new Promise(resolve => {
    let child
    try {
      child = spawnFn('systemctl', ['--user', ...args], { stdio: 'ignore' })
    } catch (error) {
      resolve(error)
      return
    }
    child.once('error', resolve)
    child.once('close', (code, signal) => resolve(code === 0 ? null : new Error(`systemctl ${args[0]} exited ${code ?? signal}`)))
  })
  return run(['reset-failed', unit]).then(() => run(['--no-block', 'restart', unit]))
}

/**
 * The restart controller one plugin instance exposes through its route.
 * @param {object} options
 * @param {object} options.ctx plugin context (for `hmr`).
 * @param {string|null} [options.unit] systemd user unit; detected when omitted.
 * @param {Function} [options.spawn] spawn replacement for tests.
 * @param {Function} [options.log] warning sink.
 * @param {Function} [options.defer] schedules work after the response, default 80 ms.
 * @param {object} [options.hostUpdater] `createHostUpdater()`; DSH updates are offered only with a unit.
 */
function createRestartController({ ctx, unit = detectUnit(), spawn: spawnFn = spawn, log = () => {}, defer = fn => setTimeout(fn, 80), hostUpdater = null } = {}) {
  const hasHmr = () => {
    try {
      const hmr = typeof ctx.get === 'function' ? ctx.get('hmr') : undefined
      return !!(hmr && typeof hmr.reconcileProfile === 'function')
    } catch {
      return false
    }
  }

  function status() {
    const state = restartState()
    return {
      soft: hasHmr(),
      full: unit !== null,
      unit,
      pid: process.pid,
      seq: state.seq,
      phase: state.phase,
      reason: state.reason,
      active: activeSessionCount(ctx),
    }
  }

  async function fullRestart(seq) {
    setPhase(seq, 'restarting')
    const error = await restartUnit(unit, spawnFn)
    if (error) {
      log('restart failed: ' + error.message)
      // A fixed public code; systemctl's own text stays in the Host log.
      setPhase(seq, 'failed', 'systemctl')
    }
  }

  async function updateThenRestart(seq, version) {
    setPhase(seq, 'updating')
    const error = await hostUpdater.install(version)
    if (error) {
      log('DSH update failed: ' + error.message + (error.output ? '\n' + error.output : ''))
      // Nothing restarts: the old DSH is still installed and running.
      setPhase(seq, 'failed', 'update-' + error.message)
      return
    }
    return fullRestart(seq)
  }

  /** DSH update state for the page; null where updates are not offered at all. */
  async function updateStatus(options) {
    if (unit === null || !hostUpdater) return null
    return hostUpdater.check(options)
  }

  async function softThenMaybeRestart(seq) {
    setPhase(seq, 'reloading')
    const outcome = await reconcileProfile(ctx)
    if (!outcome.applied) log('soft reload incomplete: ' + outcome.reason)
    let next
    try {
      next = planAfterReload(outcome, unit !== null, activeSessionCount(ctx))
    } catch (error) {
      log('restart policy failed: ' + ((error && error.message) || error))
      next = 'manual'
    }
    if (next === 'restart' && unit !== null) return fullRestart(seq)
    setPhase(seq, next === 'done' ? 'reloaded' : next === 'confirm' ? 'confirm' : 'manual', outcome.applied ? null : outcome.reason)
  }

  /**
   * Start a reload ('reload': soft first) or a restart ('restart': skip the soft step).
   * The caller sends its response before the deferred work runs, because a soft
   * reload can dispose this plugin and a restart ends the process.
   * @returns {{ok: true, seq: number} | {ok: false, error: string}}
   */
  function request(mode, options = {}) {
    const state = restartState()
    if (state.phase === 'reloading' || state.phase === 'restarting' || state.phase === 'updating') return { ok: false, error: 'in-progress' }
    if (mode === 'update' && (unit === null || !hostUpdater)) return { ok: false, error: 'update-unavailable' }
    if (mode === 'restart' && unit === null) return { ok: false, error: 'restart-unavailable' }
    if (mode === 'reload' && !hasHmr() && unit === null) return { ok: false, error: 'reload-unavailable' }
    const seq = state.seq + 1
    state.seq = seq
    state.mode = mode
    setPhase(seq, mode === 'restart' ? 'restarting' : mode === 'update' ? 'updating' : 'reloading')
    defer(() => {
      const work = mode === 'restart' ? fullRestart(seq) : mode === 'update' ? updateThenRestart(seq, options.version) : softThenMaybeRestart(seq)
      work.catch(error => {
        log('restart flow failed: ' + ((error && error.message) || error))
        setPhase(seq, 'failed', 'internal')
      })
    })
    return { ok: true, seq }
  }

  return { status, request, updateStatus }
}

export { activeSessionCount, systemdUnitOf, detectUnit, reconcileProfile, planAfterReload, restartUnit, createRestartController, restartState }
