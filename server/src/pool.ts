// Exact spot straight from the pool, not from an indexer. Two cases cover the pump ecosystem:
//  • bonding curve: the curve account's virtual reserves (price = vSOL / vTOKEN)   — PDA ["bonding-curve", mint] under the pump program
//  • PumpSwap:      the pool's own token accounts (WSOL + token), owned by the pool PDA — balances via getTokenAccountsByOwner
// Anything else (Raydium, Meteora, Orca) falls back to the indexer price in market.ts. Cached 1s per mint.
import { PublicKey } from '@solana/web3.js'
import { conn } from './chain.ts'

export const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')
export const WSOL = 'So11111111111111111111111111111111111111112'
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']
export type PoolSpot = { priceSol: number; liqSol: number; source: 'curve' | 'pumpswap'; t: number; complete?: boolean }
const cache = new Map<string, PoolSpot>()

export const curvePda = (mint: string) => PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()], PUMP_PROGRAM)[0]

/** pump.fun bonding curve: 8-byte discriminator, then u64 LE virtual_token_reserves, virtual_sol_reserves, real_token_reserves, real_sol_reserves, token_total_supply, u8 complete */
export async function curveSpot(mint: string, tokenDecimals = 6): Promise<PoolSpot | null> {
  const info = await conn.getAccountInfo(curvePda(mint), 'processed'); if (!info || info.data.length < 49) return null
  const d = info.data; const u = (o: number) => Number(d.readBigUInt64LE(o))
  const vTok = u(8), vSol = u(16), rSol = u(32), complete = d[48] === 1
  if (!vTok || !vSol) return null
  return { priceSol: (vSol / 1e9) / (vTok / 10 ** tokenDecimals), liqSol: vSol / 1e9, source: 'curve', t: Date.now(), complete, realSol: rSol / 1e9 } as PoolSpot & { realSol: number }
}

/** PumpSwap: the pool account owns its two vaults. Price = WSOL balance / token balance (ui units). */
export async function pumpswapSpot(pool: string, mint: string): Promise<PoolSpot | null> {
  const owner = new PublicKey(pool)
  const accs = (await Promise.all(TOKEN_PROGRAMS.map((p) => conn.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey(p) }, 'processed').catch(() => ({ value: [] }))))).flatMap((r) => r.value)
  let sol = 0, tok = 0
  for (const a of accs) { const i = (a.account.data as any).parsed.info; const ui = +(i.tokenAmount.uiAmount || 0); if (i.mint === WSOL) sol += ui; else if (i.mint === mint) tok += ui }
  if (!sol || !tok) return null
  return { priceSol: sol / tok, liqSol: sol, source: 'pumpswap', t: Date.now() }
}

/** Best exact source for this market, or null when the venue isn't one we decode. */
export async function poolSpot(mint: string, m: { onCurve: boolean; pair?: string; dexId?: string; decimals?: number }): Promise<PoolSpot | null> {
  const c = cache.get(mint); if (c && Date.now() - c.t < 1000) return c
  let s: PoolSpot | null = null
  try {
    if (m.onCurve) s = await curveSpot(mint, m.decimals ?? 6)
    else if (m.dexId === 'pumpswap' && m.pair) s = await pumpswapSpot(m.pair, mint)
  } catch { s = null }
  if (s) cache.set(mint, s)
  return s
}
