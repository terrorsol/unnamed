import test from 'node:test'
import assert from 'node:assert/strict'
import * as MM from '../src/mm.ts'

const mk = (chest = 10, tokens = 3e8) => ({ chest, tokens, supply: 1e9, pct: 30, avgCost: 1e-7, mode: 'mm', ceiling: 0.3, samples: [], high15: [], ema5: null, ema15: null, spentEpisode: 0, tranchesFired: [], lastBuy: 0, trimmedToday: 0, trimDay: 0, buyTimes: [], lastCapture: 0 })
const m = (p) => ({ priceSol: p, mcapUsd: p * 1e9 * 180, liqSol: 60, vol1h: 50000 })
/** feed a price for n ticks of 5s; run defense each tick like vault.ts does; return SOL spent */
function play(s, path, t0 = 0, buys = []) {
  let t = t0, spent = 0
  for (const p of path) { t += 5000; const { dd } = MM.observe(s, p, t); const d = MM.defense(s, m(p), p, t, dd, 0, MM.P, 0.5); if (d) { const got = d.spend / p; s.chest -= d.spend; s.tokens += got; MM.onDefended(s, d.spend, got, d.level, t); spent += d.spend; buys.push({ t, p, sol: d.spend }) } s.ddPrev = dd }
  return { spent, t }
}
const flat = (p, n) => Array(n).fill(p)

test('a crash episode spends at most 40% of the chest, and the rolling 15-min window cannot re-arm it while the price stays down', () => {
  const s = mk(); const buys = []
  let r = play(s, flat(1e-7, 60), 0, buys)                    // 5 min at 1.0 → vwap = 1.0
  r = play(s, [...flat(0.75e-7, 4), ...flat(0.60e-7, 4), ...flat(0.45e-7, 4)], r.t, buys)   // through −20 / −35 / −50
  assert.equal(buys.length, 3, 'three tranches fired'); assert.ok(r.spent <= 10 * 0.4 + 1e-9 && r.spent > 2, `spent ${r.spent}`)
  const spentEp = r.spent
  r = play(s, flat(0.45e-7, 12 * 20), r.t, buys)              // 20 min down there: the 15-min high has rolled to 0.48
  assert.equal(buys.length, 3, 'no new tranche while still down (episode is anchored to its own high)')
  r = play(s, flat(0.37e-7, 12 * 5), r.t, buys)               // −17% from the rolled high: legacy would have fired again
  assert.equal(buys.length, 3, 'still nothing'); assert.equal(s.spentEpisode, spentEp)
})

test('day cap: back-to-back crashes with recoveries cannot spend more than 50% of the chest the day started with', () => {
  const s = mk(); const buys = []; let r = { t: 0 }
  for (let i = 0; i < 4; i++) {
    r = play(s, flat(1e-7, 60), r.t, buys)                    // recover to the episode high → episode ends, cooldown
    r = play(s, flat(1e-7, 12 * 31), r.t, buys)               // wait out the 30-min cooldown
    r = play(s, [...flat(0.75e-7, 4), ...flat(0.60e-7, 4), ...flat(0.45e-7, 4), ...flat(0.45e-7, 12)], r.t, buys)
  }
  const spent = buys.reduce((a, b) => a + b.sol, 0)
  assert.ok(spent <= 5 + 1e-9, `spent ${spent} of a 10 SOL chest`); assert.ok(spent > 4, 'but it did defend')
})

test('a dip from a pump is not a dip: no buying above the 30-min / 2-hour VWAP', () => {
  const s = mk(); const buys = []
  let r = play(s, flat(1e-7, 60), 0, buys)
  r = play(s, [...flat(2e-7, 12), ...flat(4e-7, 12)], r.t, buys)   // +300% in 2 min
  r = play(s, [...flat(3.1e-7, 4), ...flat(2.5e-7, 4), ...flat(1.9e-7, 4), ...flat(1.9e-7, 24)], r.t, buys)   // −52% from the top, still +90% vs before
  assert.equal(buys.length, 0, 'no defense above vwap')
  r = play(s, [...flat(0.8e-7, 4), ...flat(0.6e-7, 12)], r.t, buys)   // now under vwap
  assert.ok(buys.length >= 1, 'buys once it is a real dip')
})

