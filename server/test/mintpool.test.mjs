import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
process.env.DATA_DIR = '/tmp/banker-mintpool-test-' + Date.now(); process.env.MINT_SUFFIX = 'A'
const MP = await import('../src/mintpool.ts')
test('a popped mint whose launch never went live goes back to the pool; one that went live is spent for good', async () => {
  const grind = () => { for (;;) { const k = Keypair.generate(); if (k.publicKey.toBase58().endsWith('A')) return k } }
  const a = grind(), b = grind(); MP.add(bs58.encode(a.secretKey)); MP.add(bs58.encode(b.secretKey))
  const x = MP.next(), y = MP.next(); assert.equal(MP.stats().available, 0)
  const live = new Set([y.kp.publicKey.toBase58()])
  assert.equal(await MP.reclaim(async (pub) => live.has(pub), 0), 1, 'the dead one comes back')
  assert.equal(MP.stats().available, 1); assert.equal(MP.next().kp.publicKey.toBase58(), x.kp.publicKey.toBase58(), 'same keypair, reusable')
  assert.equal(await MP.reclaim(async () => false, 0), 1, 'only the re-popped dead one can come back — the live one dropped its secret')
  assert.equal(MP.stats().available, 1)
})
