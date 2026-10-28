// Market-maker policy. Pure: no chain, no clock, no randomness unless passed in.
// The vault loop (vault.ts) and the simulator (scripts/mmsim.ts) run this exact code, so what the sim says is what the bot does.
import * as R from './rules.ts'

export const P = {
  defenseEpisodeFrac: R.VAULT_MAX_CRASH_SPEND, // ≤40% of chest per crash episode (× inventory skew)
  defenseDayFrac: 0.5,                         // ≤50% of the chest the day started with, per 24h
  episodeMaxMs: 2 * 3600_000,                  // an episode ends on recovery to −3% of its high, or after this long
  episodeCooldownMs: 30 * 60_000,              // after an episode that spent SOL, no defense for this long
  recoverFrac: 0.97,                           // "recovered" = back within 3% of the episode high
  wickTicks: 2,                                // a trigger must hold on two consecutive ticks (≥5s)
  poolImpactMax: 0.10,                         // a single vault buy or sell moves the pool ≤10% (spend ≤10% of pool SOL)
  toxicSellerShare: 0.6,                       // ≥60% of recent sell volume from one wallet → half budget, no third tranche
  toxicWindowMs: 10 * 60_000,
  deskBidFrac: 0.25,                           // standing desk bid ≤25% of chest
  deskToxicDrop: 0.05,                         // a desk fill followed by a −5% move within 90s pauses desk bids
  deskToxicWindowMs: 90_000,
  deskPauseMs: 15 * 60_000,
  captureDayCap: R.MM_DAY_CAP,
  minBuySol: 0.05,
  episodeAnchor: true,
  captureOn: true,
  defendBelowVwap: 1.02,
  accumulateFrac: 0.10,                        // tax-funded vault: when under its supply target, spend ≤10% of the chest per buy, under VWAP, every ≥2 min
  accumulateEveryMs: 120_000,
  accumulateMinChest: 0.3,
  accumulateDayFrac: 0.25,                     // accumulation has its own day budget so it never starves the desk bid or the crash defense
  warmupMs: 10 * 60_000,                       // no buys in the first 10 min after arming: the VWAP/high have to mean something first (the paper vault bought a −54% 'dip' 15s after seeding into a crash)
  maxDrawdown: 0.35,                           // drawdown stop: the mm leg (dip buys, desk fills, accumulation − captures) down ≥35% on what it deployed → no new buys, desk bid halved and deep, until it is back at break-even. 0 = off                       // a dip is only bought under the 30-min and 2-hour VWAP (a −20% dip from a +300% pump is not a dip)                         // false = legacy behaviour (rolling 15-min high only), kept for the simulator's before/after
}
export type Params = typeof P

export type Swap = { t: number; side: 'buy' | 'sell'; sol: number; trader?: string }
export type State = {
  chest: number; tokens: number; supply: number; pct: number; avgCost: number; mode: 'floor' | 'mm'; ceiling: number
  samples: { t: number; p: number; v: number }[]; samplesLong?: { t: number; p: number; v: number }[]; high15: { t: number; p: number }[]; ema5: number | null; ema15: number | null
  spentEpisode: number; tranchesFired: number[]; levelJit?: number; ddPrev?: number; lastBuy: number
  epHigh?: number; epStart?: number; cooldownUntil?: number
  dayKey?: number; dayDefense?: number; dayAccum?: number; dayChest0?: number; trimmedToday: number; trimDay: number
  buyTimes: number[]; nextCaptureAt?: number; lastCapture: number
  deskPauseUntil?: number; lastDeskFill?: { t: number; p: number; seller?: string } | null; toxicEvents?: number[]; denied?: Record<string, number>
  mmSpent?: number; mmGot?: number; mmTok?: number; stoppedAt?: number; armedAt?: number
}
export type Market = { priceSol: number; mcapUsd: number; liqSol: number; vol1h?: number }

