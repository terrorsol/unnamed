// Desk: an order book of resting SOL bids for blocks of tokens, 3–5% under spot. Non-custodial:
// the fill is a single transaction co-signed by seller and bidder; the server only matches and relays.
import { Transaction, Keypair } from '@solana/web3.js'
import { createHash, randomBytes } from 'node:crypto'
import { conn, confirm, tokenProgram } from './chain.ts'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import type { WebSocket } from 'ws'
import * as R from './rules.ts'
import { market } from './market.ts'
import { balanceSol, decimals, TREASURY, tokenBalance } from './chain.ts'
import { verifyFill } from './verify.ts'

export type Bid = { id: string; mint: string; symbol: string; bidder: string; sol: number; discBps: number; placedAt: number; refreshedAt: number; status: 'open' | 'filling' | 'filled' | 'cancelled'; ws: WebSocket | null; fills: number; rfq?: string; expiresAt?: number; awaySince?: number; internal?: { kp: Keypair; label: string; maxSol: () => number } }
const bids = new Map<string, Bid>()
/** A resting SELL offer: seller holds the tokens, names a SOL size and a price vs spot (discBps>0 under, <0 over). Buyers take it; the seller's browser co-signs. */
export type Ask = { id: string; mint: string; symbol: string; seller: string; sol: number; discBps: number; placedAt: number; refreshedAt: number; status: 'open' | 'filling' | 'filled' | 'cancelled'; ws: WebSocket | null; awaySince?: number }
const asks = new Map<string, Ask>()
const pubAsk = (a: Ask, me?: string) => ({ id: a.id, mint: a.mint, symbol: a.symbol, sol: a.sol, discBps: a.discBps, placedAt: a.placedAt, status: a.status, away: !!a.awaySince, seller: alias(a.seller), mine: me === a.seller })
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void; timer: any }>()
const decCache = new Map<string, number>()
async function dec(mint: string) { if (!decCache.has(mint)) decCache.set(mint, await decimals(mint)); return decCache.get(mint)! }
/** Pseudonymous desk: wallets never appear in the book, pings or fill tape — only a per-wallet alias (salted hash, stable for the server's lifetime). Settlement is still one on-chain tx with both wallets; we hide nothing on-chain. */
const SALT = randomBytes(8).toString('hex')
export const alias = (pk: string) => 'desk-' + createHash('sha256').update(SALT + pk).digest('hex').slice(0, 5)
const pubBid = (b: Bid, me?: string) => ({ id: b.id, mint: b.mint, symbol: b.symbol, sol: b.sol, discBps: b.discBps, placedAt: b.placedAt, restable: (!!b.rfq || R.restable(b.placedAt)) && !b.awaySince, away: !!b.awaySince, rfq: b.rfq, status: b.status, bidder: b.internal ? b.internal.label : alias(b.bidder), mine: me === b.bidder, vault: !!b.internal, block: b.rfq === 'buy', expiresAt: b.expiresAt })
// ---- fill history (persisted) ----
const DIR = process.env.DATA_DIR || './data'; const HF = DIR + '/fills.json'
export type Fill = { t: number; mint: string; symbol: string; seller: string; bidder: string; sol: number; discBps: number; tokens: number; sig: string; vault: boolean }
let fills: Fill[] = []; try { if (existsSync(HF)) fills = JSON.parse(readFileSync(HF, 'utf8')) } catch {}
function recordFill(f: Fill) { fills.unshift(f); fills = fills.slice(0, 2000); try { mkdirSync(DIR, { recursive: true }); writeFileSync(HF, JSON.stringify(fills)) } catch {} }
export const history = (mint?: string) => (mint ? fills.filter((f) => f.mint === mint) : fills).slice(0, 100).map((f) => ({ ...f, seller: alias(f.seller), bidder: f.vault ? 'vault' : alias(f.bidder) }))
export function leaderboard(me?: string) {
  const by: Record<string, { wallet: string; soldSol: number; boughtSol: number; fills: number; saved: number }> = {}
  for (const f of fills) { const s = (by[f.seller] ||= { wallet: f.seller, soldSol: 0, boughtSol: 0, fills: 0, saved: 0 }); s.soldSol += f.sol; s.fills++; s.saved += f.sol * 0.03
    if (!f.vault) { const b = (by[f.bidder] ||= { wallet: f.bidder, soldSol: 0, boughtSol: 0, fills: 0, saved: 0 }); b.boughtSol += f.sol; b.fills++; b.saved += f.sol * f.discBps / 10000 } }
  return Object.values(by).sort((a, b) => b.soldSol + b.boughtSol - (a.soldSol + a.boughtSol)).slice(0, 50).map((x) => ({ ...x, mine: !!me && x.wallet === me, wallet: alias(x.wallet) }))
}
/** Server-held bidder (the vault). Keeps one resting bid per mint; refreshed by the vault loop. */
export async function placeInternal(kp: Keypair, label: string, mint: string, sol: number, discBps: number, maxSol: () => number) { return pubBid(await placeInternalRaw(kp, label, mint, sol, discBps, maxSol)) }
export async function placeInternalRaw(kp: Keypair, label: string, mint: string, sol: number, discBps: number, maxSol: () => number, fresh = false): Promise<Bid> {
  const bidder = kp.publicKey.toBase58()
  const existing = fresh ? null : [...bids.values()].find((b) => b.bidder === bidder && b.mint === mint && b.status === 'open' && !b.rfq)
  if (existing) { existing.sol = sol; existing.discBps = discBps; existing.refreshedAt = Date.now(); return existing }
  const m = await market(mint); if (!m) throw new Error('unknown market'); const why = R.validBid(sol, discBps, m); if (why) throw new Error(why)
  const id = 'v' + Math.random().toString(36).slice(2, 9)
  const b: Bid = { id, mint, symbol: m.symbol, bidder, sol, discBps, placedAt: Date.now(), refreshedAt: Date.now(), status: 'open', ws: null, fills: 0, internal: { kp, label, maxSol } }
  bids.set(id, b); bookChanged(mint); return b
}
export function cancelInternal(bidderPk: string, mint: string) { for (const [id, b] of bids) if (b.bidder === bidderPk && b.mint === mint && b.status === 'open') bids.delete(id) }

