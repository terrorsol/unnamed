// Vamp detection without declarations. A vamp is a younger, smaller coin that copies a runner's name/ticker (and often its image),
// launched right after the runner moved, frequently by the same deployer. Evidence is scored, never guessed from one signal.
// Universe = the live board (DexScreener boosts + profiles + every vaulted coin + anything a client asks about), refreshed every 60s.
// Output: for every detected vamp → its original, a 0–1 score and the reasons; families = clusters by normalized name/ticker with a leader.
import { PublicKey } from '@solana/web3.js'
import { conn } from './chain.ts'
import { curvePda } from './pool.ts'

const DEX = () => process.env.DEX_URL || 'https://api.dexscreener.com'
export type Coin = { mint: string; symbol: string; name: string; image?: string; createdAt: number; mcapUsd: number; vol1h: number; vol24: number; ch1h: number; ch5m: number; buys1h: number; sells1h: number; liqUsd: number; dexId: string; pair?: string; creator?: string }
export type Vamp = { mint: string; symbol: string; original: string; originalSymbol: string; score: number; reasons: string[]; ageMin: number; mcapUsd: number }
export type Family = { key: string; members: { mint: string; symbol: string; mcapUsd: number; vol1h: number; createdAt: number; leader: boolean; score: number; vampOf?: string }[] }

const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
const lev = (a: string, b: string) => { if (a === b) return 0; const m = a.length, n = b.length; if (!m || !n) return m + n; let prev = [...Array(n + 1).keys()]; for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur } return prev[n] }
/** 0..1 similarity of two names: exact 1, one edit 0.8, containment 0.6, shared 4+ char stem 0.4 */
export function nameSim(a: string, b: string) { const x = norm(a), y = norm(b); if (!x || !y) return 0; if (x === y) return 1; const d = lev(x, y); const L = Math.min(x.length, y.length); if (d <= 1 && L >= 4) return 0.8; if (d <= 2 && L >= 8) return 0.65; if (L >= 4 && (x.includes(y) || y.includes(x))) return 0.6; return 0 }

const universe = new Map<string, Coin>(); let vamps: Vamp[] = []; let families: Family[] = []; let lastRun = 0
const creators = new Map<string, string | null>()
const createdHint = new Map<string, number>()

function parsePair(p: any): Coin | null {
  if (!p?.baseToken?.address || p.chainId !== 'solana') return null
  return { mint: p.baseToken.address, symbol: p.baseToken.symbol || '', name: p.baseToken.name || '', image: p.info?.imageUrl, createdAt: p.pairCreatedAt || 0, mcapUsd: p.marketCap || p.fdv || 0, vol1h: p.volume?.h1 || 0, vol24: p.volume?.h24 || 0, ch1h: p.priceChange?.h1 ?? 0, ch5m: p.priceChange?.m5 ?? 0, buys1h: p.txns?.h1?.buys || 0, sells1h: p.txns?.h1?.sells || 0, liqUsd: p.liquidity?.usd || 0, dexId: p.dexId, pair: p.pairAddress }
}
async function tokensByMint(mints: string[]) {
  const out: Coin[] = []
  for (let i = 0; i < mints.length; i += 30) { try { const r = await fetch(`${DEX()}/tokens/v1/solana/${mints.slice(i, i + 30).join(',')}`); const arr: any[] = await r.json(); const best = new Map<string, any>(); for (const p of arr) { const b = best.get(p.baseToken?.address); if (!b || (p.liquidity?.usd || 0) > (b.liquidity?.usd || 0)) best.set(p.baseToken?.address, p) } for (const p of best.values()) { const c = parsePair(p); if (c) out.push(c) } } catch {} }
  return out
}
/** pump.fun bonding curve stores the creator after `complete` (offset 49, 32 bytes). Works for graduated coins too (the curve account stays). */
export async function creatorOf(mint: string): Promise<string | null> {
  if (creators.has(mint)) return creators.get(mint)!
  let c: string | null = null
  try { const info = await conn.getAccountInfo(curvePda(mint)); if (info && info.data.length >= 81) c = new PublicKey(info.data.subarray(49, 81)).toBase58() } catch {}
  creators.set(mint, c); return c
}
/** Extra mints the detector should always include (vaulted coins, coins clients are looking at). */
const pinned = new Set<string>()
export const watch = (mint: string) => { if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) pinned.add(mint) }

