// Market simulator for the vault. Constant-product pool, scripted + random order flow, fees, the vault's real rules.
// Shared by the server backtest (test/sim.test.mjs) and the Simulate page. Deterministic for a given seed.
export type Mode = 'none' | 'floor' | 'mm'
export type Params = { poolSol: number; chestPct: number; mode: Mode; ceiling: number; hours: number; seed: number; swapFee: number; deskUse: number; pumpStrength: number; v2?: boolean; skew?: boolean; zstretch?: boolean; volDisc?: boolean }
export type Result = { path: number[]; peak: number; maxDrawdown: number; final: number; vaultValue: number; vaultStart: number; chest: number; captured: number; captures: number; deskBought: number; deskFills: number; dips: number; dipBought: number; devPaid: number; floor: number; impactAvoided: number; volumeSol: number; trimmed: number; txs: number; feesPaid: number }

export function captureFrac(price: number, vwap30: number, avgCost: number, mcapUsd: number, ceiling: number, rnd: number) {
  if (!vwap30 || price <= vwap30 || price <= avgCost * 1.02) return 0
  const stretch = price / vwap30 - 1
  let f = Math.min(0.30, 0.10 + stretch * 0.40)
  f *= mcapUsd < 100_000 ? 0.5 : mcapUsd < 1_000_000 ? 1 : 0.75
  f *= 0.8 + rnd * 0.4
  return Math.max(0, Math.min(ceiling, f))
}
export function inventorySkew(vaultedPct: number, targetPct: number, k = 0.5) { const q = targetPct > 0 ? (vaultedPct - targetPct) / targetPct : 0; return { capture: Math.min(1.5, Math.max(0.5, 1 + k * q)), defend: Math.min(1.5, Math.max(0.5, 1 - k * q)), q } }
export function sigmaOf(samples: { t: number; p: number }[]) { const by: number[] = []; let last = -1, lp = 0; for (const s of samples) { const m = Math.floor(s.t / 60000); if (m !== last) { if (lp > 0) by.push(Math.log(s.p / lp)); lp = s.p; last = m } } if (by.length < 3) return 0; const mu = by.reduce((a, b) => a + b, 0) / by.length; return Math.sqrt(by.reduce((a, b) => a + (b - mu) ** 2, 0) / (by.length - 1)) * Math.sqrt(by.length) }
export const deskDiscount = (_sig: number) => 0.04 // vol-widening tested and rejected (see DIAGNOSIS.md)
export function captureFracV2(price: number, vwap30: number, avgCost: number, mcapUsd: number, sig: number, vaultedPct: number, targetPct: number, ceiling: number, rnd: number) {
  if (!vwap30 || price <= vwap30 || price <= avgCost * 1.02) return 0
  const raw = price / vwap30 - 1; const z = sig > 0 ? raw / sig : raw / 0.1; const stretch = 0.5 * raw + 0.5 * Math.min(1, z * 0.1)
  let f = Math.min(0.30, 0.10 + stretch * 0.40); f *= mcapUsd < 100_000 ? 0.5 : mcapUsd < 1_000_000 ? 1 : 0.75; f *= inventorySkew(vaultedPct, targetPct).capture; f *= 0.8 + rnd * 0.4
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
        if (bidSol >= minBlock && size >= minBlock && impact > ((P.volDisc ?? P.v2) ? deskDiscount(sigmaOf(samples)) : 0.04) && r() < P.deskUse) {
          const fillSol = Math.min(size, bidSol); const px = price() * (1 - ((P.volDisc ?? P.v2) ? deskDiscount(sigmaOf(samples)) : 0.04)); const tok = fillSol / px
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
      const sig = (P.zstretch ?? P.v2) ? sigmaOf(samples) : 0; const vaultedPct = (vt / supply) * 100; const target = (P.poolSol * P.chestPct * 0.5 / p0 / supply) * 100 || 5
      const useZ = P.zstretch ?? P.v2, useSkew = P.skew ?? P.v2
      let f = useZ ? captureFracV2(p, vw, avgCost, mcapUsd, sig, useSkew ? vaultedPct : target, target, P.ceiling, r()) : captureFrac(p, vw, avgCost, mcapUsd, P.ceiling, r()) * (useSkew ? inventorySkew(vaultedPct, target).capture : 1)
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
    const budget = chest * 0.4 * ((P.skew ?? P.v2) ? inventorySkew((vt / supply) * 100, (P.poolSol * P.chestPct * 0.5 / p0 / supply) * 100 || 5).defend : 1); const level = TRANCHES.findIndex((L, idx) => dd <= L && !fired.includes(idx))
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

// ---- synthetic chart shapes for testing the classifier: returns a price/volume/txn history and the features a live board would see ----
export type Shape = 'runner' | 'rug' | 'bundle' | 'crash' | 'dead' | 'healthy'
export function shapeFeatures(shape: Shape, seed = 1) {
  const r = rng(seed); const S0 = 80; let S = S0, T = 4e8; const price = () => S / T
  const hist: { t: number; p: number; buy: boolean; sol: number }[] = []
  const buy = (sol: number) => { const dT = T - (S * T) / (S + sol); S += sol; T -= dT; return dT }
  const sell = (sol: number) => { let tokens = sol / price(); tokens = Math.min(tokens, T * 0.45); const dS = S - (S * T) / (T + tokens); S -= dS; T += tokens }
  const steps = 6 * 720; let top1 = 3, top10 = 25, ageMin = 360, liqFrac = 1
  for (let i = 0; i < steps; i++) {
    const h = i / 720; let pb = 0.5, inten = 0.2, size = 0.3 + r() * r() * 2
    if (shape === 'runner') { pb = 0.58; inten = 0.25 + h * 0.08; if (i % 300 < 40) pb = 0.35 } // steady bid, periodic shallow dips, rising participation
    if (shape === 'healthy') { pb = 0.5; inten = 0.2 }
    if (shape === 'crash') { pb = h < 4 ? 0.68 : 0.22; inten = h < 4 ? 0.5 : 0.7; size *= h < 4 ? 1.2 : 2 }
    if (shape === 'rug') { pb = h < 5.8 ? 0.56 : 0.05; inten = h < 5.8 ? 0.3 : 1; if (h >= 5.9 && i % 10 === 0) { sell(S * 0.35); hist.push({ t: i * 5000, p: price(), buy: false, sol: S * 0.35 }) } top1 = 28; liqFrac = 0.4 }
    if (shape === 'bundle') { ageMin = 12; top10 = 68; top1 = 14; pb = h < 0.15 ? 0.95 : 0.45; inten = h < 0.15 ? 1 : 0.9; size *= h < 0.15 ? 6 : 1.5 }
    if (shape === 'dead') { pb = 0.45; inten = h < 1 ? 0.3 : 0.004; size *= 0.5 }
    if (r() < inten) { const isBuy = r() < pb; if (isBuy) buy(size); else sell(size); hist.push({ t: i * 5000, p: price(), buy: isBuy, sol: size }) }
  }
  const now = steps * 5000; const pAt = (minAgo: number) => { const t = now - minAgo * 60000; const x = [...hist].reverse().find((e) => e.t <= t); return x ? x.p : hist[0]?.p || price() }
  const pct = (minAgo: number) => (price() / pAt(minAgo) - 1) * 100
  const win = (minAgo: number) => hist.filter((e) => e.t >= now - minAgo * 60000)
  const SOLUSD = 160; const mcap = 1e9 * price() * SOLUSD
  return { m5: pct(5), h1: pct(60), h6: pct(360), h24: pct(360), vol5m: win(5).reduce((a, e) => a + e.sol, 0) * SOLUSD, vol1h: win(60).reduce((a, e) => a + e.sol, 0) * SOLUSD, vol24: win(360).reduce((a, e) => a + e.sol, 0) * SOLUSD, mcap, liq: S * liqFrac * SOLUSD * 2, ageMin, buys1h: win(60).filter((e) => e.buy).length, sells1h: win(60).filter((e) => !e.buy).length, buys5m: win(5).filter((e) => e.buy).length, sells5m: win(5).filter((e) => !e.buy).length, top1, top10, mintAuth: shape === 'rug', freezeAuth: false, vault: false }
}