export async function place(ws: WebSocket, bidder: string, mint: string, sol: number, discBps: number) {
  if (!Number.isFinite(sol) || !Number.isFinite(discBps) || sol <= 0 || sol > 10_000) throw new Error('bad bid')
  const m = await market(mint); if (!m) throw new Error('unknown market')
  const why = R.validBid(sol, discBps, m); if (why) throw new Error(why)
  const open = [...bids.values()].filter((b) => b.bidder === bidder && b.status === 'open')
  if (open.length >= 5) throw new Error('max 5 open bids')
  const committed = open.reduce((a, b) => a + b.sol, 0)
  const bal = await balanceSol(bidder); if (bal < committed + sol * (1 + R.CROSS_FEE_BPS / 10000) + 0.01) throw new Error(`insufficient balance for ${sol} SOL bid (have ${bal.toFixed(3)}, ${committed.toFixed(2)} already committed)`)
  const id = Math.random().toString(36).slice(2, 10)
  const b: Bid = { id, mint, symbol: m.symbol, bidder, sol, discBps, placedAt: Date.now(), refreshedAt: Date.now(), status: 'open', ws, fills: 0 }
  bids.set(id, b); bookChanged(mint); setTimeout(() => { if (bids.get(id)?.status === 'open') bookChanged(mint) }, R.REST_MS + 50); return pubBid(b, bidder)
}
/** Buy a block: buyer posts "I'll take up to `sol` SOL of this coin at up to +premiumBps over spot for ttl seconds". Any holder fills it
 *  with the normal fill tx (seller signs, buyer's browser co-signs). Zero chart impact on entry; holders get an exit above spot. */
