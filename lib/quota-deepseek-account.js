'use strict'
/**
 * DeepSeek Platform account balance through the Host `deepseekAccount` service.
 *
 * Unlike the API-key balance endpoint (`/user/balance`), an account login has no
 * API key to resolve. The official account provider already owns the stored grant,
 * the Platform origin and the five client headers, so the status line asks that
 * service for `getBalance()` instead of re-reading the credential.
 */
import { providerError } from './quota-http.js'

const ACCOUNT_CURRENCIES = new Set(['CNY', 'USD'])

// Platform sends wallet amounts as decimal strings (including "0E-16"), but the
// status line only needs a finite number for its two-decimal display.
function walletAmount(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  if (typeof value === 'string' && value.trim() === '') return undefined
  const amount = Number(value)
  return Number.isFinite(amount) ? amount : undefined
}

// Recharge wallets and bonus wallets are separate Platform arrays. Keep them
// distinguishable in the panel, while `remaining` is their usable sum per
// currency. Missing wallets stay missing; a zero balance stays a zero balance.
function accountWalletsToBalance(wallets, bonusWallets, now = Date.now()) {
  const entries = new Map()
  const add = (wallet, field) => {
    if (!wallet || !ACCOUNT_CURRENCIES.has(wallet.currency)) return
    const amount = walletAmount(wallet.balance)
    if (amount === undefined) return
    const entry = entries.get(wallet.currency) || { currency: wallet.currency }
    entry[field] = amount
    entries.set(wallet.currency, entry)
  }
  for (const wallet of Array.isArray(wallets) ? wallets : []) add(wallet, 'toppedUp')
  for (const wallet of Array.isArray(bonusWallets) ? bonusWallets : []) add(wallet, 'granted')
  const balances = []
  for (const entry of entries.values()) {
    const balance = { currency: entry.currency, remaining: (entry.toppedUp || 0) + (entry.granted || 0) }
    if (entry.toppedUp !== undefined) balance.toppedUp = entry.toppedUp
    if (entry.granted !== undefined) balance.granted = entry.granted
    balances.push(balance)
  }
  if (!balances.length) return null
  // Platform usually returns a zero wallet for the unused currency. Keep both
  // currencies but lead with the funded one, so the chip starts with the
  // balance that matters rather than "$0.00".
  balances.sort((a, b) => Math.abs(b.remaining) - Math.abs(a.remaining))
  return {
    style: 'balance',
    currency: balances[0].currency,
    balances,
    fetchedAt: now,
  }
}

// A signed-out account (null) and an absent account integration are distinct:
// both ask the user to act, but only one can be fixed by signing in.
async function fetchDeepseekAccountBalance(account, client) {
  if (!account || typeof account.getBalance !== 'function') throw providerError('no-account')
  let details
  try {
    details = await account.getBalance(client)
  } catch (error) {
    throw providerError('network')
  }
  if (details === null) throw providerError('signed-out')
  if (!details || details.status !== 'ready') throw providerError('network')
  const balance = accountWalletsToBalance(details.value, details.bonusWallets)
  if (!balance) throw providerError('invalid-response')
  return balance
}

export { accountWalletsToBalance, fetchDeepseekAccountBalance }
