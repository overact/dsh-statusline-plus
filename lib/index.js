'use strict'
/**
 * dsh-statusline-plus — host half.
 * Registers webServer API routes used by the browser bundle:
 *   GET  /statusline/api/config -> current config
 *   POST /statusline/api/config -> revisioned native profile configuration update
 *   POST /statusline/api/usage  -> fetch opencode.ai quota (official API), optional force
 *   POST /statusline/api/git    -> git status --porcelain for a given cwd
 *   POST /statusline/api/codex-quota -> fetch Codex subscription quota (optional force)
 *   POST /statusline/api/antigravity-quota -> fetch Antigravity subscription quota (Google API, optional force)
 *   POST /statusline/api/provider-quota -> fetch a declared providers[] entry (balance / windows)
 *   POST /statusline/api/session-model -> current provider/model of a live session
 *   GET  /statusline/api/peak-schedule -> holiday calendar + official-rule change check (24 h cache)
 *   GET  /statusline/api/tps -> streaming TPS for one session (server-sent events)
 *
 * Module map: config.js (settings model and schema), quota-*.js and cpa-credentials.js
 * (account quota sources), git-status.js, session-log.js, http-route.js, tps.js,
 * session-metrics.js / tool-activity.js (session projections), peak-schedule.js.
 */
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { RequestPool } from './request-pool.js'
import { createQuotaDispatcher } from './quota-transport.js'
import { TpsTracker, streamTps, estimateTextTokens, validSessionId } from './tps.js'
import { createSessionMetricsProjection } from './session-metrics.js'
import { loadPricingCatalog } from './model-pricing.js'
import { createToolActivityProjection } from './tool-activity.js'
import { PeakScheduleSource } from './peak-schedule.js'
import { Config, SettingsSchema, sanitizeConfig, sanitizeUsageUrl, sanitizeProvider, sanitizeProviders, sanitizeProviderEndpointUrl, assertRawConfig, OPENROUTER_PROVIDER_PRESET } from './config.js'
import { quotaNetworkDetails, readQuotaJson } from './quota-http.js'
import { pickPath, providerBalanceFromParse, providerWindowsFromParse, fetchProviderQuota, fetchUsage } from './quota-providers.js'
import { buildCodexResult, fetchCodexQuota, parseWhamUsage } from './quota-codex.js'
import { parsePriority, readAllCredentials } from './cpa-credentials.js'
import { ANTIGRAVITY_HOST, parseAntigravityQuotaSummary, fetchAntigravityQuotaForCred, collectAntigravityQuotas, fetchAntigravityQuota } from './quota-antigravity.js'
import { parseNumstat, parseGitStatus, parseGitStatusV2, resolveGitRepo, fetchGitStatus } from './git-status.js'
import { decodeRecentSessionText, normalizeSessionId, selectSessionLog, readLiveSessionModel, readSessionModel } from './session-log.js'
import { sendJson, readBody, rejectBodyError, sameOriginRequest, guardRequest } from './http-route.js'

const ACCOUNT_QUOTA_ERRORS = ['auth', 'rate-limit', 'network', 'no-credential', 'account-required', 'disabled', 'invalid-response']
const PROVIDER_QUOTA_ERRORS = ['auth', 'rate-limit', 'network', 'no-credential', 'invalid-response', 'not-found', 'disabled']

