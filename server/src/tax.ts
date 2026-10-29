/** per-coin weights for one platform-fee claim: the taxed volume each coin's stream observed. When nothing was observed (stream dropped,
 *  server restarted before the accrual was saved) and only one coin can have produced the fee, that coin gets all of it — the fee never
 *  sits unattributed just because the tape missed the trades. With several coins and no observations it stays unattributed (never guessed). */
export function taxWeights(ours: { taxAccrued?: number }[]): number[] {
  const w = ours.map((v) => Math.max(0, v.taxAccrued || 0)); if (w.some((x) => x > 0)) return w
  return ours.length === 1 ? [1] : w
}
