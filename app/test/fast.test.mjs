import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js'
import { addTip, senderUrl, TIP_ACCOUNTS, MIN_TIP_LAMPORTS } from '../src/lib/fast.ts'

const bh = '11111111111111111111111111111111'
const payer = Keypair.generate(), other = Keypair.generate()
const ixs = () => [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }), SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: other.publicKey, lamports: 1000 })]
const conn = { getAddressLookupTable: async () => ({ value: null }) }

test('senderUrl lifts the api key off the RPC url', () => {
  assert.equal(senderUrl('https://mainnet.helius-rpc.com/?api-key=abc-123'), 'https://sender.helius-rpc.com/fast?api-key=abc-123')
  assert.equal(senderUrl('https://api.mainnet-beta.solana.com'), 'https://sender.helius-rpc.com/fast')
  assert.equal(senderUrl('https://x/?api-key=k', true), 'https://sender.helius-rpc.com/fast?api-key=k&swqos_only=true')
})

test('addTip appends a tip transfer to a v0 tx and keeps payer/blockhash/instructions', async () => {
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: bh, instructions: ixs() }).compileToV0Message()
  const tx = new VersionedTransaction(msg)
  const out = await addTip(conn, tx, payer.publicKey, MIN_TIP_LAMPORTS)
  assert.equal(out.message.version, 0)
  assert.equal(out.message.recentBlockhash, bh)
  assert.equal(out.message.compiledInstructions.length, 3)
  const keys = out.message.staticAccountKeys.map((k) => k.toBase58())
  assert.equal(keys[0], payer.publicKey.toBase58())
  assert.ok(TIP_ACCOUNTS.some((t) => keys.includes(t)), 'a Sender tip account is in the key list')
  const tip = out.message.compiledInstructions[2]
  assert.equal(keys[tip.programIdIndex], SystemProgram.programId.toBase58())
  // transfer data: u32 instruction index 2, then u64 lamports LE
  const data = Buffer.from(tip.data); assert.equal(data.readUInt32LE(0), 2); assert.equal(Number(data.readBigUInt64LE(4)), MIN_TIP_LAMPORTS)
  out.sign([payer]); assert.ok(out.serialize().length > 0, 'signs and serializes')
})

test('addTip handles legacy txs and a zero tip is a no-op', async () => {
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: bh, instructions: ixs() }).compileToLegacyMessage()
  const tx = new VersionedTransaction(msg)
  const out = await addTip(conn, tx, payer.publicKey, 5_000_000)
  assert.equal(out.message.version, 'legacy'); assert.equal(out.message.compiledInstructions.length, 3)
  assert.equal(await addTip(conn, tx, payer.publicKey, 0), tx)
})
