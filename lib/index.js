'use strict'
/**
 * dsh-statusline-plus — host half.
 * Registers webServer API routes used by the browser bundle:
 *   POST /statusline/api/usage  -> fetch opencode.ai quota (official API), optional force
 *   POST /statusline/api/git    -> git status --porcelain for a given cwd
 *   POST /statusline/api/codex-quota -> fetch Codex subscription quota (optional force)
 *   POST /statusline/api/antigravity-quota -> fetch Antigravity subscription quota (Google API, optional force)
 *   POST /statusline/api/provider-quota -> fetch a declared providers[] entry (balance / windows)
 *   POST /statusline/api/session-model -> current provider/model of a live session
 *   GET  /statusline/api/peak-schedule -> holiday calendar + official-rule change check (24 h cache)
 *   GET  /statusline/api/tps -> streaming TPS for one session (server-sent events)
 *   GET  /statusline/api/restart -> reload/restart capability and progress
 *   POST /statusline/api/restart -> soft reload (then restart if needed) or full restart
 *
 * Module map: config.js (settings model and schema), quota-*.js and cpa-credentials.js
 * (account quota sources), git-status.js, session-log.js, http-route.js, tps.js,
 * session-metrics.js / tool-activity.js (session projections), peak-schedule.js.
 */
import { randomUUID } from 'node:crypto'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { RequestPool } from './request-pool.js'
import { createQuotaDispatcher } from './quota-transport.js'
import { TpsTracker, streamTps, estimateTextTokens, validSessionId } from './tps.js'
import { createSessionMetricsProjection } from './session-metrics.js'
import { loadPricingCatalog } from './model-pricing.js'
import { createToolActivityProjection } from './tool-activity.js'
import { createSubagentActivityProjection } from './subagent-activity.js'
import { PeakScheduleSource } from './peak-schedule.js'
import { Config, SettingsSchema, sanitizeConfig, sanitizeUsageUrl, sanitizeProvider, sanitizeProviders, sanitizeProviderEndpointUrl, assertRawConfig, OPENROUTER_PROVIDER_PRESET } from './config.js'
import { quotaNetworkDetails, readQuotaJson } from './quota-http.js'
import { pickPath, providerBalanceFromParse, providerWindowsFromParse, parseOpenCodeUsage, fetchProviderQuota, fetchOpenCodeQuota } from './quota-providers.js'
import { fetchClaudeQuota, parseClaudeUsage } from './quota-claude.js'
import { quotaPinOf, readInOrder } from './quota-order.js'
import { buildCodexResult, fetchCodexQuota, parseWhamUsage } from './quota-codex.js'
import { parsePriority, readAllCredentials } from './cpa-credentials.js'
import { ANTIGRAVITY_HOST, parseAntigravityQuotaSummary, fetchAntigravityQuotaForCred, collectAntigravityQuotas, fetchAntigravityQuota } from './quota-antigravity.js'
import { fetchMagpieQuotas, fetchMagpieSubscriptions, requestMagpieQuotas, matchMagpieSubscription, parseMagpieSubscriptions, parseMagpieAntigravity, parseMagpieCodex, windowKind, windowMinutes } from './quota-magpie.js'
import { parseNumstat, parseGitStatusV2, resolveGitRepo, fetchGitStatus, createGitLookups } from './git-status.js'
import { decodeRecentSessionText, normalizeSessionId, selectSessionLog, readLiveSessionModel, readSessionModel } from './session-log.js'
import { sendJson, readBody, rejectBodyError, sameOriginRequest, guardRequest } from './http-route.js'
import { createRestartController, reconcileProfile, systemdUnitOf } from './restart.js'
import { createHostUpdater } from './host-update.js'
import { PACKAGE_NAME, createUpdateChecker, applyUpdate, hostPackageManager, resolveInstall, readInstalled, compareVersions } from './update.js'

