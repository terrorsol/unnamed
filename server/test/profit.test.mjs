import test from 'node:test'
import assert from 'node:assert/strict'
import * as MM from '../src/mm.ts'

const PO = { ...MM.P, profitOnly: true, profitMinVolSol: 10, profitVolMult: 20, profitMargin: 0.04, warmupMs: 0 }
const mk = (o = {}) => ({ chest: 2, tokens: 0, supply: 1e9, pct: 5, avgCost: 0, mode: 'mm', ceiling: 0.3, samples: [], high15: [], ema5: null, ema15: null, spentEpisode: 0, tranchesFired: [], lastBuy: 0, trimmedToday: 0, trimDay: 0, buyTimes: [], lastCapture: 0, ...o })
// market with a given SOL volume in the last hour (SOL at $180)
const mkt = (p, volSol) => ({ priceSol: p, mcapUsd: p * 1e9 * 180, liqSol: 60, vol1h: volSol * 180 })

test('volume in SOL comes from the market USD figure at the market\'s own SOL price', () => {
  assert.ok(Math.abs(MM.volSol({ supply: 1e9 }, mkt(1e-7, 42)) - 42) < 1e-6)
  assert.equal(MM.volSol({ supply: 1e9 }, { ...mkt(1e-7, 42), volSol: 7 }), 7)
})
test('profit-only: no desk bid when the last hour traded under 10 SOL, and the bid is at most 1/20 of the hour', () => {
  const s = mk({ samples: [{ t: 0, p: 1e-7, v: 1 }] })
  assert.equal(MM.deskBid(s, 0.2, 1e6, PO, 0.5, 1e-7, 60, 5), 0, 'thin hour → no bid')
  const b = MM.deskBid(s, 0.2, 1e6, PO, 0.5, 1e-7, 60, 40); assert.ok(b > 0 && b <= 40 / 20 + 1e-9, `bid ${b}`)
  assert.ok(MM.deskBid(s, 0.2, 1e6, MM.P, 0.5, 1e-7, 60, 0) > 0, 'mode off: unchanged (volume not required)')
})
test('profit-only: dip buys and accumulation need the volume too', () => {
  const buyRoom = (vol) => MM.profitRoom(vol, PO)
  assert.equal(buyRoom(9.99), 0); assert.equal(buyRoom(100), 5); assert.equal(MM.profitRoom(0, MM.P), Infinity)
  const s = mk({ tokens: 0, pct: 5, samples: [{ t: 0, p: 1e-7, v: 1 }], samplesLong: [{ t: 0, p: 1e-7, v: 1 }] })
  assert.equal(MM.accumulate(s, mkt(1e-7, 3), 1e-7, 1e6, PO, 0.5), null, 'thin hour → no accumulation')
  const a = MM.accumulate(s, mkt(1e-7, 200), 1e-7, 1e6, PO, 0.5); assert.ok(a > 0, 'enough volume → allowed')
})
test('profit-only: nothing is ever sold under cost × 1.04', () => {
  assert.equal(MM.sellFloor(1e-7, PO), 1.04e-7); assert.equal(MM.sellFloor(1e-7, MM.P), 0); assert.equal(MM.sellFloor(0, PO), 0)
  // inventory bought at 1.0: a big buy at 1.02 is not trimmed, at 1.10 it may be
  const s = mk({ tokens: 5e7, avgCost: 1e-7, samples: Array.from({ length: 30 }, (_, i) => ({ t: i * 1000, p: 1e-7, v: 1 })) })
  for (let i = 0; i < 50; i++) { s.nextCaptureAt = 0; assert.equal(MM.capture(s, mkt(1.02e-7, 500), 1.02e-7, 5, 1e6 + i, PO, 0, 0.5), 0) }
  // leg tokens bought at 1.0 (cost 5 SOL for 5e7): never sold at 1.03 even if legTakeProfit were lower than the margin
  const l = mk({ tokens: 5e7, avgCost: 1e-7, mmTok: 5e7, mmCost: 5 })
  assert.equal(MM.capture(l, mkt(1.03e-7, 500), 1.03e-7, 5, 1e6, { ...PO, legTakeProfit: 0.01 }, 1, 0.5), 0)
  assert.ok(MM.capture(l, mkt(1.2e-7, 500), 1.2e-7, 5, 2e6, PO, 1, 0.5) > 0, 'well above cost → the leg exits')
})
test('initials: until the launch buy is back, each incoming buy gets a slice of the vault sold into it — a share of that buy, not the max', () => {
  const IN = { ...PO, initialsFrac: 0.5, initialsMinBuy: 0.05 }
  const s = mk({ tokens: 1.2e8, avgCost: 3.3e-8, launchSpend: 4, invGot: 0, samples: [{ t: 0, p: 4e-8, v: 1 }] })
  const t = MM.capture(s, mkt(4e-8, 50), 4e-8, 1.0, 1e6, IN, 0.99, 0.5)
  assert.ok(Math.abs(t * 4e-8 - 0.5) < 1e-6, `sold ${t * 4e-8} SOL into a 1 SOL buy`)
  assert.equal(MM.capture(s, mkt(3.3e-8, 50), 3.3e-8, 1.0, 1e6, IN, 0.99, 0.5), 0, 'never under cost +1%')
  assert.equal(MM.capture(s, mkt(4e-8, 50), 4e-8, 0.01, 1e6, IN, 0.99, 0.5), 0, 'dust buys are left alone')
  s.invGot = 3.9; const t2 = MM.capture(s, mkt(4e-8, 50), 4e-8, 2.0, 1e6, IN, 0.99, 0.5)
  assert.ok(t2 * 4e-8 <= 0.1 * 1.03 + 1e-9, 'never more than what is left to recover')
  s.invGot = 4; assert.equal(MM.initialsOn(s, IN), false, 'initials back → normal policy')
})
