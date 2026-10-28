// Replay REAL coin flow through the real vault policy (src/mm.ts) and check every invariant on every tick.
// Data: app/scripts/scrape.mjs output (reports-backtest branch): 1-min candles + trades per pool, from GeckoTerminal.
// Flow per candle on a constant-product pool with the coin's real SOL reserve S: net SOL = S·(√(close/open) − 1), gross = candle volume;
// buys = (gross+net)/2, sells = (gross−net)/2, spread over 12 five-second ticks (alternating, largest first) so pumps and dumps
// look like streams of trades, not one block. Our own trades move the same pool.
//   node --experimental-strip-types scripts/mmreplay.ts <dir> [chest=0.3] [pct=5] [seed=1] [buys=1] [tax=0] [impact=0] [only=substr]
// impact: how much of the vault's own price impact persists in the path. 0 = the real path is exogenous and phantom flow undoes every
// vault trade (pessimistic: the vault's support never helps the chart). 1 = the vault's trades shift the whole path (optimistic).
import { readdirSync, readFileSync } from 'node:fs'
import * as MM from '../src/mm.ts'
import * as R from '../src/rules.ts'

const DIR = process.argv[2] || '../app/data/real'
const arg = (k: string, d: number) => { const a = process.argv.find((x) => x.startsWith(k + '=')); return a ? +a.split('=')[1] : d }
const CHEST = arg('chest', 0.3), PCT = arg('pct', 5), SEED = arg('seed', 1), BUYS = arg('buys', 1), TAX = arg('tax', 0), IMPACT = arg('impact', 0), DESKVWAP = arg('deskvwap', 1), TP = arg('tp', MM.P.legTakeProfit), ONLY = (process.argv.find((x) => x.startsWith('only=')) || '').slice(5)
const TICK = 5000
function mulberry(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
let rng = mulberry(SEED); Math.random = () => rng()

class Pool { // constant product, 2% tax to the chest on both sides (launchlab shape), reserves in SOL / tokens
  B: number; A: number; tax: number; fee: number; taxIn = 0
  constructor(B: number, A: number, tax = 0.02, fee = 0.0025) { this.B = B; this.A = A; this.tax = tax; this.fee = fee }
  get price() { return this.B / this.A }
  buy(sol: number, chest: { v: number }) { const net = sol * (1 - this.fee - this.tax); const out = this.A - (this.A * this.B) / (this.B + net); this.B += net; this.A -= out; chest.v += sol * this.tax; this.taxIn += sol * this.tax; return out }
  sell(tok: number, chest: { v: number }) { const gross = this.B - (this.A * this.B) / (this.A + tok); this.A += tok; this.B -= gross; chest.v += gross * this.tax; this.taxIn += gross * this.tax; return gross * (1 - this.fee - this.tax) }
}
type Viol = { t: number; what: string }
function replay(file: string) {
  const d = JSON.parse(readFileSync(file, 'utf8')); const solUsd = +d.solUsd || 150
  const candles = (d.ohlcv as number[][]).slice().sort((a, b) => a[0] - b[0]); if (candles.length < 20) return null
  const S0 = Math.max(5, (d.reserveUsd || 0) / 2 / solUsd); const p0 = candles[0][1] / solUsd
  const pool = new Pool(S0, S0 / p0, TAX); const supply = 1e9
  const chest = { v: CHEST }
  // vault starts holding PCT% of supply at p0 (block-zero buy) with CHEST SOL; armed now (warmup applies)
  const t0 = candles[0][0] * 1000
  const s: MM.State = { chest: chest.v, tokens: supply * PCT / 100, supply, pct: PCT, avgCost: p0, mode: 'mm', ceiling: 0.3, samples: [], high15: [], ema5: null, ema15: null, spentEpisode: 0, tranchesFired: [], lastBuy: 0, trimmedToday: 0, trimDay: 0, buyTimes: [], lastCapture: 0, armedAt: t0 }
  const P: MM.Params = { ...(BUYS ? MM.P : { ...MM.P, defenseEpisodeFrac: 0, accumulateFrac: 0 }), ...(DESKVWAP ? {} : { deskBelowVwap: 0, deskWarmup: false }), legTakeProfit: TP }
  const tape: MM.Swap[] = []; const viol: Viol[] = []; const st = { defenses: 0, captures: 0, deskFills: 0, accum: 0, stops: 0, minChest: chest.v, spent: 0, got: 0, deskSol: 0 }
  let desk: { sol: number; px: number } | null = null; let stoppedWas = false; let shift = 1
  const own = <T>(fn: () => T): T => { const pb = pool.price; const r = fn(); shift *= Math.pow(pool.price / pb, IMPACT); return r }
  const nav = () => chest.v + s.tokens * pool.price; const nav0 = nav(); const tok0 = s.tokens
  const holdVal = (p: number) => CHEST + tok0 * p // "hold" = never trade
  let t = t0
  for (let i = 1; i < candles.length; i++) {
    const [ts, o, h, l, c, volUsd] = candles[i]; const open = o / solUsd, close = c / solUsd
    const S = pool.B; const net = S * (Math.sqrt(Math.max(close * shift, 1e-12) / Math.max(pool.price, 1e-12)) - 1)  // drive the pool toward the real close
    const gross = Math.max(Math.abs(net), (volUsd || 0) / solUsd)
    let buys = Math.max(0, (gross + net) / 2), sells = Math.max(0, (gross - net) / 2)
    const n = 12; const tickT = Math.max(TICK, Math.floor(60000 / n))
    for (let k = 0; k < n; k++) {
      t += tickT
      // trades this tick: alternate sides, front-load the bigger side so the candle's extreme prints early
      const b = buys / n * (1 + (rng() - 0.5) * 0.6), sl = sells / n * (1 + (rng() - 0.5) * 0.6)
      if (b > 0.0005) { pool.buy(b, chest); tape.push({ t, side: 'buy', sol: b, trader: 'org' + Math.floor(rng() * 300) }); // capture decision on each buy
        s.chest = chest.v; const tok = MM.capture(s, mkt(pool, tape, t, supply, solUsd), pool.price, b, t, P); if (tok > 0) { if (tok > Math.max(s.tokens * 0.05, Math.max(0, s.mmTok || 0)) + 1e-9) viol.push({ t, what: 'capture > 5% of vault tokens (beyond the mm leg)' }); const got = own(() => pool.sell(tok, chest)); s.tokens -= tok; chest.v += got; MM.onCaptured(s, tok, t, got); st.captures++; st.got += got } }
      if (sl > 0.0005) { pool.sell(sl / pool.price, chest); tape.push({ t, side: 'sell', sol: sl, trader: 'org' + Math.floor(rng() * 300) }) }
      // desk: a fraction of sell flow hits the vault's resting bid off-chart (−4%) when there is one
      if (desk && sl > 0.2 && rng() < 0.3) { const sol = Math.min(desk.sol, sl); const tok = sol / desk.px; chest.v -= sol; s.tokens += tok; s.chest = chest.v; MM.onDeskFill(s, sol, tok, pool.price, t, 'org'); desk = null; st.deskFills++; st.deskSol += sol; st.spent += sol }
      // ---- the vault's tick (same order as vault.ts tickOne)
      s.chest = chest.v; const px = pool.price; const m = mkt(pool, tape, t, supply, solUsd)
      const { dd } = MM.observe(s, px, t, P)
      const stopped = MM.stopped(s, px, t, P); if (stopped && !stoppedWas) st.stops++; stoppedWas = stopped
      const dec = MM.defense(s, m, px, t, dd, MM.sellerShare(tape.filter((x) => t - x.t < 600_000), t, P), P)
      if (dec) {
        if (t - t0 < P.warmupMs) viol.push({ t, what: 'defense buy during warmup' }); if (stopped) viol.push({ t, what: 'defense buy while stopped' })
        if (dec.spend > chest.v - 0.02 + 1e-9) viol.push({ t, what: 'defense spend > chest' }); if (dec.spend > m.liqSol * P.poolImpactMax + 1e-9) viol.push({ t, what: 'defense spend > pool impact cap' })
        const chestPre = chest.v; const dayRoomPre = Math.max(s.dayChest0 || 0, chestPre) * P.defenseDayFrac - (s.dayDefense || 0)
        if (dec.spend > dayRoomPre + 1e-6) viol.push({ t, what: 'day spend > 50% of chest' })
        const got = own(() => pool.buy(dec.spend, chest)); chest.v -= dec.spend; s.tokens += got; s.chest = chest.v; MM.onDefended(s, dec.spend, got, dec.level, t, P); st.defenses++; st.spent += dec.spend
        if (s.spentEpisode > chestPre * P.defenseEpisodeFrac * 1.5 + 1e-6) viol.push({ t, what: 'episode spend > 40% of chest (skew-adjusted ×1.5)' })
      } else { const a = MM.accumulate(s, m, px, t, P); if (a) { if (t - t0 < P.warmupMs) viol.push({ t, what: 'accumulate during warmup' }); const got = own(() => pool.buy(a, chest)); chest.v -= a; s.tokens += got; s.chest = chest.v; MM.onAccumulated(s, a, got, t); st.accum++; st.spent += a } }
      const want = MM.deskBid(s, Math.max(0.2, m.liqSol * 0.02), t, P, Math.random(), px, m.liqSol); if (want > chest.v * 0.7 + 1e-9) viol.push({ t, what: 'desk bid > 70% of chest' }); desk = want > 0 ? { sol: want, px: px * 0.96 } : null
      if (chest.v < 0.02 - 1e-9) viol.push({ t, what: 'chest below 0.02 reserve' })
      s.ddPrev = dd; st.minChest = Math.min(st.minChest, chest.v)
    }
    while (tape.length > 3000) tape.shift()
  }
  const pxEnd = pool.price; const realEnd = candles[candles.length - 1][4] / solUsd
  const taxIn = pool.taxIn; const capital = CHEST + taxIn
  return { name: d.name, dex: d.dex, hours: +((candles.length) / 60).toFixed(1), poolSol: +S0.toFixed(1), real: realEnd / p0, sim: pxEnd / p0, nav0, nav: nav(), hold: holdVal(pxEnd), chest: chest.v, taxIn, kept: chest.v / capital, mmPct: MM.mmPnl(s, pxEnd) / capital * 100, legPct: s.mmSpent ? MM.mmPnl(s, pxEnd) / s.mmSpent * 100 : NaN, legSpent: s.mmSpent || 0, invGot: s.invGot || 0, tokPct: s.tokens / supply * 100, mmPnl: MM.mmPnl(s, pxEnd), ...st, viol }
}
function mkt(pool: Pool, tape: MM.Swap[], t: number, supply: number, solUsd: number): MM.Market { let v = 0; for (let i = tape.length - 1; i >= 0 && t - tape[i].t < 3600_000; i--) v += tape[i].sol; return { priceSol: pool.price, mcapUsd: pool.price * supply * solUsd, liqSol: pool.B, vol1h: v * solUsd } }

const files = readdirSync(DIR).filter((f) => f.endsWith('.json') && !f.startsWith('report') && (!ONLY || f.includes(ONLY)))
const rows: any[] = []; for (const f of files) { try { const r = replay(DIR + '/' + f); if (r) rows.push(r) } catch (e: any) { console.error('skip', f, e.message) } }
const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—')
const beats = rows.filter((r) => r.nav > r.hold).length, viols = rows.reduce((a, r) => a + r.viol.length, 0)
const pnl = rows.map((r) => r.mmPct).sort((a, b) => a - b); const med = pnl[Math.floor(pnl.length / 2)] || 0; const kept = rows.map((r) => r.kept).sort((a, b) => a - b)
const leg = rows.map((r) => r.legPct).filter(Number.isFinite).sort((a, b) => a - b); const legSol = rows.reduce((a, r) => a + r.mmPnl, 0); const inv = rows.reduce((a, r) => a + r.invGot, 0); const spent = rows.reduce((a, r) => a + r.legSpent, 0)
console.log(`# mm replay · ${rows.length} real coins · vault ${PCT}% supply + ${CHEST} SOL chest · tax ${TAX * 100}% · buys ${BUYS ? 'on' : 'off'} · desk vwap gate ${DESKVWAP ? 'on' : 'off'} · leg take-profit ${TP > 0 ? TP * 100 + '%' : 'off'} · own impact persists ${IMPACT * 100}% · seed ${SEED}`)
console.log(`invariant violations: **${viols}** · vault NAV beats hold on ${beats}/${rows.length} · mm-leg P&L (% of capital = chest + tax received) median ${f(med, 1)}%, worst ${f(pnl[0], 1)}%, best ${f(pnl[pnl.length - 1], 1)}% · chest kept (end ÷ capital) median ${f(kept[Math.floor(kept.length / 2)] * 100, 0)}%, worst ${f(kept[0] * 100, 0)}% · chest ended ≥ start on ${rows.filter((r) => r.chest >= CHEST).length}/${rows.length} · stops fired on ${rows.filter((r) => r.stops).length}`)
console.log(`mm leg (SOL it deployed on dips / desk / accumulation, marked at the end price): deployed ${f(spent, 1)} SOL across all coins → ${f(legSol, 1)} SOL P&L (${f(spent ? legSol / spent * 100 : 0, 1)}%) · per coin median ${f(leg[Math.floor(leg.length / 2)] ?? NaN, 1)}%, worst ${f(leg[0] ?? NaN, 1)}%, best ${f(leg[leg.length - 1] ?? NaN, 1)}% · inventory sold into pumps: ${f(inv, 1)} SOL`)
console.log('| coin | venue | pool SOL | h | real | sim | tax in | chest end | kept | mm P&L % | leg spent | leg % | inv sold | dips | accum | captures | desk | stops | worst chest | violations |')
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
for (const r of rows.sort((a, b) => a.mmPct - b.mmPct)) console.log(`| ${r.name} | ${r.dex} | ${r.poolSol} | ${r.hours} | ${f(r.real)}x | ${f(r.sim)}x | ${f(r.taxIn)} | ${f(r.chest)} | ${f(r.kept * 100, 0)}% | ${f(r.mmPct, 1)}% | ${f(r.legSpent)} | ${f(r.legPct, 0)}% | ${f(r.invGot)} | ${r.defenses} | ${r.accum} | ${r.captures} | ${r.deskFills} | ${r.stops} | ${f(r.minChest)} | ${r.viol.length ? [...new Set(r.viol.map((v: Viol) => v.what))].join('; ') : ''} |`)
