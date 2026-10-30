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

test('block-zero math matches PumpPortal to the lamport (real bundle from preflight: 0.05 dev, 0.1 vault)', () => {
  const z = blockZero(0.05, 0.1)
  assert.ok(Math.abs(z.devTokens - 1785357.737104) < 1e-3, 'dev tokens ' + z.devTokens)
  assert.ok(Math.abs(z.vaultTokens - 3552950.720606) < 1e-3, 'vault tokens ' + z.vaultTokens)
  const { bundleCost } = { bundleCost: (d, v) => import('../src/launch.ts').then((L) => L.bundleCost(d, v)) }
  return bundleCost(1785357.737104, 3552950.720606).then((r) => { assert.ok(Math.abs(r.sol - 0.1) < 1e-9, 'real SOL ' + r.sol); assert.ok(Math.abs(r.cost - 0.101) < 1e-9, 'with 1% fee ' + r.cost) })
})
test('block-zero shape: second buyer pays more, mcap after ≈ 30 + SOL in', () => {
  const z = blockZero(1, 1)
  assert.ok(z.vaultTokens < z.devTokens && z.vaultAvgCost > 1 / z.devTokens)
  assert.ok(z.mcapSol > 31.7 && z.mcapSol < 31.9, 'mcap after 2 SOL in: 32 × 1e9/vTok ≈ 31.8 — ' + z.mcapSol)
  assert.equal(blockZero(0, 0).vaultTokens, 0)
  const one = curveBuy({ vSol: CURVE0.vSol, vTok: CURVE0.vTok }, 1); assert.ok(Math.abs(one.cost - 1.01) < 1e-12)
})

test('inspectBuy accepts the PumpPortal shape and reports the real max SOL out', () => {
  const t = tx([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }), ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }), buyIx(30e6, 1.1), SystemProgram.transfer({ fromPubkey: vault.publicKey, toPubkey: new PublicKey(JITO_TIPS[0]), lamports: 1e6 })])
  const b = inspectBuy(t, vault.publicKey.toBase58(), mint.toBase58())
  assert.equal(b.tokens, 30e6); assert.equal(b.maxSolCost, 1.1); assert.equal(b.tipSol, 0.001); assert.ok(Math.abs(b.solOut - (1.1 * 1.005 + 0.001)) < 1e-9); assert.equal(b.via, 'pump')
  assert.deepEqual(b.ixs, ['compute', 'compute', 'buy', 'tip'])
})

test('inspectBuy refuses: wrong mint, other wallet credited, SOL to a stranger, second signer, unknown program, a create', () => {
  const me = vault.publicKey.toBase58(), m = mint.toBase58()
  assert.throws(() => inspectBuy(tx([buyIx(1e6, 0.1, vault.publicKey, dummy())]), me, m), /reference the mint/)
  assert.throws(() => inspectBuy(tx([buyIx(1e6, 0.1, dummy())]), me, m), /signer|different wallet/)
  assert.throws(() => inspectBuy(tx([buyIx(1e6, 0.1), SystemProgram.transfer({ fromPubkey: vault.publicKey, toPubkey: dummy(), lamports: 5e8 })]), me, m), /non-tip/)
  assert.throws(() => inspectBuy(tx([buyIx(1e6, 0.1), new TransactionInstruction({ programId: dummy(), keys: [], data: Buffer.alloc(1) })]), me, m), /unexpected program/)
  assert.throws(() => inspectBuy(tx([new TransactionInstruction({ programId: PUMP_PROGRAM, keys: [{ pubkey: mint, isSigner: false, isWritable: true }], data: Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]) })]), me, m), /create/)
  assert.throws(() => inspectBuy(tx([new TransactionInstruction({ programId: PUMP_PROGRAM, keys: [{ pubkey: mint, isSigner: false, isWritable: true }], data: Buffer.from('d6904cec5f8b31b4', 'hex') })]), me, m), /create/)
  assert.throws(() => inspectBuy(tx([ComputeBudgetProgram.setComputeUnitLimit({ units: 1 })]), me, m), /no pump buy/)
  const other = Keypair.generate(); assert.throws(() => inspectBuy(tx([buyIx(1e6, 0.1, other.publicKey)], other.publicKey), me, m), /fee payer/)
})

test('inspectBuy accepts the PumpPortal wrapper buy (their program, same data layout)', async () => {
  const { PUMPPORTAL_PROGRAM } = await import('../src/launch.ts')
  const keys = [dummy(), new PublicKey(PUMP_PROGRAM), mint, dummy(), vault.publicKey, dummy()].map((k) => ({ pubkey: k, isSigner: k.equals(vault.publicKey), isWritable: true }))
  const ix = new TransactionInstruction({ programId: new PublicKey(PUMPPORTAL_PROGRAM), keys, data: Buffer.concat([Buffer.from('66323d1201daebea', 'hex'), u64(5e6 * 1e6), u64(0.25e9)]) })
  const b = inspectBuy(tx([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }), ix]), vault.publicKey.toBase58(), mint.toBase58())
  assert.equal(b.via, 'pumpportal'); assert.equal(b.tokens, 5e6); assert.equal(b.maxSolCost, 0.25)
})

test('inspectCreate finds the create + dev buy', () => {
  const create = new TransactionInstruction({ programId: PUMP_PROGRAM, keys: [{ pubkey: mint, isSigner: true, isWritable: true }, { pubkey: vault.publicKey, isSigner: true, isWritable: true }], data: Buffer.concat([Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]), Buffer.alloc(4)]) })
  const c = inspectCreate(tx([create, buyIx(34e6, 1.05)]), mint.toBase58())
  assert.equal(c.created, 'create'); assert.equal(c.buy.tokens, 34e6); assert.equal(c.signers, 2)
  assert.throws(() => inspectCreate(tx([buyIx(1e6, 0.1)]), mint.toBase58()), /no create/)
})
test('setMaxSolCost tightens the PumpPortal-padded ceiling in place, before signing', async () => {
  const { setMaxSolCost } = await import('../src/launch.ts')
  const t = tx([ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }), buyIx(3.5, 0.303)])
  assert.equal(inspectBuy(t, vault.publicKey.toBase58(), mint.toBase58()).maxSolCost, 0.303)
  assert.ok(setMaxSolCost(t, 0.1062))
  const b = inspectBuy(t, vault.publicKey.toBase58(), mint.toBase58()); assert.ok(Math.abs(b.maxSolCost - 0.1062) < 1e-9); assert.ok(Math.abs(b.tokens - 3.5) < 1e-9)
  t.sign([vault]); assert.ok(VersionedTransaction.deserialize(t.serialize()).signatures[0].some((x) => x))
  assert.equal(setMaxSolCost(tx([ComputeBudgetProgram.setComputeUnitLimit({ units: 1 })]), 1), false)
})