const ACCOUNT_QUOTA_ERRORS = ['auth', 'rate-limit', 'network', 'no-credential', 'disabled', 'invalid-response']
const PROVIDER_QUOTA_ERRORS = ['auth', 'rate-limit', 'network', 'no-credential', 'invalid-response', 'not-found', 'disabled', 'signed-out', 'no-account']
const GIT_ERRORS = ['disabled', 'git-not-found', 'git-unsafe-repo', 'git-too-many-files', 'git-timeout', 'git-invalid-cwd', 'git-failed']

// DSH's signed-in DeepSeek account provider owns the stored grant and the
// Platform client headers. It is optional: an installation that only uses API
// keys has no such service, and API-key sources keep working unchanged.
function deepseekAccountOf(ctx) {
  try {
    if (ctx.deepseekAccount) return ctx.deepseekAccount
  } catch (e) { /* 账号服务未挂载 */ }
  try { return typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : undefined } catch (e) { return undefined }
}

// The account provider's five Platform headers need the running client build.
// The browser can send the graph release it booted with; the Host graph is the
// fallback for a minimized client payload or an older browser bundle.
function clientVersionOf(ctx) {
  try {
    const modules = ctx.clientModules || (typeof ctx.get === 'function' ? ctx.get('clientModules') : undefined)
    const version = modules && modules.release && modules.release.version
    if (typeof version === 'string' && version) return version
  } catch (e) { /* 客户端模块服务未挂载 */ }
  return '0.0.0'
}

// Account metadata is display identity, never a credential. Bound every field
// so a malformed request cannot change the Platform origin or header shape.
function accountClientMetadata(ctx, body) {
  const source = body && typeof body.account === 'object' && !Array.isArray(body.account) ? body.account : {}
  const version = typeof source.version === 'string' && source.version.trim()
    ? source.version.trim().slice(0, 64) : clientVersionOf(ctx)
  const locale = typeof source.locale === 'string' && source.locale.trim()
    ? source.locale.trim().slice(0, 32) : 'en-US'
  const offset = typeof source.timezoneOffsetSeconds === 'number' && Number.isFinite(source.timezoneOffsetSeconds)
    ? Math.max(-86400, Math.min(86400, Math.trunc(source.timezoneOffsetSeconds)))
    : -new Date().getTimezoneOffset() * 60
  return { version, locale, timezoneOffsetSeconds: offset }
}

// apply() replaces the defaults with the native profile before any route exists.
const state = {
  config: sanitizeConfig(),
  sessionModelCache: new Map(),
}

/** Identity of this loaded copy, so the page can tell when a hot update replaced it. */
const instanceId = randomUUID()

/**
 * Apply a freshly installed copy to the running profile without a restart.
 *
 * This is the path the plugin manager itself takes after an install: evict the
 * modules that changed on disk and start their entries again. A profile without
 * HMR, or a change that cannot be applied live, only means the update waits for
 * the next start; the page reports which case it hit.
 * @param {object} ctx plugin context of the copy that was just replaced.
 * @returns {Promise<{applied: boolean, reason?: string}>} the outcome, for logging and tests.
 */
async function hotApplyUpdate(ctx) {
  const log = message => console.warn('[statusline-plus] ' + message)
  const outcome = await reconcileProfile(ctx)
  if (outcome.applied) {
    log('update applied to the running profile')
    return { applied: true }
  }
  if (outcome.reason === 'no-hmr') log('update installed; this profile has no HMR, so it applies on the next start')
  else if (outcome.error) log('update installed, but applying it live failed: ' + outcome.reason)
  else log('update needs a restart: ' + outcome.reason)
  return { applied: false, reason: outcome.reason }
}

/**
 * Register one session projection across host generations.
 * DSH 0.2.1 returns a disposer; DSH 0.2.2+ returns an awaitable ProjectionHandle.
 * Awaiting both keeps the registration ready before the routes advertise data.
 * @param {object} ctx plugin context owning the sessionProjections service.
 * @param {object} definition projection definition.
 * @returns {Promise<() => void>} idempotent release function.
 */
