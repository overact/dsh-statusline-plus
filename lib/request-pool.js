'use strict'

/** Shared requests with bounded caching, backoff and subscriber-owned cancellation. */
class RequestPool {
  constructor({ limit = 64, timeoutMs = 20000, now = Date.now } = {}) {
    this.limit = limit
    this.timeoutMs = timeoutMs
    this.now = now
    this.entries = new Map()
    this.cache = new Map()
    this.closed = false
  }
  clear() {
    for (const entry of this.entries.values()) entry.controller.abort(new Error('request-invalidated'))
    this.entries.clear()
    this.cache.clear()
  }
  close() { this.closed = true; this.clear() }
  run(key, load, { force = false, signal, ttlMs = 60000 } = {}) {
    if (this.closed) return Promise.reject(new Error('disabled'))
    if (signal?.aborted) return Promise.reject(signal.reason)
    const cached = this.cache.get(key)
    if (cached && this.now() < cached.until && (cached.error || !force)) {
      return cached.error ? Promise.reject(cached.error) : Promise.resolve(cached.value)
    }
    let entry = this.entries.get(key)
    if (!entry) {
      if (this.entries.size >= this.limit) return Promise.reject(new Error('busy'))
      const controller = new AbortController()
      entry = { controller, subscribers: 0 }
      this.entries.set(key, entry)
      const timer = setTimeout(() => controller.abort(new Error('timeout')), this.timeoutMs)
      const aborted = new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
      })
      entry.promise = Promise.race([Promise.resolve().then(() => { controller.signal.throwIfAborted(); return load(controller.signal) }), aborted])
        .then(value => {
          if (ttlMs > 0 && !controller.signal.aborted && this.entries.get(key) === entry) this.remember(key, { value, until: this.now() + ttlMs })
          return value
        }, error => {
          if (ttlMs > 0 && !controller.signal.aborted && this.entries.get(key) === entry) {
            const delay = error?.message === 'rate-limit' ? Math.max(60000, Math.min(3600000, error.retryAfterMs || 0)) : 15000
            this.remember(key, { error, until: this.now() + delay })
          }
          throw error
        }).finally(() => {
          clearTimeout(timer)
          if (this.entries.get(key) === entry) this.entries.delete(key)
        })
    }
    entry.subscribers++
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', cancel)
        entry.subscribers--
        fn(value)
      }
      const cancel = () => {
        finish(reject, signal.reason)
        if (entry.subscribers === 0) {
          entry.controller.abort(new Error('request-cancelled'))
          if (this.entries.get(key) === entry) this.entries.delete(key)
        }
      }
      signal?.addEventListener('abort', cancel, { once: true })
      entry.promise.then(value => finish(resolve, value), error => finish(reject, error))
    })
  }
  remember(key, value) {
    this.cache.delete(key)
    if (this.cache.size >= this.limit) this.cache.delete(this.cache.keys().next().value)
    this.cache.set(key, value)
  }
}
export { RequestPool }
