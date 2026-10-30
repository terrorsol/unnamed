/** Per-coin credit for one platform-fee claim. A claim drains the platform fee vault for EVERY pool on our platform, including coins with no
 *  chest, so a chest is credited what its own observed volume paid — taxAccrued (2% of the swaps its feed saw), with 25% headroom for swaps
 *  the feed sized a little low — never a share of fees it didn't observe. What nobody observed stays unattributed (platform), never guessed.
 *  Oct 30 review: the old 'only one armed vault → it gets everything' rule let a free attached chest collect every chest-less coin's fee. */
export const TAX_HEADROOM = 1.25
export function taxWeights(ours: { taxAccrued?: number }[]): number[] {
  return ours.map((v) => Math.max(0, v.taxAccrued || 0))
}
/** split `got` by the weights, each credit capped at its own accrual × headroom; the remainder is unattributed */
export function taxCredits(got: number, accrued: number[]): number[] {
  const total = accrued.reduce((a, w) => a + w, 0); if (!(total > 0) || !(got > 0)) return accrued.map(() => 0)
  return accrued.map((w) => Math.min(got * w / total, w * TAX_HEADROOM))
}
