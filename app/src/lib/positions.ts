// Local cost-basis + hold-clock ledger (per wallet, per browser). Feeds the protocol preview (flip fee, PnL).
// On-chain balances are always the source of truth for *what you hold*; this only remembers *what you paid*.
import { mergeClock } from './protocol'
export type Lot = { mint: string; symbol: string; costSol: number; t: number; tokens?: number }
export type Fill = { sig: string; mint: string; symbol: string; side: 'buy' | 'sell' | 'create'; sol: number; t: number }
const K = (o: string) => `unnamed_pos_${o}`
export function loadLedger(owner: string): { lots: Record<string, Lot>; fills: Fill[] } {
  try { return { lots: {}, fills: [], ...(JSON.parse(localStorage.getItem(K(owner)) || '{}')) } } catch { return { lots: {}, fills: [] } }
}
function save(owner: string, l: ReturnType<typeof loadLedger>) { try { localStorage.setItem(K(owner), JSON.stringify({ lots: l.lots, fills: l.fills.slice(0, 200) })) } catch {} }
export function recordBuy(owner: string, mint: string, symbol: string, sol: number, sig: string) {
  const l = loadLedger(owner); const now = Date.now(); const p = l.lots[mint]
  l.lots[mint] = p ? { ...p, costSol: p.costSol + sol, t: mergeClock(p.t, p.costSol, sol, now) } : { mint, symbol, costSol: sol, t: now }
  l.fills.unshift({ sig, mint, symbol, side: 'buy', sol, t: now }); save(owner, l)
}
export function recordSell(owner: string, mint: string, symbol: string, frac: number, solOut: number, sig: string) {
  const l = loadLedger(owner); const p = l.lots[mint]
  if (p) { if (frac >= 0.999) delete l.lots[mint]; else l.lots[mint] = { ...p, costSol: p.costSol * (1 - frac) } }
  l.fills.unshift({ sig, mint, symbol, side: 'sell', sol: solOut, t: Date.now() }); save(owner, l)
}
export function recordCreate(owner: string, mint: string, symbol: string, sol: number, sig: string) {
  const l = loadLedger(owner); const now = Date.now()
  if (sol > 0) l.lots[mint] = { mint, symbol, costSol: sol, t: now }
  l.fills.unshift({ sig, mint, symbol, side: 'create', sol, t: now }); save(owner, l)
}
