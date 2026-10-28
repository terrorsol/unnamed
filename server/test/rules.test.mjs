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
test('trim caps: per-trim, per-day, per-volume', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≈ ${b}`)
  near(R.trimSize(1000, 0, 1000, 0.001), 20)          // 2% of position wins
  near(R.trimSize(1000, 45, 1000, 0.001), 5)          // day cap: 50 - 45
  near(R.trimSize(1000, 0, 0.1, 0.001), 10)           // vol cap: 0.1*0.1/0.001 = 10
  near(R.trimSize(1000, 50, 1000, 0.001), 0)
})
test('mm capture curve', () => {
  assert.equal(R.captureFrac(0.9, 1, 0.5, 500_000, 0.3, 0.5), 0)            // below vwap: never
  assert.equal(R.captureFrac(1.01, 1, 1.0, 500_000, 0.3, 0.5), 0)           // not above cost+2%: never
  const at = R.captureFrac(1.0001, 1, 0.5, 500_000, 0.3, 0.5); assert.ok(at > 0.09 && at < 0.11)
  const s20 = R.captureFrac(1.2, 1, 0.5, 500_000, 0.3, 0.5); assert.ok(Math.abs(s20 - 0.18) < 0.01)
  const s50 = R.captureFrac(1.5, 1, 0.5, 500_000, 0.3, 0.5); assert.ok(Math.abs(s50 - 0.30) < 0.01)
  assert.ok(Math.abs(R.captureFrac(1.5, 1, 0.5, 50_000, 0.3, 0.5) - 0.15) < 0.01)   // early tier ×0.5
  assert.ok(Math.abs(R.captureFrac(1.5, 1, 0.5, 5_000_000, 0.3, 0.5) - 0.225) < 0.01) // large ×0.75
  assert.ok(R.captureFrac(1.5, 1, 0.5, 500_000, 0.2, 0.5) <= 0.2)             // dev ceiling
  assert.equal(R.triggerRate(0), 0.4); assert.equal(R.triggerRate(10), 0.7); assert.ok(Math.abs(R.triggerRate(5) - 0.55) < 1e-9)
})
test('mm v2: inventory skew, vol-aware desk discount, z-stretch', () => {
  assert.equal(R.inventorySkew(10, 10).capture, 1); assert.ok(R.inventorySkew(20, 10).capture > 1 && R.inventorySkew(20, 10).defend < 1); assert.ok(R.inventorySkew(2, 10).capture < 1)
  assert.equal(R.deskDiscountBps(0), 400); assert.equal(R.deskDiscountBps(0.5), 400)
  const calm = R.captureFracV2(1.05, 1, 0.5, 5e5, 0.02, 10, 10, 0.3, 0.5), wild = R.captureFracV2(1.05, 1, 0.5, 5e5, 0.3, 10, 10, 0.3, 0.5)
  assert.ok(calm > wild, 'same +5% is more stretched on a calm coin')
  assert.equal(R.captureFracV2(0.95, 1, 0.5, 5e5, 0.1, 10, 10), 0)
  const long = R.captureFracV2(1.2, 1, 0.5, 5e5, 0.1, 25, 10, 0.3, 0.5), short = R.captureFracV2(1.2, 1, 0.5, 5e5, 0.1, 4, 10, 0.3, 0.5); assert.ok(long > short)
  const t = Date.now(); const samples = Array.from({ length: 31 }, (_, i) => ({ t: t + i * 60000, p: 1 + 0.05 * Math.sin(i) })); assert.ok(R.sigma(samples) > 0.05 && R.sigma(samples) < 0.5)
})
test('otc fairness constants', () => { assert.ok(R.COUNTER_MAX_BPS <= 1000); assert.ok(R.SELLER_DRIFT >= 0.03 && R.SELLER_DRIFT <= 0.1); assert.ok(R.QUOTE_MAX_AGE_MS <= 2000); assert.equal(R.minBlockSol({ mcapUsd: 1e6, liqSol: 100, onCurve: false, priceSol: 1e-5 }), 2) })
