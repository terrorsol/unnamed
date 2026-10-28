import test from 'node:test'
import assert from 'node:assert/strict'
import { solForPct, blockZero, flipFee, vaultPct, mergeClock, vaultBuyBudget, vaultMayTrim, deskMinBlock, deskOpen, redeemValue, leaderScore } from '../src/lib/protocol.ts'

test('flip fee decays 8% → 0 over 30 min and is 0 on losses', () => {
  assert.ok(Math.abs(flipFee(1, 0) - 0.08) < 1e-9)
  assert.ok(Math.abs(flipFee(1, 15) - 0.04) < 1e-9)
  assert.equal(flipFee(1, 30), 0)
  assert.equal(flipFee(1, 45), 0)
  assert.equal(flipFee(-1, 1), 0)
  assert.equal(flipFee(0, 1), 0)
})
test('vault supply: pct caps at 50%, and solForPct inverts the curve for the 20–50% launch range', () => {
  assert.ok(vaultPct(0) === 0)
  assert.ok(vaultPct(1) > 1.6 && vaultPct(1) < 1.8, 'half of 1 SOL on the fresh curve ≈ 1.7% of supply: ' + vaultPct(1))
  assert.ok(vaultPct(1, 2) < vaultPct(1), 'a dev buy ahead of the vault leaves it fewer tokens')
  assert.equal(vaultPct(500), 50, 'capped at 50%')
  for (const pct of [20, 30, 40, 50]) { const sol = solForPct(pct, 0.5, 225); const got = blockZero(0.5, sol * 2, 225).vaultPct; assert.ok(Math.abs(got - pct) < 0.2, `${pct}% ← ${sol} SOL → ${got}%`) }
  const s20 = solForPct(20, 0, 225), s50 = solForPct(50, 0, 225); assert.ok(s20 > 6 && s20 < 8 && s50 > 25 && s50 < 30, `20% ≈ 7 SOL (${s20}), 50% ≈ 27 SOL (${s50})`)
})
test('clock merges cost-weighted', () => {
  const t = mergeClock(0, 1, 3, 1000); assert.equal(t, 750)
})
test('vault policy gates', () => {
  assert.equal(vaultBuyBudget(100, 5), 0)
  assert.ok(vaultBuyBudget(100, -40) <= 40)
  assert.equal(vaultMayTrim(10, 8, 9, true), true)
  assert.equal(vaultMayTrim(10, 11, 9, true), false)
  assert.equal(vaultMayTrim(10, 8, 9, false), false)
})
test('desk + redeem', () => {
  assert.equal(deskMinBlock(5), 0.2)
  assert.equal(deskMinBlock(1000), 20)
  assert.equal(deskOpen(true, 99_999), false)
  assert.equal(deskOpen(true, 100_000), true)
  assert.ok(Math.abs(redeemValue(1, 100) - 0.93) < 1e-9)
  assert.ok(leaderScore(100, 400) === 2000)
})
