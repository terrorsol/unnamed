// Market simulator for the vault. Constant-product pool, scripted + random order flow, fees, the vault's real rules.
// Shared by the server backtest (test/sim.test.mjs) and the Simulate page. Deterministic for a given seed.
export type Mode = 'none' | 'floor' | 'mm'
export type Params = { poolSol: number; chestPct: number; mode: Mode; ceiling: number; hours: number; seed: number; swapFee: number; deskUse: number; pumpStrength: number }
export type Result = { path: number[]; peak: number; maxDrawdown: number; final: number; vaultValue: number; vaultStart: number; chest: number; captured: number; captures: number; deskBought: number; deskFills: number; dips: number; dipBought: number; devPaid: number; floor: number; impactAvoided: number; volumeSol: number; trimmed: number; txs: number; feesPaid: number }

export function captureFrac(price: number, vwap30: number, avgCost: number, mcapUsd: number, ceiling: number, rnd: number) {
  if (!vwap30 || price <= vwap30 || price <= avgCost * 1.02) return 0
  const stretch = price / vwap30 - 1
  let f = Math.min(0.30, 0.10 + stretch * 0.40)
  f *= mcapUsd < 100_000 ? 0.5 : mcapUsd < 1_000_000 ? 1 : 0.75
  f *= 0.8 + rnd * 0.4
  return Math.max(0, Math.min(ceiling, f))
}
export const triggerRate = (bpm: number) => Math.min(0.70, Math.max(0.40, 0.40 + (bpm / 10) * 0.30))
const TRANCHES = [-0.20, -0.35, -0.50]
function rng(seed: number) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1_000_000) / 1_000_000 } }

