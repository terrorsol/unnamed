// Vault market-maker simulator. Runs the real policy (src/mm.ts) against a LaunchLab-shaped pool with organic flow and adversaries.
// Usage: npm run mmsim [-- hours=24 pct=30 chest=5 seed=1]
import * as MM from '../src/mm.ts'
import * as R from '../src/rules.ts'

const arg = (k: string, d: number) => { const a = process.argv.find((x) => x.startsWith(k + '=')); return a ? +a.split('=')[1] : d }
const HOURS = arg('hours', 24), PCT = arg('pct', 30), TARGET = arg('target', PCT), CHEST = arg('chest', 5), SEED = arg('seed', 1), SOLUSD = 180
const TICK = 5000

// ---- seeded rng (the policy's own jitter uses Math.random; we pin it for reproducible runs)
function mulberry(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
let rng = mulberry(SEED); Math.random = () => rng()
const poisson = (lam: number) => { let L = Math.exp(-lam), k = 0, p = 1; do { k++; p *= rng() } while (p > L); return k - 1 }
const logn = (med: number, sig = 0.9) => med * Math.exp(sig * (Math.sqrt(-2 * Math.log(rng() + 1e-12)) * Math.cos(2 * Math.PI * rng())))

// ---- pool: LaunchLab default config (constant product, virtual reserves), fees off the SOL side: 0.25% protocol + 2% tax → chest
class Pool {
  taxIn = 0; vA = 1_073_025_605.6; vB = 30.00085; fee = 0.0025; tax = 0.02; swaps: MM.Swap[] = []; tape: { t: number; usd: number }[] = []
  get price() { return this.vB / this.vA }
  buy(sol: number, trader: string, t: number, chest: { v: number }) { const net = sol * (1 - this.fee - this.tax); const out = this.vA - (this.vA * this.vB) / (this.vB + net); this.vB += net; this.vA -= out; chest.v += sol * this.tax; this.taxIn += sol * this.tax; this.rec(t, 'buy', sol, trader); return out }
  sell(tokens: number, trader: string, t: number, chest: { v: number }) { const gross = this.vB - (this.vA * this.vB) / (this.vA + tokens); this.vA += tokens; this.vB -= gross; chest.v += gross * this.tax; this.taxIn += gross * this.tax; this.rec(t, 'sell', gross, trader); return gross * (1 - this.fee - this.tax) }
  rec(t: number, side: 'buy' | 'sell', sol: number, trader: string) { this.swaps.push({ t, side, sol, trader }); this.tape.push({ t, usd: sol * SOLUSD }); if (this.swaps.length > 4000) this.swaps.splice(0, 2000); if (this.tape.length > 4000) this.tape.splice(0, 2000) }
  market(t: number): MM.Market { const vol1h = this.tape.filter((x) => t - x.t < 3600_000).reduce((a, x) => a + x.usd, 0); return { priceSol: this.price, mcapUsd: this.price * 1e9 * SOLUSD, liqSol: this.vB, vol1h } }
  recent(t: number) { return this.swaps.filter((x) => t - x.t < 600_000) }
}

type Agent = (t: number, w: World) => void
type World = { pool: Pool; chest: { v: number }; s: MM.State; p: MM.Params; desk: { sol: number; px: number } | null; log: string[]; stats: { defenses: number; captures: number; deskFills: number; minChest: number; minNav: number; accum: number }; organicTok: number }

function vaultTick(w: World, t: number) {
  const { pool, s, p } = w; const m = pool.market(t); const px = m.priceSol
  s.chest = w.chest.v
  const { dd } = MM.observe(s, px, t, p)
  const dec = MM.defense(s, m, px, t, dd, MM.sellerShare(pool.recent(t), t, p), p)
  if (dec) { const got = pool.buy(dec.spend, 'VAULT', t, w.chest); w.chest.v -= dec.spend; s.tokens += got; s.chest = w.chest.v; MM.onDefended(s, dec.spend, got, dec.level, t, p); w.stats.defenses++ }
  else { const a = MM.accumulate(s, m, px, t, p); if (a) { const got = pool.buy(a, 'VAULT', t, w.chest); w.chest.v -= a; s.tokens += got; s.chest = w.chest.v; MM.onAccumulated(s, a, got, t); w.stats.accum++ } }
  // standing desk bid (−4%): sized by policy, refreshed every tick in the sim
  const want = MM.deskBid(s, Math.max(0.2, m.liqSol * 0.02), t, p); w.desk = want > 0 && w.chest.v * 0.7 >= want ? { sol: want, px: px * 0.96 } : null
  s.ddPrev = dd; w.stats.minChest = Math.min(w.stats.minChest, w.chest.v); w.stats.minNav = Math.min(w.stats.minNav, w.chest.v + s.tokens * px)
}
/** a buy landed: the vault may counter it (capture) */
function vaultOnBuy(w: World, sol: number, t: number) {
  const m = w.pool.market(t); const px = m.priceSol; w.s.chest = w.chest.v
  const tok = MM.capture(w.s, m, px, sol, t, w.p); if (tok <= 0) return
  const got = w.pool.sell(tok, 'VAULT', t, w.chest); w.s.tokens -= tok; w.chest.v += got; MM.onCaptured(w.s, tok, t, got); w.stats.captures++
}
/** someone sells a block into the vault's desk bid at −4% */
function deskSell(w: World, tokens: number, t: number, who = 'ATK'): number {
  if (!w.desk || MM.deskDenied(w.s, who, t)) return 0; const sol = Math.min(w.desk.sol, tokens * w.desk.px); if (sol < 0.2) return 0
  const tok = sol / w.desk.px; w.chest.v -= sol; w.s.tokens += tok; w.s.chest = w.chest.v; MM.onDeskFill(w.s, sol, tok, w.pool.price, t, who); w.desk = null; w.stats.deskFills++
  return tok
}

// ---- agents
const organic = (bias = 0, base = 0.1, dieAfterMin = Infinity): Agent => { let sent = bias; return (t, w) => {
  if (t / 60000 > dieAfterMin) base = Math.max(0.005, base * 0.9995)
  sent = Math.max(-1, Math.min(1, bias + (sent - bias) * 0.99 + (rng() - 0.5) * 0.1))
  for (let i = poisson(base * (1 + sent) / 2); i > 0; i--) { const sol = Math.min(logn(0.3), 8); w.pool.buy(sol, 'org' + Math.floor(rng() * 500), t, w.chest); vaultOnBuy(w, sol, t) }
  for (let i = poisson(base * (1 - sent) / 2); i > 0; i--) { const tokWant = Math.min(logn(0.3), 8) / w.pool.price; const tok = Math.min(tokWant, w.organicTok * 0.25); if (tok > 0) { w.organicTok -= tok; w.pool.sell(tok, 'org' + Math.floor(rng() * 500), t, w.chest) } }
} }
// track organic inventory: organic buys add tokens (patched in by wrapping pool.buy below)
const whale = (pumpSol: number, atMin: number): Agent => { let tok = 0, phase = 0; return (t, w) => {
  const min = t / 60000
  if (phase === 0 && min >= atMin) { phase = 1 }
  if (phase === 1 && min < atMin + 5) { const sol = pumpSol / 60; tok += w.pool.buy(sol, 'whale', t, w.chest); vaultOnBuy(w, sol, t) }
  if (phase === 1 && min >= atMin + 5) phase = 2
  if (phase === 2 && min < atMin + 10 && tok > 0) { const part = tok / 60; tok -= part; w.pool.sell(part, 'whale', t, w.chest) }
} }
/** dump cycler: holds a bag, dumps through the tranche levels, waits for the window to roll, buys back, repeats. The classic MM bleed. */
const dumpCycler = (bagPct: number, waitMin: number) => { const A = { sol: 0, tok: 0, spent: 0, tok0: 0 }; let phase: 'buy' | 'dump' | 'wait' | 'rebuy' = 'buy'; let high = 0, since = 0, lvl = 0, rebuyTarget = 0
  const agent: Agent = (t, w) => {
    const px = w.pool.price
    if (phase === 'buy') { const want = (bagPct / 100) * 1e9; let sol = 0, lo = 0, hi = 60; for (let i = 0; i < 30; i++) { sol = (lo + hi) / 2; const net = sol * 0.9775; const out = w.pool.vA - (w.pool.vA * w.pool.vB) / (w.pool.vB + net); if (out > want) hi = sol; else lo = sol } A.tok += w.pool.buy(sol, 'ATK', t, w.chest); A.tok0 = A.tok; A.spent += sol; A.sol -= sol; vaultOnBuy(w, sol, t); phase = 'wait'; since = t; return }
    if (phase === 'wait') { if (t - since > waitMin * 60000) { phase = 'dump'; high = px; lvl = 0; since = t } return }
    if (phase === 'dump') {
      const target = [-0.21, -0.36, -0.51][lvl]; if (target == null) { phase = 'rebuy'; since = t; rebuyTarget = A.tok; return }
      // first try the desk bid (sells a block at −4% off-chart, no impact), then the pool
      if (w.desk && A.tok > 0) { const dpx = w.desk.px; const tok = deskSell(w, A.tok, t); A.tok -= tok; A.sol += tok * dpx }
      if (px / high - 1 > target && A.tok > 0) { const step = Math.min(A.tok, (0.02 * w.pool.vA)); A.tok -= step; A.sol += w.pool.sell(step, 'ATK', t, w.chest) }
      else if (t - since > 15000) { lvl++; since = t }
      return
    }
    if (phase === 'rebuy') { if (t - since < 20000) return; const sol = Math.min(A.sol * 0.95, 2); if (sol > 0.05 && A.tok < rebuyTarget) { A.tok += w.pool.buy(sol, 'ATK', t, w.chest); A.sol -= sol; vaultOnBuy(w, sol, t) } else { phase = 'wait'; since = t } }
  }
  return { agent, pnl: (w: World) => A.sol + A.tok * w.pool.price * 0.9775 - (A.tok0 * w.pool.price * 0.9775 - A.spent), A }
}
/** capture farmer: wash-buys just over the MM threshold to make the vault sell, then dumps */
const captureFarmer = (hours: number) => { const A = { sol: 0, tok: 0 }; const agent: Agent = (t, w) => { const min = t / 60000; if (min < hours * 60 && t % 10000 === 0) { const sol = 0.6; A.tok += w.pool.buy(sol, 'ATK', t, w.chest); A.sol -= sol; vaultOnBuy(w, sol, t) } else if (min >= hours * 60 && A.tok > 0) { const step = Math.min(A.tok, 0.02 * w.pool.vA); A.tok -= step; A.sol += w.pool.sell(step, 'ATK', t, w.chest) } }
  return { agent, pnl: (w: World) => A.sol + A.tok * w.pool.price * 0.9775, A } }
/** pump cycler: pumps hard for 10 min, dumps to −50% from the top, waits, repeats every hour */
const pumpCycler = (pumpSol: number) => { const A = { sol: 0, tok: 0 }; let phase: 'pump' | 'dump' | 'rest' = 'pump'; let since = 0, top = 0; const agent: Agent = (t, w) => {
  const px = w.pool.price
  if (phase === 'pump') { const sol = pumpSol / 120; A.tok += w.pool.buy(sol, 'ATK', t, w.chest); A.sol -= sol; vaultOnBuy(w, sol, t); top = Math.max(top, w.pool.price); if (t - since > 600_000) { phase = 'dump'; since = t } return }
  if (phase === 'dump') { if (w.desk && A.tok > 0) { const dpx = w.desk.px; const tok = deskSell(w, A.tok, t); A.tok -= tok; A.sol += tok * dpx } if (px > top * 0.5 && A.tok > 0) { const step = Math.min(A.tok, 0.02 * w.pool.vA); A.tok -= step; A.sol += w.pool.sell(step, 'ATK', t, w.chest) } else { phase = 'rest'; since = t } return }
  if (phase === 'rest' && t - since > 2400_000) { phase = 'pump'; since = t; top = 0 }
}; return { agent, pnl: (w: World) => A.sol + A.tok * w.pool.price * 0.9775, A } }
/** desk dumper: fills the vault's desk bid with a block, then dumps the rest on the chart, repeats whenever the bid is back */
const deskDumper = (bagPct: number) => { const A = { sol: 0, tok: 0, spent: 0, tok0: 0 }; let bought = false, last = 0; const agent: Agent = (t, w) => {
  if (!bought) { const want = (bagPct / 100) * 1e9; let sol = 0, lo = 0, hi = 60; for (let i = 0; i < 30; i++) { sol = (lo + hi) / 2; const net = sol * 0.9775; const out = w.pool.vA - (w.pool.vA * w.pool.vB) / (w.pool.vB + net); if (out > want) hi = sol; else lo = sol } A.tok += w.pool.buy(sol, 'ATK', t, w.chest); A.tok0 = A.tok; A.sol -= sol; A.spent = sol; vaultOnBuy(w, sol, t); bought = true; return }
  if (w.desk && A.tok > 0 && t - last > 30000) { const px = w.desk.px; const tok = deskSell(w, A.tok, t); if (tok > 0) { A.tok -= tok; A.sol += tok * px; last = t; const dump = Math.min(A.tok, 0.05 * w.pool.vA); A.tok -= dump; A.sol += w.pool.sell(dump, 'ATK', t, w.chest) } }
  else if (A.tok < (bagPct / 200) * 1e9 && A.sol > 1 && t - last > 120000) { const sol = Math.min(A.sol * 0.5, 3); A.tok += w.pool.buy(sol, 'ATK', t, w.chest); A.sol -= sol; vaultOnBuy(w, sol, t) }
} ; return { agent, pnl: (w: World) => A.sol + A.tok * w.pool.price * 0.9775 - (A.tok0 * w.pool.price * 0.9775 - A.spent), A } }

/** bleeder: buys a bag at launch and sells it evenly over N hours, never buys back — the coin goes to ~zero and stays there */
const bleeder = (bagPct: number, hours: number) => { const A = { tok: 0, sol: 0, tok0: 0 }; let bought = false; const agent: Agent = (t, w) => {
  if (!bought) { const want = (bagPct / 100) * 1e9; let sol = 0, lo = 0, hi = 100; for (let i = 0; i < 30; i++) { sol = (lo + hi) / 2; const net = sol * 0.9775; const out = w.pool.vA - (w.pool.vA * w.pool.vB) / (w.pool.vB + net); if (out > want) hi = sol; else lo = sol } A.tok += w.pool.buy(sol, 'BLEED', t, w.chest); A.tok0 = A.tok; A.sol -= sol; vaultOnBuy(w, sol, t); bought = true; return }
  const per = A.tok0 / (hours * 3600_000 / TICK); if (A.tok > 0 && t % (TICK * 6) === 0) { const step = Math.min(A.tok, per * 6); A.tok -= step; A.sol += w.pool.sell(step, 'BLEED', t, w.chest) }
}; return { agent, pnl: (w: World) => A.sol + A.tok * w.pool.price * 0.9775, A } }

function run(name: string, p: MM.Params, agents: Agent[], pnl?: (w: World) => number) {
  rng = mulberry(SEED); Math.random = () => rng()
  const pool = new Pool(); const chest = { v: 0 }
  // block zero: dev 0.5 SOL, vault buys PCT% of supply, then the chest
  pool.buy(0.5, 'dev', 0, chest)
  const want = (PCT / 100) * 1e9; let lo = 0, hi = 200, vsol = 0; if (PCT > 0) for (let i = 0; i < 40; i++) { vsol = (lo + hi) / 2; const net = vsol * 0.9775; const out = pool.vA - (pool.vA * pool.vB) / (pool.vB + net); if (out > want) hi = vsol; else lo = vsol }
  const tok = PCT > 0 ? pool.buy(vsol, 'VAULT', 0, chest) : 0; chest.v += CHEST
  const s: MM.State = { chest: chest.v, tokens: tok, supply: 1e9, pct: TARGET, avgCost: tok ? vsol / tok : 0, mode: 'mm', ceiling: 0.3, samples: [], high15: [], ema5: null, ema15: null, spentEpisode: 0, tranchesFired: [], lastBuy: 0, trimmedToday: 0, trimDay: 0, buyTimes: [], lastCapture: 0 }
  const w: World = { pool, chest, s, p, desk: null, log: [], stats: { defenses: 0, captures: 0, deskFills: 0, minChest: chest.v, minNav: Infinity, accum: 0 }, organicTok: 0 }
  // organic inventory: every non-vault, non-attacker buy adds to the organic bag
  const ob = pool.buy.bind(pool); pool.buy = (sol, trader, t, c) => { const out = ob(sol, trader, t, c); if (trader.startsWith('org')) w.organicTok += out; return out }
  const nav0 = chest.v + tok * pool.price, floor0 = chest.v / 1e9, px0 = pool.price, chest0 = chest.v; pool.taxIn = 0
  for (let t = TICK; t <= HOURS * 3600_000; t += TICK) { for (const a of agents) a(t, w); vaultTick(w, t) }
  const px = pool.price; const nav = chest.v + s.tokens * px; const mmPnl = chest.v - pool.taxIn - chest0 + (s.tokens - tok) * px
  return { name, mmPnl, chest: chest.v, taxIn: pool.taxIn, tokens: s.tokens / 1e7, nav, navPct: (nav / nav0 - 1) * 100, floorPct: (chest.v / 1e9 / floor0 - 1) * 100, pxPct: (px / px0 - 1) * 100, drain: (1 - w.stats.minChest / chest0) * 100, navDd: (1 - w.stats.minNav / nav0) * 100, ...w.stats, atk: pnl ? pnl(w) : NaN, vsol }
}

const NEW = MM.P
const NONE: MM.Params = { ...MM.P, captureOn: false, defenseEpisodeFrac: 0, deskBidFrac: 0 }
const NOSTOP: MM.Params = { ...MM.P, maxDrawdown: 0 }
const OLD: MM.Params = { ...MM.P, defendBelowVwap: 100, episodeAnchor: false, defenseDayFrac: 100, episodeCooldownMs: 0, poolImpactMax: 100, toxicSellerShare: 2, deskBidFrac: 0.6, deskToxicDrop: 2 }
const scenarios: [string, () => { agents: Agent[]; pnl?: (w: World) => number }][] = [
  ['calm organic', () => ({ agents: [organic(0)] })],
  ['volume dies after 2h', () => ({ agents: [organic(0, 0.1, 120)] })],
  ['grind down 24h', () => ({ agents: [organic(-0.5)] })],
  ['pump 20 SOL then dump', () => ({ agents: [organic(0), whale(20, 60)] })],
  ['dump cycler 8% bag, 16-min cycles', () => { const a = dumpCycler(8, 16); return { agents: [organic(0), a.agent], pnl: a.pnl } }],
  ['capture farmer 1h wash', () => { const a = captureFarmer(1); return { agents: [organic(0), a.agent], pnl: a.pnl } }],
  ['pump cycler 30 SOL hourly', () => { const a = pumpCycler(30); return { agents: [organic(0), a.agent], pnl: a.pnl } }],
  ['desk dumper 10% bag', () => { const a = deskDumper(10); return { agents: [organic(0), a.agent], pnl: a.pnl } }],
  ['death spiral: 30% bag sold over 6h, volume fades', () => { const a = bleeder(30, 6); return { agents: [organic(-0.3, 0.1, 60), a.agent], pnl: a.pnl } }],
  ['round trip to launch price: 30% bag + 40 SOL pump, all sold over 6h, no buyers', () => { const a = bleeder(30, 6); return { agents: [organic(-0.8, 0.03, 30), whale(40, 20), a.agent], pnl: a.pnl } }],
  ['slow bleed: 30% bag sold over 48h', () => { const a = bleeder(30, 48); return { agents: [organic(-0.3, 0.06), a.agent], pnl: a.pnl } }],
]
const rows: any[] = []
const ONLY = (process.argv.find((x) => x.startsWith('only=')) || '').slice(5)
for (const [name, mk] of scenarios.filter(([n]) => !ONLY || n.includes(ONLY))) for (const [pn, p] of [['no vault', NONE], ['old', OLD], ['new·nostop', NOSTOP], ['new', NEW]] as const) { const sc = mk(); rows.push({ policy: pn, ...run(name, p, sc.agents, sc.pnl) }) }
const f = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '—')
console.log(`# mm sim · ${HOURS}h · vault ${PCT}% supply (${f(rows[0].vsol, 1)} SOL) + ${CHEST} SOL chest · seed ${SEED}`)
console.log('| scenario | policy | chest | tax in | mm own P&L | worst chest | worst NAV | tokens | price | NAV | defenses | accum | captures | desk fills | attacker edge vs hold |')
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
for (const r of rows) console.log(`| ${r.name} | ${r.policy} | ${f(r.chest, 2)} | ${f(r.taxIn, 2)} | ${f(r.mmPnl, 2)} | ${f(-r.drain, 0)}% | ${f(-Math.max(0, r.navDd), 0)}% | ${f(r.tokens, 1)}% | ${f(r.pxPct, 0)}% | ${f(r.navPct, 0)}% | ${r.defenses} | ${r.accum} | ${r.captures} | ${r.deskFills} | ${f(r.atk, 2)} |`)
