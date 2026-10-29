// Creator rewards. Pure: no chain, no clock unless passed in.
// A creator earns a share of their coin's trading fees, sized by the SOL they locked into its chest ("skin").
// What they earn is held and released in four steps as the coin proves itself — $50K, $150K, $250K, $500K value,
// each held for 15 minutes so a one-candle wick unlocks nothing — then paid out every hour.
// Anything still locked 30 days after launch goes to the chest: if the coin dies, holders get it.
// Off unless CREATOR_REWARDS=1.

export const ENABLED = () => process.env.CREATOR_REWARDS === '1'
export const P = {
  maxSharePct: 20,          // the most a creator can earn: 20% of their coin's fees…
  fullStakeSol: 3,          // …reached by locking 3 SOL or more; linear below (0.5 SOL → 3.3%)
  milestonesUsd: [50_000, 150_000, 250_000, 500_000],
  holdMs: 15 * 60_000,      // a milestone counts once the value has held above it this long
  payEveryMs: 60 * 60_000,  // payouts go out hourly
  minPaySol: 0.001,         // smaller balances wait for the next hour
  forfeitMs: 30 * 86_400_000, // still locked after 30 days → the chest
}
export type Params = typeof P

export type Cr = { earned: number; paid: number; forfeited: number; hits: number; above: (number | null)[]; nextPayAt: number }
export const fresh = (): Cr => ({ earned: 0, paid: 0, forfeited: 0, hits: 0, above: P.milestonesUsd.map(() => null), nextPayAt: 0 })

/** creator's share of fees, in percent, for a given stake */
export function sharePct(stakeSol: number, p: Params = P): number {
  if (!(stakeSol > 0)) return 0
  return +Math.min(p.maxSharePct, (p.maxSharePct * stakeSol) / p.fullStakeSol).toFixed(2)
}
/** split a fee credit between the chest and the creator */
export function splitFee(sol: number, stakeSol: number, renounced: boolean, p: Params = P): { chest: number; creator: number } {
  if (renounced || !(sol > 0)) return { chest: Math.max(0, sol), creator: 0 }
  const creator = Math.floor(sol * sharePct(stakeSol, p) / 100 * 1e9) / 1e9
  return { chest: sol - creator, creator }
}
/** how much of what was earned is unlocked right now (25% per milestone hit) */
export const unlocked = (c: Cr, p: Params = P) => c.earned * (c.hits / p.milestonesUsd.length)
/** unlocked and not yet paid */
export const payable = (c: Cr, p: Params = P) => Math.max(0, unlocked(c, p) - c.paid)
/** still locked (earned, not unlocked, not forfeited) */
export const locked = (c: Cr, p: Params = P) => Math.max(0, c.earned - unlocked(c, p) - c.forfeited)
/** owed to the creator in total: what the shared wallet must keep aside for them */
export const owed = (c: Cr, p: Params = P) => Math.max(0, c.earned - c.paid - c.forfeited)

/** One observation of the coin's value. Returns milestones newly hit, the amount due now (0 until the hourly tick), and any forfeit to move to the chest. Mutates c. */
export function step(c: Cr, mcapUsd: number, now: number, launchedAt: number, p: Params = P): { newHits: number[]; pay: number; forfeit: number } {
  const newHits: number[] = []
  if (!c.above || c.above.length !== p.milestonesUsd.length) c.above = p.milestonesUsd.map((_, i) => (c.above?.[i] ?? null))
  // milestones are climbed in order; hits never go back
  for (let i = c.hits; i < p.milestonesUsd.length; i++) {
    const m = p.milestonesUsd[i]
    if (mcapUsd >= m) { if (c.above[i] == null) c.above[i] = now; if (now - c.above[i]! >= p.holdMs && i === c.hits) { c.hits++; newHits.push(i) } }
    else c.above[i] = null
  }
  let forfeit = 0
  if (launchedAt > 0 && now - launchedAt >= p.forfeitMs && c.hits < p.milestonesUsd.length) { forfeit = locked(c, p); if (forfeit > 0) c.forfeited += forfeit }
  let pay = 0
  if (now >= (c.nextPayAt || 0)) { const due = payable(c, p); if (due >= p.minPaySol) pay = Math.floor(due * 1e9) / 1e9; c.nextPayAt = now + p.payEveryMs }
  return { newHits, pay, forfeit }
}
/** after a payout landed */
export const onPaid = (c: Cr, sol: number) => { c.paid = +(c.paid + sol).toFixed(9) }
/** what the dashboard shows */
export function view(c: Cr | undefined, stakeSol: number, renounced: boolean, mcapUsd: number, p: Params = P) {
  const cc = c || fresh(); const next = p.milestonesUsd[cc.hits] ?? null
  return { enabled: ENABLED(), sharePct: renounced ? 0 : sharePct(stakeSol, p), earned: +cc.earned.toFixed(6), unlocked: +unlocked(cc, p).toFixed(6), paid: +cc.paid.toFixed(6), payable: +payable(cc, p).toFixed(6), locked: +locked(cc, p).toFixed(6), forfeited: +cc.forfeited.toFixed(6), hits: cc.hits, milestones: p.milestonesUsd, next, nextFrac: next ? Math.min(1, Math.max(0, mcapUsd / next)) : 1, holdingSince: next != null ? cc.above?.[cc.hits] ?? null : null, holdMs: p.holdMs, nextPayAt: cc.nextPayAt || 0 }
}
