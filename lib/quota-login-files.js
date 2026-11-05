'use strict'
/**
 * Login files written by each subscription's official tool, for users with no
 * gateway. They are only read: never refreshed, rewritten, logged or kept, and
 * each token is sent only to the fixed endpoint of its own service. An expired
 * login reads as `auth`; signing in again is left to the official tool.
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const MAX_LOGIN_FILE_BYTES = 1024 * 1024

function missing() { return new Error('no-credential') }

function readLoginFile(path) {
  try {
    if (statSync(path).size > MAX_LOGIN_FILE_BYTES) return null
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch { return null }
}

function usableToken(value) {
  return typeof value === 'string' && value && !/[\r\n]/.test(value) ? value : null
}

// An API-key login has no subscription tokens, so it has no quota to read.
function readCodexLogin(env = process.env) {
  const root = env.CODEX_HOME || join(homedir(), '.codex')
  const token = usableToken(readLoginFile(join(root, 'auth.json'))?.tokens?.access_token)
  if (!token) throw missing()
  return token
}

// The usage endpoint needs the `user:profile` scope, which a token made with
// `claude setup-token` lacks. macOS keeps this login in the Keychain, not a file.
function readClaudeLogin(env = process.env, now = Date.now()) {
  const root = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  const login = readLoginFile(join(root, '.credentials.json'))?.claudeAiOauth
  const token = usableToken(login?.accessToken)
  if (!token) throw missing()
  if (Array.isArray(login.scopes) && !login.scopes.includes('user:profile')) throw missing()
  if (typeof login.expiresAt === 'number' && login.expiresAt <= now) throw new Error('auth')
  return token
}

function readAntigravityLogin(now = Date.now()) {
  const path = join(homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
  const login = readLoginFile(path)?.token
  const token = usableToken(login?.access_token)
  if (!token) throw missing()
  const expiry = login.expiry ? new Date(login.expiry).getTime() : NaN
  if (Number.isFinite(expiry) && expiry <= now) throw new Error('auth')
  return token
}

// The Codex login made inside DSH, read through the Host credentials service.
const CODEX_LOGIN_KEY = 'llm-pi-ai/openai-codex'

// The record belongs to the login plugin and has no published shape, so anything
// unexpected counts as "no login". Read-only: an expired grant is reported, never
// refreshed, because rotating it could sign the user out of DSH.
async function readDshCodexToken(credentials, now = Date.now()) {
  if (!credentials || typeof credentials.readRecord !== 'function') throw new Error('no-credential')
  let record
  try { record = await credentials.readRecord(CODEX_LOGIN_KEY) } catch { throw new Error('no-credential') }
  const grant = record && record.kind === 'grant' ? record.payload : null
  if (!grant || typeof grant !== 'object' || grant.type !== 'oauth' || typeof grant.access !== 'string' || !grant.access || /[\r\n]/.test(grant.access)) {
    throw new Error('no-credential')
  }
  if (typeof grant.expires === 'number' && grant.expires <= now) throw new Error('auth')
  return grant.access
}

export { readCodexLogin, readClaudeLogin, readAntigravityLogin, readDshCodexToken }
