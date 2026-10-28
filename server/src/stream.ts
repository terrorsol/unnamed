// Block-level swap detection for graduated coins. Helius standard websocket (all plans): logsSubscribe on the pool address,
// then getTransaction to read the pool's WSOL balance delta → exact buy/sell size in the same slot it landed.
// Upgrade path: Helius transactionSubscribe (enhanced WS) or LaserStream gRPC — same onSwap() contract, set HELIUS_GRPC.
import { Connection, PublicKey } from '@solana/web3.js'
import { RPC, conn } from './chain.ts'
const WSOL = 'So11111111111111111111111111111111111111112'
export type Swap = { pool: string; sig: string; slot: number; side: 'buy' | 'sell'; sol: number; trader: string; t: number }
type Handler = (s: Swap) => void
let ws: any = null, nextId = 1, closed = false
const subs = new Map<string, { id: number | null; subId: number | null; handlers: Set<Handler> }>()
const pending = new Map<number, string>() // request id → pool
const wsUrl = () => RPC.replace(/^http/, 'ws')
const seen = new Set<string>()

function send(o: any) { if (ws?.readyState === 1) ws.send(JSON.stringify(o)) }
function subscribe(pool: string) { const id = nextId++; pending.set(id, pool); send({ jsonrpc: '2.0', id, method: 'logsSubscribe', params: [{ mentions: [pool] }, { commitment: 'confirmed' }] }); return id }
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
    try { const sw = await decode(conn, pool, sig, context.slot); if (sw) s.handlers.forEach((h) => h(sw)) } catch {}
  }
  ws.onclose = () => { if (!closed) setTimeout(connect, 3000) }
  ws.onerror = () => { try { ws.close() } catch {} }
}
/** Read the pool's WSOL delta from the tx: + = buy (SOL into pool), − = sell. Works for PumpSwap, Raydium, Meteora pools. */
export async function decode(c: Connection, pool: string, sig: string, slot: number): Promise<Swap | null> {
  const tx = await c.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }); if (!tx || tx.meta?.err) return null
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses as any }).staticAccountKeys.map((k) => k.toBase58())
  const payer = keys[0]
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
export function watchPool(pool: string, h: Handler) {
  if (!ws) { closed = false; connect() }
  let s = subs.get(pool); if (!s) { s = { id: null, subId: null, handlers: new Set() }; subs.set(pool, s); if (ws?.readyState === 1) s.id = subscribe(pool) }
  s.handlers.add(h); return () => { s!.handlers.delete(h); if (!s!.handlers.size) { if (s!.subId != null) send({ jsonrpc: '2.0', id: nextId++, method: 'logsUnsubscribe', params: [s!.subId] }); subs.delete(pool) } }
}
export const streamStats = () => ({ pools: subs.size, connected: ws?.readyState === 1 })