export function simulate(P: Params): Result {
  const r = rng(P.seed); const SOLUSD = 160; const supply = 1e9
  // pool
  let S = P.poolSol, T = supply * 0.4; const price = () => S / T
  const p0 = price(); const path: number[] = []
  const S0 = S
  const buy = (sol: number) => { const fee = sol * P.swapFee; const inS = sol - fee; const dT = T - (S * T) / (S + inS); S += inS; T -= dT; return { tokens: dT, fee } }
  const sell = (tokens: number) => { tokens = Math.min(tokens, T) ; let dS = S - (S * T) / (T + tokens); if (dS > S * 0.5) { dS = S * 0.5; tokens = T } const fee = dS * P.swapFee; S -= dS; T += tokens; return { sol: dS - fee, fee } }
  // vault
  let chest = P.mode === 'none' ? 0 : P.poolSol * P.chestPct, vt = 0, avgCost = 0, captured = 0, captures = 0, deskBought = 0, deskFills = 0, dips = 0, dipBought = 0, devPaid = 0, impactAvoided = 0, trimmed = 0, txs = 0, feesPaid = 0, volumeSol = 0
  const vaultStart = chest
  if (P.mode !== 'none') { const seed = chest * 0.5; const b = buy(seed); vt = b.tokens; avgCost = seed / vt; chest -= seed; txs++; feesPaid += b.fee }
  const samples: { t: number; p: number; v: number }[] = []; const high15: { t: number; p: number }[] = []; const buyTimes: number[] = []
  let spentEpisode = 0, fired: number[] = [], lastCapture = -1e9, lastBuy = -1e9, trimmedToday = 0, lastTrim = -1e9
  let peak = p0, trough = p0, maxDD = 0
  const steps = Math.round(P.hours * 720) // 5s steps
  for (let i = 0; i < steps; i++) {
    const t = i * 5000; const h = i / 720
    // regime: chop → pump → dump → recover, repeating every ~2.5h, scaled by pumpStrength
    const phase = (h % 2.5)
    const bias = phase < 0.5 ? 0 : phase < 1.3 ? 1.0 * P.pumpStrength : phase < 1.7 ? -1.6 * P.pumpStrength : 0.3
    const intensity = Math.min(1, 0.15 + Math.abs(bias) * 0.35)
    // external order flow this step
    let inflow = 0
    if (r() < intensity) {
      const size = 0.2 + r() * r() * (S0 * 0.03) // 0.2 SOL .. 3% of starting reserve, skewed small
      const isBuy = r() < 0.5 + bias * 0.15
      if (isBuy) { const b = buy(size); inflow += size; buyTimes.push(t); volumeSol += size; samples.push({ t, p: price(), v: size }) }
      else {
        // a seller: with a vault bid resting at −4%, part of sell flow uses the desk when it beats chart impact
        const impact = 1 - 1 / (1 + size / S) ** 2
        const bidSol = P.mode !== 'none' ? Math.max(0, Math.min(chest * (P.mode === 'mm' ? 0.6 : 0.35), chest - 0.02)) : 0
        const minBlock = Math.max(0.2, S * 0.02)
        if (bidSol >= minBlock && size >= minBlock && impact > 0.04 && r() < P.deskUse) {
          const fillSol = Math.min(size, bidSol); const px = price() * 0.96; const tok = fillSol / px
          chest -= fillSol * 1.005; vt += tok; avgCost = (avgCost * (vt - tok) + fillSol) / vt; deskBought += fillSol; deskFills++; txs++
          impactAvoided += (1 - 1 / (1 + fillSol / S) ** 2); volumeSol += fillSol
          const rest = size - fillSol; if (rest > 0.01) { const tokens = rest / price(); sell(tokens); volumeSol += rest; samples.push({ t, p: price(), v: rest }) }
        } else { const tokens = size / price(); sell(tokens); volumeSol += size; samples.push({ t, p: price(), v: size }) }
      }
    }
    const p = price(); path.push(p / p0)
    if (p > peak) { peak = p; trough = p } if (p < trough) { trough = p; maxDD = Math.max(maxDD, 1 - trough / peak) }
    if (P.mode === 'none') continue
    // vault bookkeeping
    while (samples.length && t - samples[0].t > 30 * 60_000) samples.shift(); while (buyTimes.length && t - buyTimes[0] > 60_000) buyTimes.shift()
    high15.push({ t, p }); while (high15.length && t - high15[0].t > 15 * 60_000) high15.shift()
    const vw = samples.reduce((a, s) => a + s.p * s.v, 0) / Math.max(1e-9, samples.reduce((a, s) => a + s.v, 0)) || p
    const high = Math.max(...high15.map((x) => x.p)); const dd = p / high - 1
    if (dd > -0.03) { spentEpisode = 0; fired = [] }
    const mcapUsd = supply * p * SOLUSD
    // capture (mm)
    if (P.mode === 'mm' && inflow >= 0.5 && vt > 0 && t - lastCapture >= 4000 && r() < triggerRate(buyTimes.length)) {
      const f = captureFrac(p, vw, avgCost, mcapUsd, P.ceiling, r())
      if (f > 0) {
        const vol1hSol = volumeSol / Math.max(1, h) // rough 1h volume
        let tokens = Math.min((inflow * f) / p, (vol1hSol * 0.15) / p, vt * 0.10 - trimmedToday, vt * 0.05)
        if (tokens * p >= 0.05) { const s = sell(tokens); vt -= tokens; chest += s.sol; feesPaid += s.fee; captured += s.sol; captures++; txs++; trimmedToday += tokens; lastCapture = t
          const profit = s.sol - avgCost * tokens; const cut = Math.max(0, profit) * 0.0665; if (cut > 0.001) { chest -= cut; devPaid += cut } }
      }
    }
    // floor-mode trims (above cost +5%, above vwap, uptrend proxy)
    if (P.mode === 'floor' && vt > 0 && p > avgCost * 1.05 && p > vw && t - lastTrim > 120_000 && r() < 0.5) { const tokens = Math.min(vt * 0.02, vt * 0.05 - trimmedToday); if (tokens > 0 && tokens * p >= 0.05) { const s = sell(tokens); vt -= tokens; chest += s.sol; feesPaid += s.fee; trimmed += s.sol; trimmedToday += tokens; lastTrim = t; txs++; const profit = s.sol - avgCost * tokens; const cut = Math.max(0, profit) * 0.0665; if (cut > 0.001) { chest -= cut; devPaid += cut } } }
    // defense tranches
    const budget = chest * 0.4; const level = TRANCHES.findIndex((L, idx) => dd <= L && !fired.includes(idx))
    if (level >= 0 && t - lastBuy > 15000) { const spend = Math.min(budget / 3, chest - 0.02, Math.max(0, budget - spentEpisode)); if (spend >= 0.05) { const b = buy(spend); const got = b.tokens; avgCost = (avgCost * vt + spend) / (vt + got); vt += got; chest -= spend; spentEpisode += spend; lastBuy = t; fired.push(level); dips++; dipBought += spend; feesPaid += b.fee; txs++ } }
    if (i % 17280 === 0) trimmedToday = 0 // daily reset
  }
  const pf = price()
  return { path, peak: peak / p0, maxDrawdown: maxDD, final: pf / p0, vaultValue: chest + vt * pf, vaultStart, chest, captured, captures, deskBought, deskFills, dips, dipBought, devPaid, floor: chest / supply, impactAvoided, volumeSol, trimmed, txs, feesPaid }
}
/** Run the same flow with and without the vault; the delta is what the vault did. */
export function compare(base: Omit<Params, 'mode'>) {
  const none = simulate({ ...base, mode: 'none' }); const floor = simulate({ ...base, mode: 'floor' }); const mm = simulate({ ...base, mode: 'mm' })
  return { none, floor, mm }
}