export async function rfqBuy(ws: WebSocket, buyer: string, mint: string, sol: number, premiumBps: number, ttlSec: number) {
  if (!Number.isFinite(sol) || sol <= 0 || sol > 10_000) throw new Error('bad size')
  if (!Number.isFinite(premiumBps) || premiumBps < 0 || premiumBps > R.BUY_RFQ_MAX_PREMIUM_BPS) throw new Error(`premium must be 0–${R.BUY_RFQ_MAX_PREMIUM_BPS / 100}%`)
  ttlSec = Math.max(30, Math.min(600, Math.round(ttlSec || 120)))
  const m = await market(mint); if (!m) throw new Error('unknown market'); if (!R.deskOpen(m)) throw new Error('desk closed for this coin')
  if (sol < R.minBlockSol(m)) throw new Error(`min block ${R.minBlockSol(m).toFixed(2)} SOL here`)
  const open = [...bids.values()].filter((b) => b.bidder === buyer && b.status === 'open'); const committed = open.reduce((a, b) => a + b.sol, 0)
  const bal = await balanceSol(buyer); if (bal < committed + sol * (1 + R.CROSS_FEE_BPS / 10000) + 0.01) throw new Error(`insufficient balance (have ${bal.toFixed(3)} SOL)`)
  const id = 'b' + Math.random().toString(36).slice(2, 10)
  const b: Bid = { id, mint, symbol: m.symbol, bidder: buyer, sol, discBps: -premiumBps, placedAt: Date.now(), refreshedAt: Date.now(), status: 'open', ws, fills: 0, rfq: 'buy', expiresAt: Date.now() + ttlSec * 1000 }
  bids.set(id, b); bookChanged(mint)
  broadcast({ type: 'buy_rfq', mint, symbol: m.symbol, sol, premiumBps, secondsLeft: ttlSec, bidId: id }, ws)
  return pubBid(b, buyer)
}
export async function placeAsk(ws: WebSocket, seller: string, mint: string, sol: number, discBps: number) {
  if (!Number.isFinite(sol) || sol <= 0 || sol > 10_000) throw new Error('bad size')
  if (!Number.isFinite(discBps) || discBps < -R.ASK_MAX_PREMIUM_BPS || discBps > R.DISC_MAX_BPS) throw new Error(`price must be within +${R.ASK_MAX_PREMIUM_BPS / 100}% over and ${R.DISC_MAX_BPS / 100}% under spot`)
  const m = await market(mint); if (!m) throw new Error('unknown market'); const w = R.deskWhy(m); if (w) throw new Error('desk closed: ' + w)
  if (sol < R.minBlockSol(m)) throw new Error(`min block ${R.minBlockSol(m).toFixed(2)} SOL here`)
  const held = await tokenBalance(seller, mint); const need = sol / (m.priceSol * (1 - discBps / 10000)); if (held.ui < need * 0.98) throw new Error(`you hold ${held.ui.toLocaleString()} ${m.symbol}; this offer needs ≈${Math.ceil(need).toLocaleString()}`)
  const open = [...asks.values()].filter((a) => a.seller === seller && a.status === 'open'); if (open.length >= 5) throw new Error('max 5 open offers')
  const id = 's' + Math.random().toString(36).slice(2, 10)
  const a: Ask = { id, mint, symbol: m.symbol, seller, sol, discBps, placedAt: Date.now(), refreshedAt: Date.now(), status: 'open', ws }
  asks.set(id, a); bookChanged(mint); return pubAsk(a, seller)
}
export function cancelAsk(seller: string, id: string) { const a = asks.get(id); if (a && a.seller === seller && a.status === 'open') { asks.delete(id); bookChanged(a.mint); return true } return false }
export const myAsks = (me: string) => [...asks.values()].filter((a) => a.seller === me && a.status === 'open').map((a) => pubAsk(a, me))
/** What a buyer pays to take an ask (whole or partial ≥ min block) */
export async function askQuote(id: string, buyer: string, sol?: number) {
  const a = asks.get(id); if (!a || a.status !== 'open') throw new Error('offer not open'); if (a.seller === buyer) throw new Error('cannot take your own offer'); if (a.awaySince) throw new Error('seller is away — try again in a moment')
  const m = await market(a.mint, R.QUOTE_MAX_AGE_MS); if (!m) throw new Error('no market')
  const take = sol && sol < a.sol ? sol : a.sol; if (take < a.sol && take < R.minBlockSol(m) - 1e-9) throw new Error(`partial must be ≥ min block ${R.minBlockSol(m).toFixed(2)} SOL`)
  const d = await dec(a.mint); const tp = await tokenProgram(a.mint); const q = R.fillQuote(take, a.discBps, m.priceSol, d)
  const bal = await balanceSol(buyer); if (bal < take * (1 + R.CROSS_FEE_BPS / 10000) + 0.01) throw new Error(`insufficient balance (have ${bal.toFixed(3)} SOL)`)
  return { ask: pubAsk(a), takeSol: take, partial: take < a.sol, mint: a.mint, seller: a.seller, buyer, treasury: TREASURY, decimals: d, tokenProgram: tp, priceSol: m.priceSol, refAgeMs: Date.now() - ((m as any).t || Date.now()), base: q.base.toString(), tokens: q.tokens, sellerLamports: q.sellerLamports.toString(), fee: q.fee.toString(), px: q.px }
}
/** Buyer-built, buyer-signed tx → seller's browser verifies + co-signs (token transfer) → chain. */
export async function askFill(id: string, buyer: string, txB64: string, sol?: number): Promise<{ sig: string }> {
  const a = asks.get(id); if (!a || a.status !== 'open') throw new Error('offer not open')
  if (!a.ws || a.ws.readyState !== 1) throw new Error('seller is away — try again in a moment')
  a.status = 'filling'; let q: Awaited<ReturnType<typeof askQuote>>
  try { a.status = 'open'; q = await askQuote(id, buyer, sol); a.status = 'filling'; const held = await tokenBalance(a.seller, a.mint); if (held.raw < BigInt(q.base)) { asks.delete(id); bookChanged(a.mint); throw new Error('seller no longer holds the block — offer removed') } } catch (e) { if (a.status === 'filling') a.status = 'open'; throw e }
  const tx = Transaction.from(Buffer.from(txB64, 'base64'))
  const buyerSig = tx.signatures.find((s) => s.publicKey.toBase58() === buyer); if (!buyerSig?.signature) { a.status = 'open'; throw new Error('tx not signed by buyer') }
  const why = verifyFill(tx, { mint: a.mint, seller: a.seller, bidder: buyer, treasury: TREASURY, base: BigInt(q.base), sellerLamports: BigInt(q.sellerLamports), fee: BigInt(q.fee), tokenProgram: q.tokenProgram, decimals: q.decimals, payer: 'bidder' })
  if (why) { a.status = 'open'; throw new Error('fill rejected: ' + why) }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete('a:' + id); if (a.status === 'filling') a.status = 'open'; reject(new Error('seller did not respond in time')) }, 25000)
    pending.set('a:' + id, { resolve, reject, timer, buyer, tokens: q.tokens, takeSol: q.takeSol } as any)
    a.ws!.send(JSON.stringify({ type: 'fill_ask', askId: id, tx: txB64, expect: { mint: a.mint, seller: a.seller, bidder: buyer, treasury: TREASURY, takeSol: q.takeSol, base: q.base, sellerLamports: q.sellerLamports, fee: q.fee, priceSol: q.priceSol, discBps: a.discBps, tokenProgram: q.tokenProgram, decimals: q.decimals, payer: 'bidder' } }))
  })
}
export function settleAsk(id: string, ok: boolean, sig?: string, err?: string) {
  const p = pending.get('a:' + id); const a = asks.get(id); if (!p) return
  clearTimeout(p.timer); pending.delete('a:' + id)
  if (ok && sig) { if (a) { const took = (p as any).takeSol || a.sol; const left = a.sol - took; if (left > 0.05) { a.sol = left; a.status = 'open' } else { a.status = 'filled'; asks.delete(id) } recordFill({ t: Date.now(), mint: a.mint, symbol: a.symbol, seller: a.seller, bidder: (p as any).buyer || '', sol: took, discBps: a.discBps, tokens: (p as any).tokens || 0, sig, vault: false }); bookChanged(a.mint) } p.resolve({ sig }) }
  else { if (a) { a.status = 'open'; bookChanged(a.mint) } p.reject(new Error(err || 'seller rejected')) }
}
export function cancel(bidder: string, id: string) { const b = bids.get(id); if (b && b.bidder === bidder && b.status === 'open') { b.status = 'cancelled'; bids.delete(id); bookChanged(b.mint); return true } return false }
export function refresh(bidder: string) { const now = Date.now(); for (const b of bids.values()) if (b.bidder === bidder) b.refreshedAt = now; for (const a of asks.values()) if (a.seller === bidder) a.refreshedAt = now }
/** Socket dropped (phone switched apps, flaky network): bids go 'away' — kept, unfillable — and come back when the same wallet re-auths within the grace window. */
export function dropSocket(ws: WebSocket) { const now = Date.now(); const mints = new Set<string>(); for (const b of bids.values()) if (b.ws === ws && b.status === 'open') { b.ws = null; b.awaySince = now; mints.add(b.mint) } for (const a of asks.values()) if (a.ws === ws && a.status === 'open') { a.ws = null; a.awaySince = now; mints.add(a.mint) } for (const m of mints) bookChanged(m) }
export function reattach(ws: WebSocket, bidder: string) { let n = 0; const mints = new Set<string>(); for (const b of bids.values()) if (b.bidder === bidder && b.status === 'open' && !b.internal && !b.ws) { b.ws = ws; b.awaySince = undefined; b.refreshedAt = Date.now(); n++; mints.add(b.mint) } for (const a of asks.values()) if (a.seller === bidder && a.status === 'open' && !a.ws) { a.ws = ws; a.awaySince = undefined; a.refreshedAt = Date.now(); n++; mints.add(a.mint) } for (const m of mints) bookChanged(m); return n }
export function sweep() { const now = Date.now(); for (const [id, b] of bids) if (b.status === 'open' && !b.internal && (R.expired(b.refreshedAt, now) || (b.expiresAt && now > b.expiresAt) || (b.awaySince && now - b.awaySince > R.BIDDER_GRACE_MS))) { bids.delete(id); bookChanged(b.mint) }
  for (const [id, a] of asks) if (a.status === 'open' && (R.expired(a.refreshedAt, now) || (a.awaySince && now - a.awaySince > R.BIDDER_GRACE_MS))) { asks.delete(id); bookChanged(a.mint) } }

