// npm run backtest — grid over chest size × flow violence, v1 vs v2 rules, averaged over seeds. Prints a table and writes backtest.json.
import { simulate } from '../src/lib/sim.ts'
import { writeFileSync } from 'node:fs'
const seeds = +(process.argv[2] || 20), hours = 6
const rows = [], out = {}
const avg = (arr, f) => arr.reduce((a, x) => a + f(x), 0) / arr.length
for (const chestPct of [0.15, 0.3]) for (const pumpStrength of [0.6, 1.0, 1.4]) for (const [mode, v2] of [['none', false], ['mm', false], ['mm', true]]) {
  const rs = []; for (let seed = 1; seed <= seeds; seed++) rs.push(simulate({ poolSol: 100, chestPct, ceiling: 0.3, hours, seed, swapFee: 0.015, deskUse: 0.5, pumpStrength, mode, v2 }))
  const row = { chest: chestPct * 100 + '%', flow: pumpStrength, rules: mode === 'none' ? 'none' : v2 ? 'mm v2' : 'mm v1', peak: +avg(rs, (x) => x.peak).toFixed(2), maxDD: +(avg(rs, (x) => x.maxDrawdown) * 100).toFixed(1), final: +avg(rs, (x) => x.final).toFixed(2), vaultPnL: mode === 'none' ? null : +avg(rs, (x) => x.vaultValue - x.vaultStart).toFixed(2), captured: mode === 'none' ? null : +avg(rs, (x) => x.captured).toFixed(2), offChart: mode === 'none' ? null : +avg(rs, (x) => x.deskBought).toFixed(2), txPerHr: mode === 'none' ? null : +(avg(rs, (x) => x.txs) / hours).toFixed(1) }
  rows.push(row); out[`${chestPct}|${pumpStrength}|${row.rules}`] = row
}
console.table(rows); writeFileSync(new URL('../backtest.json', import.meta.url), JSON.stringify(rows, null, 2)); console.log('wrote app/backtest.json')
