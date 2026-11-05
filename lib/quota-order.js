'use strict'
/**
 * One reading order for every subscription: the user's pin (default none), then
 * tools such as Magpie and CPA, then everything else.
 *
 * A pin is the only source read. Otherwise the next source is tried only when
 * this one has no usable login (`no-credential`, `auth`); a network, server or
 * decode failure from a real source is reported as it is. Magpie is optional
 * local software, so any failure there just moves on, unless a later source can
 * only say `auth`: then a busy Magpie's retryable failure is the truer answer.
 */
const TRANSIENT = new Set(['network', 'rate-limit', 'timeout'])

function errorCode(error) {
  return (error && (error.code || error.message)) || 'network'
}

function quotaPinOf(config, id) {
  const pins = config && config.quotaSources
  const pin = pins && typeof pins === 'object' ? pins[id] : undefined
  return typeof pin === 'string' && pin ? pin : null
}

async function readInOrder(tiers, pin) {
  const tagged = async tier => ({ ...await tier.read(), source: tier.source || tier.id })
  if (pin) {
    const tier = tiers.find(item => item.id === pin)
    if (!tier) throw new Error('no-credential')
    return tagged(tier)
  }
  let toolFailure = null, sawAuth = null, sawMissing = null
  for (const tier of tiers) {
    try {
      return await tagged(tier)
    } catch (error) {
      const code = errorCode(error)
      if (code === 'auth') sawAuth = sawAuth || error
      else if (code === 'no-credential') sawMissing = sawMissing || error
      else if (tier.tool) { if (TRANSIENT.has(code)) toolFailure = toolFailure || error }
      else throw error
    }
  }
  if (sawAuth) throw toolFailure || sawAuth
  throw sawMissing || new Error('no-credential')
}

export { quotaPinOf, readInOrder }
