'use strict'
/** Bounded key/value cache with a per-entry TTL and one eviction policy. */
function createTtlMap({ ttlMs = 60000, limit = 64, now = Date.now } = {}) {
  const entries = new Map()
  return {
    get(key) { const hit = entries.get(key); if (!hit) return undefined; if (now() < hit.until) return hit.value; entries.delete(key); return undefined },
    // `ttl` overrides the map default for this entry (request-pool error backoff).
    set(key, value, ttl = ttlMs) { entries.delete(key); if (entries.size >= limit) entries.delete(entries.keys().next().value); entries.set(key, { value, until: now() + ttl }); return value },
    delete(key) { entries.delete(key) },
    clear() { entries.clear() },
    get size() { return entries.size },
  }
}
export { createTtlMap }
