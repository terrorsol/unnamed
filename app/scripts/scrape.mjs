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
  for (const dex of ['pump-fun', 'pumpswap', 'raydium-launchlab']) for (let page = 1; page <= Math.ceil(N / 40); page++) {
    try { const d = await gj(`/networks/solana/dexes/${dex}/pools?page=${page}&sort=h24_volume_usd_desc`); for (const p of d) pools.push({ dex, address: p.attributes.address, name: p.attributes.name, mint: p.relationships.base_token.data.id.replace('solana_', ''), reserveUsd: +p.attributes.reserve_in_usd, vol24: +p.attributes.volume_usd.h24, fdv: +p.attributes.fdv_usd || 0, created: p.attributes.pool_created_at }) } catch (e) { console.error(e.message) }
  }
  // dedupe, drop dust and giants: we want memecoins where a 15–30 SOL chest is meaningful (pool reserve 20–3000 SOL)
  const seen = new Set(); const pick = pools.filter((p) => { if (seen.has(p.address)) return false; seen.add(p.address); const sol = p.reserveUsd / 2 / solUsd; return sol >= 20 && sol <= 3000 && p.vol24 > 20000 }).sort((a, b) => b.vol24 - a.vol24).slice(0, N)
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
function flowFromCandles(ohlcv, solUsd) {
  // newest first → oldest first. per minute: volume usd split into buys/sells by where the close sits in the candle range
  const rows = [...ohlcv].sort((a, b) => a[0] - b[0]); const out = []
  for (const [ts, o, h, l, c, v] of rows) {
    if (!v) continue; const sol = v / solUsd; const range = h - l; const buyShare = range > 0 ? Math.min(0.9, Math.max(0.1, (c - l) / range)) : 0.5
    const n = Math.max(1, Math.min(12, Math.round(sol / 0.5))) // break the minute into chunks of ≈0.5 SOL
    for (let k = 0; k < n; k++) out.push({ t: ts * 1000 + (k * 60000) / n, side: (k / n) < buyShare ? 'buy' : 'sell', sol: sol / n })
  }
  return out
}
const files = readdirSync(OUT).filter((f) => f.endsWith('.json') && !f.startsWith('report'))
const rows = []
for (const f of files) {
  const d = JSON.parse(readFileSync(`${OUT}/${f}`, 'utf8')); const poolSol = d.reserveUsd / 2 / d.solUsd
  const flow = flowFromCandles(d.ohlcv, d.solUsd); if (flow.length < 50) continue
  const base = { poolSol, chestPct: 0.3, ceiling: 0.3, hours: 0, seed: 7, swapFee: 0.01, deskUse: 0.5, pumpStrength: 1, v2: true, skew: true, zstretch: true, flow }
  const r = compare(base); const hours = (flow[flow.length - 1].t - flow[0].t) / 3.6e6
  rows.push({ name: d.name, dex: d.dex, pool: d.address, poolSol: +poolSol.toFixed(1), hours: +hours.toFixed(1), swaps: flow.length, volSol: +flow.reduce((a, x) => a + x.sol, 0).toFixed(0), none: pick(r.none), floor: pick(r.floor), mm: pick(r.mm) })
}
function pick(r) { return { final: +r.final.toFixed(3), peak: +r.peak.toFixed(3), maxDD: +r.maxDrawdown.toFixed(3), vaultStart: +r.vaultStart.toFixed(2), vaultEnd: +r.vaultValue.toFixed(2), captured: +r.captured.toFixed(2), desk: +r.deskBought.toFixed(2), dips: +r.dipBought.toFixed(2), txs: r.txs } }
const avg = (k, m) => rows.length ? rows.reduce((a, x) => a + x[m][k], 0) / rows.length : 0
const med = (k, m) => { const v = rows.map((x) => x[m][k]).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : 0 }
const better = (k, m, lower = false) => rows.filter((x) => lower ? x[m][k] < x.none[k] : x[m][k] > x.none[k]).length
const agg = {}
for (const m of ['none', 'floor', 'mm']) agg[m] = { finalAvg: +avg('final', m).toFixed(3), finalMed: +med('final', m).toFixed(3), peakAvg: +avg('peak', m).toFixed(3), maxDDAvg: +avg('maxDD', m).toFixed(3), vaultPnl: +(avg('vaultEnd', m) - avg('vaultStart', m)).toFixed(2), finalBeatsNone: better('final', m), ddBeatsNone: better('maxDD', m, true) }
const report = { generatedAt: new Date().toISOString(), coins: rows.length, agg, rows: rows.sort((a, b) => b.volSol - a.volSol) }
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 1))
const md = [`# Real-flow backtest · ${rows.length} coins · ${report.generatedAt.slice(0, 16)}Z`, '', 'Flow rebuilt from 1-min candles (volume split by candle direction, ≈0.5 SOL chunks), replayed through the vault rules with a 30% chest. Same flow for all three modes.', '',
  '| mode | final (avg) | final (median) | peak | max drawdown | vault P&L (SOL) | final beats no-vault | drawdown beats no-vault |', '|---|---|---|---|---|---|---|---|',
  ...['none', 'floor', 'mm'].map((m) => `| ${m} | ${agg[m].finalAvg}x | ${agg[m].finalMed}x | ${agg[m].peakAvg}x | ${(agg[m].maxDDAvg * 100).toFixed(0)}% | ${agg[m].vaultPnl} | ${m === 'none' ? '—' : agg[m].finalBeatsNone + '/' + rows.length} | ${m === 'none' ? '—' : agg[m].ddBeatsNone + '/' + rows.length} |`),
  '', '| coin | venue | pool SOL | hours | vol SOL | none final | mm final | none DD | mm DD | mm vault | captured | desk | dips |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map((x) => `| ${x.name.replace(/\|/g, '/')} | ${x.dex} | ${x.poolSol} | ${x.hours} | ${x.volSol} | ${x.none.final}x | ${x.mm.final}x | ${(x.none.maxDD * 100).toFixed(0)}% | ${(x.mm.maxDD * 100).toFixed(0)}% | ${x.mm.vaultStart}→${x.mm.vaultEnd} | ${x.mm.captured} | ${x.mm.desk} | ${x.mm.dips} |`)].join('\n')
writeFileSync(`${OUT}/report.md`, md)
console.log(md.split('\n').slice(0, 9).join('\n'))
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, md, { flag: 'a' })
