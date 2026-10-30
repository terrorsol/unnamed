// The one-signature launch, server side, end to end with the chain faked: build (stake inside the create) → bundle lands → arm books the
// stake from the create tx and the block-zero buy from the vault tx, exactly once, even when the app's arm and autoArm race.
// LaunchLab is mocked (module mock); the shared Connection object is patched per method. Run with --experimental-test-module-mocks.
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, PublicKey, VersionedTransaction, TransactionMessage, SystemProgram, SystemInstruction } from '@solana/web3.js'
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
let poolLive = false, vaultTokens = 0, blockhashValid = false, tradeN = 0, reuseMint = null
const createSigs = []             // signatures in the order they landed on the mint
const land = (tx, deltas) => { const sig = bs58.encode(tx.signatures[0]); const keys = [...new Set([...tx.message.staticAccountKeys.map((k) => k.toBase58()), ...Object.keys(deltas)])]
  // parsed instructions the way the RPC returns them: system transfers decoded, everything else opaque
  const instructions = TransactionMessage.decompile(tx.message).instructions.map((ix) => { if (!ix.programId.equals(SystemProgram.programId)) return { programId: ix.programId }; try { const d = SystemInstruction.decodeTransfer(ix); return { program: 'system', parsed: { type: 'transfer', info: { source: d.fromPubkey.toBase58(), destination: d.toPubkey.toBase58(), lamports: Number(d.lamports) } } } } catch { return { program: 'system', parsed: { type: 'other' } } } })
  parsed.set(sig, { blockTime: Math.floor(Date.now() / 1000), meta: { err: null, innerInstructions: [], preBalances: keys.map(() => 100e9), postBalances: keys.map((k) => 100e9 + Math.round((deltas[k] || 0) * 1e9)) }, transaction: { message: { instructions, accountKeys: keys.map((k) => ({ pubkey: new PublicKey(k) })) } } }); return sig }

