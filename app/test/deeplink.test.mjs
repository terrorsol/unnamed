import test from 'node:test'
import assert from 'node:assert/strict'
import nacl from 'tweetnacl'
import bs58 from 'bs58'
import { newSecret, pubOf, sharedKey, seal, open, link } from '../src/lib/dlcrypto.ts'

// play the wallet's side of the protocol with its own keypair
const wallet = nacl.box.keyPair()
const walletPub = bs58.encode(wallet.publicKey)

test('request we seal is readable by the wallet', () => {
  const dapp = newSecret(); const dappPub = pubOf(dapp)
  const { nonce, payload } = seal({ transaction: 'abc', session: 's1' }, sharedKey(walletPub, dapp))
  const out = nacl.box.open(bs58.decode(payload), bs58.decode(nonce), bs58.decode(dappPub), wallet.secretKey)
  assert.deepEqual(JSON.parse(new TextDecoder().decode(out)), { transaction: 'abc', session: 's1' })
})
test('answer the wallet seals is readable by us; tampering is caught', () => {
  const dapp = newSecret(); const dappPub = pubOf(dapp)
  const n = nacl.randomBytes(24); const box = nacl.box(new TextEncoder().encode(JSON.stringify({ public_key: 'PK', session: 'S' })), n, bs58.decode(dappPub), wallet.secretKey)
  const sh = sharedKey(walletPub, dapp)
  assert.deepEqual(open(bs58.encode(box), bs58.encode(n), sh), { public_key: 'PK', session: 'S' })
  box[3] ^= 1; assert.throws(() => open(bs58.encode(box), bs58.encode(n), sh))
})
test('links carry the method and come back to banker://wallet/<method>', () => {
  const u = new URL(link('https://phantom.app/ul/v1', 'signTransaction', { nonce: 'n', payload: 'p', dapp_encryption_public_key: 'k' }))
  assert.equal(u.pathname, '/ul/v1/signTransaction')
  assert.equal(u.searchParams.get('redirect_link'), 'banker://wallet/signTransaction')
  assert.equal(u.searchParams.get('payload'), 'p')
})
