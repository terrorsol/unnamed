// The one-signature launch, server side, end to end with the chain faked: build (stake inside the create) → bundle lands → arm books the
// stake from the create tx and the block-zero buy from the vault tx, exactly once, even when the app's arm and autoArm race.
// LaunchLab is mocked (module mock); the shared Connection object is patched per method. Run with --experimental-test-module-mocks.
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, PublicKey, VersionedTransaction, TransactionMessage, SystemProgram } from '@solana/web3.js'
import bs58 from 'bs58'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'vaultflow-'))
const SHARED = Keypair.generate(); process.env.VAULT_KEY = bs58.encode(SHARED.secretKey)
process.env.PROFIT_ONLY = '1'; process.env.PROFIT_LAUNCH_BUY_SOL = '9'; process.env.TEST_MAX_CHEST_SOL = '10'; process.env.VAMPS = '0'
const dev = Keypair.generate(); let mintKp = Keypair.generate(); let MINT = mintKp.publicKey.toBase58(); const BANKY = SHARED.publicKey.toBase58()
const bh = '11111111111111111111111111111111'
const DEVPK = dev.publicKey.toBase58()

// ---- fake chain ----
const parsed = new Map()          // sig → parsed tx (keys + pre/post lamports)
let poolLive = false, vaultTokens = 0
const createSigs = []             // signatures in the order they landed on the mint
const land = (tx, deltas) => { const sig = bs58.encode(tx.signatures[0]); const keys = [...new Set([...tx.message.staticAccountKeys.map((k) => k.toBase58()), ...Object.keys(deltas)])]
  parsed.set(sig, { meta: { err: null, preBalances: keys.map(() => 100e9), postBalances: keys.map((k) => 100e9 + Math.round((deltas[k] || 0) * 1e9)) }, transaction: { message: { accountKeys: keys.map((k) => ({ pubkey: new PublicKey(k) })) } } }); return sig }

mock.module('../src/launchlab.ts', { namedExports: {
  PLATFORM_ID: Keypair.generate().publicKey, TAX_BPS: 200, CURVE_CUSTOM: false,
  status: () => ({ venue: 'launchlab' }), isOurs: () => true, platformKeypair: () => SHARED, platformVaultSol: async () => 0,
  pool: async (m) => (poolLive && m === MINT ? { poolId: 'POOL', status: 0, creator: DEVPK, liqSol: 45, priceSol: 1e-7, realB: 0n } : null),
  quote: (_s, solIn) => ({ tokens: solIn * 27e6, after: { virtualA: 1073025605596382n, virtualB: 30000852951n, realA: 0n, realB: BigInt(Math.round((0.5 + solIn) * 0.977e9)) } }),
  buildTrade: async (owner) => new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: bh, instructions: [SystemProgram.transfer({ fromPubkey: owner, toPubkey: new PublicKey('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5'), lamports: 5e6 })] }).compileToV0Message()),
  buildLaunch: async (devPk, _meta, devBuy) => {
    mintKp = Keypair.generate(); MINT = mintKp.publicKey.toBase58()   // every launch is a new coin (as with the real mint pool)
    const txs = [new VersionedTransaction(new TransactionMessage({ payerKey: devPk, recentBlockhash: bh, instructions: [SystemProgram.createAccount({ fromPubkey: devPk, newAccountPubkey: mintKp.publicKey, lamports: 1e6, space: 82, programId: SystemProgram.programId })] }).compileToV0Message())]
    const restamp = (b) => { for (const t of txs) { t.message.recentBlockhash = b; t.sign([mintKp]) } return txs.map((t) => Buffer.from(t.serialize()).toString('base64')) }
    const addTransfer = async (to, lamports) => { const m = TransactionMessage.decompile(txs[0].message); m.instructions.push(SystemProgram.transfer({ fromPubkey: devPk, toPubkey: to, lamports })); txs[0] = new VersionedTransaction(m.compileToV0Message()); return txs[0].serialize().length }
    return { mint: MINT, poolId: 'POOL', txs: restamp(bh), restamp, addTransfer, devTokens: devBuy * 30e6, devCostSol: devBuy, afterDev: { virtualA: 1073025605596382n, virtualB: 30000852951n, realA: 0n, realB: 0n }, permTax: 0 }
  },
} })

const C = await import('../src/chain.ts')
Object.assign(C.conn, {
  getLatestBlockhash: async () => ({ blockhash: bh, lastValidBlockHeight: 1 }),
  getParsedTransaction: async (sig) => parsed.get(sig) || null,
  getSignatureStatuses: async (sigs) => ({ value: sigs.map((s) => (parsed.has(s) ? { confirmationStatus: 'confirmed', err: null } : null)) }),
  getSignaturesForAddress: async () => createSigs.map((signature) => ({ signature, slot: 7, err: null })).reverse(),
  getTokenSupply: async () => ({ value: { uiAmount: 1e9, decimals: 6 } }),
  getParsedTokenAccountsByOwner: async () => ({ value: vaultTokens ? [{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: vaultTokens, amount: String(vaultTokens * 1e6) } } } } } }] : [] }),
  getAccountInfo: async () => null, getBalance: async () => 0,
})
const V = await import('../src/vault.ts')

