// UNNAMED protocol rules — the reference implementation the on-chain programs mirror.
// Used today as a *preview* layer over real market data (not enforced on-chain yet).
export const FLIP_WINDOW_MIN = 30
export const FLIP_MAX_RATE = 0.08
export const WALLET_CAP = 0.025
export const VAULT_CAP = 0.10
export const DESK_MIN_BLOCK_OF_RESERVE = 0.02
export const DESK_GATE_MCAP_USD = 100_000
export const REDEEM_HAIRCUT = 0.07

/** Early-flip fee on a sell. profit in SOL, heldMin minutes since (cost-weighted) purchase. */
export function flipFee(profit: number, heldMin: number): number {
  if (profit <= 0 || heldMin >= FLIP_WINDOW_MIN) return 0
  return profit * FLIP_MAX_RATE * (1 - heldMin / FLIP_WINDOW_MIN)
}
/** Vault supply% from SOL staked: exponential-ish pricing, 10% cap reached at ≈3.1 SOL */
// pump.fun curve at creation: virtual 30 SOL × 1.073e9 tokens, 1e9 supply, 1% fee on the SOL side. Same math as server/src/launch.ts (checked against PumpPortal's own build in CI preflight).
export const CURVE0 = { vSol: 30, vTok: 1_073_000_000, supply: 1_000_000_000, feeBps: 100 }
export function curveBuy(s: { vSol: number; vTok: number }, sol: number) { const net = sol * (1 - CURVE0.feeBps / 1e4); const vSol = s.vSol + net; const vTok = (s.vSol * s.vTok) / vSol; return { tokens: s.vTok - vTok, after: { vSol, vTok } } }
/** Block zero: dev buys inside the create tx, the vault buys half its stake right after in the same bundle. */
export function blockZero(devSol: number, stakeSol: number) {
  const dev = curveBuy(CURVE0, devSol); const vault = curveBuy(dev.after, stakeSol * 0.5)
  const price = vault.after.vSol / vault.after.vTok
  return { devPct: dev.tokens / CURVE0.supply * 100, vaultPct: Math.min(VAULT_CAP * 100, vault.tokens / CURVE0.supply * 100), mcapSol: price * CURVE0.supply, chestSol: stakeSol * 0.5 }
}
export function vaultPct(stakeSol: number, devSol = 0): number { return blockZero(devSol, stakeSol).vaultPct }
/** Cost-weighted clock when adding to a position */
export function mergeClock(oldT: number, oldCost: number, newCost: number, now: number): number { return Math.round((oldT * oldCost + now * newCost) / (oldCost + newCost)) }
/** Vault dip-buy budget for a given drawdown: ≤40% of chest per crash */
export function vaultBuyBudget(chest: number, drawdownPct: number): number { if (drawdownPct >= 0) return 0; return Math.min(chest * 0.4, chest * Math.min(0.4, Math.abs(drawdownPct) / 100 * 2)) }
/** Vault may trim only above holder cost basis AND 30-min VWAP, and only in an uptrend */
export function vaultMayTrim(price: number, avgCost: number, vwap30: number, trendUp: boolean): boolean { return trendUp && price > avgCost && price > vwap30 }
export function deskMinBlock(reserveSol: number): number { return Math.max(0.2, reserveSol * DESK_MIN_BLOCK_OF_RESERVE) }
export function deskOpen(bonded: boolean, mcapUsd: number): boolean { return bonded && mcapUsd >= DESK_GATE_MCAP_USD }
export function redeemValue(supplyPct: number, chestSol: number): number { return (supplyPct / 100) * chestSol * (1 - REDEEM_HAIRCUT) }
/** Copy flag: L = aged_mcap × sqrt(1h volume) */
export function leaderScore(agedMcap: number, vol1h: number): number { return agedMcap * Math.sqrt(Math.max(0, vol1h)) }
