// BANKER protocol rules — the reference implementation the on-chain programs mirror.
// Used today as a *preview* layer over real market data (not enforced on-chain yet).
export const FLIP_WINDOW_MIN = 30
export const FLIP_MAX_RATE = 0.08
export const WALLET_CAP = 0.025
export const VAULT_CAP = 0.50
export const DESK_MIN_BLOCK_OF_RESERVE = 0.02
export const DESK_GATE_MCAP_USD = 100_000
export const REDEEM_HAIRCUT = 0.07

/** Early-flip fee on a sell. profit in SOL, heldMin minutes since (cost-weighted) purchase. */
export function flipFee(profit: number, heldMin: number): number {
  if (profit <= 0 || heldMin >= FLIP_WINDOW_MIN) return 0
  return profit * FLIP_MAX_RATE * (1 - heldMin / FLIP_WINDOW_MIN)
}
/** Vault supply% from SOL staked: exponential-ish pricing, 10% cap reached at ≈3.1 SOL */
// pump.fun curve at creation: virtual 30 SOL × 1.073e9 tokens, 1e9 supply. Tokens are quoted on the gross SOL; the 1% fee is charged on top.
// Same math as server/src/launch.ts, which CI preflight checks against PumpPortal's real builds to the lamport.
export const CURVE0 = { vSol: 30, vTok: 1_073_000_000, supply: 1_000_000_000, feeBps: 100 }
/** pump: tokens on the gross SOL, fee on top. LaunchLab (our launchpad): the fees (protocol 0.25% + tax + creator) come OFF the SOL before it hits the curve. */
export function curveBuy(s: { vSol: number; vTok: number }, sol: number, feeOffBps = 0) { const net = sol * (1 - feeOffBps / 1e4); const vSol = s.vSol + net; const vTok = (s.vSol * s.vTok) / vSol; return { tokens: s.vTok - vTok, after: { vSol, vTok }, cost: feeOffBps ? sol : sol * (1 + CURVE0.feeBps / 1e4) } }
/** Block zero: dev buys inside the create tx, the vault buys half its stake right after in the same bundle. */
export function blockZero(devSol: number, stakeSol: number, feeOffBps = 0) {
  const dev = curveBuy(CURVE0, devSol, feeOffBps); const vault = curveBuy(dev.after, stakeSol * 0.5, feeOffBps)
  const price = vault.after.vSol / vault.after.vTok
  return { devPct: dev.tokens / CURVE0.supply * 100, vaultPct: Math.min(VAULT_CAP * 100, vault.tokens / CURVE0.supply * 100), mcapSol: price * CURVE0.supply, chestSol: stakeSol * 0.5 }
}
export function vaultPct(stakeSol: number, devSol = 0, feeOffBps = 0): number { return blockZero(devSol, stakeSol, feeOffBps).vaultPct }
/** SOL the block-zero vault buy needs to take `pct` of supply, after a dev buy of `devSol` */
export function solForPct(pct: number, devSol = 0, feeOffBps = 0): number { const dev = curveBuy(CURVE0, devSol, feeOffBps); const want = (pct / 100) * CURVE0.supply; let lo = 0, hi = 500; for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (curveBuy(dev.after, mid, feeOffBps).tokens > want) hi = mid; else lo = mid } return +hi.toFixed(3) }
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