export async function book(mint: string, me?: string) {
  const m = await market(mint)
  const list = [...bids.values()].filter((b) => b.mint === mint && b.status === 'open').sort((a, b) => a.discBps - b.discBps || b.sol - a.sol)
  const askList = [...asks.values()].filter((a) => a.mint === mint && a.status === 'open').sort((a, b) => b.discBps - a.discBps || b.sol - a.sol)
  return { asks: askList.map((a) => pubAsk(a, me)), open: m ? R.deskOpen(m) : false, why: m ? R.deskWhy(m) : 'no market', minBlock: m ? R.minBlockSol(m) : null, market: m, bids: list.map((b) => pubBid(b, me)), rules: { discMin: R.DISC_MIN_BPS, discMax: R.DISC_MAX_BPS, restMs: R.REST_MS, feeBps: R.CROSS_FEE_BPS, gateUsd: R.GATE_MCAP_USD } }
}
export const myBids = (me: string) => [...bids.values()].filter((b) => b.bidder === me && b.status === 'open').map((b) => pubBid(b, me))
export function books() {
  const by: Record<string, { mint: string; symbol: string; bids: number; sol: number; bestDisc: number; asks?: number; askSol?: number }> = {}
  for (const a of asks.values()) { if (a.status !== 'open') continue; const e = (by[a.mint] ||= { mint: a.mint, symbol: a.symbol, bids: 0, sol: 0, bestDisc: 9999 }); e.asks = (e.asks || 0) + 1; e.askSol = (e.askSol || 0) + a.sol }
  for (const b of bids.values()) { if (b.status !== 'open') continue; const e = (by[b.mint] ||= { mint: b.mint, symbol: b.symbol, bids: 0, sol: 0, bestDisc: 9999 }); e.bids++; e.sol += b.sol; e.bestDisc = Math.min(e.bestDisc, b.discBps) }
  return Object.values(by).sort((a, b) => b.sol - a.sol)
}
/** What a seller must deliver to take a bid in full, priced off spot right now */
export async function quote(id: string, seller: string, sol?: number) {
  const b = bids.get(id); if (!b || b.status !== 'open') throw new Error('bid not open')
  if (!b.rfq && !R.restable(b.placedAt)) throw new Error(`bid resting — fillable in ${Math.ceil((R.REST_MS - (Date.now() - b.placedAt)) / 1000)}s`)
  if (b.bidder === seller) throw new Error('cannot fill your own bid')
  const m = await market(b.mint, R.QUOTE_MAX_AGE_MS); if (!m) throw new Error('no market')
  if (b.awaySince) throw new Error('bidder is away — try again in a moment')
  // partial fill: seller may take part of the block (≥ min block, or the whole thing); the remainder keeps resting
  const take = sol && sol < b.sol ? sol : b.sol
  if (take < b.sol && take < R.minBlockSol(m) - 1e-9) throw new Error(`partial fill must be ≥ min block ${R.minBlockSol(m).toFixed(2)} SOL`)
  if (take <= 0) throw new Error('bad size')
  const d = await dec(b.mint); const tp = await tokenProgram(b.mint); const q = R.fillQuote(take, b.discBps, m.priceSol, d)
  const rf = b.rfq && b.rfq !== 'buy' ? rfqs.get(b.rfq) : null; const drift = rf ? m.priceSol / rf.priceSol - 1 : 0
  return { bid: pubBid(b), takeSol: take, partial: take < b.sol, mint: b.mint, bidder: b.bidder, seller, treasury: TREASURY, decimals: d, tokenProgram: tp, priceSol: m.priceSol, refAgeMs: Date.now() - ((m as any).t || Date.now()), drift, needsConfirm: !!rf && drift < -R.SELLER_DRIFT, anchorPrice: rf?.priceSol || null, px: q.px, tokens: q.tokens, base: q.base.toString(), lamports: q.lamports.toString(), sellerLamports: q.sellerLamports.toString(), fee: q.fee.toString() }
}
/** Seller submits a seller-signed tx; server verifies structure vs a fresh quote, relays to bidder to co-sign + send */
export async function fill(id: string, seller: string, txB64: string, sol?: number): Promise<{ sig: string }> {
  const b = bids.get(id); if (!b || b.status !== 'open') throw new Error('bid not open')
  if (!b.internal && (!b.ws || b.ws.readyState !== 1)) throw new Error('bidder is away — try again in a moment')
  // claim the bid first so two sellers can't both quote the same block; released on any failure below
  b.status = 'filling'
  let q: Awaited<ReturnType<typeof quote>>
  try {
    b.status = 'open'; q = await quote(id, seller, sol); b.status = 'filling'
    // fail fast if the seller doesn't actually hold the block (the chain would reject it after the bidder co-signed)
    const held = await tokenBalance(seller, b.mint); if (held.raw < BigInt(q.base)) throw new Error(`you hold ${held.ui.toLocaleString()} ${b.symbol}, this fill needs ${q.tokens.toLocaleString()}`)
  } catch (e) { b.status = 'open'; throw e }
  const tx = Transaction.from(Buffer.from(txB64, 'base64'))
  const sellerSig = tx.signatures.find((s) => s.publicKey.toBase58() === seller); if (!sellerSig?.signature) { b.status = 'open'; throw new Error('tx not signed by seller') }
  const why = verifyFill(tx, { mint: b.mint, seller, bidder: b.bidder, treasury: TREASURY, base: BigInt(q.base), sellerLamports: BigInt(q.sellerLamports), fee: BigInt(q.fee), tokenProgram: q.tokenProgram, decimals: q.decimals })
  if (why) { b.status = 'open'; throw new Error('fill rejected: ' + why) }
  if ((await balanceSol(b.bidder)) < q.takeSol + 0.005) { bids.delete(id); throw new Error('bidder balance dropped — bid removed') }
  if (b.internal) {
    try {
      if (b.sol > b.internal.maxSol()) throw new Error('vault bid no longer affordable')
      tx.partialSign(b.internal.kp); const raw = tx.serialize(); const sig = await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }); const rb = setInterval(() => conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {}), 2000); try { await confirm(sig) } finally { clearInterval(rb) }
      settleAmount(b, q.takeSol); recordFill({ t: Date.now(), mint: b.mint, symbol: b.symbol, seller, bidder: b.bidder, sol: q.takeSol, discBps: b.discBps, tokens: q.tokens, sig, vault: true }); rfqNoteFill(id, q.takeSol); onVaultFill?.(b.bidder, b.sol, q.tokens); return { sig }
    } catch (e) { b.status = 'open'; throw e }
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); if (b.status === 'filling') b.status = 'open'; reject(new Error('bidder did not respond in time')) }, 25000)
    pending.set(id, { resolve, reject, timer, seller, tokens: q.tokens, takeSol: q.takeSol } as any)
    b.ws!.send(JSON.stringify({ type: 'fill', bidId: id, tx: txB64, expect: { mint: b.mint, seller, bidder: b.bidder, treasury: TREASURY, takeSol: q.takeSol, base: q.base, sellerLamports: q.sellerLamports, fee: q.fee, priceSol: q.priceSol, discBps: b.discBps, tokenProgram: q.tokenProgram, decimals: q.decimals } }))
  })
}
/** After a fill: shrink the bid by what was taken; close it when nothing fillable is left. */
function settleAmount(b: Bid, took: number) { const left = b.sol - took; if (left > 0.05 && !b.rfq) { b.sol = left; b.status = 'open'; b.refreshedAt = Date.now() } else { b.status = 'filled'; bids.delete(b.id) } bookChanged(b.mint) }
/** Bidder's answer to a relayed fill */
export function settle(id: string, ok: boolean, sig?: string, err?: string) {
  const p = pending.get(id); const b = bids.get(id); if (!p) return
  clearTimeout(p.timer); pending.delete(id)
  if (ok && sig) { if (b) { const took = (p as any).takeSol || b.sol; b.fills++; settleAmount(b, took); recordFill({ t: Date.now(), mint: b.mint, symbol: b.symbol, seller: (p as any).seller || '', bidder: b.bidder, sol: took, discBps: b.discBps, tokens: (p as any).tokens || 0, sig, vault: false }); rfqNoteFill(id, took) } p.resolve({ sig }) }
  else { if (b) { b.status = 'open'; bookChanged(b.mint) } p.reject(new Error(err || 'bidder rejected')) }
}
export const stats = () => ({ openBids: [...bids.values()].filter((b) => b.status === 'open').length, markets: books().length })

