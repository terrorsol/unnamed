import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, Transaction, SystemProgram } from '@solana/web3.js'
import { sign, outLastHour } from '../src/keeper.ts'
const sk = Keypair.generate(); const v = { id: 'v-' + Date.now(), chest: 10, sk } // unique: the ledger persists to DATA_DIR
const tx = () => { const t = new Transaction().add(SystemProgram.transfer({ fromPubkey: sk.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })); t.feePayer = sk.publicKey; t.recentBlockhash = '11111111111111111111111111111111'; return t }
test('keeper signs inside caps, refuses a single tx over 75% of chest and an hour over 100%', () => {
  assert.ok(sign(v, tx(), 'trade', 1).signatures[0].signature, 'signs a 1 SOL buy')
  assert.throws(() => sign(v, tx(), 'desk_fill', 8), /per-tx cap/)
  sign(v, tx(), 'desk_fill', 6.5); sign(v, tx(), 'trade', 2.4)   // 9.9 of 10 allowed this hour
  assert.throws(() => sign(v, tx(), 'trade', 0.5), /hourly cap/)
  assert.ok(sign(v, tx(), 'treasury', 10), 'treasury share at import is structural, not capped')
  assert.ok(sign(v, tx(), 'trade', 0), 'sells move no SOL out and always sign')
  assert.ok(outLastHour(v.id) > 9.8)
  assert.throws(() => sign(v, tx(), 'withdraw', 1), /unknown purpose/)
})
