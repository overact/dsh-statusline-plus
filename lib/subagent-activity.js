'use strict'

/**
 * Parent-session fold of direct-child discovery and settlement.
 *
 * The Host's `subagentCatalog` projection lists direct children, but an
 * external child (Claude Code, Codex) is recorded without a local child
 * Session: its id never appears in the session list or the status map, so the
 * browser half has no running state or timing for it. The parent's own log
 * still carries both edges — `subagent/catalog` when the child is established
 * and a `user/message` with `source.kind === 'subagent-settled'` when its
 * activation settles — and this fold turns them into one durable record per
 * child. A child with no settlement record yet is reported as unsettled; the
 * browser half treats that as running, which is the only reading consistent
 * with a live activation.
 *
 * Inherited events are excluded: a fork seed replays its ancestor's catalog
 * and settlement notices, which are not this session's children.
 *
 * @module dsh-statusline-plus/subagent-activity
 */

import { z } from 'zod'

// The panel shows at most 12 rows; a longer history only needs to stay bounded.
const CHILD_LIMIT = 64
const ID_LIMIT = 256
const LABEL_LIMIT = 512
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const timestamp = z.number().finite().nonnegative()
const modeSchema = z.enum(['one-shot', 'continuable', 'external', 'unknown'])
const childSchema = z.object({
  id: z.string().min(1).max(ID_LIMIT),
  mode: modeSchema,
  label: z.string().max(LABEL_LIMIT).nullable(),
  createdAt: timestamp,
  settledAt: timestamp.nullable(),
}).strict()
const viewSchema = z.object({
  children: z.array(childSchema).max(CHILD_LIMIT),
  truncated: z.boolean(),
}).strict()
const stateSchema = z.object({
  inheritedEventCount: count,
  lastSeq: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
  children: z.array(childSchema).max(CHILD_LIMIT),
  truncated: z.boolean(),
}).strict()

const validCount = value => Number.isSafeInteger(value) && value >= 0
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= ID_LIMIT
const timeOf = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const modeOf = value => value === 'one-shot' || value === 'continuable' || value === 'external' ? value : 'unknown'
const labelOf = value => typeof value === 'string' && value.length > 0 ? value.slice(0, LABEL_LIMIT) : null

function finish(state, children, truncated, seq) {
  return { ...state, children, truncated, lastSeq: seq }
}

// Evict a settled child first: a running one is still reported by the chip.
function appendChild(state, child) {
  const children = [...state.children, child]
  let truncated = state.truncated
  if (children.length > CHILD_LIMIT) {
    const settled = children.findIndex(item => item.settledAt !== null)
    children.splice(settled < 0 ? 0 : settled, 1)
    truncated = true
  }
  return { children, truncated }
}

function applySubagentActivity(state, event) {
  if (!event || !validCount(event.seq) || event.seq < state.inheritedEventCount || event.seq <= state.lastSeq) return state
  const data = event.data || {}, seq = event.seq
  if (event.type === 'subagent/catalog') {
    const id = data.childId
    if (!validId(id)) return state
    const createdAt = timeOf(event.time) ?? timeOf(data.childCreatedAt)
    if (createdAt === null) return state
    const index = state.children.findIndex(child => child.id === id)
    // A repeated discovery fact keeps the first origin; only metadata is refreshed.
    const child = {
      id,
      mode: modeOf(data.mode),
      label: labelOf(data.label),
      createdAt: index === -1 ? createdAt : state.children[index].createdAt,
      settledAt: index === -1 ? null : state.children[index].settledAt,
    }
    const children = index === -1 ? null : state.children.slice()
    if (children === null) {
      const appended = appendChild(state, child)
      return finish(state, appended.children, appended.truncated, seq)
    }
    children[index] = child
    return finish(state, children, state.truncated, seq)
  }
  if (event.type === 'user/message') {
    const source = data.source
    if (!source || source.kind !== 'subagent-settled') return state
    const id = source.senderSessionId
    if (!validId(id)) return state
    const index = state.children.findIndex(child => child.id === id)
    if (index === -1) return state
    const settledAt = timeOf(event.time)
    if (settledAt === null) return state
    const children = state.children.slice()
    children[index] = { ...children[index], settledAt }
    return finish(state, children, state.truncated, seq)
  }
  return state
}

function createSubagentActivityProjection() {
  return {
    key: 'statuslineSubagents', stateVersion: 1, stateSchema,
    init(_header, inheritedEventCount = 0) {
      return {
        inheritedEventCount: validCount(inheritedEventCount) ? inheritedEventCount : 0,
        lastSeq: -1, children: [], truncated: false,
      }
    },
    apply: applySubagentActivity,
    wire: { viewSchema, view: state => ({ children: state.children, truncated: state.truncated }) },
  }
}

export { createSubagentActivityProjection, CHILD_LIMIT }