export const vaultedPct = (s: State) => (s.supply ? (s.tokens / s.supply) * 100 : 0)
/** P&L of the mm leg only (SOL spent on dip buys / desk fills / accumulation vs SOL got back from captures, plus the tokens it still holds at p). The block-zero seed is not part of it. */
export const mmPnl = (s: State, p: number) => (s.mmGot || 0) - (s.mmSpent || 0) + Math.max(0, s.mmTok || 0) * p
/** drawdown stop: true while the mm leg is down ≥ maxDrawdown of what it deployed; clears at break-even. Guards defense, accumulation and (half) the desk bid. */
export function stopped(s: State, p: number, now: number, p_: Params = P): boolean {
  if (!(p_.maxDrawdown > 0) || !(s.mmSpent! > 0)) return false
  const pnl = mmPnl(s, p)
  if (s.stoppedAt) { if (pnl >= 0) { s.stoppedAt = undefined; return false } return true }
  if (pnl <= -s.mmSpent! * p_.maxDrawdown) { s.stoppedAt = now; return true }
  return false
}

/** One price observation. Updates windows, EMAs, the day budget and the crash episode. Returns the drawdown the defense will use. */
export function observe(s: State, p: number, now: number, p_: Params = P): { dd: number; high: number; episode: boolean } {
  (s.samples ||= []).push({ t: now, p, v: 1 }); s.samples = s.samples.filter((x) => now - x.t < 30 * 60_000); s.high15 ||= []; s.buyTimes ||= []; s.tranchesFired ||= []
  const sl = (s.samplesLong ||= []); if (!sl.length || now - sl[sl.length - 1].t >= 30_000) sl.push({ t: now, p, v: 1 }); s.samplesLong = sl.filter((x) => now - x.t < 2 * 3600_000)
  s.high15.push({ t: now, p }); s.high15 = s.high15.filter((x) => now - x.t < 15 * 60_000)
  s.ema5 = R.ema(s.ema5, p, 5); s.ema15 = R.ema(s.ema15, p, 15)
  const day = Math.floor(now / 86400000); if (day !== s.dayKey) { s.dayKey = day; s.dayDefense = 0; s.dayAccum = 0; s.dayChest0 = s.chest }
  if (day !== s.trimDay) { s.trimDay = day; s.trimmedToday = 0 }
  // desk toxicity: a block bought off-chart, then the chart drops → the seller was dumping into us. Pull the bid for a while.
  // Each event doubles the pause (15 → 30 → 60 min …) and the seller is refused the vault's bids for 24h.
  if (s.lastDeskFill && now - s.lastDeskFill.t <= p_.deskToxicWindowMs && p < s.lastDeskFill.p * (1 - p_.deskToxicDrop)) {
    s.toxicEvents = (s.toxicEvents || []).filter((t) => now - t < 86400_000); s.toxicEvents.push(now)
    s.deskPauseUntil = now + p_.deskPauseMs * 2 ** Math.min(6, s.toxicEvents.length - 1)
    if (s.lastDeskFill.seller) (s.denied ||= {})[s.lastDeskFill.seller] = now + 86400_000
    s.lastDeskFill = null
  }
  const high15 = Math.max(...s.high15.map((x) => x.p))
  // episode: anchored to the high where the crash started, so a rolling window can't reset the budget while the price is still down
  let episode = !!s.epHigh
  if (episode) {
    s.epHigh = Math.max(s.epHigh!, p)
    const recovered = p >= s.epHigh! * p_.recoverFrac; const aged = now - (s.epStart || now) > p_.episodeMaxMs
    if (recovered || aged) { if (s.spentEpisode > 0) s.cooldownUntil = now + p_.episodeCooldownMs; s.epHigh = undefined; s.epStart = undefined; s.spentEpisode = 0; s.tranchesFired = []; episode = false }
  }
  const high = episode ? s.epHigh! : high15
  const dd = p / high - 1
  if (!episode && dd > -0.03) { s.spentEpisode = 0; s.tranchesFired = []; s.levelJit = (Math.random() * 2 - 1) * 0.02 }
  return { dd, high, episode }
}

