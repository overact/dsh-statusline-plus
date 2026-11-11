'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const { systemdUnitOf, restartUnit, createRestartController, restartState, reconcileProfile, planAfterReload, activeSessionCount } = require('../lib/restart.js')

function fakeSpawn(codes = {}) {
  const calls = []
  const spawn = (command, args) => {
    calls.push([command, ...args])
    const child = new EventEmitter()
    const verb = args.find(arg => !arg.startsWith('--'))
    setImmediate(() => child.emit('close', codes[verb] ?? 0, null))
    return child
  }
  return { calls, spawn }
}

function resetState() {
  const state = restartState()
  Object.assign(state, { seq: 0, phase: 'idle', mode: null, reason: null, at: 0 })
}

const flush = () => new Promise(resolve => setImmediate(resolve))
const settle = async () => { for (let i = 0; i < 6; i++) await flush() }

test('the unit is read from a user-manager cgroup and nothing else', () => {
  assert.equal(systemdUnitOf('0::/user.slice/user-1000.slice/user@1000.service/app.slice/dsh-web.service\n'), 'dsh-web.service')
  assert.equal(systemdUnitOf('1:name=systemd:/user.slice/user-1000.slice/user@1000.service/app.slice/my-dsh.service\n0::/x'), 'my-dsh.service')
  assert.equal(systemdUnitOf('0::/non-systemd\n'), null, 'a WSL shell or terminal')
  assert.equal(systemdUnitOf('0::/system.slice/dsh-web.service\n'), null, 'a system unit needs privileges')
  assert.equal(systemdUnitOf('0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-term-123.scope\n'), null, 'a terminal scope is not a service')
  assert.equal(systemdUnitOf(''), null)
})

test('a restart clears the start limit, then queues the restart without blocking on it', async () => {
  const { calls, spawn } = fakeSpawn()
  assert.equal(await restartUnit('dsh-web.service', spawn), null)
  assert.deepEqual(calls, [
    ['systemctl', '--user', 'reset-failed', 'dsh-web.service'],
    ['systemctl', '--user', '--no-block', 'restart', 'dsh-web.service'],
  ])
})

test('a failed reset-failed still restarts; a refused restart is reported', async () => {
  const soft = fakeSpawn({ 'reset-failed': 1 })
  assert.equal(await restartUnit('dsh-web.service', soft.spawn), null)
  assert.equal(soft.calls.length, 2)
  const refused = fakeSpawn({ restart: 5 })
  assert.match(String(await restartUnit('dsh-web.service', refused.spawn)), /exited 5/)
})

test('a missing systemctl is a failure, not a crash', async () => {
  const error = await restartUnit('dsh-web.service', () => { throw new Error('ENOENT') })
  assert.match(String(error), /ENOENT/)
})

test('a full restart is refused where there is no user unit', () => {
  resetState()
  const controller = createRestartController({ ctx: { get: () => undefined }, unit: null, defer: fn => fn() })
  assert.deepEqual(controller.request('restart'), { ok: false, error: 'restart-unavailable' })
  assert.deepEqual(controller.request('reload'), { ok: false, error: 'reload-unavailable' })
  assert.deepEqual({ soft: controller.status().soft, full: controller.status().full }, { soft: false, full: false })
})

test('a full restart runs systemctl and a second request waits for the first', async () => {
  resetState()
  const { calls, spawn } = fakeSpawn()
  const controller = createRestartController({ ctx: { get: () => undefined }, unit: 'dsh-web.service', spawn, defer: fn => setImmediate(fn) })
  const first = controller.request('restart')
  assert.equal(first.ok, true)
  assert.deepEqual(controller.request('restart'), { ok: false, error: 'in-progress' })
  assert.equal(calls.length, 0, 'nothing runs before the response has left')
  await settle()
  assert.equal(calls.length, 2)
  // A successful restart ends this process; the state stays "restarting" until then.
  assert.equal(controller.status().phase, 'restarting')
})

