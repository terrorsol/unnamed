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
  const r = await fetch(`${process.env.DEX_URL || 'https://api.dexscreener.com'}/token-pairs/v1/solana/${mint}`).catch(() => null)
  const pairs: any[] = r && r.ok ? await r.json().catch(() => []) : []
  const p = pairs.filter((x) => x.chainId === 'solana').sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0]
  // DexScreener misses or mis-prices many Token-2022 (mayhem) pump coins; GeckoTerminal tracks them. Fall back when there is no pair or no volume.
  if (!p || !(p.volume?.h1 > 0)) { const g = await fromGecko(mint).catch(() => null); if (g) return g }
  if (!p) return null
  const onCurve = p.dexId === 'pumpfun', priceSol = +(p.priceNative || 0)
  // DexScreener reports no liquidity for bonding-curve coins. pump's curve is a virtual constant product (30 SOL × 1.073e9 tokens),
  // so the effective SOL depth at price p is sqrt(k·p) — 30 SOL at launch, ~115 SOL at graduation. That is what impact math needs.
  const liqSol = p.liquidity?.quote || (onCurve && priceSol ? Math.sqrt(30 * 1.073e9 * priceSol) : 0)
  const mcapUsd = p.marketCap || p.fdv || 0
  return { mcapUsd, imcap: mcapUsd, ipx: priceSol, liqSol, onCurve, priceSol, symbol: p.baseToken.symbol, pair: p.pairAddress, dexId: p.dexId, vol1h: p.volume?.h1 || 0, t: Date.now(), exact: false }
}
const GT = 'https://api.geckoterminal.com/api/v2'
export async function fromGecko(mint: string) {
  if (process.env.GECKO === '0') return null
  const r = await fetch(`${GT}/networks/solana/tokens/${mint}/pools?page=1`, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error('geckoterminal ' + r.status)
  const d: any = await r.json(); const pools: any[] = (d.data || []).filter((x: any) => x.relationships?.quote_token?.data?.id === 'solana_So11111111111111111111111111111111111111112')
  const p = pools.sort((a: any, b: any) => +(b.attributes.reserve_in_usd || 0) - +(a.attributes.reserve_in_usd || 0))[0]; if (!p) return null
  const a = p.attributes; const dex = p.relationships?.dex?.data?.id || ''; const onCurve = dex === 'pump-fun'
  const priceSol = +(a.base_token_price_native_currency || 0); const mcapUsd = +(a.market_cap_usd || a.fdv_usd || 0)
  const liqSol = onCurve && priceSol ? Math.sqrt(30 * 1.073e9 * priceSol) : (+(a.reserve_in_usd || 0) / 2) / Math.max(1e-9, +(a.base_token_price_usd || 0) / Math.max(priceSol, 1e-12))
  return { mcapUsd, imcap: mcapUsd, ipx: priceSol, liqSol: Number.isFinite(liqSol) ? liqSol : 0, onCurve, priceSol, symbol: (a.name || '').split(' / ')[0] || '', pair: a.address, dexId: dex === 'pump-fun' ? 'pumpfun' : dex, vol1h: +(a.volume_usd?.h1 || 0), t: Date.now(), exact: false, source: 'gecko' }
}
