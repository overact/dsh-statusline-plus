'use strict'
/** One async value, cached for a TTL and shared by concurrent readers. */
function createCachedRefresh({ read, ttlMs = 60000, now = Date.now }) {
  const lifetime = typeof ttlMs === 'function' ? ttlMs : () => ttlMs
  let cached = null, pending = null
  return {
    async read({ force = false } = {}) {
      if (!force && cached && now() < cached.until) return cached.value
      if (!pending) pending = Promise.resolve().then(read).then(value => {
        cached = { value, until: now() + Math.max(0, lifetime(value)) }
        return value
      }, error => { throw error }).finally(() => { pending = null })
      return pending
    },
    peek() { return cached ? cached.value : null },
    clear() { cached = null },
  }
}
export { createCachedRefresh }
