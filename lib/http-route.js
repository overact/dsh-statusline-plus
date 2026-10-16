'use strict'
/** Small JSON route helpers for the plugin's webServer endpoints. */

function sendJson(res, status, obj) {
  if (res.destroyed || res.writableEnded) return
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

const BODY_LIMIT_BYTES = 1024 * 1024
const BODY_ERROR_KEY = '__slpBodyError'

function readBody(req) {
  return new Promise(resolve => {
    const chunks = []
    let size = 0, settled = false
    const finish = value => {
      if (settled) return
      settled = true
      req.removeListener('data', data)
      req.removeListener('end', end)
      req.removeListener('error', error)
      req.removeListener('aborted', error)
      chunks.length = 0
      resolve(value)
    }
    const data = chunk => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += buf.length
      if (size > BODY_LIMIT_BYTES) {
        finish({ [BODY_ERROR_KEY]: 'body-too-large' })
        req.resume?.()
      } else chunks.push(buf)
    }
    const end = () => {
      try {
        const value = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
        finish(value && typeof value === 'object' && !Array.isArray(value) ? value : { [BODY_ERROR_KEY]: 'invalid-json' })
      } catch { finish({ [BODY_ERROR_KEY]: 'invalid-json' }) }
    }
    const error = () => finish({ [BODY_ERROR_KEY]: 'body-read-failed' })
    req.on('data', data); req.on('end', end); req.on('error', error); req.on('aborted', error)
    if (req.aborted) error()
  })
}

function bodyErrorStatus(code) {
  return code === 'body-too-large' ? 413 : 400
}

function rejectBodyError(body, res) {
  const code = body && body[BODY_ERROR_KEY]
  if (!code) return false
  sendJson(res, bodyErrorStatus(code), { ok: false, error: code })
  return true
}

function sameOriginRequest(req) {
  const headers = req && req.headers
  if (!headers || !headers.origin) return true
  const origin = String(headers.origin)
  const host = String(headers.host || '').toLowerCase()
  if (!host) return true
  try {
    const url = new URL(origin)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.host.toLowerCase() === host
  } catch (e) {
    return false
  }
}

function guardRequest(req, res, methods, needsJson) {
  if (methods.indexOf(req.method) === -1) {
    res.setHeader('allow', methods.join(', '))
    sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return false
  }
  if (req.method !== 'GET' && !sameOriginRequest(req)) {
    sendJson(res, 403, { ok: false, error: 'cross-origin' })
    return false
  }
  if (needsJson) {
    const contentType = String((req.headers && req.headers['content-type']) || '').toLowerCase()
    if (!contentType.split(';', 1)[0].trim().includes('application/json')) {
      sendJson(res, 415, { ok: false, error: 'json-required' })
      return false
    }
  }
  return true
}

export { sendJson, readBody, rejectBodyError, sameOriginRequest, guardRequest }
