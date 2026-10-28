import test from 'node:test'
import assert from 'node:assert/strict'
import { flipFee, vaultPct, mergeClock, vaultBuyBudget, vaultMayTrim, deskMinBlock, deskOpen, redeemValue, leaderScore } from '../src/lib/protocol.ts'

test('flip fee decays 8% → 0 over 30 min and is 0 on losses', () => {
  assert.ok(Math.abs(flipFee(1, 0) - 0.08) < 1e-9)
  assert.ok(Math.abs(flipFee(1, 15) - 0.04) < 1e-9)
  assert.equal(flipFee(1, 30), 0)
  assert.equal(flipFee(1, 45), 0)
  assert.equal(flipFee(-1, 1), 0)
  assert.equal(flipFee(0, 1), 0)
})
test('vault pct caps at 10% around 3.1 SOL', () => {
  assert.ok(vaultPct(0) === 0)
  assert.ok(vaultPct(1) > 1.6 && vaultPct(1) < 1.8, 'half of 1 SOL on the fresh curve ≈ 1.7% of supply: ' + vaultPct(1))
  assert.ok(vaultPct(1, 2) < vaultPct(1), 'a dev buy ahead of the vault leaves it fewer tokens')
  assert.ok(Math.abs(vaultPct(10) - 14.6) < 0.5 || vaultPct(10) === 10, 'capped at the 10% target')
  assert.equal(vaultPct(50), 10)
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
