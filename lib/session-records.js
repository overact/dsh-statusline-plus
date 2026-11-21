'use strict'
/**
 * Shared readers for session identities and native compact stream records.
 * Used by the TPS tracker, the session-model route and the cost fold, so all
 * three agree on one spelling of a session id and one usage record.
 */

// Native Agent ids are `session-<uuid>`, UI ids may be the bare uuid.
const SESSION_ID_RE = /^(?:session-)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

/** The bare lowercase uuid of a session id, or null when it is not one. */
function normalizeSessionId(sessionId) {
  const match = String(sessionId || '').trim().match(SESSION_ID_RE)
  return match ? match[1].toLowerCase() : null
}

// assistant/attempt has no top-level usage in DSH 0.2.0, but its compact
// stream preserves the provider's latest usage chunk. Read it in place without
// keeping any generated content.
function lastStreamUsage(stream) {
  if (!Array.isArray(stream)) return null
  for (let i = stream.length - 1; i >= 0; i--) {
    const record = stream[i]
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage
  }
  return null
}

export { normalizeSessionId, lastStreamUsage }
