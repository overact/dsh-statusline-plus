'use strict'
/** CLI Proxy API (CPA) account files under ~/.cli-proxy-api, shared by Codex and Antigravity. */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// CPA 落盘的 auth 文件把 priority 存成 JSON 字符串（如 "100"），
// 早期只接受 number 会把所有账号压成 0，导致显示顺序与真实路由优先级不符。
function parsePriority(data) {
  const source = data || {}
  const raw = source.priority !== undefined && source.priority !== null
    ? source.priority
    : (source.attributes ? source.attributes.priority : undefined)
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0
  if (typeof raw === 'string' && raw.trim() !== '') {
    const value = Number(raw)
    if (Number.isFinite(value)) return value
  }
  return 0
}

function toCredential(filePath, name, data) {
  return {
    ...data,
    filePath,
    fileName: name,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    projectId: data.project_id,
    email: data.email,
    priority: parsePriority(data),
  }
}

function credentialFiles(prefix, root) {
  return readdirSync(root).filter(name => name.startsWith(prefix + '-') && name.endsWith('.json'))
}

function readCredentialData(root, name) {
  const filePath = join(root, name)
  return { filePath, data: JSON.parse(readFileSync(filePath, 'utf8')) }
}

function readAllCredentials(prefix, root = join(homedir(), '.cli-proxy-api')) {
  let files = []
  try { files = credentialFiles(prefix, root) } catch { return [] }
  const creds = []
  for (const name of files) {
    try {
      const { filePath, data } = readCredentialData(root, name)
      if (data && (data.access_token || data.refresh_token)) {
        creds.push(toCredential(filePath, name, data))
      }
    } catch {}
  }
  creds.sort((a, b) => b.priority - a.priority || a.fileName.localeCompare(b.fileName))
  return creds
}

// A selected account must be one existing file of this prefix; no fallback to another account.
function readSelectedCredential(prefix, selected) {
  if (!selected) return readAllCredentials(prefix)[0] || null
  const root = join(homedir(), '.cli-proxy-api')
  try {
    if (!credentialFiles(prefix, root).includes(selected)) return null
    const { filePath, data } = readCredentialData(root, selected)
    return toCredential(filePath, selected, data)
  } catch { return null }
}

export { parsePriority, readAllCredentials, readSelectedCredential }
