'use strict'
// Fold invariants shared by the session projections: which events belong to
// this session (inherited count/last seq) and which values are safe to store.
const ID_LIMIT = 256
const validCount = value => Number.isSafeInteger(value) && value >= 0
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= ID_LIMIT
const finiteTime = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const timeOf = value => finiteTime(value) ? value : null
const inheritedCount = value => validCount(value) ? value : 0
const acceptEvent = (event, inherited, lastSeq = -1) => !!event && validCount(event.seq) && event.seq >= inherited && event.seq > lastSeq
// Keep the first evictable entry (oldest settled/running) when the list is full.
function appendBounded(list, item, limit, evictable) {
  const next = [...list, item]
  if (next.length <= limit) return { list: next, evicted: null }
  const index = Math.max(0, next.findIndex(evictable))
  const evicted = next[index]
  next.splice(index, 1)
  return { list: next, evicted }
}

export { acceptEvent, appendBounded, finiteTime, inheritedCount, timeOf, validCount, validId }