/** share of sell volume from the single biggest seller in the window (0 when unknown) */
export function sellerShare(tape: Swap[], now: number, p_: Params = P): number {
  const by: Record<string, number> = {}; let tot = 0
  for (const x of tape) { if (x.side !== 'sell' || now - x.t > p_.toxicWindowMs || !x.trader) continue; by[x.trader] = (by[x.trader] || 0) + x.sol; tot += x.sol }
  if (tot < 0.5) return 0
  return Math.max(...Object.values(by)) / tot
}

/** Defense decision for this tick: how much SOL to spend buying the dip, and which tranche. null = nothing. */
export function defense(s: State, m: Market, p: number, now: number, dd: number, sellerConc = 0, p_: Params = P, rnd = Math.random()): { spend: number; level: number } | null {
  if (now < (s.cooldownUntil || 0) || now - s.lastBuy <= 15000 || stopped(s, p, now, p_) || (s.armedAt && now - s.armedAt < p_.warmupMs)) return null
  const toxic = sellerConc >= p_.toxicSellerShare
  if (s.levelJit == null) s.levelJit = 0
  const levels = toxic ? R.DEFENSE_TRANCHES.slice(0, 2) : R.DEFENSE_TRANCHES
  const level = levels.findIndex((L, i) => dd <= L + s.levelJit! && (s.ddPrev ?? 0) <= L + s.levelJit! && !(s.tranchesFired || []).includes(i))
  if (level < 0) return null
  // price-aware: never buy a 'dip' that is still above where the coin traded for the last 30 min / 2 h
  const ref = Math.min(R.vwap(s.samples), R.vwap(s.samplesLong || s.samples)); if (ref > 0 && p > ref * p_.defendBelowVwap) return null
  let budget = s.chest * p_.defenseEpisodeFrac * R.inventorySkew(vaultedPct(s), s.pct || 5).defend
  if (toxic) budget *= 0.5
  const dayRoom = Math.max(0, Math.max(s.dayChest0 ?? 0, s.chest) * p_.defenseDayFrac - (s.dayDefense || 0))
  const impactRoom = m.liqSol > 0 ? m.liqSol * p_.poolImpactMax : Infinity
  const spend = +Math.min(budget / 3 * (0.85 + rnd * 0.3), s.chest - 0.02, Math.max(0, budget - s.spentEpisode), dayRoom, impactRoom).toFixed(4)
  if (spend < p_.minBuySol) return null
  return { spend, level }
}
/** Accumulation for a vault that started with less supply than its target (tax-funded launch): buy under VWAP, small, slow. null = nothing. */
export function accumulate(s: State, m: Market, p: number, now: number, p_: Params = P, rnd = Math.random()): number | null {
  if (s.chest < p_.accumulateMinChest || now - s.lastBuy < p_.accumulateEveryMs || now < (s.cooldownUntil || 0) || stopped(s, p, now, p_) || (s.armedAt && now - s.armedAt < p_.warmupMs)) return null
  const target = s.pct || 0; if (target <= 0 || vaultedPct(s) >= target * 0.98) return null
  const ref = Math.min(R.vwap(s.samples), R.vwap(s.samplesLong || s.samples)); if (!ref || p > ref * p_.defendBelowVwap) return null
  const dayRoom = Math.max(0, Math.max(s.dayChest0 ?? 0, s.chest) * p_.accumulateDayFrac - (s.dayAccum || 0))
  const impactRoom = m.liqSol > 0 ? m.liqSol * p_.poolImpactMax : Infinity
  const spend = +Math.min(s.chest * p_.accumulateFrac * (0.8 + rnd * 0.4), s.chest - 0.02, dayRoom, impactRoom).toFixed(4)
  return spend >= p_.minBuySol ? spend : null
}
export function onAccumulated(s: State, spend: number, got: number, now: number) { s.avgCost = (s.avgCost * (s.tokens - got) + spend) / Math.max(s.tokens, 1e-9); s.dayAccum = (s.dayAccum || 0) + spend; s.lastBuy = now; s.mmSpent = (s.mmSpent || 0) + spend; s.mmTok = (s.mmTok || 0) + got }
/** Book a defense buy that landed. */
export function onDefended(s: State, spend: number, got: number, level: number, now: number, p_: Params = P) {
  if (!s.epHigh && p_.episodeAnchor) { s.epHigh = Math.max(...s.high15.map((x) => x.p)); s.epStart = now }
  s.avgCost = (s.avgCost * (s.tokens - got) + spend) / Math.max(s.tokens, 1e-9)
  s.spentEpisode += spend; s.dayDefense = (s.dayDefense || 0) + spend; s.lastBuy = now; (s.tranchesFired ||= []).push(level); s.mmSpent = (s.mmSpent || 0) + spend; s.mmTok = (s.mmTok || 0) + got
}