export async function refresh(extra: string[] = []) {
  const mints = new Set<string>([...pinned, ...extra])
  for (const path of ['/token-boosts/top/v1', '/token-boosts/latest/v1', '/token-profiles/latest/v1']) { try { const r = await fetch(DEX() + path); const arr: any[] = await r.json(); for (const x of arr) if (x.chainId === 'solana' && x.tokenAddress) mints.add(x.tokenAddress) } catch {} }
  // GeckoTerminal: what's trending (the originals) and what just launched (where vamps are born)
  for (const path of ['/networks/solana/trending_pools?page=1', '/networks/solana/trending_pools?page=2', '/networks/solana/new_pools?page=1', '/networks/solana/new_pools?page=2']) {
    try { const r = await fetch('https://api.geckoterminal.com/api/v2' + path, { headers: { accept: 'application/json' } }); if (!r.ok) continue; const d: any = await r.json(); for (const p of d.data || []) { const m = p.relationships?.base_token?.data?.id?.replace('solana_', ''); if (m && m !== 'So11111111111111111111111111111111111111112') { mints.add(m); const t = Date.parse(p.attributes?.pool_created_at || ''); if (t) createdHint.set(m, t) } } } catch {}
  }
  const coins = await tokensByMint([...mints].slice(0, 300))
  for (const c of coins) if (!c.createdAt && createdHint.has(c.mint)) c.createdAt = createdHint.get(c.mint)!
  for (const c of coins) universe.set(c.mint, c)
  // drop stale entries not seen for 30 min
  const seen = new Set(coins.map((c) => c.mint)); for (const [m, c] of universe) if (!seen.has(m) && !pinned.has(m) && Date.now() - (c as any).seenAt > 1.8e6) universe.delete(m)
  for (const c of coins) (c as any).seenAt = Date.now()
  // creators only for coins that are name-adjacent to something (saves RPC): compute clusters first
  const list = [...universe.values()]
  const clusters = cluster(list)
  const need = new Set<string>(); for (const cl of clusters) if (cl.length > 1) for (const c of cl) need.add(c.mint)
  await Promise.all([...need].slice(0, 120).map(async (m) => { const c = universe.get(m); if (c && !c.creator) c.creator = (await creatorOf(m)) || undefined }))
  const out: Vamp[] = []; const fams: Family[] = []
  for (const cl of clusters) {
    if (cl.length < 2) continue
    const scored = cl.map((c) => ({ c, s: runnerScore(c) })).sort((a, b) => b.s - a.s)
    const leader = scored[0].c
    const fam: Family = { key: norm(leader.symbol) || norm(leader.name), members: [] }
    for (const { c, s } of scored) {
      let vampOf: string | undefined
      if (c.mint !== leader.mint) { const v = judge(c, leader); if (v) { out.push(v); vampOf = leader.mint } }
      fam.members.push({ mint: c.mint, symbol: c.symbol, mcapUsd: c.mcapUsd, vol1h: c.vol1h, createdAt: c.createdAt, leader: c.mint === leader.mint, score: +s.toFixed(1), vampOf })
    }
    fams.push(fam)
  }
  vamps = out.sort((a, b) => b.score - a.score); families = fams; lastRun = Date.now()
  return { coins: universe.size, vamps: vamps.length, families: families.length }
}
/** where the money is: aged mcap × √(1h volume) × buy-pressure tilt — the original is the one still attracting flow, not just the oldest */
export function runnerScore(c: Coin) {
  const ageH = c.createdAt ? (Date.now() - c.createdAt) / 3.6e6 : 48
  const aged = c.mcapUsd * Math.min(1, ageH / 6)
  const tilt = c.buys1h + c.sells1h ? 0.75 + 0.5 * (c.buys1h / (c.buys1h + c.sells1h)) : 1
  return aged * Math.sqrt(Math.max(1, c.vol1h)) * tilt / 1e6
}
function cluster(list: Coin[]): Coin[][] {
  const by = new Map<string, Coin[]>()
  for (const c of list) { const k = norm(c.symbol) || norm(c.name); if (!k || k.length < 2) continue; (by.get(k) || by.set(k, []).get(k)!).push(c) }
  // merge near-identical keys (1 edit) so "PEPE"/"PEPE2"/"PEPEE" land together
  const keys = [...by.keys()]; const used = new Set<string>(); const out: Coin[][] = []
  for (const k of keys) { if (used.has(k)) continue; used.add(k); const group = [...by.get(k)!]; for (const k2 of keys) { if (used.has(k2)) continue; if (nameSim(k, k2) >= 0.65) { used.add(k2); group.push(...by.get(k2)!) } } out.push(group) }
  return out
}
/** Is `c` a vamp of `orig`? Needs: younger + smaller, name/ticker copied, and at least one more signal (same deployer, launched inside the runner's window, same image). */
export function judge(c: Coin, orig: Coin): Vamp | null {
  if (!orig.createdAt || !c.createdAt || c.createdAt <= orig.createdAt) return null
  if (c.mcapUsd >= orig.mcapUsd) return null
  const reasons: string[] = []; let score = 0
  const symSim = nameSim(c.symbol, orig.symbol), nameS = nameSim(c.name, orig.name)
  // names alone only convict when BOTH ticker and name are exact copies; a near-copy needs a second signal (timing, deployer, image)
  if (symSim >= 0.8) { score += symSim === 1 ? 0.4 : 0.3; reasons.push(symSim === 1 ? 'same ticker' : 'ticker one edit away') } else if (symSim >= 0.6) { score += 0.2; reasons.push('ticker contains the original') }
  if (nameS >= 0.8) { score += nameS === 1 ? 0.2 : 0.1; reasons.push(nameS === 1 ? 'same name' : 'name one edit away') } else if (nameS >= 0.6) { score += 0.08; reasons.push('name overlaps') }
  if (score === 0) return null
  const gapH = (c.createdAt - orig.createdAt) / 3.6e6
  if (gapH <= 48) { score += gapH <= 6 ? 0.2 : 0.1; reasons.push(`launched ${gapH < 1 ? Math.round(gapH * 60) + ' min' : gapH.toFixed(1) + ' h'} after the original`) }
  if (c.creator && orig.creator && c.creator === orig.creator) { score += 0.35; reasons.push('same deployer wallet') }
  if (c.image && orig.image && c.image === orig.image) { score += 0.2; reasons.push('same image') }
  const ratio = orig.mcapUsd ? c.mcapUsd / orig.mcapUsd : 0; if (ratio < 0.5) { score += 0.05; reasons.push(`${Math.round(ratio * 100)}% of the original's mcap`) }
  if (score < 0.55) return null
  return { mint: c.mint, symbol: c.symbol, original: orig.mint, originalSymbol: orig.symbol, score: +Math.min(1, score).toFixed(2), reasons, ageMin: Math.round((Date.now() - c.createdAt) / 60000), mcapUsd: c.mcapUsd }
}
export const list = () => ({ at: lastRun, vamps, families })
export const forMint = (mint: string) => ({ vamp: vamps.find((v) => v.mint === mint) || null, family: families.find((f) => f.members.some((m) => m.mint === mint)) || null, copies: vamps.filter((v) => v.original === mint) })
export function start() { const run = () => refresh().catch(() => {}); run(); setInterval(run, 60000) }
