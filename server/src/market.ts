import type { Market } from './rules.ts'
const cache = new Map<string, { t: number; m: Market & { decimals?: number; symbol: string; pair?: string } }>()
export async function market(mint: string, maxAgeMs = 5000): Promise<(Market & { symbol: string; pair?: string; t?: number }) | null> {
  const c = cache.get(mint); if (c && Date.now() - c.t < maxAgeMs) return c.m
  const r = await fetch(`${process.env.DEX_URL || 'https://api.dexscreener.com'}/token-pairs/v1/solana/${mint}`); if (!r.ok) return null
  const pairs: any[] = await r.json()
  const p = pairs.filter((x) => x.chainId === 'solana').sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0]
  if (!p) return null
  const m = { mcapUsd: p.marketCap || p.fdv || 0, liqSol: p.liquidity?.quote || 0, onCurve: p.dexId === 'pumpfun', priceSol: +(p.priceNative || 0), symbol: p.baseToken.symbol, pair: p.pairAddress, vol1h: p.volume?.h1 || 0, t: Date.now() }
  cache.set(mint, { t: m.t, m }); return m
}
