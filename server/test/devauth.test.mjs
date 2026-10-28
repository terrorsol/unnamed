import test from 'node:test'
import assert from 'node:assert/strict'
import nacl from 'tweetnacl'
import bs58 from 'bs58'
import { Keypair } from '@solana/web3.js'
import { devAuth } from '../src/auth.ts'

const dev = Keypair.generate(); const v = { id: 'abc', dev: dev.publicKey.toBase58() }
const sign = (msg) => ({ msg, sig: bs58.encode(nacl.sign.detached(new TextEncoder().encode(msg), dev.secretKey)) })
const minute = () => Math.floor(Date.now() / 60000)

test('dev auth: a fresh signature from the vault dev passes', () => { assert.doesNotThrow(() => devAuth(v, 'launch', v.dev, sign(`unnamed:launch:abc:${v.dev}:${minute()}`))) })
test('dev auth: wrong action, vault, mint, stale, other signer, or missing all fail', () => {
  assert.throws(() => devAuth(v, 'launch', v.dev, undefined), /required/)
  assert.throws(() => devAuth(v, 'arm', 'MINT', sign(`unnamed:launch:abc:MINT:${minute()}`)), /match/)
  assert.throws(() => devAuth(v, 'arm', 'MINT', sign(`unnamed:arm:zzz:MINT:${minute()}`)), /match/)
  assert.throws(() => devAuth(v, 'arm', 'MINT', sign(`unnamed:arm:abc:OTHER:${minute()}`)), /match/)
  assert.throws(() => devAuth(v, 'arm', 'MINT', sign(`unnamed:arm:abc:MINT:${minute() - 30}`)), /expired/)
  const other = Keypair.generate(); const m = `unnamed:arm:abc:MINT:${minute()}`
  assert.throws(() => devAuth(v, 'arm', 'MINT', { msg: m, sig: bs58.encode(nacl.sign.detached(new TextEncoder().encode(m), other.secretKey)) }), /bad dev signature/)
})
