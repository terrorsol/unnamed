// Desk: an order book of resting SOL bids for blocks of tokens, 3–5% under spot. Non-custodial:
// the fill is a single transaction co-signed by seller and bidder; the server only matches and relays.
import { Transaction } from '@solana/web3.js'
import type { WebSocket } from 'ws'
import * as R from './rules.ts'
import { market } from './market.ts'
import { balanceSol, decimals, TREASURY } from './chain.ts'
import { verifyFill } from './verify.ts'

export type Bid = { id: string; mint: string; symbol: string; bidder: string; sol: number; discBps: number; placedAt: number; refreshedAt: number; status: 'open' | 'filling' | 'filled' | 'cancelled'; ws: WebSocket | null; fills: number }
const bids = new Map<string, Bid>()
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void; timer: any }>()
const decCache = new Map<string, number>()
async function dec(mint: string) { if (!decCache.has(mint)) decCache.set(mint, await decimals(mint)); return decCache.get(mint)! }
const pubBid = (b: Bid, me?: string) => ({ id: b.id, mint: b.mint, symbol: b.symbol, sol: b.sol, discBps: b.discBps, placedAt: b.placedAt, restable: R.restable(b.placedAt), status: b.status, bidder: b.bidder.slice(0, 4) + '…' + b.bidder.slice(-4), mine: me === b.bidder })

export async function place(ws: WebSocket, bidder: string, mint: string, sol: number, discBps: number) {
  const m = await market(mint); if (!m) throw new Error('unknown market')
  const why = R.validBid(sol, discBps, m); if (why) throw new Error(why)
  const open = [...bids.values()].filter((b) => b.bidder === bidder && b.status === 'open')
  if (open.length >= 5) throw new Error('max 5 open bids')
  const committed = open.reduce((a, b) => a + b.sol, 0)
  const bal = await balanceSol(bidder); if (bal < committed + sol * (1 + R.CROSS_FEE_BPS / 10000) + 0.01) throw new Error(`insufficient balance for ${sol} SOL bid (have ${bal.toFixed(3)}, ${committed.toFixed(2)} already committed)`)
  const id = Math.random().toString(36).slice(2, 10)
  const b: Bid = { id, mint, symbol: m.symbol, bidder, sol, discBps, placedAt: Date.now(), refreshedAt: Date.now(), status: 'open', ws, fills: 0 }
  bids.set(id, b); return pubBid(b, bidder)
}
export function cancel(bidder: string, id: string) { const b = bids.get(id); if (b && b.bidder === bidder && b.status === 'open') { b.status = 'cancelled'; bids.delete(id); return true } return false }
export function refresh(bidder: string) { for (const b of bids.values()) if (b.bidder === bidder) b.refreshedAt = Date.now() }
export function dropSocket(ws: WebSocket) { for (const [id, b] of bids) if (b.ws === ws && b.status === 'open') bids.delete(id) }
export function sweep() { const now = Date.now(); for (const [id, b] of bids) if (b.status === 'open' && R.expired(b.refreshedAt, now)) bids.delete(id) }

export async function book(mint: string, me?: string) {
  const m = await market(mint)
  const list = [...bids.values()].filter((b) => b.mint === mint && b.status === 'open').sort((a, b) => a.discBps - b.discBps || b.sol - a.sol)
  return { open: m ? R.deskOpen(m) : false, minBlock: m ? R.minBlockSol(m) : null, market: m, bids: list.map((b) => pubBid(b, me)), rules: { discMin: R.DISC_MIN_BPS, discMax: R.DISC_MAX_BPS, restMs: R.REST_MS, feeBps: R.CROSS_FEE_BPS, gateUsd: R.GATE_MCAP_USD } }
}
export function books() {
  const by: Record<string, { mint: string; symbol: string; bids: number; sol: number; bestDisc: number }> = {}
  for (const b of bids.values()) { if (b.status !== 'open') continue; const e = (by[b.mint] ||= { mint: b.mint, symbol: b.symbol, bids: 0, sol: 0, bestDisc: 9999 }); e.bids++; e.sol += b.sol; e.bestDisc = Math.min(e.bestDisc, b.discBps) }
  return Object.values(by).sort((a, b) => b.sol - a.sol)
}
/** What a seller must deliver to take a bid in full, priced off spot right now */
export async function quote(id: string, seller: string) {
  const b = bids.get(id); if (!b || b.status !== 'open') throw new Error('bid not open')
  if (!R.restable(b.placedAt)) throw new Error(`bid resting — fillable in ${Math.ceil((R.REST_MS - (Date.now() - b.placedAt)) / 1000)}s`)
  if (b.bidder === seller) throw new Error('cannot fill your own bid')
  const m = await market(b.mint); if (!m) throw new Error('no market')
  const d = await dec(b.mint); const q = R.fillQuote(b.sol, b.discBps, m.priceSol, d)
  return { bid: pubBid(b), mint: b.mint, bidder: b.bidder, seller, treasury: TREASURY, decimals: d, priceSol: m.priceSol, px: q.px, tokens: q.tokens, base: q.base.toString(), lamports: q.lamports.toString(), sellerLamports: q.sellerLamports.toString(), fee: q.fee.toString() }
}
/** Seller submits a seller-signed tx; server verifies structure vs a fresh quote, relays to bidder to co-sign + send */
export async function fill(id: string, seller: string, txB64: string): Promise<{ sig: string }> {
  const b = bids.get(id); if (!b || b.status !== 'open') throw new Error('bid not open')
  if (!b.ws || b.ws.readyState !== 1) { bids.delete(id); throw new Error('bidder offline — bid removed') }
  const q = await quote(id, seller)
  const tx = Transaction.from(Buffer.from(txB64, 'base64'))
  const sellerSig = tx.signatures.find((s) => s.publicKey.toBase58() === seller); if (!sellerSig?.signature) throw new Error('tx not signed by seller')
  const why = verifyFill(tx, { mint: b.mint, seller, bidder: b.bidder, treasury: TREASURY, base: BigInt(q.base), sellerLamports: BigInt(q.sellerLamports), fee: BigInt(q.fee) })
  if (why) throw new Error('fill rejected: ' + why)
  if ((await balanceSol(b.bidder)) < b.sol + 0.005) { bids.delete(id); throw new Error('bidder balance dropped — bid removed') }
  b.status = 'filling'
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); if (b.status === 'filling') b.status = 'open'; reject(new Error('bidder did not respond in time')) }, 25000)
    pending.set(id, { resolve, reject, timer })
    b.ws!.send(JSON.stringify({ type: 'fill', bidId: id, tx: txB64, expect: { mint: b.mint, seller, bidder: b.bidder, treasury: TREASURY, base: q.base, sellerLamports: q.sellerLamports, fee: q.fee, priceSol: q.priceSol, discBps: b.discBps, decimals: q.decimals } }))
  })
}
/** Bidder's answer to a relayed fill */
export function settle(id: string, ok: boolean, sig?: string, err?: string) {
  const p = pending.get(id); const b = bids.get(id); if (!p) return
  clearTimeout(p.timer); pending.delete(id)
  if (ok && sig) { if (b) { b.status = 'filled'; b.fills++; bids.delete(id) } p.resolve({ sig }) }
  else { if (b) b.status = 'open'; p.reject(new Error(err || 'bidder rejected')) }
}
export const stats = () => ({ openBids: [...bids.values()].filter((b) => b.status === 'open').length, markets: books().length })