mock.module('../src/launchlab.ts', { namedExports: {
  PLATFORM_ID: Keypair.generate().publicKey, TAX_BPS: 200, CURVE_CUSTOM: false,
  status: () => ({ venue: 'launchlab' }), isOurs: () => true, platformKeypair: () => SHARED, platformVaultSol: async () => 0,
  poolIdOf: (m) => new PublicKey(m),   // stand-in: the pool account is the mint here (getAccountInfo below answers for it)
  pool: async (m) => (poolLive && m === MINT ? { poolId: 'POOL', status: 0, creator: DEVPK, liqSol: 45, priceSol: 1e-7, realB: 0n } : null),
  quote: (_s, solIn) => ({ tokens: solIn * 27e6, after: { virtualA: 1073025605596382n, virtualB: 30000852951n, realA: 0n, realB: BigInt(Math.round((0.5 + solIn) * 0.977e9)) } }),
  buildTrade: async (owner) => new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: bh, instructions: [SystemProgram.transfer({ fromPubkey: owner, toPubkey: new PublicKey('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5'), lamports: 5e6 + (++tradeN) })] }).compileToV0Message()),   // unique per build, like a real one
  buildLaunch: async (devPk, _meta, devBuy) => {
    mintKp = reuseMint || Keypair.generate(); MINT = mintKp.publicKey.toBase58()   // every launch is a new coin (as with the real mint pool) — unless a test hands back a reclaimed one
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
  getAccountInfo: async (pk) => (poolLive && pk.toBase58() === MINT ? { data: Buffer.alloc(0), owner: SystemProgram.programId, lamports: 1, executable: false } : null), getBalance: async () => 0,
  isBlockhashValid: async () => ({ value: blockhashValid }),
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

test('the server arms on its own the moment the bundle lands (no arm call from the app)', async () => {
  const { v, b } = await launch()
  const ct = VersionedTransaction.deserialize(Buffer.from(b.txs[0], 'base64')); ct.sign([dev])
  const vt = VersionedTransaction.deserialize(Buffer.from(b.vaultTx, 'base64'))
  createSigs.length = 0; const createSig = land(ct, { [DEVPK]: -(STAKE + 0.52), [BANKY]: +STAKE }); land(vt, { [BANKY]: -(b.vaultSpend + 0.005) }); createSigs.push(createSig)
  poolLive = true; vaultTokens = 197e6
  let armed = null; for (let i = 0; i < 40 && !armed; i++) { await new Promise((r) => setTimeout(r, 200)); armed = V.list().find((x) => x.id === v.id) || null }
  assert.ok(armed, 'armed by the landing watcher'); assert.ok(Math.abs(armed.chest - (STAKE - b.vaultSpend - 0.005)) < 1e-6, 'stake in, vault buy out')
  assert.equal(armed.activity.filter((x) => x.kind === 'stake').length, 1)
  poolLive = false; createSigs.length = 0
})

test('a second build while the first can still land is refused (two coins, two buys on one stake); allowed once its blockhash is gone', async () => {
  const { v } = await launch(); blockhashValid = true
  await assert.rejects(V.buildLaunch({ dev: DEVPK, name: 'Bank', symbol: 'BANK', uri: 'u', devBuySol: 0.5, vaultId: v.id, vaultBuySol: BUY, fundInBundle: true, auth: { sessionWallet: DEVPK } }), /can still land/)
  blockhashValid = false
  const b2 = await V.buildLaunch({ dev: DEVPK, name: 'Bank', symbol: 'BANK', uri: 'u', devBuySol: 0.5, vaultId: v.id, vaultBuySol: BUY, fundInBundle: true, auth: { sessionWallet: DEVPK } })
  assert.ok(b2.vaultTx)
})

test('parallel /vault/fund calls on one stake book it once; a stake tx cannot be booked into a second vault', async () => {
  const v = V.create(DEVPK, 2, undefined, 'mm', 0.3, 'launchlab', 1, 10); const w = V.create(DEVPK, 2, undefined, 'mm', 0.3, 'launchlab', 1, 10)
  const t = new VersionedTransaction(new TransactionMessage({ payerKey: dev.publicKey, recentBlockhash: bh, instructions: [SystemProgram.transfer({ fromPubkey: dev.publicKey, toPubkey: SHARED.publicKey, lamports: 2e9 })] }).compileToV0Message()); t.sign([dev])
  const sig = land(t, { [DEVPK]: -2, [BANKY]: +2 })
  const rs = await Promise.allSettled(Array.from({ length: 10 }, () => V.fund(v.id, sig)))
  assert.ok(rs.some((r) => r.status === 'fulfilled'))
  const after = await V.fund(v.id, sig); assert.ok(Math.abs(after.chest - 2) < 1e-9, 'booked once: ' + after.chest)
  await assert.rejects(V.fund(w.id, sig), /already booked/)
})

test('only the dev\'s own transfer counts: SOL someone else sent to the shared wallet is not a stake', async () => {
  const v = V.create(DEVPK, 2, undefined, 'mm', 0.3, 'launchlab', 1, 10); const other = Keypair.generate()
  const t = new VersionedTransaction(new TransactionMessage({ payerKey: dev.publicKey, recentBlockhash: bh, instructions: [SystemProgram.transfer({ fromPubkey: other.publicKey, toPubkey: SHARED.publicKey, lamports: 3e9 })] }).compileToV0Message()); t.sign([dev, other])
  const sig = land(t, { [BANKY]: +3 })
  await assert.rejects(V.fund(v.id, sig), /no SOL from the vault owner/)
})

test('a reclaimed …BANK mint handed to a second vault launches for that vault (the first vault lets go of it)', async () => {
  const A = await launch(); const M = mintKp; reuseMint = M   // A's launch never landed; its mint goes back to the pool
  const B = await launch(); reuseMint = null; assert.equal(B.b.mint, A.b.mint)
  const ct = VersionedTransaction.deserialize(Buffer.from(B.b.txs[0], 'base64')); ct.sign([dev]); const vt = VersionedTransaction.deserialize(Buffer.from(B.b.vaultTx, 'base64'))
  createSigs.length = 0; const cs = land(ct, { [DEVPK]: -(STAKE + 0.52), [BANKY]: +STAKE }); land(vt, { [BANKY]: -(B.b.vaultSpend + 0.005) }); createSigs.push(cs)
  poolLive = true; vaultTokens = 197e6
  const armed = await V.arm(B.v.id, B.b.mint, 'BANK', 'Bank', { sessionWallet: DEVPK }, cs)
  assert.equal(armed.armed, true); assert.ok(Math.abs(armed.chest - (STAKE - B.b.vaultSpend - 0.005)) < 1e-6)
  await assert.rejects(V.arm(A.v.id, A.b.mint, 'BANK', 'Bank', { sessionWallet: DEVPK }), /did not launch that coin|not on chain|another chest/)
  poolLive = false; createSigs.length = 0
})