async function registerSessionProjection(ctx, definition) {
  const registered = ctx.sessionProjections.register(definition)
  const handle = await registered
  if (typeof handle === 'function') return handle
  if (handle && typeof handle.dispose === 'function') return () => { void handle.dispose() }
  return () => {}
}

async function apply(ctx, options = {}) {
  const quotaDispatcher = createQuotaDispatcher()
  ctx.effect(() => () => quotaDispatcher.destroy())
  // inject guarantees these are ready; direct
  // ctx.get() misses services provided by sibling bundle entries.
  const webServer = ctx.webServer
  const connection = ctx.connection
  const subprocess = ctx.subprocess
  const sessions = ctx.sessions
  const peakSchedule = new PeakScheduleSource({ cachePath: dshHomePath('statusline-peak-cache.json'), log: message => console.warn('[statusline-plus] ' + message) })
  const projectionReleases = []
  projectionReleases.push(await registerSessionProjection(ctx, createSessionMetricsProjection(await loadPricingCatalog(), peakSchedule.pricingSnapshot())))
  projectionReleases.push(await registerSessionProjection(ctx, createToolActivityProjection()))
  projectionReleases.push(await registerSessionProjection(ctx, createSubagentActivityProjection()))
  const gitPool = new RequestPool({ timeoutMs: 8500 })
  const gitLookups = createGitLookups()
  // One registry read per minute at most: the settings page asks on open, never on a timer.
  const checkUpdate = createUpdateChecker({ registry: process.env.STATUSLINE_REGISTRY, log: message => console.warn('[statusline-plus] ' + message) })
  let updateInFlight = false
  // Why the last install could not be swapped in, so the page need not wait to find out.
  let hotFailed = null
  // DSH's own update: one ~70-byte registry read per page load, at most once a minute.
  const hostUpdater = createHostUpdater({ registry: process.env.STATUSLINE_REGISTRY })
  const restart = createRestartController({ ctx, hostUpdater, log: message => console.warn('[statusline-plus] ' + message) })
  // The page treats a new process as recovered only once every plugin and the
  // session store have loaded; an early reload would show an empty session list.
  let hostReady = false
  try {
    const loader = typeof ctx.get === 'function' ? ctx.get('loader') : undefined
    if (loader && typeof loader.await === 'function') loader.await().then(() => { hostReady = true }, () => { hostReady = true })
    else hostReady = true
  } catch (e) { hostReady = true }
  let sshBridge
  let sshBridgeFiber
  if (typeof ctx.inject === 'function') {
    sshBridgeFiber = ctx.inject(['sshRemoteHostBridge'], (scope) => {
      const negotiated = scope.sshRemoteHostBridge.negotiate({
        minVersion: 1,
        maxVersion: 1,
        requiredCapabilities: ['path-mapping', 'reverse-path-mapping', 'routed-subprocess'],
      })
      gitPool.clear(); gitLookups.clear()
      sshBridge = negotiated
      return () => {
        if (sshBridge === negotiated) { sshBridge = undefined; gitPool.clear(); gitLookups.clear() }
      }
    })
  }
  let credentials = ctx.credentials
  if (credentials === undefined && typeof ctx.get === 'function') {
    try { credentials = ctx.get('credentials') } catch (e) { /* 凭据服务未挂载 */ }
  }

  const quotaPool = new RequestPool({ timeoutMs: 20000 })
  const accountPool = new RequestPool({ timeoutMs: 15000 })
  // Several chips refreshing together share one read of the local gateway.
  const magpiePool = new RequestPool({ timeoutMs: 10000 })
  const readMagpie = signal => magpiePool.run('rows', requestSignal => requestMagpieQuotas(requestSignal, quotaDispatcher), { signal, ttlMs: 3000 })
  const quotaConfig = () => ({ ...state.config, readMagpie })
  const tps = new TpsTracker({ enabled: () => state.config.enabled && state.config.showTps })
  const rawOptions = () => Object.fromEntries(Object.entries(options).map(([key, value]) => [key, typeof value?.get === 'function' ? value.get() : value]))
  // A stored profile is read tolerantly: a malformed entry must never stop the plugin
  // from loading, and every other setting keeps working. Edits made in the settings UI
  // are still rejected loudly by validateConfig, so a typo is reported where it is made.
  // The warning is de-duplicated because configSource() runs on every read.
  let configWarning = null
  const warnOnce = message => {
    if (message === configWarning) return
    configWarning = message
    if (message) console.warn('[statusline-plus] ' + message)
  }
  const configSource = () => {
    const raw = rawOptions()
    try {
      return SettingsSchema(raw)
    } catch (error) {
      warnOnce('ignoring invalid stored configuration: ' + ((error && error.message) || String(error)))
      return sanitizeConfig(raw)
    }
  }
  state.config = sanitizeConfig(configSource())
  const disposers = []
  // A local sign-out makes cached account balances stale immediately; do not
  // let the normal TTL keep showing a signed-out wallet.
  if (typeof ctx.on === 'function') disposers.push(ctx.on('deepseek-account/signed-out', () => quotaPool.clear()))
  // Every listener and route is released with the plugin scope, so Harness HMR can
  // reload this plugin repeatedly without duplicate handlers.
  // The Config schema tolerates a malformed stored provider so the plugin can always
  // load. This waterfall runs before a settings edit is persisted (dsh-config-editor
  // resolves it, then writes the RAW value), and it is registered inside apply(), so it
  // is absent during this plugin's own activation. A stored profile therefore stays
  // tolerant while an edit that would persist a literal secret or an internal endpoint
  // is still rejected before anything reaches disk.
  disposers.push(ctx.on('internal/config', function (raw, next) {
    const config = next()
    // Cordis wraps fibers in tracing proxies, so `this === ctx.fiber` is false even for
    // the same fiber (their uids match). Scope by uid, never by object identity.
    if (this?.uid !== ctx.fiber?.uid) return config
    assertRawConfig(config)
    return config
  }))
  disposers.push(ctx.on('settings/document-updated', ns => {
    if (ns !== 'statusline-plus') return

    const previous = state.config
    state.config = sanitizeConfig(configSource())
    // Display-only edits neither cancel requests nor invalidate cached data.
    const changed = keys => keys.some(key => JSON.stringify(previous[key]) !== JSON.stringify(state.config[key]))
    if (changed(['enabled', 'showQuota', 'showCodexQuota', 'showAntigravityQuota', 'showOpenCodeQuota', 'apiKeyEnv', 'usageUrl', 'fetchTimeoutMs', 'cacheTtlMs', 'codexAccount', 'antigravityAccount', 'showClaudeQuota', 'quotaSources', 'providers'])) {
      quotaPool.clear()
      accountPool.clear()
      magpiePool.clear()
    }
    if (changed(['enabled', 'showGit', 'gitCwd'])) { gitPool.clear(); gitLookups.clear() }
    if (changed(['enabled', 'showTps'])) tps.reset()
  }))
  const quota = (key, load, force, signal) => {
    if (!state.config.enabled || !state.config.showQuota) throw new Error('disabled')
    if (key.startsWith('opencode') && !state.config.showOpenCodeQuota || key === 'codex' && !state.config.showCodexQuota || key === 'antigravity' && !state.config.showAntigravityQuota || key === 'claude' && state.config.showClaudeQuota === false) throw new Error('disabled')
    return quotaPool.run(key, load, { force, signal, ttlMs: Math.max(15000, state.config.cacheTtlMs) })
  }
  const register = spec => webServer.register({ ...spec, handler: async (req, res) => {
    // Named webServer routes bypass the built-in /api transport. Admit them
    // through the same Host/Origin fence and browser authentication first.
    const admission = connection.admit(req)
    if ('rejection' in admission) return sendJson(res, admission.rejection, {
      ok: false, error: admission.rejection === 401 ? 'unauthorized' : 'forbidden',
    })
    const controller = new AbortController()
    const abort = () => controller.abort(new Error('client-disconnected'))
    const close = () => { if (!res.writableEnded) abort() }
    req.once('aborted', abort)
    res.once?.('close', close)
    req.slpSignal = controller.signal
    try { await spec.handler(req, res) } finally {
      req.removeListener('aborted', abort)
      res.removeListener?.('close', close)
    }
  } })
  // Account quota routes answer with a stable short code; anything else reads as network.
  const quotaRoute = (path, errors, load) => register({
    kind: 'exact', path,
    handler: async (req, res) => {
      if (!guardRequest(req, res, ['POST'], true)) return
      const body = await readBody(req)
      if (rejectBodyError(body, res)) return
      try {
        const data = await load(body, body.force === true, req.slpSignal)
        // Host clock at response time. The browser converts fetchedAt into its
        // own clock domain, so a skewed client never sits at 0s until it catches up.
        return sendJson(res, 200, { ok: true, data, serverNow: Date.now() })
      } catch (e) {
        const msg = (e && e.message) || String(e)
        return sendJson(res, 200, { ok: false, error: errors.includes(msg) ? msg : 'network' })
      }
    },
  })

  disposers.push(
    ctx.on('agent/assistant-stream', payload => tps.onFrame(payload)),
    ctx.on('session/event', (session, event) => tps.onSession(session, event)),
  )

  disposers.push(
    register({
      kind: 'exact', path: '/statusline/api/peak-schedule',
      handler: async (req, res) => {
        if (!guardRequest(req, res, ['GET'], false)) return
        if (!sameOriginRequest(req)) return sendJson(res, 403, { ok: false, error: 'cross-origin' })
        return sendJson(res, 200, { ok: true, data: await peakSchedule.get() })
      },
    }),
    register({
      kind: 'exact', path: '/statusline/api/tps',
      handler: async (req, res) => {
        if (!guardRequest(req, res, ['GET'], false)) return
        if (!sameOriginRequest(req)) return sendJson(res, 403, { ok: false, error: 'cross-origin' })
        if (!state.config.enabled || !state.config.showTps) { res.writeHead(204); res.end(); return }
        const sessionId = new URL(req.url, 'http://localhost').searchParams.get('sessionId')
        if (!validSessionId(sessionId)) return sendJson(res, 400, { ok: false, error: 'invalid-session' })
        return streamTps(tps, sessionId, req, res, req.slpSignal)
      },
    }),
    register({
      kind: 'exact',
      path: '/statusline/api/restart',
      handler: async (req, res) => {
        if (!guardRequest(req, res, ['GET', 'POST'], req.method === 'POST')) return
        if (!sameOriginRequest(req)) return sendJson(res, 403, { ok: false, error: 'cross-origin' })
        // Switched off in settings: no registry reads and no restarts, only a marker the page hides on.
        const restartEnabled = state.config.enabled && state.config.showRestartButton !== false
        if (req.method === 'GET' && !restartEnabled) return sendJson(res, 200, { ok: true, data: { disabled: true, pid: process.pid } })
        if (req.method === 'POST' && !restartEnabled) return sendJson(res, 409, { ok: false, error: 'disabled' })
        if (req.method === 'GET') {
          const query = new URL(req.url, 'http://localhost').searchParams
          // Progress probes skip the update check; the button asks for it once on mount.
          const update = hostReady && query.get('update') === '1'
            ? await restart.updateStatus({ force: query.get('force') === '1', signal: req.slpSignal }).catch(() => null)
            : undefined
          return sendJson(res, hostReady ? 200 : 503, { ok: hostReady, data: { ...restart.status(), ready: hostReady, instanceId, ...(update === undefined ? {} : { update }) } })
        }
        const body = await readBody(req)
        if (rejectBodyError(body, res)) return
        const mode = ['reload', 'restart', 'update'].includes(body.mode) ? body.mode : null
        if (!mode) return sendJson(res, 400, { ok: false, error: 'invalid-mode' })
        if (mode === 'update' && typeof body.version !== 'string') return sendJson(res, 400, { ok: false, error: 'invalid-version' })
        // The work is deferred inside request(), so this response leaves first.
        const result = restart.request(mode, { version: body.version })
        return sendJson(res, result.ok ? 202 : 409, result.ok ? { ok: true, data: { seq: result.seq, pid: process.pid, instanceId } } : result)
      },
    }),
    register({
      kind: 'exact',
      path: '/statusline/api/version',
      handler: async (req, res) => {
        if (!guardRequest(req, res, ['GET', 'POST'], req.method === 'POST')) return
        if (!sameOriginRequest(req)) return sendJson(res, 403, { ok: false, error: 'cross-origin' })
        if (req.method === 'GET') {
          const force = new URL(req.url, 'http://localhost').searchParams.get('force') === '1'
          const data = await checkUpdate({ force, signal: req.slpSignal })
          return sendJson(res, 200, { ok: true, data: { ...data, instanceId, hotFailed } })
        }
        const body = await readBody(req)
        if (rejectBodyError(body, res)) return
        const version = typeof body.version === 'string' ? body.version.trim() : ''
        if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) return sendJson(res, 400, { ok: false, error: 'invalid-version' })
        const install = resolveInstall()
        // A linked checkout is the developer's own tree; replacing it from the
        // settings page would silently detach the profile from that tree.
        if (install.linked) return sendJson(res, 409, { ok: false, error: 'linked-install' })
        const installed = readInstalled().version
        if (installed !== null && compareVersions(version, installed) <= 0) return sendJson(res, 409, { ok: false, error: 'not-newer' })
        if (updateInFlight) return sendJson(res, 409, { ok: false, error: 'in-flight' })
        updateInFlight = true
        try {
          // Deliberately not tied to req.slpSignal: aborting pnpm because the tab
          // closed would leave node_modules half-written.
          const result = await applyUpdate({ version, profileDir: install.dir, profile: install.profile, subprocess, packageManager: hostPackageManager(ctx) })
          if (result.exitCode !== 0) return sendJson(res, 200, { ok: false, error: 'install-failed', output: result.output })
          sendJson(res, 200, { ok: true, data: { version, output: result.output, instanceId } })
          // Applying the replacement disposes this plugin's own fiber, so it runs
          // only after the response is on the wire. The page learns the outcome by
          // watching for a new instance id, and falls back to a restart prompt.
          hotFailed = null
          setTimeout(() => {
            void hotApplyUpdate(ctx).then(outcome => { if (!outcome.applied) hotFailed = outcome.reason })
          }, 80)
          return undefined
        } catch (error) {
          const reason = String((error && error.message) || error)
          if (reason !== 'no-package-manager') return sendJson(res, 200, { ok: false, error: 'install-failed' })
          // No installer started, so name the one that works on this machine: the
          // host's own CLI, which carries the package manager DSH ships with.
          const hint = `dsh plugin${install.profile ? ` --profile ${install.profile}` : ''} add ${PACKAGE_NAME}@${version}`
          return sendJson(res, 200, { ok: false, error: 'no-package-manager', output: hint })
        } finally {
          updateInFlight = false
        }
      },
    }),
    register({
      kind: 'exact',
      path: '/statusline/api/usage',
      handler: async (req, res) => {
        if (!guardRequest(req, res, ['POST'], true)) return
        const body = await readBody(req)
        if (rejectBodyError(body, res)) return
        const force = body && body.force === true
        try {
          const directOnly = body && body.direct === true
          const data = await quota(directOnly ? 'opencode:direct' : 'opencode', signal => fetchOpenCodeQuota(credentials, quotaConfig(), signal, quotaDispatcher, directOnly), force, req.slpSignal)
          return sendJson(res, 200, { ok: true, data, serverNow: Date.now() })
        } catch (e) {
          return sendJson(res, 200, {
            ok: false,
            error: (e && e.message) || String(e),
          })
        }
      },
    }),
    register({
      kind: 'exact',
      path: '/statusline/api/git',
      handler: async (req, res) => {
        if (!guardRequest(req, res, ['POST'], true)) return
        const body = await readBody(req)
        if (rejectBodyError(body, res)) return
        const cwd = body && body.cwd
        const sessionId = body && body.sessionId
        try {
          if (!state.config.enabled || !state.config.showGit) throw new Error('disabled')
          const key = String(sessionId || '') + '\0' + String(cwd || '')
          const force = body?.force === true
          // Manual retry may recover immediately after a local repo repair.
          if (force) { gitPool.cache.delete(key); gitLookups.clear() }
          const data = await gitPool.run(key,
            signal => fetchGitStatus(subprocess, cwd, sshBridge, signal, gitLookups),
            { signal: req.slpSignal, force, ttlMs: 1000 })
          return sendJson(res, 200, { ok: true, data })
        } catch (e) {
          // A stable code only: Git's own output can name private paths.
          const message = e && e.message
          return sendJson(res, 200, { ok: false, error: message === 'timeout' ? 'git-timeout' : GIT_ERRORS.includes(message) ? message : 'git-failed' })
        }
      },
    }),
    quotaRoute('/statusline/api/codex-quota', ACCOUNT_QUOTA_ERRORS, (body, force, signal) =>
      quota('codex', requestSignal => fetchCodexQuota(quotaConfig(), requestSignal, quotaDispatcher, credentials), force, signal)),
    quotaRoute('/statusline/api/antigravity-quota', ACCOUNT_QUOTA_ERRORS, (body, force, signal) =>
      quota('antigravity', requestSignal => fetchAntigravityQuota(quotaConfig(), force, requestSignal, accountPool, quotaDispatcher), force, signal)),
    quotaRoute('/statusline/api/claude-quota', ACCOUNT_QUOTA_ERRORS, (body, force, signal) =>
      quota('claude', requestSignal => fetchClaudeQuota(quotaConfig(), requestSignal, quotaDispatcher), force, signal)),
    // Whatever this user's Magpie reports: one subscription by id, or all of them.
    quotaRoute('/statusline/api/magpie-quota', PROVIDER_QUOTA_ERRORS, (body, force, signal) => {
      const id = typeof body.id === 'string' ? body.id.trim().toLowerCase().slice(0, 64) : ''
      return quota('magpie:' + id, async requestSignal => {
        const list = await fetchMagpieSubscriptions(quotaConfig(), requestSignal, quotaDispatcher)
        if (!id) return { subscriptions: list, fetchedAt: Date.now(), source: 'magpie' }
        const hit = matchMagpieSubscription(list, [id])
        if (!hit) throw new Error('no-credential')
        return { ...hit, source: 'magpie' }
      }, force, signal)
    }),
    quotaRoute('/statusline/api/provider-quota', PROVIDER_QUOTA_ERRORS, (body, force, signal) => {
      const id = typeof body.id === 'string' ? body.id.trim().slice(0, 64) : ''
      if (!id) throw new Error('not-found')
      // The live session's billing provider decides whether DeepSeek reads the
      // API-key wallet or the signed-in Platform account. Cache keys keep those
      // two balances apart even when the configured source id is the same.
      const modelProvider = typeof body.provider === 'string' ? body.provider.trim().toLowerCase().slice(0, 64) : ''
      const account = modelProvider === 'deepseek-account' ? deepseekAccountOf(ctx) : undefined
      const cacheKey = 'provider:' + id + (modelProvider ? ':' + modelProvider : '')
      return quota(cacheKey, requestSignal => fetchProviderQuota(credentials, quotaConfig(), id, requestSignal, quotaDispatcher, {
        modelProvider,
        account,
        client: account ? accountClientMetadata(ctx, body) : undefined,
      }).then(data => ({ ...data, source: modelProvider === 'deepseek-account' ? 'host' : data.source || 'direct' })), force, signal)
    }),
    register({
      kind: 'exact',
      path: '/statusline/api/session-model',
      handler: async (req, res) => {
        if (!guardRequest(req, res, ['POST'], true)) return
        const body = await readBody(req)
        if (rejectBodyError(body, res)) return
        const sessionId = String((body && body.sessionId) || '').trim()
        const normalizedSessionId = normalizeSessionId(sessionId)
        if (!normalizedSessionId) {
          const live = readLiveSessionModel(sessions, sessionId)
          return sendJson(res, 200, live ? { ok: true, data: live } : { ok: false, error: 'session-not-found' })
        }
        const liveModel = readLiveSessionModel(sessions, sessionId)
        if (liveModel) return sendJson(res, 200, { ok: true, data: liveModel })
        const now = Date.now()
        const cached = state.sessionModelCache.get(normalizedSessionId)
        if (cached && now - cached.at < 10000) {
          return sendJson(res, 200, cached.result)
        }
        let result
        try {
          const model = readSessionModel(sessionId, sessions)
          result = model ? { ok: true, data: model } : { ok: false, error: 'model-unknown' }
        } catch (e) {
          result = { ok: false, error: /not found/i.test((e && e.message) || '') ? 'session-not-found' : 'decode' }
        }
        // Bounded FIFO: at most 64 sessions, 10 s each.
        if (state.sessionModelCache.size >= 64) {
          const first = state.sessionModelCache.keys().next().value
          if (first !== undefined) state.sessionModelCache.delete(first)
        }
        state.sessionModelCache.set(normalizedSessionId, { at: now, result })
        return sendJson(res, 200, result)
      },
    })
  )

  ctx.effect(() => () => {
    quotaPool.close()
    magpiePool.close()
    gitPool.close()
    accountPool.close()
    tps.reset()
    state.sessionModelCache.clear()
    sshBridge = undefined
    if (sshBridgeFiber && typeof sshBridgeFiber.dispose === 'function') sshBridgeFiber.dispose()
    for (const d of disposers) d()
    for (const release of projectionReleases) release()
  })
}

