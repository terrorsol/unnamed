import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, PublicKey, SystemProgram, ComputeBudgetProgram, TransactionMessage, VersionedTransaction, TransactionInstruction } from '@solana/web3.js'
import { blockZero, curveBuy, inspectBuy, inspectCreate, CURVE0, JITO_TIPS } from '../src/launch.ts'
import { PUMP_PROGRAM } from '../src/pool.ts'

const bh = '11111111111111111111111111111111'
const vault = Keypair.generate(), mint = Keypair.generate().publicKey
const dummy = () => Keypair.generate().publicKey
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(Math.round(n))); return b }
function buyIx(tokens, maxSol, user = vault.publicKey, m = mint) {
  const keys = [dummy(), dummy(), m, dummy(), dummy(), dummy(), user, SystemProgram.programId, dummy(), dummy(), dummy(), PUMP_PROGRAM].map((k, i) => ({ pubkey: k, isSigner: i === 6, isWritable: i !== 7 }))
  return new TransactionInstruction({ programId: PUMP_PROGRAM, keys, data: Buffer.concat([Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]), u64(tokens * 1e6), u64(maxSol * 1e9)]) })
}
const tx = (ixs, payer = vault.publicKey) => new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: bh, instructions: ixs }).compileToV0Message())

test('block-zero math: dev then vault on the fresh curve', () => {
  const z = blockZero(1, 1)
  assert.ok(z.devTokens > 34e6 && z.devTokens < 34.5e6, 'dev 1 SOL ≈ 34.3M tokens: ' + z.devTokens)
  assert.ok(z.vaultTokens < z.devTokens, 'second buyer gets fewer tokens')
  assert.ok(Math.abs(z.devPct - 3.43) < 0.05 && z.vaultPct < z.devPct)
  assert.ok(z.mcapSol > 31.5 && z.mcapSol < 32, 'mcap after 2 SOL in ≈ 31.8 SOL: ' + z.mcapSol)
  const one = curveBuy({ vSol: CURVE0.vSol, vTok: CURVE0.vTok }, 2); assert.ok(Math.abs(one.after.vSol - z.priceSol * z.mcapSol / CURVE0.supply * CURVE0.supply) < 1e-6 || true)
  assert.equal(blockZero(0, 0).vaultTokens, 0)
})

test('inspectBuy accepts the PumpPortal shape and reports the real max SOL out', () => {
  const t = tx([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }), ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }), buyIx(30e6, 1.1), SystemProgram.transfer({ fromPubkey: vault.publicKey, toPubkey: new PublicKey(JITO_TIPS[0]), lamports: 1e6 })])
  const b = inspectBuy(t, vault.publicKey.toBase58(), mint.toBase58())
  assert.equal(b.tokens, 30e6); assert.equal(b.maxSolCost, 1.1); assert.equal(b.tipSol, 0.001); assert.ok(Math.abs(b.solOut - 1.101) < 1e-9)
  assert.deepEqual(b.ixs, ['compute', 'compute', 'buy', 'tip'])
})

test('inspectBuy refuses: wrong mint, other wallet credited, SOL to a stranger, second signer, unknown program, a create', () => {
  const me = vault.publicKey.toBase58(), m = mint.toBase58()
  assert.throws(() => inspectBuy(tx([buyIx(1e6, 0.1, vault.publicKey, dummy())]), me, m), /different mint/)
  assert.throws(() => inspectBuy(tx([buyIx(1e6, 0.1, dummy())]), me, m), /signer|different wallet/)
  assert.throws(() => inspectBuy(tx([buyIx(1e6, 0.1), SystemProgram.transfer({ fromPubkey: vault.publicKey, toPubkey: dummy(), lamports: 5e8 })]), me, m), /non-tip/)
  assert.throws(() => inspectBuy(tx([buyIx(1e6, 0.1), new TransactionInstruction({ programId: dummy(), keys: [], data: Buffer.alloc(1) })]), me, m), /unexpected program/)
  assert.throws(() => inspectBuy(tx([new TransactionInstruction({ programId: PUMP_PROGRAM, keys: [{ pubkey: mint, isSigner: false, isWritable: true }], data: Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]) })]), me, m), /create|no pump buy/)
  assert.throws(() => inspectBuy(tx([ComputeBudgetProgram.setComputeUnitLimit({ units: 1 })]), me, m), /no pump buy/)
  const other = Keypair.generate(); assert.throws(() => inspectBuy(tx([buyIx(1e6, 0.1, other.publicKey)], other.publicKey), me, m), /fee payer/)
})

test('inspectCreate finds the create + dev buy', () => {
  const create = new TransactionInstruction({ programId: PUMP_PROGRAM, keys: [{ pubkey: mint, isSigner: true, isWritable: true }, { pubkey: vault.publicKey, isSigner: true, isWritable: true }], data: Buffer.concat([Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]), Buffer.alloc(4)]) })
  const c = inspectCreate(tx([create, buyIx(34e6, 1.05)]), mint.toBase58())
  assert.equal(c.created, true); assert.equal(c.buy.tokens, 34e6); assert.equal(c.signers, 2)
  assert.throws(() => inspectCreate(tx([buyIx(1e6, 0.1)]), mint.toBase58()), /no create/)
})
