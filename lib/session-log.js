'use strict'
/** Current provider/model of a session: live Host session first, else the tail of its log. */
import { existsSync, readdirSync, openSync, closeSync, readSync, fstatSync } from 'node:fs'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

// ---- 会话日志解码（zstd 多帧 + 撕裂尾部容错） ----
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const RECENT_SESSION_MAX_FRAMES = 128
const RECENT_SESSION_MAX_OUTPUT_BYTES = 2 * 1024 * 1024

// 从日志尾部反向解码有限数量的帧。Node 的同步 zstd API 每次调用都会创建
// 原生解码上下文；对长会话逐帧全解会让 glibc 保留数 GiB 已释放 arena。
// statusline 只需要最近的 model/tool 线索，因此必须给帧数和输出量设硬上限。
function decodeRecentSessionText(buf, options = {}) {
  const maxFrames = Math.max(1, Math.min(4096, Number(options.maxFrames) || RECENT_SESSION_MAX_FRAMES))
  const maxOutputBytes = Math.max(1024, Math.min(16 * 1024 * 1024,
    Number(options.maxOutputBytes) || RECENT_SESSION_MAX_OUTPUT_BYTES))
  const offsets = []
  let cursor = 0
  while (cursor < buf.length) {
    const idx = buf.indexOf(ZSTD_MAGIC, cursor)
    if (idx < 0) break
    offsets.push(idx)
    cursor = idx + ZSTD_MAGIC.length
  }
  const reversed = []
  let outputBytes = 0
  let decodedFrames = 0
  for (let i = offsets.length - 1; i >= 0 && decodedFrames < maxFrames && outputBytes < maxOutputBytes; i--) {
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
    decodedFrames += 1
    try {
      const part = zlib.zstdDecompressSync(buf.subarray(offsets[i], end), { maxOutputLength: maxOutputBytes - outputBytes })
      if (part.length === 0) continue
      reversed.push(part)
      outputBytes += part.length
    } catch (e) {
      // 不跨过超大帧寻找更旧的模型：该帧可能含有更新后的 request/header。
      if (e.code === 'ERR_BUFFER_TOO_LARGE') break
      // 最后一帧可能仍在写入；跳过它并继续尝试更早的完整帧。
    }
  }
  return Buffer.concat(reversed.reverse()).toString('utf8')
}

const SESSION_ID_RE = /^(?:session-)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

function normalizeSessionId(sessionId) {
  const match = String(sessionId || '').trim().match(SESSION_ID_RE)
  return match ? match[1].toLowerCase() : null
}

function selectSessionLog(directory) {
  if (!existsSync(directory)) return null
  const candidates = readdirSync(directory).flatMap(name => {
    const match = /^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?$/.exec(name)
    return match ? [{ name, version: Number(match[1] || 0) }] : []
  }).sort((a, b) => b.version - a.version || Number(b.name.endsWith('.zstd')) - Number(a.name.endsWith('.zstd')))
  if (!candidates.length) return null
  if (candidates[0].version > 2) throw new Error('unsupported session format')
  return join(directory, candidates[0].name)
}

function findSessionLog(sessionId) {
  const bareId = normalizeSessionId(sessionId)
  if (!bareId) throw new Error('bad session id')
  const requested = String(sessionId || '').trim()
  const candidates = requested.startsWith('session-')
    ? ['session-' + bareId, bareId]
    : [bareId, 'session-' + bareId]
  const root = dshHomePath('sessions')
  let projects
  try {
    projects = readdirSync(root, { withFileTypes: true })
  } catch (e) { throw new Error('sessions root not found') }
  for (const candidate of candidates) {
    for (const proj of projects) {
      if (!proj.isDirectory()) continue
      const file = selectSessionLog(join(root, proj.name, candidate))
      if (file) return file
    }
  }
  throw new Error('session log not found')
}

// 只读文件尾部并反向解出有限数量的完整 zstd 帧：长会话日志不做全量解码。
function decodeSessionTail(file, maxBytes) {
  const fd = openSync(file, 'r')
  try {
    const size = fstatSync(fd).size
    const len = Math.min(size, maxBytes)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    return file.endsWith('.jsonl') ? buf.subarray(Math.max(0, buf.length - RECENT_SESSION_MAX_OUTPUT_BYTES)).toString('utf8') : decodeRecentSessionText(buf)
  } finally {
    closeSync(fd)
  }
}

// 从解出的文本尾部向前找最近一次 request/header，避免扫全量日志
function scanLastRequestModel(text) {
  const lines = String(text || '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line.indexOf('"type":"request/header"') === -1) continue
    try {
      const ev = JSON.parse(line)
      const cfg = ev.data && ev.data.header && ev.data.header.config
      if (cfg && cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model }
    } catch (e) { /* skip malformed */ }
  }
  return null
}

function findLiveSession(sessions, sessionId) {
  if (!sessions || typeof sessions.get !== 'function') return null
  const bareId = normalizeSessionId(sessionId)
  const raw = String(sessionId || '').trim()
  if (!raw) return null
  const candidates = bareId ? [raw, bareId, 'session-' + bareId] : [raw]
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      const session = sessions.get(candidate)
      if (session) return session
    } catch (e) { /* continue */ }
  }
  return null
}

function scanLastRequestModelEvents(events) {
  const rows = Array.isArray(events) ? events : []
  for (let i = rows.length - 1; i >= 0; i--) {
    const ev = rows[i]
    if (!ev || ev.type !== 'request/header') continue
    const cfg = ev.data && ev.data.header && ev.data.header.config
    if (cfg && cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model }
  }
  return null
}

function readLiveSessionModel(sessions, sessionId) {
  const session = findLiveSession(sessions, sessionId)
  if (!session) return null
  try {
    const header = typeof session.requestHeader === 'function' ? session.requestHeader() : null
    const cfg = header && header.config
    if (cfg && cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model }
  } catch (e) { /* fall back to the resident event array */ }
  try { return scanLastRequestModelEvents(session.snapshotEvents(Math.max(0, session.seq - 2000))) } catch (e) { return null }
}

// 读会话日志里最近一次 request/header 的 provider/model：
// 优先从内存活体会话获取（零磁盘 I/O、零解压）；磁盘路径反向只解压尾部有界帧。
function readSessionModel(sessionId, sessions) {
  if (sessions) {
    const live = readLiveSessionModel(sessions, sessionId)
    if (live) return live
  }
  const file = findSessionLog(sessionId)
  return scanLastRequestModel(decodeSessionTail(file, 8 * 1024 * 1024))
}

export { decodeRecentSessionText, normalizeSessionId, selectSessionLog, readLiveSessionModel, readSessionModel }
