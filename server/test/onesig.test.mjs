// One-signature launch: the dev's stake is appended to the create tx the server mint-signs, so the wallet signs once and nothing moves
// unless the bundle lands. These check the tx surgery itself; the real SDK create (size, simulate, Jito) is covered by the mainnet preflight.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, PublicKey, SystemProgram, ComputeBudgetProgram, TransactionMessage, VersionedTransaction, TransactionInstruction, SystemInstruction } from '@solana/web3.js'
import { appendTransfer } from '../src/launchlab.ts'

const bh = '11111111111111111111111111111111'
const dev = Keypair.generate(), mint = Keypair.generate(), vault = Keypair.generate().publicKey
const prog = Keypair.generate().publicKey
// a create-shaped tx: compute budget + one big program ix with 18 accounts (mint signer) + a dev-buy-shaped ix
function createTx(nAcc = 18) {
  const keys = [{ pubkey: dev.publicKey, isSigner: true, isWritable: true }, { pubkey: mint.publicKey, isSigner: true, isWritable: true }, ...Array.from({ length: nAcc }, () => ({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: Math.random() > 0.5 }))]
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    new TransactionInstruction({ programId: prog, keys, data: Buffer.alloc(160, 7) }), new TransactionInstruction({ programId: prog, keys: keys.slice(0, 12), data: Buffer.alloc(24, 3) })]
  return new VersionedTransaction(new TransactionMessage({ payerKey: dev.publicKey, recentBlockhash: bh, instructions: ixs }).compileToV0Message())
}

test('the stake transfer is appended to the create: same payer, mint still signs, original instructions kept in order', () => {
  const t = createTx(); const before = TransactionMessage.decompile(t.message)
  const nt = appendTransfer(t, [], dev.publicKey, vault, 7.5e9)
  assert.equal(nt.message.staticAccountKeys[0].toBase58(), dev.publicKey.toBase58())
  assert.equal(nt.message.header.numRequiredSignatures, 2)
  assert.ok(nt.message.staticAccountKeys.slice(0, 2).some((k) => k.equals(mint.publicKey)), 'mint stays a required signer')
  const after = TransactionMessage.decompile(nt.message)
  assert.equal(after.instructions.length, before.instructions.length + 1)
  for (const [i, ix] of before.instructions.entries()) { assert.ok(after.instructions[i].programId.equals(ix.programId)); assert.deepEqual(Buffer.from(after.instructions[i].data), Buffer.from(ix.data)) }
  const last = after.instructions.at(-1); assert.ok(last.programId.equals(SystemProgram.programId))
  const d = SystemInstruction.decodeTransfer(last); assert.ok(d.fromPubkey.equals(dev.publicKey)); assert.ok(d.toPubkey.equals(vault)); assert.equal(Number(d.lamports), 7.5e9)
})

test('signing works after the surgery (dev + mint), and the size stays under a packet', () => {
  const nt = appendTransfer(createTx(), [], dev.publicKey, vault, 1e9)
  nt.message.recentBlockhash = bh; nt.sign([mint]); nt.sign([dev])
  assert.ok(nt.signatures.every((s) => s.some((b) => b)), 'both signatures present')
  assert.ok(nt.serialize().length <= 1232)
})

test('refuses a transfer from anyone but the fee payer, a bad amount, or a tx that would no longer fit', () => {
  assert.throws(() => appendTransfer(createTx(), [], Keypair.generate().publicKey, vault, 1e9), /fee payer/)
  assert.throws(() => appendTransfer(createTx(), [], dev.publicKey, vault, 0), /bad stake/)
  assert.throws(() => appendTransfer(createTx(), [], dev.publicKey, vault, NaN), /bad stake/)
  assert.throws(() => appendTransfer(createTx(29), [], dev.publicKey, vault, 1e9), /max 1232/)
})
