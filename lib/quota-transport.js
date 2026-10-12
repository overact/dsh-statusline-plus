import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// Scope this to the plugin: never change Node defaults or the global dispatcher.
// The caller's AbortSignal still owns the complete request deadline.
function createQuotaDispatcher() {
  const { Agent } = require('undici')
  return new Agent({
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: 5000,
    connectTimeout: 15000,
  })
}

export { createQuotaDispatcher }
