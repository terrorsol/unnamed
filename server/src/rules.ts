// Desk + vault rules. Pure functions, unit-tested. Mirrors app/src/lib/protocol.ts.
export const DISC_MIN_BPS = 300, DISC_MAX_BPS = 500          // bids sit 3–5% under spot
export const GATE_MCAP_USD = 100_000                            // desk opens: graduated + $100K mc
export const MIN_BLOCK_OF_RESERVE = 0.02                        // min block = 2% of pool SOL reserve
export const MIN_BLOCK_FLOOR_SOL = 0.2
export const REST_MS = 60_000                                   // a bid rests 60s before it can be filled
export const BID_TTL_MS = 30 * 60_000                           // and dies after 30 min unless refreshed
export const CROSS_FEE_BPS = 50                                 // 0.5% of SOL crossed, paid by bidder → treasury
export const PRICE_TOL = 0.015                                  // bidder accepts a fill within 1.5% of their discount

export type Market = { mcapUsd: number; liqSol: number; onCurve: boolean; priceSol: number }
export function deskOpen(m: Market) { return !m.onCurve && m.mcapUsd >= GATE_MCAP_USD }
export function minBlockSol(m: Market) { return Math.max(MIN_BLOCK_FLOOR_SOL, m.liqSol * MIN_BLOCK_OF_RESERVE) }
export function validBid(sol: number, discBps: number, m: Market): string | null {
  if (!deskOpen(m)) return 'desk closed for this coin (needs graduated + $100K mc)'
  if (!(discBps >= DISC_MIN_BPS && discBps <= DISC_MAX_BPS)) return `discount must be ${DISC_MIN_BPS / 100}–${DISC_MAX_BPS / 100}%`
  const mb = minBlockSol(m); if (sol < mb) return `min block is ${mb.toFixed(2)} SOL`
  return null
}
/** tokens the seller must deliver to fully consume a bid, in base units */
export function fillQuote(bidSol: number, discBps: number, priceSol: number, decimals: number) {
  const px = priceSol * (1 - discBps / 10000)
  const tokens = bidSol / px
  const base = BigInt(Math.floor(tokens * 10 ** decimals))
  const lamports = BigInt(Math.floor(bidSol * 1e9))
  const fee = BigInt(Math.floor(Number(lamports) * CROSS_FEE_BPS / 10000))
  return { px, tokens, base, lamports, fee, sellerLamports: lamports - fee }
}
export function restable(placedAt: number, now = Date.now()) { return now - placedAt >= REST_MS }
export function expired(refreshedAt: number, now = Date.now()) { return now - refreshedAt > BID_TTL_MS }

// ---- vault policy ----
export const VAULT_MAX_CRASH_SPEND = 0.4       // ≤40% of chest per crash episode
export const VAULT_TRIM_FRAC = 0.02            // trim ≤2% of position per trim
export const VAULT_TRIM_COOLDOWN_MS = 120_000
export const VAULT_TRIM_DAY_CAP = 0.05           // ≤5% of position per 24h
export const VAULT_TRIM_VOL_CAP = 0.10           // a trim ≤10% of 1h volume
export const IMPORT_FEE_SOL = 15                 // bring-your-own-coin vault: 10 → treasury, 5 → chest
export const IMPORT_SEED_SOL = 5
export const IMPORT_MIN_MCAP_USD = 50_000
/** trim size in tokens given caps; 0 if nothing allowed */
export function trimSize(positionTokens: number, trimmedToday: number, vol1hSol: number, priceSol: number) {
  const perTrim = positionTokens * VAULT_TRIM_FRAC
  const dayRoom = positionTokens * VAULT_TRIM_DAY_CAP - trimmedToday
  const volRoom = priceSol > 0 ? (vol1hSol * VAULT_TRIM_VOL_CAP) / priceSol : 0
  return Math.max(0, Math.min(perTrim, dayRoom, volRoom))
}
export const VAULT_DIP_TRIGGER = -0.12         // buy when price is ≥12% under the 15-min high
export function dipBudget(chestSol: number, drawdown: number, spentThisEpisode: number) {
  if (drawdown > VAULT_DIP_TRIGGER) return 0
  const cap = chestSol * VAULT_MAX_CRASH_SPEND - spentThisEpisode
  const want = chestSol * Math.min(VAULT_MAX_CRASH_SPEND, Math.abs(drawdown) * 1.5)
  return Math.max(0, Math.min(cap, want))
}
export function mayTrim(price: number, avgCost: number, vwap30: number, ema5: number, ema15: number) { return price > avgCost * 1.05 && price > vwap30 && ema5 > ema15 }
export function vwap(samples: { p: number; v: number }[]) { const v = samples.reduce((a, s) => a + s.v, 0); return v ? samples.reduce((a, s) => a + s.p * s.v, 0) / v : samples.at(-1)?.p || 0 }
export function ema(prev: number | null, x: number, n: number) { return prev == null ? x : prev + (x - prev) * (2 / (n + 1)) }
