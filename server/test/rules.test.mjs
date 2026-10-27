import test from 'node:test'
import assert from 'node:assert/strict'
import * as R from '../src/rules.ts'
import { verifyFill } from '../src/verify.ts'
import { Transaction, SystemProgram, Keypair, PublicKey } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'

const M = { mcapUsd: 250_000, liqSol: 100, onCurve: false, priceSol: 0.00001 }
test('gate + min block + discount band', () => {
  assert.equal(R.deskOpen(M), true); assert.equal(R.deskOpen({ ...M, onCurve: true }), false); assert.equal(R.deskOpen({ ...M, mcapUsd: 50_000 }), false)
  assert.equal(R.minBlockSol(M), 2); assert.equal(R.minBlockSol({ ...M, liqSol: 1 }), 0.2)
  assert.equal(R.validBid(2, 400, M), null)
  assert.match(R.validBid(1, 400, M), /min block/); assert.match(R.validBid(2, 200, M), /discount/); assert.match(R.validBid(2, 600, M), /discount/)
})
test('fill quote math', () => {
  const q = R.fillQuote(2, 400, 0.00001, 6)
  assert.ok(Math.abs(q.px - 0.0000096) < 1e-12)
  assert.equal(q.lamports, 2_000_000_000n); assert.equal(q.fee, 10_000_000n); assert.equal(q.sellerLamports, 1_990_000_000n)
  assert.equal(q.base, BigInt(Math.floor((2 / 0.0000096) * 1e6)))
})
test('rest + expiry', () => { const t = Date.now(); assert.equal(R.restable(t, t + 59_000), false); assert.equal(R.restable(t, t + 60_000), true); assert.equal(R.expired(t, t + 31 * 60_000), true) })
test('vault policy', () => {
  assert.equal(R.dipBudget(10, -0.05, 0), 0); assert.ok(R.dipBudget(10, -0.2, 0) > 0); assert.ok(R.dipBudget(10, -0.5, 0) <= 4); assert.equal(R.dipBudget(10, -0.5, 4), 0)
  assert.equal(R.mayTrim(1.2, 1, 1.1, 1.15, 1.1), true); assert.equal(R.mayTrim(1.02, 1, 0.9, 1.1, 1.0), false); assert.equal(R.mayTrim(1.2, 1, 1.3, 1.15, 1.1), false)
})
test('verifyFill accepts a well-formed fill and rejects tampering', () => {
  const seller = Keypair.generate(), bidder = Keypair.generate(), mint = Keypair.generate().publicKey, treasury = Keypair.generate().publicKey
  const e = { mint: mint.toBase58(), seller: seller.publicKey.toBase58(), bidder: bidder.publicKey.toBase58(), treasury: treasury.toBase58(), base: 123456n, sellerLamports: 1_990_000_000n, fee: 10_000_000n }
  const bAta = getAssociatedTokenAddressSync(mint, bidder.publicKey, true), sAta = getAssociatedTokenAddressSync(mint, seller.publicKey, true)
  const build = (base, sl, fee) => { const tx = new Transaction(); tx.feePayer = seller.publicKey; tx.recentBlockhash = '11111111111111111111111111111111'
    tx.add(createAssociatedTokenAccountIdempotentInstruction(seller.publicKey, bAta, bidder.publicKey, mint), createTransferInstruction(sAta, bAta, seller.publicKey, base), SystemProgram.transfer({ fromPubkey: bidder.publicKey, toPubkey: seller.publicKey, lamports: sl }), SystemProgram.transfer({ fromPubkey: bidder.publicKey, toPubkey: treasury, lamports: fee })); return tx }
  assert.equal(verifyFill(build(123456n, 1_990_000_000n, 10_000_000n), e), null)
  assert.match(verifyFill(build(123455n, 1_990_000_000n, 10_000_000n), e), /amount/)
  assert.match(verifyFill(build(123456n, 2_990_000_000n, 10_000_000n), e), /ix2/)
  assert.match(verifyFill(build(123456n, 1_990_000_000n, 0n), e), /ix3/)
  const t = build(123456n, 1_990_000_000n, 10_000_000n); t.add(SystemProgram.transfer({ fromPubkey: bidder.publicKey, toPubkey: seller.publicKey, lamports: 1 })); assert.match(verifyFill(t, e), /count/)
  // seller + bidder co-sign round trip
  const tx = build(123456n, 1_990_000_000n, 10_000_000n); tx.partialSign(seller)
  const wire = tx.serialize({ requireAllSignatures: false }); const tx2 = Transaction.from(wire); tx2.partialSign(bidder)
  assert.equal(tx2.signatures.filter((s) => s.signature).length, 2)
  assert.doesNotThrow(() => tx2.serialize())
})
