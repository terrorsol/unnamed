import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import nacl from 'tweetnacl'
import bs58 from 'bs58'
process.env.DATA_DIR = '/tmp/banker-invite-test-' + Date.now()
const INV = await import('../src/invite.ts')
const sign = (kp, msg) => bs58.encode(nacl.sign.detached(new TextEncoder().encode(msg), kp.secretKey))
test('invite keys: mint, redeem binds to the first wallet, second wallet refused, session resolves, bad key counted', () => {
  const [a, b] = INV.mint(2, 'test'); assert.match(a, /^BANK-[A-Z2-9]{4}-[A-Z2-9]{4}$/); assert.notEqual(a, b)
  const w1 = Keypair.generate(), w2 = Keypair.generate(); const min = Math.floor(Date.now() / 60000)
  const m1 = `banker:invite:${w1.publicKey.toBase58()}:${min}`
  const r = INV.redeem(a.toLowerCase(), w1.publicKey.toBase58(), m1, sign(w1, m1), '1.1.1.1')
  assert.equal(INV.session(r.token), w1.publicKey.toBase58(), 'session maps to the wallet')
  const m2 = `banker:invite:${w2.publicKey.toBase58()}:${min}`
  assert.throws(() => INV.redeem(a, w2.publicKey.toBase58(), m2, sign(w2, m2), '1.1.1.2'), /already in use/)
  const r2 = INV.redeem(a, w1.publicKey.toBase58(), m1, sign(w1, m1), '1.1.1.1'); assert.equal(INV.session(r2.token), w1.publicKey.toBase58(), 'same wallet can redeem again (new device)')
  assert.throws(() => INV.redeem('BANK-NOPE-NOPE', w2.publicKey.toBase58(), m2, sign(w2, m2), '1.1.1.3'), /not valid/)
  assert.throws(() => INV.redeem(b, w2.publicKey.toBase58(), m2, sign(w1, m2), '1.1.1.3'), /bad signature/)
  assert.equal(INV.session('nope'), null); assert.equal(INV.stats().redeemed, 1)
})
