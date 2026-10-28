import test from 'node:test'
import assert from 'node:assert/strict'
import { judge, nameSim, runnerScore } from '../src/vamp.ts'
const now = Date.now()
const orig = { mint: 'A', symbol: 'PEPE', name: 'Pepe', image: 'https://x/pepe.png', createdAt: now - 10 * 3.6e6, mcapUsd: 2_000_000, vol1h: 400_000, vol24: 3e6, ch1h: 20, ch5m: 2, buys1h: 900, sells1h: 600, liqUsd: 300_000, dexId: 'pumpswap', creator: 'DEV1' }
const mk = (o) => ({ ...orig, mint: 'B', createdAt: now - 2 * 3.6e6, mcapUsd: 150_000, vol1h: 50_000, creator: 'DEV2', image: 'https://x/other.png', ...o })
test('name similarity is strict enough', () => {
  assert.equal(nameSim('PEPE', 'pepe'), 1); assert.equal(nameSim('PEPE', 'PEPE2'), 0.8); assert.equal(nameSim('PEPE', 'PEPPE'), 0.8); assert.equal(nameSim('DOGE', 'PEPE'), 0); assert.equal(nameSim('BONK', 'BONKINU'), 0.6)
})
test('same ticker + launched hours after + smaller = vamp; unrelated or older coins are not', () => {
  const v = judge(mk({}), orig); assert.ok(v && v.score >= 0.55, 'ticker copy flagged'); assert.ok(v.reasons.some((r) => /same ticker/.test(r)))
  assert.equal(judge(mk({ symbol: 'DOGE', name: 'Doge' }), orig), null, 'different coin')
  assert.equal(judge(mk({ createdAt: now - 20 * 3.6e6 }), orig), null, 'older than the original is never its vamp')
  assert.equal(judge(mk({ mcapUsd: 5_000_000 }), orig), null, 'bigger than the original is the original')
})
test('same deployer or same image raises the score; a near-name alone inside 48h is still flagged, outside 48h with no other signal is not', () => {
  const a = judge(mk({ creator: 'DEV1' }), orig); const b = judge(mk({}), orig); assert.ok(a.score > b.score); assert.ok(a.reasons.includes('same deployer wallet'))
  const c = judge(mk({ image: orig.image }), orig); assert.ok(c.reasons.includes('same image'))
  const far = judge(mk({ symbol: 'PEPE2', name: 'Pepe Two', createdAt: now - 1 * 3.6e6, mcapUsd: 1_900_000 }), { ...orig, createdAt: now - 100 * 3.6e6 }); assert.equal(far, null, 'near-name, no timing, no deployer, near-equal size → not enough evidence')
})
test('runner score follows aged mcap and volume with a buy-pressure tilt', () => {
  const a = runnerScore(orig); const b = runnerScore({ ...orig, buys1h: 300, sells1h: 900 }); assert.ok(a > b)
  const young = runnerScore({ ...orig, createdAt: now - 0.5 * 3.6e6 }); assert.ok(young < a, 'brand-new mcap is discounted')
})
