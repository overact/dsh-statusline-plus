'use strict'
// What DSH itself already knows about a model provider's connection.
//
// A user who configured a provider on the Models page has already told the Host
// its base URL and which credential holds its key. Asking them to retype both in
// this plugin's source card is the friction this removes. The plugin only reads:
// it never writes the profile, and it never guesses a route it does not know.

// Entry ids vary by profile (`llm-deepseek-api-key` on this machine, `llm-deepseek`
// elsewhere), so the section is found by its shape, not by one hard-coded id.
const PI_AI_NS = 'llm-pi-ai'
const DEEPSEEK_NS = /^llm-deepseek/

function sectionsOf(settings) {
  if (!settings || typeof settings.describe !== 'function') return []
  try {
    const list = settings.describe()
    return Array.isArray(list) ? list : []
  } catch (_) {
    return []
  }
}

function valueOf(section) {
  return section && section.value && typeof section.value === 'object' ? section.value : null
}

function textOf(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

// The credentials role marks a field as a credential reference. Older Hosts do
// not publish it, so the conventional name is accepted too.
function looksLikeCredentialRef(name) {
  return typeof name === 'string' && /(env|ref|key)$/i.test(name)
}

// A wallet probe wants the API origin; DeepSeek's configured base URL is the
// Anthropic-compatible endpoint (`/anthropic`), which answers no balance call.
function originOf(url) {
  const text = textOf(url)
  if (!text) return ''
  try {
    return new URL(text).origin
  } catch (_) {
    return ''
  }
}

// The name of the credential reference a section declares. `apiKeyEnv` is the
// published field; a build that names it differently still qualifies, and its
// value is the same kind of string (a credential name), so it is offered as-is.
function credentialRefOf(value) {
  const named = textOf(value.apiKeyEnv)
  if (named) return named
  for (const key of Object.keys(value)) {
    if (!looksLikeCredentialRef(key)) continue
    const candidate = textOf(value[key])
    if (candidate) return candidate
  }
  return ''
}

function deepseekSection(sections) {
  for (const section of sections) {
    if (!section || !DEEPSEEK_NS.test(String(section.ns || ''))) continue
    const value = valueOf(section)
    if (!value) continue
    // Only the section that actually declares the API-key credential.
    const apiKeyEnv = credentialRefOf(value)
    if (apiKeyEnv) return { section, value, apiKeyEnv }
  }
  return null
}

function piAiProvider(sections, route) {
  for (const section of sections) {
    if (!section || section.ns !== PI_AI_NS) continue
    const value = valueOf(section)
    const providers = value && value.providers
    if (!providers || typeof providers !== 'object') continue
    const entry = providers[route]
    if (entry && typeof entry === 'object') return entry
  }
  return null
}

// { apiKeyEnv, baseURL, source } where source is 'pi-ai' or 'deepseek'.
// null when this Host does not declare that route — the caller says so instead
// of filling in a guess.
function connectionFor(sections, route) {
  const key = textOf(route)
  if (!key) return null
  const piAi = piAiProvider(sections, key)
  if (piAi) {
    const apiKeyEnv = textOf(piAi.apiKeyEnv), baseURL = originOf(piAi.baseURL)
    if (apiKeyEnv || baseURL) return { apiKeyEnv, baseURL, source: 'pi-ai' }
  }
  const deepseek = deepseekSection(sections)
  if (deepseek) {
    const apiKeyEnv = deepseek.apiKeyEnv
    const baseURL = originOf(deepseek.value.baseURL) || 'https://api.deepseek.com'
    // The DeepSeek route answers to its own ids; other routes must be pi-ai.
    if (apiKeyEnv && (key === 'deepseek' || key === 'deepseek-account' || key === 'deepseek-official')) {
      return { apiKeyEnv, baseURL, source: 'deepseek' }
    }
  }
  return null
}

export { connectionFor, sectionsOf, originOf, looksLikeCredentialRef, PI_AI_NS }