const api = { Config, name: 'dsh-statusline-plus', inject: ['webServer', 'connection', 'subprocess', 'credentials', 'sessions', 'settings', 'sessionProjections'], apply }
// 测试钩子：仅当 SLP_TEST=1 时暴露纯函数，便于独立脚本验证解析逻辑
if (process.env.SLP_TEST === '1') {
  api.__test = {
    selectSessionLog,
    SettingsSchema,
    readQuotaJson,
    quotaNetworkDetails,
    sanitizeConfig,
    assertRawConfig,
    sanitizeUsageUrl,
    parseWhamUsage,
    buildCodexResult,
    fetchCodexQuota,
    fetchAntigravityQuota,
    ANTIGRAVITY_HOST,
    parseAntigravityQuotaSummary,
    collectAntigravityQuotas,
    fetchAntigravityQuotaForCred,
    fetchMagpieQuotas,
    fetchMagpieSubscriptions,
    requestMagpieQuotas,
    parseMagpieSubscriptions,
    matchMagpieSubscription,
    fetchClaudeQuota,
    parseClaudeUsage,
    fetchOpenCodeQuota,
    readInOrder,
    quotaPinOf,
    parseMagpieAntigravity,
    parseMagpieCodex,
    windowKind,
    windowMinutes,
    parsePriority,
    readAllCredentials,
    sanitizeProviders,
    sanitizeProvider,
    sanitizeProviderEndpointUrl,
    pickPath,
    providerBalanceFromParse,
    providerWindowsFromParse,
    parseOpenCodeUsage,
    OPENROUTER_PROVIDER_PRESET,
    estimateTextTokens,
    hotApplyUpdate,
    systemdUnitOf,
    parseNumstat,
    parseGitStatusV2,
    resolveGitRepo,
    fetchGitStatus,
    createGitLookups,
    decodeRecentSessionText,
    readLiveSessionModel,
    readSessionModel,
  }
}
export default api
export const name = api.name
export const inject = api.inject
export { Config, apply }
export const __test = api.__test