test('a refused systemctl releases the lock with a fixed public code', async () => {
  resetState()
  const { spawn } = fakeSpawn({ restart: 1 })
  const controller = createRestartController({ ctx: { get: () => undefined }, unit: 'dsh-web.service', spawn, defer: fn => setImmediate(fn) })
  controller.request('restart')
  await settle()
  assert.equal(controller.status().phase, 'failed')
  assert.equal(controller.status().reason, 'systemctl')
  assert.equal(controller.request('restart').ok, true, 'the user can retry')
})

test('the state is process-wide, so a copy loaded by a soft reload reports the old copy\'s run', async () => {
  resetState()
  const ctx = { get: name => name === 'hmr' ? { runExclusive: run => run(), reconcileProfile: () => new Promise(() => {}) } : undefined }
  const before = createRestartController({ ctx, unit: null, defer: fn => fn() })
  before.request('reload')
  const after = createRestartController({ ctx, unit: null })
  assert.equal(after.status().phase, 'reloading')
  assert.equal(after.status().seq, before.status().seq)
})

test('reconcile reports the restart reason, pending modules and thrown errors', async () => {
  const hmr = result => ({ get: () => ({ runExclusive: run => run(), reconcileProfile: async () => result }) })
  assert.deepEqual(await reconcileProfile(hmr({ warnings: [], pending: [] })), { applied: true })
  assert.equal((await reconcileProfile(hmr({ pending: [], restartReason: 'host-module' }))).reason, 'host-module')
  assert.equal((await reconcileProfile(hmr({ pending: [{ url: 'x', reason: 'unmanaged-plugin' }] }))).reason, 'unmanaged-plugin')
  const thrown = await reconcileProfile({ get: () => ({ runExclusive: async () => { throw new Error('boom') }, reconcileProfile() {} }) })
  assert.equal(thrown.error, true)
  assert.deepEqual(await reconcileProfile({ get: () => undefined }), { applied: false, reason: 'no-hmr' })
})

test('after a soft reload: done when applied, ask while a turn may run, restart only when idle', () => {
  assert.equal(planAfterReload({ applied: true }, true, 3), 'done')
  assert.equal(planAfterReload({ applied: false, reason: 'host-module' }, true, 0), 'restart')
  assert.equal(planAfterReload({ applied: false, reason: 'host-module' }, true, 2), 'confirm')
  assert.equal(planAfterReload({ applied: false, reason: 'module-comparison' }, true, null), 'confirm', 'unknown activity is treated as busy')
  assert.equal(planAfterReload({ applied: false, reason: 'boom', error: true }, true, 0), 'restart')
  assert.equal(planAfterReload({ applied: false, reason: 'no-hmr' }, false, 0), 'manual')
})

test('running sessions are counted from top-level agents, unknown without the service', () => {
  const agents = list => ({ get: name => name === 'agents' ? list : undefined })
  const roots = [{ status: 'running' }, { status: 'idle' }, { status: 'running' }]
  assert.equal(activeSessionCount(agents({ roots: () => roots, list: () => [...roots, { status: 'running' }] })), 2, 'subagents are not counted twice')
  assert.equal(activeSessionCount(agents({ list: () => roots })), 2)
  assert.equal(activeSessionCount({ get: () => undefined }), null)
  assert.equal(activeSessionCount({ get: () => { throw new Error('cannot get property') } }), null)
})

test('a reload that needs a restart stops at confirm while a session runs', async () => {
  resetState()
  const { calls, spawn } = fakeSpawn()
  const hmr = { runExclusive: run => run(), reconcileProfile: async () => ({ pending: [], restartReason: 'host-module' }) }
  const busy = [{ status: 'running' }]
  const ctx = { get: name => name === 'hmr' ? hmr : name === 'agents' ? { roots: () => busy } : undefined }
  const controller = createRestartController({ ctx, unit: 'dsh-web.service', spawn, defer: fn => setImmediate(fn) })
  controller.request('reload')
  await settle()
  assert.deepEqual({ phase: controller.status().phase, reason: controller.status().reason, active: controller.status().active }, { phase: 'confirm', reason: 'host-module', active: 1 })
  assert.equal(calls.length, 0, 'no restart without the user')
  busy.length = 0
  controller.request('reload')
  await settle()
  assert.equal(calls.length, 2, 'idle: the reload escalates by itself')
})
