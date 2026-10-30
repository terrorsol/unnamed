// pump fast path (pumpfast.ts): trade events read from logs, the direct sell, its fee guard, expiry handling and self-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, PublicKey, SystemProgram, ComputeBudgetProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, createTransferInstruction } from '@solana/spl-token'
const PF = await import('../src/pumpfast.ts')

const PUMP = PF.PUMP, pda = (seeds, prog = PUMP) => PublicKey.findProgramAddressSync(seeds, prog)[0]
const mint = Keypair.generate().publicKey, creator = Keypair.generate().publicKey, owner = Keypair.generate().publicKey, buyer = Keypair.generate().publicKey
const feeRec = Keypair.generate().publicKey, bb = Keypair.generate().publicKey

function eventB64({ sol = 1_500_000_000n, tokens = 40_000_000_000n, isBuy = true, vSol = 45_000_000_000n, vTok = 700_000_000_000_000n, full = true } = {}) {
  const parts = [Buffer.from('bddb7fd34ee661ee', 'hex'), mint.toBuffer()]
  const u64 = (x) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(x)); return b }
  parts.push(u64(sol), u64(tokens), Buffer.from([isBuy ? 1 : 0]), buyer.toBuffer(), u64(1793360000n), u64(vSol), u64(vTok), u64(15_000_000_000n), u64(500_000_000_000_000n))
  if (full) { parts.push(feeRec.toBuffer(), u64(95), u64(1234), creator.toBuffer(), u64(30), u64(450), Buffer.from([1]), u64(0), u64(0), u64(0), u64(0))
    const ix = Buffer.from('buy'); const n = Buffer.alloc(4); n.writeUInt32LE(ix.length); parts.push(n, ix, Buffer.from([0]), u64(0), u64(0), u64(5), u64(77)) }
  return Buffer.concat(parts).toString('base64')
}

test('the trade event pump writes into its logs gives the exact buy and the curve right after it', () => {
  const e = PF.decodeTradeEvent(eventB64())
  assert.equal(e.mint, mint.toBase58()); assert.equal(e.user, buyer.toBase58()); assert.equal(e.isBuy, true); assert.equal(e.sol, 1.5)
  assert.equal(e.vSol, 45_000_000_000n); assert.equal(e.vTok, 700_000_000_000_000n); assert.equal(e.feeBps, 95); assert.equal(e.creatorFeeBps, 30); assert.equal(e.buybackFeeBps, 5); assert.equal(e.creator, creator.toBase58())
  const short = PF.decodeTradeEvent(eventB64({ full: false })); assert.equal(short.vSol, 45_000_000_000n); assert.equal(short.feeBps, 95)   // an older, shorter event still reads
  assert.equal(PF.decodeTradeEvent(Buffer.from('0011223344556677', 'hex').toString('base64')), null)
  const evs = PF.tradesFromLogs(['Program log: Instruction: Buy', 'Program data: ' + eventB64(), 'Program data: AAAA', 'Program data: ' + eventB64({ isBuy: false })])
  assert.equal(evs.length, 2); assert.equal(evs[1].isBuy, false)
})
test('sellOut matches the curve and rounds against us (never promises a lamport the program will not pay)', () => {
  const vSol = 45_000_000_000n, vTok = 700_000_000_000_000n, amt = 10_000_000_000_000n
  const gross = (amt * vSol) / (vTok + amt); const net = PF.sellOut(vSol, vTok, amt, 130)
  assert.equal(net, gross - (gross * 130n + 9999n) / 10000n); assert.ok(net < gross)
  assert.equal(PF.sellOut(vSol, vTok, 0n, 130), 0n)
  assert.ok(PF.sellOut(vSol, vTok, amt * 2n, 130) > net)   // more tokens, more SOL
})
test('the direct sell: pump IDL order, the creator\'s vault, the owner\'s ATA on the coin\'s token program, recipients from Global', () => {
  const f = { mint: mint.toBase58(), curve: PF.curveOf(mint).toBase58(), creator: creator.toBase58(), tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(), cashback: false, t: 0 }
  const ix = PF.sellIx(owner, f, { fee: [feeRec.toBase58()], buyback: [bb.toBase58()] }, 123n, 45n)
  const k = ix.keys.map((x) => x.pubkey.toBase58())
  assert.deepEqual(k, [pda([Buffer.from('global')]), feeRec, mint, PF.curveOf(mint), getAssociatedTokenAddressSync(mint, PF.curveOf(mint), true, TOKEN_2022_PROGRAM_ID), getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID), owner,
    SystemProgram.programId, pda([Buffer.from('creator-vault'), creator.toBuffer()]), TOKEN_2022_PROGRAM_ID, pda([Buffer.from('__event_authority')]), PUMP, pda([Buffer.from('fee_config'), PUMP.toBuffer()], PF.PUMP_FEES), PF.PUMP_FEES,
    pda([Buffer.from('bonding-curve-v2'), mint.toBuffer()]), bb].map((x) => x.toBase58()))
  assert.equal(ix.keys.filter((x) => x.isSigner).length, 1); assert.ok(ix.keys[6].isSigner && ix.keys[6].isWritable)
  assert.equal(Buffer.from(ix.data).toString('hex').slice(0, 16), '33e685a4017f83ad'); assert.equal(Buffer.from(ix.data).readBigUInt64LE(8), 123n); assert.equal(Buffer.from(ix.data).readBigUInt64LE(16), 45n)
  const cb = PF.sellIx(owner, { ...f, cashback: true }, { fee: [feeRec.toBase58()], buyback: [bb.toBase58()] }, 1n, 1n)
  assert.equal(cb.keys[14].pubkey.toBase58(), pda([Buffer.from('user_volume_accumulator'), owner.toBuffer()]).toBase58())   // cashback coins: the volume accumulator first
})
test('selfCheck: only compute budget, the pump sell and one small tip, the vault the only signer', () => {
  const f = { mint: mint.toBase58(), curve: PF.curveOf(mint).toBase58(), creator: creator.toBase58(), tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(), cashback: false, t: 0 }
  const sell = PF.sellIx(owner, f, { fee: [feeRec.toBase58()], buyback: [bb.toBase58()] }, 1n, 1n)
  const tx = (extra = []) => new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: '11111111111111111111111111111111', instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }), sell, SystemProgram.transfer({ fromPubkey: owner, toPubkey: Keypair.generate().publicKey, lamports: 1_000_000 }), ...extra] }).compileToV0Message())
  assert.doesNotThrow(() => PF.selfCheck(tx(), owner))
  assert.throws(() => PF.selfCheck(tx([SystemProgram.transfer({ fromPubkey: owner, toPubkey: Keypair.generate().publicKey, lamports: 6_000_000 })]), owner), /unexpected/)
  assert.throws(() => PF.selfCheck(tx([createTransferInstruction(Keypair.generate().publicKey, Keypair.generate().publicKey, owner, 1n)]), owner), /unexpected/)
  assert.throws(() => PF.selfCheck(tx(), Keypair.generate().publicKey), /signer/)
})

