// Pull real order flow for N Solana memecoin pools (pump.fun curve + PumpSwap + Raydium Launchlab) from GeckoTerminal and
// replay every one of them through the vault rules. Runs in CI (.github/workflows/backtest-real.yml) or locally:
//   node --experimental-strip-types scripts/scrape.mjs --n 80 --out data/real
// Output: data/real/<pool>.json (ohlcv + trades, raw), data/real/report.json + report.md (none vs floor vs mm per coin + aggregate).
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { compare } from '../src/lib/sim.ts'

const args = process.argv.slice(2); const flag = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d }
const N = +flag('n', 80), OUT = flag('out', 'data/real'), REPLAY_ONLY = args.includes('--replay-only')
const G = 'https://api.geckoterminal.com/api/v2'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let calls = 0
async function gj(p, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(G + p, { headers: { accept: 'application/json' } }); calls++
    if (r.status === 429) { const w = 15000 * (i + 1); console.error(`429 on ${p} — waiting ${w / 1000}s`); await sleep(w); continue }
    if (!r.ok) throw new Error('gecko ' + r.status + ' ' + p)
    await sleep(2200) // ~27/min, under the keyless ceiling
    return (await r.json()).data
  }
  throw new Error('rate limited: ' + p)
}

mkdirSync(OUT, { recursive: true })
if (!REPLAY_ONLY) {
  const px = await gj('/simple/networks/solana/token_price/So11111111111111111111111111111111111111112'); const solUsd = +Object.values(px.attributes.token_prices)[0]
  // candidate pools: most active on each memecoin venue, several pages each
  const pools = []
  for (const dex of ['pump-fun', 'pumpswap', 'raydium-launchlab']) for (let page = 1; page <= Math.min(5, Math.ceil(N / 25)); page++) {
    try { const d = await gj(`/networks/solana/dexes/${dex}/pools?page=${page}&sort=h24_volume_usd_desc`); for (const p of d) pools.push({ dex, address: p.attributes.address, name: p.attributes.name, mint: p.relationships.base_token.data.id.replace('solana_', ''), reserveUsd: +p.attributes.reserve_in_usd, vol24: +p.attributes.volume_usd.h24, fdv: +p.attributes.fdv_usd || 0, created: p.attributes.pool_created_at }) } catch (e) { console.error(e.message) }
  }
  // dedupe, drop dust and giants: we want memecoins where a 15–30 SOL chest is meaningful (pool reserve 20–3000 SOL)
  const seen = new Set(); const pick = pools.filter((p) => { if (seen.has(p.address)) return false; seen.add(p.address); const sol = p.reserveUsd / 2 / solUsd; return sol >= 15 && sol <= 5000 && p.vol24 > 5000 }).sort((a, b) => b.vol24 - a.vol24).slice(0, N)
  console.error(`${pools.length} candidates → ${pick.length} picked · SOL $${solUsd}`)
  for (const [i, p] of pick.entries()) {
    const f = `${OUT}/${p.address}.json`; if (existsSync(f)) continue
    try {
      const [ohlcv, trades] = [await gj(`/networks/solana/pools/${p.address}/ohlcv/minute?aggregate=1&limit=1000&currency=usd`), await gj(`/networks/solana/pools/${p.address}/trades`)]
      writeFileSync(f, JSON.stringify({ ...p, solUsd, fetchedAt: Date.now(), ohlcv: ohlcv.attributes.ohlcv_list, trades: trades.map((x) => x.attributes) }))
      console.error(`${i + 1}/${pick.length} ${p.name} · ${ohlcv.attributes.ohlcv_list.length} candles · ${trades.length} trades · calls ${calls}`)
    } catch (e) { console.error(`skip ${p.name}: ${e.message}`) }
  }
}

// ---- replay: trades give exact flow for the last ≤300 swaps; candles give hours of flow (volume split by candle direction) ----
/** Flow that reproduces the candle path on a constant-product pool. Price ∝ S²/k, so the net SOL that moves a candle from open to close is
 *  ΔS = S·(√(c/o) − 1). Gross volume comes from the candle; buys = (vol+ΔS)/2, sells = (vol−ΔS)/2, each split into ≈0.5 SOL swaps spread over the minute.
 *  Replaying this through the sim with no vault reproduces the real chart (final ≈ last/first). Returns flow + pool SOL at the window start. */
