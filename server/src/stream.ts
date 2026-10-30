// Block-level swap detection for graduated coins, our LaunchLab pools and pump.fun bonding curves. Helius standard websocket (all plans): logsSubscribe on the pool address,
// then getTransaction to read the pool's WSOL balance delta → exact buy/sell size in the same slot it landed.
// Upgrade path: Helius transactionSubscribe (enhanced WS) or LaserStream gRPC — same onSwap() contract, set HELIUS_GRPC.
import { Connection, PublicKey } from '@solana/web3.js'
import { RPC, conn } from './chain.ts'
const WSOL = 'So11111111111111111111111111111111111111112'
export type Swap = { pool: string; sig: string; slot: number; side: 'buy' | 'sell'; sol: number; trader: string; t: number; ev?: TradeEvent }
import { tradesFromLogs, type TradeEvent } from './pumpfast.ts'
type Handler = (s: Swap) => void
let ws: any = null, nextId = 1, closed = false
const subs = new Map<string, { id: number | null; subId: number | null; handlers: Set<Handler>; fast?: boolean }>()
const pending = new Map<number, string>() // request id → pool
const wsUrl = () => process.env.WS_URL || RPC.replace(/^http/, 'ws')   // WS_URL: a websocket endpoint when the RPC's own ws is refused (seen on Render: closed before established)
const seen = new Set<string>()

