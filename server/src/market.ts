import type { Market } from './rules.ts'
import { poolSpot } from './pool.ts'
const cache = new Map<string, { t: number; it: number; m: any }>()
export async function market(mint: string, maxAgeMs = 5000): Promise<(Market & { symbol: string; pair?: string; t?: number; dexId?: string; exact?: boolean }) | null> {
  const c = cache.get(mint)
  if (c && Date.now() - c.t < maxAgeMs) return c.m
  // indexer fields (symbol, mcap, volume, pair) refresh at most every 5s; the PRICE is re-read from the pool itself whenever asked
  const fresh = c && Date.now() - c.it < 5000; const base = fresh ? c.m : (await fromIndexer(mint)) || c?.m; if (!base) return null; const it = fresh ? c!.it : Date.now()
  const spot = await poolSpot(mint, { onCurve: base.onCurve, pair: base.pair, dexId: (base as any).dexId, decimals: (base as any).decimals })
  const ipx = (base as any).ipx ?? base.priceSol // indexer price, kept so mcap scales with the exact price
  const m = spot ? { ...base, ipx, priceSol: spot.priceSol, liqSol: spot.liqSol || base.liqSol, mcapUsd: ipx ? (base as any).imcap * (spot.priceSol / ipx) : base.mcapUsd, t: Date.now(), exact: true } : { ...base, ipx, priceSol: ipx, mcapUsd: (base as any).imcap, t: fresh ? c!.t : Date.now(), exact: false }
  cache.set(mint, { t: m.t, it, m }); return m
}
async function fromIndexer(mint: string) {
  const r = await fetch(`${process.env.DEX_URL || 'https://api.dexscreener.com'}/token-pairs/v1/solana/${mint}`); if (!r.ok) return null
  const pairs: any[] = await r.json()
  const p = pairs.filter((x) => x.chainId === 'solana').sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0]
  if (!p) return null
  const onCurve = p.dexId === 'pumpfun', priceSol = +(p.priceNative || 0)
  // DexScreener reports no liquidity for bonding-curve coins. pump's curve is a virtual constant product (30 SOL × 1.073e9 tokens),
  // so the effective SOL depth at price p is sqrt(k·p) — 30 SOL at launch, ~115 SOL at graduation. That is what impact math needs.
  const liqSol = p.liquidity?.quote || (onCurve && priceSol ? Math.sqrt(30 * 1.073e9 * priceSol) : 0)
  const mcapUsd = p.marketCap || p.fdv || 0
  return { mcapUsd, imcap: mcapUsd, ipx: priceSol, liqSol, onCurve, priceSol, symbol: p.baseToken.symbol, pair: p.pairAddress, dexId: p.dexId, vol1h: p.volume?.h1 || 0, t: Date.now(), exact: false }
}
