/** Slippage sized to the trade: expected CPMM impact for this size against the pool's SOL depth, ×1.6 headroom, +0.8% base, never above the user's max. A 0.1 SOL buy into a 60 SOL pool gets ~1.1%, not 10%. */
export function dynSlippageBps(sizeSol: number, depthSol: number | undefined, maxBps: number) {
  if (!depthSol || depthSol <= 0 || !sizeSol) return maxBps
  const impact = 1 - 1 / (1 + sizeSol / depthSol) ** 2 // price move of a constant-product buy of sizeSol
  return Math.min(maxBps, Math.max(80, Math.round((impact * 1.6 + 0.008) * 10000)))
}
