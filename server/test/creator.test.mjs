import test from 'node:test'
import assert from 'node:assert/strict'
import * as CR from '../src/creator.ts'
const M = 60_000, H = 60 * M, D = 24 * H

test('share is sized by stake, capped at 20%; renounced creators get nothing', () => {
  assert.equal(CR.sharePct(0), 0); assert.equal(CR.sharePct(1.5), 10); assert.equal(CR.sharePct(3), 20); assert.equal(CR.sharePct(10), 20)
  const s = CR.splitFee(1, 3, false); assert.ok(Math.abs(s.creator - 0.2) < 1e-9 && Math.abs(s.chest - 0.8) < 1e-9)
  assert.deepEqual(CR.splitFee(1, 3, true), { chest: 1, creator: 0 })
  const t = CR.splitFee(0.123456789, 1, false); assert.ok(Math.abs(t.chest + t.creator - 0.123456789) < 1e-12, 'split never creates or loses SOL')
})

test('a wick unlocks nothing; holding 15 min unlocks 25% per milestone, in order', () => {
  const c = CR.fresh(); c.earned = 4
  CR.step(c, 60_000, 0, 1); CR.step(c, 40_000, 5 * M, 1); CR.step(c, 60_000, 20 * M, 1)
  assert.equal(c.hits, 0, 'dipped below before 15 min: no unlock')
  CR.step(c, 60_000, 36 * M, 1); assert.equal(c.hits, 1); assert.equal(CR.unlocked(c), 1)
  // jumping straight to $600K and holding 15 min: every milestone below it was held 15 min, so all unlock together
  CR.step(c, 600_000, 40 * M, 1); assert.equal(c.hits, 1, 'not instantly')
  CR.step(c, 600_000, 56 * M, 1); assert.equal(c.hits, 4); assert.equal(CR.unlocked(c), 4)
  CR.step(c, 1_000, 200 * M, 1); assert.equal(c.hits, 4, 'hits never go back')
})

test('payouts go out hourly, only what is unlocked, never twice', () => {
  const c = CR.fresh(); c.earned = 2; c.hits = 2 // 50% unlocked = 1 SOL
  const a = CR.step(c, 10_000, 0, 1); assert.ok(Math.abs(a.pay - 1) < 1e-9); CR.onPaid(c, a.pay)
  assert.equal(CR.step(c, 10_000, 30 * M, 1).pay, 0, 'not before the next hour')
  c.earned = 4 // fees keep coming: 50% of 4 = 2 unlocked, 1 already paid
  const b = CR.step(c, 10_000, H + 1, 1); assert.ok(Math.abs(b.pay - 1) < 1e-9); CR.onPaid(c, b.pay)
  assert.equal(CR.payable(c), 0); assert.ok(Math.abs(CR.owed(c) - 2) < 1e-9, 'the locked half is still owed')
})

test('a coin that never makes it: after 30 days the locked part goes to the chest, once', () => {
  const c = CR.fresh(); c.earned = 3; c.hits = 1 // 0.75 unlocked, 2.25 locked
  const r = CR.step(c, 1_000, 31 * D, 1); assert.ok(Math.abs(r.forfeit - 2.25) < 1e-9)
  assert.equal(CR.step(c, 1_000, 32 * D, 1).forfeit, 0, 'forfeit happens once')
  assert.ok(Math.abs(CR.owed(c) - 0.75) < 1e-9, 'the unlocked part is still the creator\'s')
})