function flowFromCandles(ohlcv, solUsd, poolSolNow) {
  const rows = [...ohlcv].sort((a, b) => a[0] - b[0]).filter((r) => r[1] > 0 && r[4] > 0)
  if (rows.length < 10) return { flow: [], poolSol0: poolSolNow }
  const first = rows[0][1], last = rows[rows.length - 1][4]
  const poolSol0 = poolSolNow / Math.sqrt(last / first) // walk the reserve back to the start of the window
  let S = poolSol0; const out = []
  for (const [ts, o, h, l, c, v] of rows) {
    const vol = (v || 0) / solUsd; const net = S * (Math.sqrt(c / o) - 1)
    const buys = Math.max(0, (vol + net) / 2), sells = Math.max(0, (vol - net) / 2)
    // the candle's own volume may not carry the move (thin candles): top up the dominant side so the path is reproduced
    const chunk = Math.max(0.05, Math.min(0.5, S / 400)); const t0 = ts * 1000
    const push = (side, amt) => { const n = Math.max(1, Math.round(amt / chunk)); for (let k = 0; k < n; k++) out.push({ t: t0 + ((k + 0.5) * 60000) / n, side, sol: amt / n }) }
    if (buys > 0) push('buy', Math.max(buys, net > 0 ? net : 0)); if (sells > 0) push('sell', Math.max(sells, net < 0 ? -net : 0))
    S += net
  }
  out.sort((a, b) => a.t - b.t)
  return { flow: out, poolSol0 }
}
const files = readdirSync(OUT).filter((f) => f.endsWith('.json') && !f.startsWith('report'))
const rows = []
for (const f of files) {
  const d = JSON.parse(readFileSync(`${OUT}/${f}`, 'utf8')); const poolSolNow = d.reserveUsd / 2 / d.solUsd
  const { flow, poolSol0: poolSol } = flowFromCandles(d.ohlcv, d.solUsd, poolSolNow); if (flow.length < 50 || !(poolSol > 5)) continue
  const base = { poolSol, chestPct: 0.3, ceiling: 0.3, hours: 0, seed: 7, swapFee: 0, deskUse: 0.5, pumpStrength: 1, v2: true, skew: true, zstretch: true, flow } // fees are already inside the real candles
  const r = compare(base); const hours = (flow[flow.length - 1].t - flow[0].t) / 3.6e6
  const real = +(d.ohlcv.slice().sort((a, b) => a[0] - b[0]).filter((r) => r[1] > 0 && r[4] > 0).at(-1)[4] / d.ohlcv.slice().sort((a, b) => a[0] - b[0]).filter((r) => r[1] > 0)[0][1]).toFixed(3)
  rows.push({ name: d.name, dex: d.dex, pool: d.address, realFinal: real, poolSol: +poolSol.toFixed(1), hours: +hours.toFixed(1), swaps: flow.length, volSol: +flow.reduce((a, x) => a + x.sol, 0).toFixed(0), none: pick(r.none), floor: pick(r.floor), mm: pick(r.mm) })
}
function pick(r) { return { final: +r.final.toFixed(3), peak: +r.peak.toFixed(3), maxDD: +r.maxDrawdown.toFixed(3), vaultStart: +r.vaultStart.toFixed(2), vaultEnd: +r.vaultValue.toFixed(2), captured: +r.captured.toFixed(2), desk: +r.deskBought.toFixed(2), dips: +r.dipBought.toFixed(2), txs: r.txs } }
const avg = (k, m) => rows.length ? rows.reduce((a, x) => a + x[m][k], 0) / rows.length : 0
const med = (k, m) => { const v = rows.map((x) => x[m][k]).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : 0 }
const better = (k, m, lower = false) => rows.filter((x) => lower ? x[m][k] < x.none[k] : x[m][k] > x.none[k]).length
const agg = {}
for (const m of ['none', 'floor', 'mm']) agg[m] = { finalAvg: +avg('final', m).toFixed(3), finalMed: +med('final', m).toFixed(3), peakAvg: +avg('peak', m).toFixed(3), maxDDAvg: +avg('maxDD', m).toFixed(3), vaultPnl: +(avg('vaultEnd', m) - avg('vaultStart', m)).toFixed(2), finalBeatsNone: better('final', m), ddBeatsNone: better('maxDD', m, true) }
const report = { generatedAt: new Date().toISOString(), coins: rows.length, agg, rows: rows.sort((a, b) => b.volSol - a.volSol) }
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 1))
const md = [`# Real-flow backtest · ${rows.length} coins · ${report.generatedAt.slice(0, 16)}Z`, '', 'Flow rebuilt from 1-min candles so a constant-product pool reproduces each candle (net SOL = S·(√(close/open)−1), gross = candle volume), replayed through the vault rules with a 30% chest. real = actual last/first price; none final should track it (replay sanity check). Caveat: the chest is new SOL entering the coin, so part of the mm/floor uplift is simply capital; the drawdown and desk/dip numbers are the cleaner signal. Coins are the most active of the day (survivorship bias) — the daily run accumulates a broader set over time.', '',
  '| mode | final (avg) | final (median) | peak | max drawdown | vault P&L (SOL) | final beats no-vault | drawdown beats no-vault |', '|---|---|---|---|---|---|---|---|',
  ...['none', 'floor', 'mm'].map((m) => `| ${m} | ${agg[m].finalAvg}x | ${agg[m].finalMed}x | ${agg[m].peakAvg}x | ${(agg[m].maxDDAvg * 100).toFixed(0)}% | ${agg[m].vaultPnl} | ${m === 'none' ? '—' : agg[m].finalBeatsNone + '/' + rows.length} | ${m === 'none' ? '—' : agg[m].ddBeatsNone + '/' + rows.length} |`),
  '', '| coin | venue | pool SOL | hours | vol SOL | real | none final | mm final | none DD | mm DD | mm vault | captured | desk | dips |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map((x) => `| ${x.name.replace(/\|/g, '/')} | ${x.dex} | ${x.poolSol} | ${x.hours} | ${x.volSol} | ${x.realFinal}x | ${x.none.final}x | ${x.mm.final}x | ${(x.none.maxDD * 100).toFixed(0)}% | ${(x.mm.maxDD * 100).toFixed(0)}% | ${x.mm.vaultStart}→${x.mm.vaultEnd} | ${x.mm.captured} | ${x.mm.desk} | ${x.mm.dips} |`)].join('\n')
writeFileSync(`${OUT}/report.md`, md)
console.log(md.split('\n').slice(0, 9).join('\n'))
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, md, { flag: 'a' })