// fastSell against a fake RPC
function fakeConn({ statuses = ['confirmed'], height = 100, lvh = 1000, fees = [0, 50_000, 80_000, 120_000], vSol = 45_000_000_000n, vTok = 700_000_000_000_000n } = {}) {
  const curve = Buffer.alloc(150); curve.writeBigUInt64LE(vTok, 8); curve.writeBigUInt64LE(vSol, 16); creator.toBuffer().copy(curve, 49)
  const global = Buffer.alloc(1088); feeRec.toBuffer().copy(global, 41); bb.toBuffer().copy(global, 741)
  const sent = []; let n = 0
  return { sent, conn: {
    getMultipleAccountsInfo: async () => [{ owner: PUMP, data: curve, lamports: 1, executable: false }, { owner: TOKEN_2022_PROGRAM_ID, data: Buffer.alloc(82), lamports: 1, executable: false }],
    getAccountInfo: async (k) => (k.equals(pda([Buffer.from('global')])) ? { owner: PUMP, data: global } : { owner: PUMP, data: curve }),
    getRecentPrioritizationFees: async () => fees.map((f, i) => ({ slot: i, prioritizationFee: f })),
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: lvh }),
    sendRawTransaction: async (raw) => { sent.push(raw); return 'x' },
    getSignatureStatuses: async () => ({ value: [statuses[Math.min(n++, statuses.length - 1)] ? { confirmationStatus: statuses[Math.min(n - 1, statuses.length - 1)], err: null } : null] }),
    getBlockHeight: async () => height,
  } }
}
const sign = (tx) => { tx.sign([KP]); return tx }; const KP = Keypair.generate()
test('fastSell: priced from this pool\'s own recent fees, min-out from the event\'s reserves, confirmed → the sale', async () => {
  const mint2 = Keypair.generate().publicKey; const { conn, sent } = fakeConn()
  const r = await PF.fastSell(conn, 'http://localhost:1', KP.publicKey, mint2.toBase58(), 10_000_000_000_000n, { vSol: 45_000_000_000n, vTok: 700_000_000_000_000n, feeBps: 130, slipBps: 300 }, sign)
  assert.ok(sent.length >= 1); assert.ok(r.expectSol > 0.6 && r.expectSol < 0.64, String(r.expectSol)); assert.ok(Math.abs(r.minSol - r.expectSol * 0.97) < 1e-6)
  assert.equal(r.cuPrice, Math.round(120_000 * 1.1))   // p75 of the pool's non-zero fees × 1.1
  const tx = VersionedTransaction.deserialize(sent[0]); PF.selfCheck(tx, KP.publicKey)
  assert.ok(tx.message.staticAccountKeys.some((k) => k.toBase58() === 'jitodontfront111111111111111111111111111111'))   // nothing may be bundled in front of it
})
test('fastSell: the fee guard cuts the CU price to fit 4% of the proceeds, and refuses a sale that cannot carry the tip', async () => {
  const { conn } = fakeConn({ fees: [5_000_000, 5_000_000] })
  const r = await PF.fastSell(conn, 'http://localhost:1', KP.publicKey, Keypair.generate().publicKey.toBase58(), 1_000_000_000_000n, { vSol: 45_000_000_000n, vTok: 700_000_000_000_000n, feeBps: 130 }, sign)
  assert.ok(r.feeLamports <= r.expectSol * 1e9 * 0.04 + 1, `${r.feeLamports} vs ${r.expectSol}`)
  await assert.rejects(PF.fastSell(fakeConn().conn, 'http://localhost:1', KP.publicKey, Keypair.generate().publicKey.toBase58(), 10_000_000_000n, { vSol: 45_000_000_000n, vTok: 700_000_000_000_000n }, sign), (e) => e.code === 'uneconomic')
})
test('fastSell: a blockhash that dies unlanded rejects as expired with NO signature (it can never land: nothing to book, safe to retry)', async () => {
  const { conn } = fakeConn({ statuses: [null], height: 2000, lvh: 1000 })
  await assert.rejects(PF.fastSell(conn, 'http://localhost:1', KP.publicKey, Keypair.generate().publicKey.toBase58(), 10_000_000_000_000n, { vSol: 45_000_000_000n, vTok: 700_000_000_000_000n }, sign), (e) => e.expired === true && e.sig === undefined)
})