// ---- RFQ: a seller shops a block with a max loss and a clock; resting bids sweep instantly, everyone else gets pinged ----
export type Rfq = { id: string; mint: string; symbol: string; seller: string; sizeSol: number; maxBps: number; createdAt: number; expiresAt: number; status: 'open' | 'done' | 'expired' | 'cancelled'; matches: string[]; counters: { bidId: string; bidder: string; discBps: number; sol: number; vault: boolean }[]; filledSol: number; priceSol: number; liqSol: number }
const rfqs = new Map<string, Rfq>()
const sockets = new Set<WebSocket>()
export function registerBidderSocket(ws: WebSocket) { sockets.add(ws); ws.on('close', () => sockets.delete(ws)) }
/** Push a 'book changed' note for a mint to every client; they re-read the book immediately instead of waiting for the poll. */
export const bookChanged = (mint: string) => broadcast({ type: 'book', mint, t: Date.now() })
export const broadcast = (o: any, except?: WebSocket) => { const s = JSON.stringify(o); for (const w of sockets) if (w !== except && w.readyState === 1) w.send(s) }
export let onVaultFill: ((bidder: string, sol: number, tokens: number) => void) | null = null
export function setOnVaultFill(f: typeof onVaultFill) { onVaultFill = f }
let vaultResponder: ((mint: string, sizeSol: number, maxBps: number, rfqId: string) => Promise<Bid | null>) | null = null
export function setVaultResponder(f: typeof vaultResponder) { vaultResponder = f }
const pubRfq = (r: Rfq) => ({ ...r, seller: alias(r.seller), counters: r.counters.map((c) => ({ ...c, bidder: c.vault ? 'vault' : alias(c.bidder) })), remainingSol: Math.max(0, r.sizeSol - r.filledSol - r.matches.reduce((a, id) => a + (bids.get(id)?.status === 'open' || bids.get(id)?.status === 'filling' ? bids.get(id)!.sol : 0), 0)), secondsLeft: Math.max(0, Math.ceil((r.expiresAt - Date.now()) / 1000)) })
export async function rfqCreate(mint: string, seller: string, sizeSol: number, maxBps: number, ttlMs: number) {
  if (!Number.isFinite(sizeSol) || sizeSol <= 0 || sizeSol > 10_000) throw new Error('bad size')
  const m = await market(mint); if (!m) throw new Error('unknown market'); if (!R.deskOpen(m)) throw new Error('desk closed for this coin')
  if (sizeSol < R.minBlockSol(m)) throw new Error(`min block is ${R.minBlockSol(m).toFixed(2)} SOL`); if (maxBps < 50 || maxBps > 1500) throw new Error('max loss must be 0.5–15%')
  const id = 'r' + Math.random().toString(36).slice(2, 9); const ttl = Math.min(180000, Math.max(15000, ttlMs || 60000))
  const r: Rfq = { id, mint, symbol: m.symbol, seller, sizeSol, maxBps, createdAt: Date.now(), expiresAt: Date.now() + ttl, status: 'open', matches: [], counters: [], filledSol: 0, priceSol: m.priceSol, liqSol: m.liqSol }
  rfqs.set(id, r)
  // instant sweep: resting bids at or inside the seller's max loss, best first, until size is covered
  let left = sizeSol
  for (const b of [...bids.values()].filter((b) => b.mint === mint && b.status === 'open' && b.bidder !== seller && b.discBps <= maxBps).sort((a, b) => a.discBps - b.discBps)) { if (left <= 0) break; if (b.sol <= left + 0.01) { if (!b.internal) { const bal = await balanceSol(b.bidder).catch(() => 0); if (bal < b.sol + 0.005) { bids.delete(b.id); continue } } r.matches.push(b.id); left -= b.sol } }
  // ping every connected bidder + the vault
  broadcast({ type: 'rfq', rfq: pubRfq(r) })
  if (left > 0.01 && vaultResponder) { try { const vb = await vaultResponder(mint, left, maxBps, id); if (vb) { vb.rfq = id; if (vb.discBps <= maxBps) { r.matches.push(vb.id); left -= vb.sol } else r.counters.push({ bidId: vb.id, bidder: 'VAULT', discBps: vb.discBps, sol: vb.sol, vault: true }) } } catch {} }
  return pubRfq(r)
}
export const rfqGet = (id: string) => { const r = rfqs.get(id); if (!r) throw new Error('no such rfq'); if (r.status === 'open' && Date.now() > r.expiresAt) r.status = 'expired'; return pubRfq(r) }
export const rfqOpenFor = (mint?: string) => [...rfqs.values()].filter((r) => r.status === 'open' && Date.now() < r.expiresAt && (!mint || r.mint === mint)).map(pubRfq)
/** A bidder answers a ping: at the seller's max loss (or better) it's a match; worse is a counter the seller can accept */
export async function rfqRespond(ws: WebSocket, bidder: string, rfqId: string, discBps: number, sol: number) {
  const r = rfqs.get(rfqId); if (!r || r.status !== 'open' || Date.now() > r.expiresAt) throw new Error('rfq closed'); if (bidder === r.seller) throw new Error('that is your own request')
  if (!Number.isFinite(discBps) || discBps < 50 || discBps > R.COUNTER_MAX_BPS) throw new Error(`counter must be between −0.5% and −${R.COUNTER_MAX_BPS / 100}%`)
  const m = await market(r.mint); if (!m) throw new Error('no market'); const why = R.validBid(sol, Math.max(R.DISC_MIN_BPS, Math.min(R.DISC_MAX_BPS, discBps)), m); if (why && !/discount/.test(why)) throw new Error(why)
  if (sol > pubRfq(r).remainingSol + 0.01) sol = +pubRfq(r).remainingSol.toFixed(3); if (sol < R.minBlockSol(m)) throw new Error('block already covered')
  const bal = await balanceSol(bidder); if (bal < sol * 1.006 + 0.01) throw new Error('insufficient balance')
  const id = Math.random().toString(36).slice(2, 10)
  const b: Bid = { id, mint: r.mint, symbol: r.symbol, bidder, sol, discBps, placedAt: Date.now(), refreshedAt: Date.now(), status: 'open', ws, fills: 0, rfq: rfqId }
  bids.set(id, b)
  if (discBps <= r.maxBps) r.matches.push(id); else r.counters.push({ bidId: id, bidder: bidder.slice(0, 4) + '…' + bidder.slice(-4), discBps, sol, vault: false })
  return pubRfq(r)
}
export function rfqNoteFill(bidId: string, sol: number) { for (const r of rfqs.values()) if (r.matches.includes(bidId) || r.counters.some((c) => c.bidId === bidId)) { r.filledSol += sol; r.matches = r.matches.filter((x) => x !== bidId); r.counters = r.counters.filter((c) => c.bidId !== bidId); if (r.filledSol >= r.sizeSol - 0.01) r.status = 'done' } }
export function rfqCancel(id: string, seller: string) { const r = rfqs.get(id); if (r && r.seller === seller && r.status === 'open') r.status = 'cancelled' }
export function rfqSweep() { const now = Date.now(); for (const [id, b] of bids) if (b.rfq && b.rfq !== 'buy' && b.status === 'open') { const r = rfqs.get(b.rfq); if (!r || r.status !== 'open' || now > r.expiresAt + 30000) { bids.delete(id); bookChanged(b.mint) } } for (const [id, r] of rfqs) if (now > r.expiresAt + 600000) rfqs.delete(id) }
