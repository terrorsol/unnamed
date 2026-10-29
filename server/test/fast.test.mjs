import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import * as F from '../src/fast.ts'

test('every tipped tx carries the jitodontfront marker read-only, and the tip still goes to a sender tip account', async () => {
  const payer = Keypair.generate().publicKey
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: '11111111111111111111111111111111', instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1 })] }).compileToV0Message()
  const out = await F.addTip(null, new VersionedTransaction(msg), payer, F.MIN_TIP_LAMPORTS)
  const keys = out.message.staticAccountKeys.map((k) => k.toBase58())
  const i = keys.indexOf(F.DONTFRONT.toBase58()); assert.ok(i >= 0, 'marker present')
  assert.equal(out.message.isAccountWritable(i), false); assert.equal(out.message.isAccountSigner(i), false)
  assert.ok(keys.some((k) => F.TIP_ACCOUNTS.includes(k)), 'tip account present')
  assert.equal(out.message.compiledInstructions.length, 2)
})
