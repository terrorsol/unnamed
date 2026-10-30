import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, Transaction, SystemProgram } from '@solana/web3.js'
import { sign, outLastHour, isOwn } from '../src/keeper.ts'
import bs58 from 'bs58'
import { VersionedTransaction, TransactionMessage } from '@solana/web3.js'
const sk = Keypair.generate(); const v = { id: 'v-' + Date.now(), chest: 10, sk } // unique: the ledger persists to DATA_DIR
const tx = () => { const t = new Transaction().add(SystemProgram.transfer({ fromPubkey: sk.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })); t.feePayer = sk.publicKey; t.recentBlockhash = '11111111111111111111111111111111'; return t }
test('keeper signs inside caps, refuses a single tx over 75% of chest and an hour over 60%', () => {
  assert.ok(sign(v, tx(), 'trade', 1).signatures[0].signature, 'signs a 1 SOL buy')
  assert.throws(() => sign(v, tx(), 'desk_fill', 8), /per-tx cap/)
  sign(v, tx(), 'desk_fill', 2.5); sign(v, tx(), 'trade', 2.4)   // 5.9 of 6 allowed this hour
  assert.throws(() => sign(v, tx(), 'trade', 0.5), /hourly cap/)
  assert.ok(sign(v, tx(), 'treasury', 10), 'treasury share at import is structural, not capped')
  assert.ok(sign(v, tx(), 'trade', 0), 'sells move no SOL out and always sign')
  assert.ok(outLastHour(v.id) > 5.8)
  assert.throws(() => sign(v, tx(), 'withdraw', 1), /unknown purpose/)
})

test('every tx the keeper signs is remembered by its signature; anything else from the wallet is not ours (foreign trade detection)', () => {
  const t = sign({ id: 'own-' + Date.now(), chest: 10, sk }, tx(), 'trade', 0); assert.ok(isOwn(bs58.encode(t.signatures[0].signature)))
  const m = new TransactionMessage({ payerKey: sk.publicKey, recentBlockhash: '11111111111111111111111111111111', instructions: [SystemProgram.transfer({ fromPubkey: sk.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })] }).compileToV0Message()
  const vt = sign({ id: 'own2-' + Date.now(), chest: 10, sk }, new VersionedTransaction(m), 'trade', 0); assert.ok(isOwn(bs58.encode(vt.signatures[0])))
  const other = new VersionedTransaction(m); other.sign([sk]); const fresh = new TransactionMessage({ payerKey: sk.publicKey, recentBlockhash: '11111111111111111111111111111112', instructions: [SystemProgram.transfer({ fromPubkey: sk.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 2 })] }).compileToV0Message()
  const notOurs = new VersionedTransaction(fresh); notOurs.sign([sk]); assert.equal(isOwn(bs58.encode(notOurs.signatures[0])), false, 'signed with the same key but not through the keeper')
})
