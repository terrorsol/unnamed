// DexScreener public API (CORS-enabled, no key). Docs: https://docs.dexscreener.com/api/reference
export type Pair = {
  chainId: string; dexId: string; url: string; pairAddress: string
  baseToken: { address: string; name: string; symbol: string }
  quoteToken: { address: string; symbol: string }
  priceUsd?: string; priceNative?: string
  txns?: { h1?: { buys: number; sells: number }; h24?: { buys: number; sells: number }; m5?: { buys: number; sells: number } }
  volume?: { h24?: number; h1?: number; m5?: number }
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number }
  liquidity?: { usd?: number; base?: number; quote?: number }
  fdv?: number; marketCap?: number; pairCreatedAt?: number
  info?: { imageUrl?: string; websites?: { url: string }[]; socials?: { type: string; url: string }[] }
  boosts?: { active?: number }
}
export type Coin = {
  mint: string; symbol: string; name: string; image?: string; pair?: string; dex: string; url?: string
  priceUsd: number; mcap: number; liq: number; vol24: number; vol1h: number; ch1h: number; ch24: number; ch5m: number
  buys24: number; sells24: number; createdAt: number; onCurve: boolean; depthSol: number; raw?: Pair
}
const BASE = 'https://api.dexscreener.com'
async function j(url: string) { const r = await fetch(url); if (!r.ok) throw new Error(`dexscreener ${r.status}`); return r.json() }

export function pairToCoin(p: Pair): Coin {
  return {
    mint: p.baseToken.address, symbol: p.baseToken.symbol, name: p.baseToken.name, image: p.info?.imageUrl, pair: p.pairAddress,
    dex: p.dexId, url: p.url, priceUsd: +(p.priceUsd || 0), mcap: p.marketCap || p.fdv || 0, liq: p.liquidity?.usd || 0,
    vol24: p.volume?.h24 || 0, vol1h: p.volume?.h1 || 0, ch1h: p.priceChange?.h1 ?? 0, ch24: p.priceChange?.h24 ?? 0, ch5m: p.priceChange?.m5 ?? 0,
    buys24: p.txns?.h24?.buys || 0, sells24: p.txns?.h24?.sells || 0, createdAt: p.pairCreatedAt || 0, onCurve: p.dexId === 'pumpfun', depthSol: depthSol(p), raw: p,
  }
}
function bestPair(pairs: Pair[]): Pair | undefined {
  const sol = pairs.filter((p) => p.chainId === 'solana')
  return sol.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0]
}
/** Batch: up to 30 mints → best pair each */
/** SOL depth for impact math. DexScreener has no liquidity for bonding-curve coins; pump's curve is a virtual constant product (30 SOL × 1.073e9), depth = sqrt(k·p). */
/** Client mirror of the server's desk gate (rules.deskWhy): graduated ≥ $100K or curve ≥ $50K, trading, with depth. */
export const deskEligible = (c: Coin) => c.priceUsd > 0 && (c.onCurve ? c.mcap >= 50_000 : c.mcap >= 100_000) && c.vol1h >= 5_000 && c.depthSol >= 10
export function depthSol(p: any): number { const q = p?.liquidity?.quote; if (q) return q; const px = +(p?.priceNative || 0); return p?.dexId === 'pumpfun' && px ? Math.sqrt(30 * 1.073e9 * px) : 0 }
export async function tokensByMint(mints: string[]): Promise<Record<string, Coin>> {
  const out: Record<string, Coin> = {}
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30)
    const pairs: Pair[] = await j(`${BASE}/tokens/v1/solana/${chunk.join(',')}`)
    const by: Record<string, Pair[]> = {}
    pairs.forEach((p) => { (by[p.baseToken.address] ||= []).push(p) })
    for (const m of chunk) { const b = by[m] && bestPair(by[m]); if (b) out[m] = pairToCoin(b) }
  }
  return out
}
export async function tokenPairs(mint: string): Promise<Coin | null> {
  const pairs: Pair[] = await j(`${BASE}/token-pairs/v1/solana/${mint}`)
  const b = bestPair(pairs); return b ? pairToCoin(b) : null
}
export async function search(q: string): Promise<Coin[]> {
  const r = await j(`${BASE}/latest/dex/search?q=${encodeURIComponent(q)}`)
  const seen = new Set<string>(); const out: Coin[] = []
  for (const p of (r.pairs || []) as Pair[]) { if (p.chainId !== 'solana' || seen.has(p.baseToken.address)) continue; seen.add(p.baseToken.address); out.push(pairToCoin(p)) }
  return out.slice(0, 30)
}
/** Trending: boosted + latest profiles on Solana, hydrated with pair data */
export async function trending(): Promise<Coin[]> {
  const [boost, prof] = await Promise.all([j(`${BASE}/token-boosts/top/v1`).catch(() => []), j(`${BASE}/token-profiles/latest/v1`).catch(() => [])])
  const mints: string[] = []
  for (const t of [...boost, ...prof]) if (t.chainId === 'solana' && t.tokenAddress && !mints.includes(t.tokenAddress)) mints.push(t.tokenAddress)
  const map = await tokensByMint(mints.slice(0, 60))
  return Object.values(map).sort((a, b) => b.vol24 - a.vol24)
}
export const chartUrl = (pair: string) => `https://dexscreener.com/solana/${pair}?embed=1&loadChartSettings=0&trades=0&tabs=0&info=0&chartLeftToolbar=0&chartTheme=dark&theme=dark&chartStyle=1&chartType=usd&interval=1`