// the sniper tax policy (mm.ts)
const MM = await import('../src/mm.ts')
test('sniper tax: half of every buy in the window sold straight back, never under cost, keeps its reserve, off after the window', () => {
  const P = { ...MM.P, sniperFrac: 0.5, sniperWindowMs: 20_000, sniperMinBuy: 0.03, sniperKeep: 0.15, poolImpactMax: 0.10, captureOn: true }
  const s = { chest: 0, tokens: 100_000_000, supply: 1e9, pct: 10, avgCost: 4 / 100_000_000, mode: 'mm', ceiling: 0.3, samples: [], high15: [], ema5: null, ema15: null, spentEpisode: 0, tranchesFired: [], lastBuy: 0, trimmedToday: 0, trimDay: 0, buyTimes: [], lastCapture: 0, launchAt: 1_000, launchTok: 100_000_000, sniperTax: true }
  const p = 1e-7, m = { priceSol: p, mcapUsd: 0, liqSol: 60 }
  assert.ok(MM.sniperOn(s, 5_000, P)); assert.ok(!MM.sniperOn(s, 25_000, P)); assert.ok(!MM.sniperOn({ ...s, sniperTax: false }, 5_000, P))
  assert.equal(MM.capture(s, m, p, 2, 5_000, P), 2 * 0.5 / p)                                  // 2 SOL buy → 1 SOL of tokens
  assert.equal(MM.capture(s, { ...m, liqSol: 5 }, p, 2, 5_000, P), 5 * 0.10 / p)              // capped at 10% of the pool
  assert.equal(MM.capture({ ...s, tokens: 20_000_000 }, m, p, 2, 5_000, P), 20_000_000 - 15_000_000)   // keeps 15% of the block-zero tokens
  assert.equal(MM.capture(s, m, 3.9 / 100_000_000, 2, 5_000, P), 0)                          // under cost +1%: nothing
  assert.equal(MM.capture(s, m, p, 0.02, 5_000, P), 0)                                       // too small to be worth the fees
  assert.ok(MM.perBuyOn(s, P, 5_000))
})