// apply() replaces the defaults with the native profile before any route exists.
const state = {
  config: sanitizeConfig(),
  sessionModelCache: new Map(),
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
  ctx.sessionProjections.register(createSessionMetricsProjection(await loadPricingCatalog(), peakSchedule.pricingSnapshot()))
  ctx.sessionProjections.register(createToolActivityProjection())
  const gitPool = new RequestPool({ timeoutMs: 8500 })
  let sshBridge
  let sshBridgeFiber
  if (typeof ctx.inject === 'function') {
    sshBridgeFiber = ctx.inject(['sshRemoteHostBridge'], (scope) => {
      const negotiated = scope.sshRemoteHostBridge.negotiate({
        minVersion: 1,
        maxVersion: 1,
        requiredCapabilities: ['path-mapping', 'reverse-path-mapping', 'routed-subprocess'],
      })
      gitPool.clear()
      sshBridge = negotiated
      return () => {
        if (sshBridge === negotiated) { sshBridge = undefined; gitPool.clear() }
      }
    })
  }
  let credentials = ctx.credentials
  if (credentials === undefined && typeof ctx.get === 'function') {
    try { credentials = ctx.get('credentials') } catch (e) { /* 凭据服务未挂载 */ }
  }

  const quotaPool = new RequestPool({ timeoutMs: 20000 })
  const accountPool = new RequestPool({ timeoutMs: 15000 })
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
    if (changed(['enabled', 'showQuota', 'showCodexQuota', 'showAntigravityQuota', 'showOpenCodeQuota', 'apiKeyEnv', 'usageUrl', 'fetchTimeoutMs', 'cacheTtlMs', 'codexAccount', 'antigravityAccount', 'providers'])) {
      quotaPool.clear()
      accountPool.clear()
    }
    if (changed(['enabled', 'showGit', 'gitCwd'])) gitPool.clear()
    if (changed(['enabled', 'showTps'])) tps.reset()
  }))
  const quota = (key, load, force, signal) => {
    if (!state.config.enabled || !state.config.showQuota) throw new Error('disabled')
    if (key === 'opencode' && !state.config.showOpenCodeQuota || key === 'codex' && !state.config.showCodexQuota || key === 'antigravity' && !state.config.showAntigravityQuota) throw new Error('disabled')
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
        return sendJson(res, 200, { ok: true, data: await load(body, body.force === true, req.slpSignal) })
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
      path: '/statusline/api/config',
      handler: async (req, res) => {
        if (!guardRequest(req, res, ['GET', 'POST'], req.method === 'POST')) return
        if (req.method === 'POST') {
          const body = await readBody(req)
          if (rejectBodyError(body, res)) return
          if (!Number.isSafeInteger(body.revision)) return sendJson(res, 409, { ok: false, error: 'revision-required' })
          // Validate before persisting: an invalid patch must never reach the
          // profile, and it must not be reported as a revision conflict.
          try {
            // The schema drops malformed providers so a stored profile can never stop the
            // plugin, so the patch itself is checked here before that tolerance applies.
            // The executable schema normalises, so the raw merged value is checked here
            // before it can be written.
            assertRawConfig({ ...rawOptions(), ...body.patch })
          } catch (error) { return sendJson(res, 400, { ok: false, error: 'invalid-config' }) }
          try {
            await ctx.settings.update('statusline-plus', body.patch || {}, body.revision)
          } catch (error) {
            // Only a revision clash is a conflict. Labelling every write failure that way
            // hid persistence and overlay errors behind a misleading code.
            const message = String((error && error.message) || error)
            if (/revision|stale|conflict/i.test(message)) return sendJson(res, 409, { ok: false, error: 'config-conflict' })
            return sendJson(res, 500, { ok: false, error: 'config-write-failed' })
          }
          return sendJson(res, 200, { ok: true, config: sanitizeConfig(configSource()) })
        }
        return sendJson(res, 200, { ok: true, config: state.config })
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
          const data = await quota('opencode', signal => fetchUsage(credentials, state.config, signal, quotaDispatcher), force, req.slpSignal)
          return sendJson(res, 200, { ok: true, data, config: state.config })
        } catch (e) {
          return sendJson(res, 200, {
            ok: false,
            error: (e && e.message) || String(e),
            config: state.config,
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
          if (force) gitPool.cache.delete(key)
          const data = await gitPool.run(key,
            signal => fetchGitStatus(subprocess, cwd, [], sshBridge, signal),
            { signal: req.slpSignal, force, ttlMs: 1000 })
          return sendJson(res, 200, { ok: true, data })
        } catch (e) {
          return sendJson(res, 200, {
            ok: false,
            error: (e && e.message) || String(e),
          })
        }
      },
    }),
    quotaRoute('/statusline/api/codex-quota', ACCOUNT_QUOTA_ERRORS, (body, force, signal) =>
      quota('codex', requestSignal => fetchCodexQuota(state.config.codexAccount, requestSignal, quotaDispatcher), force, signal)),
    quotaRoute('/statusline/api/antigravity-quota', ACCOUNT_QUOTA_ERRORS, (body, force, signal) =>
      quota('antigravity', requestSignal => fetchAntigravityQuota(state.config, force, requestSignal, accountPool, quotaDispatcher), force, signal)),
    quotaRoute('/statusline/api/provider-quota', PROVIDER_QUOTA_ERRORS, (body, force, signal) => {
      const id = typeof body.id === 'string' ? body.id.trim().slice(0, 64) : ''
      if (!id) throw new Error('not-found')
      return quota('provider:' + id, requestSignal => fetchProviderQuota(credentials, state.config, id, requestSignal, quotaDispatcher), force, signal)
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
    gitPool.close()
    accountPool.close()
    tps.reset()
    state.sessionModelCache.clear()
    sshBridge = undefined
    if (sshBridgeFiber && typeof sshBridgeFiber.dispose === 'function') sshBridgeFiber.dispose()
    for (const d of disposers) d()
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
    sanitizeUsageUrl,
    parseWhamUsage,
    buildCodexResult,
    ANTIGRAVITY_HOST,
    parseAntigravityQuotaSummary,
    collectAntigravityQuotas,
    fetchAntigravityQuotaForCred,
    parsePriority,
    readAllCredentials,
    sanitizeProviders,
    sanitizeProvider,
    sanitizeProviderEndpointUrl,
    pickPath,
    providerBalanceFromParse,
    providerWindowsFromParse,
    OPENROUTER_PROVIDER_PRESET,
    estimateTextTokens,
    parseNumstat,
    parseGitStatus,
    parseGitStatusV2,
    resolveGitRepo,
    fetchGitStatus,
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