/** Capture decision when a buy of `solIn` lands: tokens to sell into it. 0 = let it run. */
export function capture(s: State, m: Market, p: number, solIn: number, now: number, p_: Params = P, rnd = Math.random(), rnd2 = Math.random()): number {
  if (!p_.captureOn || s.mode !== 'mm' || solIn < R.MM_MIN_BUY_SOL || s.tokens <= 0) return 0
  s.buyTimes = (s.buyTimes || []).filter((t) => now - t < 60000); s.buyTimes.push(now)
  if (rnd > R.triggerRate(s.buyTimes.length)) return 0
  if (now < (s.nextCaptureAt || 0)) return 0
  const frac = R.captureFracV2(p, R.vwap(s.samples), s.avgCost, m.mcapUsd, R.sigma(s.samples), vaultedPct(s), s.pct || 5, s.ceiling ?? R.MM_MAX_CAPTURE, rnd2); if (frac <= 0) return 0
  const vol1hSol = (m.vol1h || 0) / 150
  let tokens = (solIn * frac) / p
  tokens = Math.min(tokens, (vol1hSol * R.MM_VOL_CAP) / p, s.tokens * p_.captureDayCap - s.trimmedToday, s.tokens * 0.05, m.liqSol > 0 ? (m.liqSol * p_.poolImpactMax) / p : Infinity)
  if (tokens * p < 0.05) return 0
  return tokens
}
export function onCaptured(s: State, tokens: number, now: number, solGot = 0) { s.trimmedToday += tokens; s.lastCapture = now; s.nextCaptureAt = now + 3000 + Math.random() * 6000; if (solGot > 0) { s.mmGot = (s.mmGot || 0) + solGot; s.mmTok = (s.mmTok || 0) - tokens } }

/** Standing desk bid size (SOL) for this tick; 0 = no bid (paused after toxic flow, or too small). */
export function deskBid(s: State, minBlock: number, now: number, p_: Params = P, rnd = Math.random(), p = s.samples.at(-1)?.p || 0): number {
  if (now < (s.deskPauseUntil || 0) || p_.deskBidFrac <= 0) return 0
  const halve = stopped(s, p, now, p_) ? 0.5 : 1
  // desk fills count against the same day budget as dip buys: together ≤50% of the chest the day started with
  const dayRoom = Math.max(0, Math.max(s.dayChest0 ?? 0, s.chest) * p_.defenseDayFrac - (s.dayDefense || 0))
  const want = +Math.min(Math.max(s.chest * p_.deskBidFrac * halve * (0.9 + rnd * 0.2), minBlock), dayRoom).toFixed(3)
  if (want < 0.2 || s.chest * 0.7 < want) return 0
  return want
}
export function onDeskFill(s: State, sol: number, tokens: number, p: number, now: number, seller?: string) { s.dayDefense = (s.dayDefense || 0) + sol; const before = s.tokens; s.avgCost = (s.avgCost * before + sol) / Math.max(before + tokens, 1e-9); s.lastDeskFill = { t: now, p, seller }; s.mmSpent = (s.mmSpent || 0) + sol; s.mmTok = (s.mmTok || 0) + tokens }
/** a wallet that dumped the chart right after selling the vault a block is refused the vault's bids for a day */
export function deskDenied(s: State, wallet: string, now: number) { return (s.denied?.[wallet] || 0) > now }
