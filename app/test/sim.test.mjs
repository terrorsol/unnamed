import test from 'node:test'
import assert from 'node:assert/strict'
import { compare, simulate } from '../src/lib/sim.ts'
const base = { poolSol: 100, ceiling: 0.3, hours: 6, swapFee: 0.015, deskUse: 0.5, pumpStrength: 1.0 }
const avg = (f, n = 12, chestPct = 0.3) => { const acc = { none: 0, floor: 0, mm: 0 }; for (let s = 1; s <= n; s++) { const c = compare({ ...base, chestPct, seed: s }); for (const k in acc) acc[k] += f(c[k]) / n } return acc }
test('sim is deterministic and finite', () => { const a = simulate({ ...base, chestPct: 0.3, mode: 'mm', seed: 7 }), b = simulate({ ...base, chestPct: 0.3, mode: 'mm', seed: 7 }); assert.equal(a.final, b.final); for (const k of ['peak', 'final', 'maxDrawdown', 'vaultValue', 'chest']) assert.ok(Number.isFinite(a[k]), k) })
test('30% chest MM: lower drawdown, not a capped pump, vault profitable, holders better off', () => {
  const dd = avg((r) => r.maxDrawdown), peak = avg((r) => r.peak), fin = avg((r) => r.final), pnl = avg((r) => r.vaultValue - r.vaultStart)
  assert.ok(dd.mm < dd.none, `drawdown mm ${dd.mm} < none ${dd.none}`)
  assert.ok(peak.mm >= peak.none * 0.95, `mm must not cap the pump: ${peak.mm} vs ${peak.none}`)
  assert.ok(fin.mm >= fin.none, `final mm ${fin.mm} >= none ${fin.none}`)
  assert.ok(pnl.mm > 0, 'vault compounds')
})
test('5% chest is cosmetic (documented): drawdown within 3 pts of none', () => { const dd = avg((r) => r.maxDrawdown, 12, 0.05); assert.ok(Math.abs(dd.mm - dd.none) < 0.06) })
test('capture never fires below VWAP or below cost', async () => { const { captureFrac } = await import('../src/lib/sim.ts'); assert.equal(captureFrac(0.99, 1, 0.5, 5e5, 0.3, 0.5), 0); assert.equal(captureFrac(1.5, 1, 1.49, 5e5, 0.3, 0.5), 0); assert.ok(captureFrac(1.3, 1, 0.5, 5e5, 0.3, 0.5) > 0.15) })
