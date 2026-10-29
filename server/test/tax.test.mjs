import test from 'node:test'
import assert from 'node:assert/strict'
const { taxWeights } = await import('../src/tax.ts')

test('tax weights follow observed volume when there is any', () => {
  assert.deepEqual(taxWeights([{ taxAccrued: 0.3 }, { taxAccrued: 0.1 }]), [0.3, 0.1])
  assert.deepEqual(taxWeights([{ taxAccrued: 0.2 }, {}]), [0.2, 0])
})
test('one coin and nothing observed: that coin gets the whole claim (the fee never strands as unattributed)', () => {
  assert.deepEqual(taxWeights([{ taxAccrued: 0 }]), [1])
  assert.deepEqual(taxWeights([{}]), [1])
})
test('several coins and nothing observed: no guess, stays unattributed', () => {
  assert.deepEqual(taxWeights([{}, { taxAccrued: 0 }]), [0, 0])
  assert.deepEqual(taxWeights([]), [])
})
