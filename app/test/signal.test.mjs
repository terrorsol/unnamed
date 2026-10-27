import test from 'node:test'
import assert from 'node:assert/strict'
import { classify } from '../src/lib/signal.ts'
import { shapeFeatures } from '../src/lib/sim.ts'
const tally = (shape, n = 10) => { const c = {}; for (let s = 1; s <= n; s++) { const l = classify(shapeFeatures(shape, s)).label; c[l] = (c[l] || 0) + 1 } return c }
const top = (c) => Object.entries(c).sort((a, b) => b[1] - a[1])[0][0]
test('runner shapes classify as RUNNER (or HEALTHY), never risk labels', () => { const c = tally('runner'); assert.ok(['RUNNER', 'HEALTHY'].includes(top(c)), JSON.stringify(c)); assert.ok(!c['RUG RISK'] && !c['BUNDLED'] && !c['CRASHING'], JSON.stringify(c)) })
test('rug shapes → CRASHING or RUG RISK', () => { const c = tally('rug'); assert.ok(['CRASHING', 'RUG RISK'].includes(top(c)), JSON.stringify(c)); assert.ok(!c['RUNNER'], JSON.stringify(c)) })
test('bundle shapes → BUNDLED / RUG RISK', () => { const c = tally('bundle'); assert.ok(['BUNDLED', 'RUG RISK'].includes(top(c)), JSON.stringify(c)); assert.ok(!c['RUNNER'], JSON.stringify(c)) })
test('crash shapes → CRASHING / COOLING / RUG RISK, not RUNNER', () => { const c = tally('crash'); assert.ok(!c['RUNNER'], JSON.stringify(c)); assert.ok(['CRASHING', 'COOLING', 'RUG RISK', 'HEALTHY'].includes(top(c)), JSON.stringify(c)) })
test('dead shapes → DEAD', () => { const c = tally('dead'); assert.equal(top(c), 'DEAD', JSON.stringify(c)) })
test('every signal carries reasons', () => { for (const s of ['runner', 'rug', 'bundle', 'crash', 'dead', 'healthy']) assert.ok(classify(shapeFeatures(s, 1)).reasons.length > 0, s) })
test('vault lowers risk, never flips a crash into a runner', () => { const f = shapeFeatures('crash', 2); const a = classify(f), b = classify({ ...f, vault: true }); assert.ok(b.risk <= a.risk); assert.notEqual(b.label, 'RUNNER') })
