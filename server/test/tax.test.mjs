import test from 'node:test'
import assert from 'node:assert/strict'
const { taxWeights, taxCredits } = await import('../src/tax.ts')

test('tax weights follow observed volume', () => {
  assert.deepEqual(taxWeights([{ taxAccrued: 0.3 }, { taxAccrued: 0.1 }]), [0.3, 0.1])
  assert.deepEqual(taxWeights([{ taxAccrued: 0.2 }, {}]), [0.2, 0])
})
test('nothing observed: no guess, not even for a single chest (a free attached chest must not collect every coin\'s fee)', () => {
  assert.deepEqual(taxWeights([{ taxAccrued: 0 }]), [0])
  assert.deepEqual(taxWeights([{}]), [0])
  assert.deepEqual(taxCredits(1.0, [0]), [0])
})
test('credits split by observed volume, each capped at its own accrual (+25%): fees of chest-less coins stay unattributed', () => {
  // a 1 SOL claim; the chests' feeds saw 0.1 + 0.05 of fees: the rest came from coins without a chest
  const c = taxCredits(1.0, [0.1, 0.05]); assert.ok(Math.abs(c[0] - 0.125) < 1e-12); assert.ok(Math.abs(c[1] - 0.0625) < 1e-12)
  // a claim that matches what was observed is split exactly
  const d = taxCredits(0.15, [0.1, 0.05]); assert.ok(Math.abs(d[0] - 0.1) < 1e-12); assert.ok(Math.abs(d[1] - 0.05) < 1e-12)
})