const STAKE = 7.79, BUY = 7.29
async function launch() {
  const v = V.create(DEVPK, STAKE, undefined, 'mm', 0.3, 'launchlab', BUY, 20)
  const b = await V.buildLaunch({ dev: DEVPK, name: 'Bank', symbol: 'BANK', uri: 'u', devBuySol: 0.5, vaultId: v.id, vaultBuySol: BUY, fundInBundle: true, auth: { sessionWallet: DEVPK } })
  return { v, b }
}

test('build: the stake rides inside the create (dev → shared vault wallet) and nothing is booked before it lands', async () => {
  const { v, b } = await launch()
  assert.equal(b.fundSol, STAKE)
  const ct = VersionedTransaction.deserialize(Buffer.from(b.txs[0], 'base64'))
  const m = TransactionMessage.decompile(ct.message); const tr = m.instructions.at(-1)
  assert.ok(tr.programId.equals(SystemProgram.programId)); assert.equal(tr.keys[0].pubkey.toBase58(), DEVPK); assert.equal(tr.keys[1].pubkey.toBase58(), BANKY)
  assert.equal(Number(tr.data.readBigUInt64LE(4)), Math.round(STAKE * 1e9))
  assert.ok(ct.signatures[1].some((x) => x), 'mint signed after the stake went in')
  assert.ok(b.vaultTx, 'the vault buy is signed for the bundle'); assert.ok(b.vaultSpend > 7 && b.vaultSpend <= BUY)
})

test('arm after landing: stake booked from the create, block-zero buy booked once — even with two arms racing', async () => {
  const { v, b } = await launch()
  const ct = VersionedTransaction.deserialize(Buffer.from(b.txs[0], 'base64')); ct.sign([dev])
  const vt = VersionedTransaction.deserialize(Buffer.from(b.vaultTx, 'base64'))
  const createSig = land(ct, { [DEVPK]: -(STAKE + 0.5 + 0.02), [BANKY]: +STAKE }); createSigs.push(createSig)
  land(vt, { [BANKY]: -(b.vaultSpend + 0.005 + 0.00001) })
  poolLive = true; vaultTokens = 197e6
  const [a1, a2] = await Promise.all([V.arm(v.id, MINT, 'BANK', 'Bank', { sessionWallet: DEVPK }, createSig), V.arm(v.id, MINT, 'BANK', 'Bank', { sessionWallet: DEVPK })])
  assert.equal(a1.armed, true); assert.equal(a2.armed, true)
  const expect = STAKE - (b.vaultSpend + 0.005 + 0.00001)
  assert.ok(Math.abs(a2.chest - expect) < 1e-6, `chest ${a2.chest} vs ${expect}`)
  assert.equal(a2.activity.filter((x) => x.kind === 'stake').length, 1, 'stake booked once')
  assert.equal(a2.activity.filter((x) => (x.msg || '').includes('· booked')).length, 1, 'vault buy booked once')
  poolLive = false; createSigs.length = 0
})

test('arm without the create signature finds it on chain (the app never got that far) — and a closed vault never re-arms', async () => {
  const { v, b } = await launch()
  const ct = VersionedTransaction.deserialize(Buffer.from(b.txs[0], 'base64')); ct.sign([dev])
  const vt = VersionedTransaction.deserialize(Buffer.from(b.vaultTx, 'base64'))
  const vaultSig = land(vt, { [BANKY]: -(b.vaultSpend + 0.005) }); const createSig = land(ct, { [DEVPK]: -(STAKE + 0.52), [BANKY]: +STAKE })
  createSigs.push(vaultSig, createSig)  // same slot; the vault buy listed first must be skipped (it moves SOL out, not in)
  poolLive = true; vaultTokens = 197e6
  const a = await V.arm(v.id, MINT, 'BANK', 'Bank', { sessionWallet: DEVPK })
  assert.equal(a.armed, true); assert.ok(Math.abs(a.chest - (STAKE - b.vaultSpend - 0.005)) < 1e-6, 'chest = stake − vault buy')
  poolLive = false; createSigs.length = 0
})

test('a retry after a launch that landed late is refused with the live mint (no second coin for one chest)', async () => {
  const { v } = await launch(); poolLive = true
  await assert.rejects(V.buildLaunch({ dev: DEVPK, name: 'Bank', symbol: 'BANK', uri: 'u', devBuySol: 0.5, vaultId: v.id, vaultBuySol: BUY, fundInBundle: true, auth: { sessionWallet: DEVPK } }), new RegExp('already live: ' + MINT))
  poolLive = false
})

test('the stake can only come from the vault owner: someone else building on this vault is refused', async () => {
  const v = V.create(DEVPK, STAKE, undefined, 'mm', 0.3, 'launchlab', BUY, 20); const other = Keypair.generate().publicKey.toBase58()
  await assert.rejects(V.buildLaunch({ dev: other, name: 'X', symbol: 'X', uri: 'u', devBuySol: 0, vaultId: v.id, vaultBuySol: BUY, fundInBundle: true, auth: { sessionWallet: other } }), /not your vault/)
})
