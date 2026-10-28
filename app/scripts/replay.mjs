// Live backtest: replay REAL order flow through the vault rules.
//   npm run replay -- gecko:<poolAddress>          last ~300 swaps of any Solana pool (GeckoTerminal, no key)
//   npm run replay -- path/to/tape.jsonl           a server-recorded tape (DATA_DIR/tape/<mint>.jsonl, one {t,side,sol} per line)
//   flags: --chest 0.3  --pool 120   (chest as a fraction of pool SOL; pool SOL override)
import { readFileSync } from 'node:fs'
import { compare } from '../src/lib/sim.ts'

const args = process.argv.slice(2); const src = args.find((a) => !a.startsWith('--'))
const flag = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? +args[i + 1] : d }
if (!src) { console.error('usage: replay gecko:<pool> | <tape.jsonl> [--chest 0.3] [--pool <sol>]'); process.exit(1) }

const G = 'https://api.geckoterminal.com/api/v2'
const gj = async (p) => { const r = await fetch(G + p, { headers: { accept: 'application/json;version=20230302' } }); if (!r.ok) throw new Error('gecko ' + r.status + ' ' + p); return (await r.json()).data }

let flow = [], poolSol = flag('pool', 0), label = src
if (src.startsWith('gecko:')) {
  const pool = src.slice(6)
  const [pd, px] = await Promise.all([gj(`/networks/solana/pools/${pool}`), gj('/simple/networks/solana/token_price/So11111111111111111111111111111111111111112')])
  const solUsd = +Object.values(px.attributes.token_prices)[0]
  const a = pd.attributes; label = a.name
  if (!poolSol) poolSol = (+a.reserve_in_usd) / 2 / solUsd
  const tr = await gj(`/networks/solana/pools/${pool}/trades`)
  flow = tr.map((x) => ({ t: Date.parse(x.attributes.block_timestamp), side: x.attributes.kind === 'buy' ? 'buy' : 'sell', sol: (+x.attributes.volume_in_usd) / solUsd }))
} else {
  flow = readFileSync(src, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((x) => ({ t: x.t, side: x.side, sol: +x.sol }))
  if (!poolSol) poolSol = Math.max(20, flow.reduce((m, f) => Math.max(m, f.sol), 0) * 25)
}
if (flow.length < 10) { console.error('not enough flow (' + flow.length + ' swaps)'); process.exit(1) }
flow.sort((a, b) => a.t - b.t)
const span = (flow[flow.length - 1].t - flow[0].t) / 6e4
const buys = flow.filter((f) => f.side === 'buy'), vol = flow.reduce((a, f) => a + f.sol, 0)
console.log(`${label} · ${flow.length} swaps over ${span.toFixed(0)} min · ${buys.length} buys / ${flow.length - buys.length} sells · ${vol.toFixed(1)} SOL volume · pool ≈ ${poolSol.toFixed(1)} SOL`)

const base = { poolSol, chestPct: flag('chest', 0.3), ceiling: 0.3, hours: 0, seed: 7, swapFee: 0.01, deskUse: 0.5, pumpStrength: 1, v2: true, skew: true, zstretch: true, flow }
const res = compare(base)
const row = (m, r) => `${m.padEnd(6)} peak ${r.peak.toFixed(2)}x  maxDD ${(r.maxDrawdown * 100).toFixed(0)}%  final ${r.final.toFixed(2)}x  vault ${r.vaultStart.toFixed(1)}→${r.vaultValue.toFixed(1)} SOL  captured ${r.captured.toFixed(2)}  desk ${r.deskBought.toFixed(2)}  dips ${r.dipBought.toFixed(2)}  txs ${r.txs}`
for (const m of ['none', 'floor', 'mm']) console.log(row(m, res[m]))
console.log(JSON.stringify({ label, swaps: flow.length, minutes: +span.toFixed(1), poolSol: +poolSol.toFixed(2), results: Object.fromEntries(Object.entries(res).map(([k, r]) => [k, { peak: r.peak, maxDrawdown: r.maxDrawdown, final: r.final, vaultStart: r.vaultStart, vaultValue: r.vaultValue, captured: r.captured, deskBought: r.deskBought }])) }))