function send(o: any) { if (ws?.readyState === 1) ws.send(JSON.stringify(o)) }
// a pump.fun curve the chest sells into (fast: true) is watched at 'processed' and read from pump's own trade event in the logs — no
// getTransaction, no wait for confirmation (pumpfast.ts). Everything else stays at 'confirmed' and reads the tx.
function subscribe(pool: string) { const id = nextId++; pending.set(id, pool); send({ jsonrpc: '2.0', id, method: 'logsSubscribe', params: [{ mentions: [pool] }, { commitment: subs.get(pool)?.fast ? 'processed' : 'confirmed' }] }); return id }
function connect() {
  const WS = (globalThis as any).WebSocket; if (!WS) return
  try { ws = new WS(wsUrl()) } catch { return }
  ws.onopen = () => { for (const [pool, s] of subs) s.id = subscribe(pool) }
  ws.onmessage = async (ev: any) => {
    let m: any; try { m = JSON.parse(ev.data) } catch { return }
    if (m.id && pending.has(m.id)) { const pool = pending.get(m.id)!; pending.delete(m.id); const s = subs.get(pool); if (s) s.subId = m.result; return }
    if (m.method !== 'logsNotification') return
    const { value, context } = m.params.result; const sig: string = value.signature; if (value.err || seen.has(sig)) return; seen.add(sig); if (seen.size > 5000) seen.clear()
    const subId = m.params.subscription; const entry = [...subs.entries()].find(([, s]) => s.subId === subId); if (!entry) return
    const [pool, s] = entry
    if (s.fast) {
      const evs = tradesFromLogs(value.logs); if (evs.length) { for (const e of evs) { const sw: Swap = { pool, sig, slot: context.slot, side: e.isBuy ? 'buy' : 'sell', sol: e.sol, trader: e.user, t: Date.now(), ev: e }; s.handlers.forEach((h) => h(sw)) } return }
      // no event in the logs (truncated): the tx itself, once it is readable at 'confirmed'
      for (let i = 0; i < 4; i++) { await new Promise((r) => setTimeout(r, 700)); try { const sw = await decode(conn, pool, sig, context.slot); if (sw) { s.handlers.forEach((h) => h(sw)); return } } catch {} }
      return
    }
    try { const sw = await decode(conn, pool, sig, context.slot); if (sw) s.handlers.forEach((h) => h(sw)) } catch {}
  }
  ws.onclose = (e: any) => { lastClose = `${e?.code || ''} ${e?.reason || ''}`.trim(); if (!closed) setTimeout(connect, 3000) }
  ws.onerror = (e: any) => { lastError = String(e?.message || e?.error?.message || 'error').slice(0, 120); try { ws.close() } catch {} }
}
let lastClose = '', lastError = ''
// Polling fallback (any RPC, no websocket): new signatures on the pool every few seconds, decoded the same way. Runs for every watched
// pool while the websocket is not open; the `seen` set keeps the two paths from double-counting.
const pollers = new Map<string, any>(); const lastSig = new Map<string, string>()
function startPoll(pool: string) {
  if (pollers.has(pool)) return
  pollers.set(pool, setInterval(async () => {
    if (ws?.readyState === 1) return
    const s = subs.get(pool); if (!s) { clearInterval(pollers.get(pool)); pollers.delete(pool); return }
    try {
      const sigs = await conn.getSignaturesForAddress(new PublicKey(pool), { limit: 15, until: lastSig.get(pool) }, 'confirmed')
      if (!sigs.length) return; if (!lastSig.has(pool)) { lastSig.set(pool, sigs[0].signature); return } // first poll just sets the cursor
      lastSig.set(pool, sigs[0].signature)
      for (const x of sigs.reverse()) { if (x.err || seen.has(x.signature)) continue; seen.add(x.signature); const sw = await decode(conn, pool, x.signature, x.slot).catch(() => null); if (sw) s.handlers.forEach((h) => h(sw)) }
    } catch {}
  }, +(process.env.POLL_MS || 2000)))
}
/** is this pool's swap feed live — the websocket subscription, or (while the socket is down) the poller standing in for it */
export function delivering(pool: string) { const s = subs.get(pool); if (!s) return false; return (ws?.readyState === 1 && s.subId != null) || pollers.has(pool) }
/** Read the pool's WSOL delta from the tx: + = buy (SOL into pool), − = sell. Works for PumpSwap, Raydium, Meteora pools. */
export async function decode(c: Connection, pool: string, sig: string, slot: number): Promise<Swap | null> {
  const tx = await c.getTransaction(sig, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' }); if (!tx || tx.meta?.err) return null
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses as any }).staticAccountKeys.map((k) => k.toBase58())
  const payer = keys[0]
  // a pool that holds native SOL itself (the pump.fun bonding curve): its own lamport delta is the exact size of the trade, net of fees
  const pi = keys.indexOf(pool); if (pi > 0) { const d = ((tx.meta?.postBalances?.[pi] || 0) - (tx.meta?.preBalances?.[pi] || 0)) / 1e9; if (Math.abs(d) >= 0.001) return { pool, sig, slot, side: d > 0 ? 'buy' : 'sell', sol: Math.abs(d), trader: payer, t: Date.now() } }
  const pre = tx.meta?.preTokenBalances || [], post = tx.meta?.postTokenBalances || []
  let delta = 0
  for (const pb of post) { if (pb.mint !== WSOL || pb.owner === payer) continue; const pr = pre.find((x) => x.accountIndex === pb.accountIndex); const d = (+(pb.uiTokenAmount.uiAmount || 0)) - (+(pr?.uiTokenAmount.uiAmount || 0)); if (Math.abs(d) > Math.abs(delta)) delta = d }
  if (!delta) { // native SOL pools (some Raydium configs): fall back to lamport delta of non-payer accounts that moved most
    const preL = tx.meta?.preBalances || [], postL = tx.meta?.postBalances || []; let best = 0
    for (let i = 1; i < keys.length; i++) { const d = ((postL[i] || 0) - (preL[i] || 0)) / 1e9; if (Math.abs(d) > Math.abs(best) && Math.abs(d) > 0.01) best = d }
    delta = best
  }
  if (Math.abs(delta) < 0.001) return null
  return { pool, sig, slot, side: delta > 0 ? 'buy' : 'sell', sol: Math.abs(delta), trader: payer, t: Date.now() }
}
export function watchPool(pool: string, h: Handler, opts: { fast?: boolean } = {}) {
  if (!ws) { closed = false; connect() }
  let s = subs.get(pool); if (!s) { s = { id: null, subId: null, handlers: new Set(), fast: !!opts.fast }; subs.set(pool, s); if (ws?.readyState === 1) s.id = subscribe(pool) }
  else if (opts.fast && !s.fast) { s.fast = true; if (s.subId != null) send({ jsonrpc: '2.0', id: nextId++, method: 'logsUnsubscribe', params: [s.subId] }); s.subId = null; if (ws?.readyState === 1) s.id = subscribe(pool) }
  s.handlers.add(h); startPoll(pool); return () => { s!.handlers.delete(h); if (!s!.handlers.size) { if (s!.subId != null) send({ jsonrpc: '2.0', id: nextId++, method: 'logsUnsubscribe', params: [s!.subId] }); subs.delete(pool) } }
}
export const streamStats = () => ({ pools: subs.size, connected: ws?.readyState === 1, polling: pollers.size, lastClose, lastError, wsHost: (() => { try { return new URL(wsUrl()).host } catch { return '?' } })() })