test('toxic desk flow: a block sold to the vault then a −6% chart move pulls the bid, escalates, and bans the seller', () => {
  const s = mk(); let t = 0
  for (const p of flat(1e-7, 60)) { t += 5000; MM.observe(s, p, t); s.ddPrev = 0 }
  assert.ok(MM.deskBid(s, 0.2, t, MM.P, 0.5) > 0 && MM.deskBid(s, 0.2, t, MM.P, 0.5) <= 10 * 0.25 * 1.1 + 1e-9, 'bid ≤ 25% of chest')
  MM.onDeskFill(s, 2, 2e8, 1e-7, t, 'SELLER')
  t += 5000; MM.observe(s, 0.93e-7, t)
  assert.equal(MM.deskBid(s, 0.2, t, MM.P, 0.5), 0, 'bid pulled'); assert.ok(MM.deskDenied(s, 'SELLER', t), 'seller denied'); assert.ok(!MM.deskDenied(s, 'OTHER', t))
  assert.ok(s.deskPauseUntil - t >= 15 * 60_000 - 1 && s.deskPauseUntil - t < 16 * 60_000, 'first pause 15 min')
  t = s.deskPauseUntil + 1000; MM.observe(s, 1e-7, t); assert.ok(MM.deskBid(s, 0.2, t, MM.P, 0.5) > 0, 'bid back after the pause')
  MM.onDeskFill(s, 2, 2e8, 1e-7, t, 'SELLER2'); t += 5000; MM.observe(s, 0.93e-7, t)
  assert.ok(s.deskPauseUntil - t >= 30 * 60_000 - 1, 'second event: 30 min')
})

test('seller concentration: one wallet behind the selling halves the budget and disables the third tranche', () => {
  const tape = [{ t: 0, side: 'sell', sol: 5, trader: 'A' }, { t: 0, side: 'sell', sol: 1, trader: 'B' }]
  assert.ok(MM.sellerShare(tape, 1000) > 0.8)
  const s = mk(); let t = 0
  for (const p of flat(1e-7, 60)) { t += 5000; MM.observe(s, p, t); s.ddPrev = 0 }
  for (const p of [0.78e-7, 0.78e-7]) { t += 5000; const { dd } = MM.observe(s, p, t); var d = MM.defense(s, m(p), p, t, dd, 0.9, MM.P, 0.5); s.ddPrev = dd }
  assert.ok(d && d.spend < 10 * 0.4 / 3 * 0.6, `half budget: ${d && d.spend}`)
  const s2 = mk(); t = 0; for (const p of flat(1e-7, 60)) { t += 5000; MM.observe(s2, p, t); s2.ddPrev = 0 }
  for (const p of [0.48e-7, 0.48e-7]) { t += 5000; const { dd } = MM.observe(s2, p, t); var d2 = MM.defense(s2, m(p), p, t, dd, 0.9, MM.P, 0.5); s2.ddPrev = dd }
  assert.ok(d2 && d2.level <= 1, 'no third tranche against a single dumper')
})

test('pool impact cap: a vault buy never exceeds 10% of the pool SOL', () => {
  const s = mk(100); let t = 0
  for (const p of flat(1e-7, 60)) { t += 5000; MM.observe(s, p, t); s.ddPrev = 0 }
  let d; for (const p of [0.78e-7, 0.78e-7]) { t += 5000; const { dd } = MM.observe(s, p, t); d = MM.defense(s, { ...m(p), liqSol: 20 }, p, t, dd, 0, MM.P, 0.5); s.ddPrev = dd }
  assert.ok(d && d.spend <= 2 + 1e-9, `spend ${d && d.spend}`)
})
