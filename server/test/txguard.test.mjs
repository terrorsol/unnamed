// tx guard: the check before the vault key signs a trade someone else built (txguard.ts)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createApproveInstruction, createTransferInstruction, createTransferCheckedInstruction, createCloseAccountInstruction, createSyncNativeInstruction, createSetAuthorityInstruction, AuthorityType, TOKEN_PROGRAM_ID, NATIVE_MINT } from '@solana/spl-token'
import bs58 from 'bs58'
const G = await import('../src/txguard.ts')

const V = Keypair.generate().publicKey, VS = V.toBase58()
const MINT = Keypair.generate().publicKey, M = MINT.toBase58()
const OTHER = Keypair.generate().publicKey
const X = Keypair.generate().publicKey.toBase58(), CURVE = Keypair.generate().publicKey.toBase58(), FEE = Keypair.generate().publicKey.toBase58()
const ata = getAssociatedTokenAddressSync(MINT, V, true).toBase58()
const otherAta = getAssociatedTokenAddressSync(OTHER, V, true).toBase58()
const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, V, true).toBase58()
const SYS = '11111111111111111111111111111111', TOK = TOKEN_PROGRAM_ID.toBase58(), ATAP = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
const sys = (type, info) => ({ program: 'system', programId: SYS, type, info, accounts: [] })
const tok = (type, info) => ({ program: 'token', programId: TOK, type, info, accounts: [] })
const other = () => ({ program: 'other', programId: 'PumpPortaL1111111111111111111111111111111111', type: '', info: {}, accounts: [VS, M] })
const buyLim = G.limitsFor('buy', M, 0.01, { slippageBps: 1500 })

test('a pump buy through a wrapper passes: SOL to the curve, the fees and the new ATA rent are counted', () => {
  const r = G.checkIxs([
    { program: 'other', programId: ComputeBudgetProgram.programId.toBase58(), type: '', info: {}, accounts: [] },
    { program: 'ata', programId: ATAP, type: 'createIdempotent', info: { source: VS, account: ata, wallet: VS, mint: M }, accounts: [] },
    sys('createAccount', { source: VS, newAccount: ata, lamports: 2039280, owner: TOK }), tok('initializeAccount3', { account: ata, mint: M, owner: VS }),
    other(), sys('transfer', { source: VS, destination: CURVE, lamports: 10_000_000 }), sys('transfer', { source: VS, destination: FEE, lamports: 95_000 }), sys('transfer', { source: VS, destination: X, lamports: 50_000 }),
  ], VS, buyLim)
  assert.equal(r.tokOut, 0n); assert.ok(Math.abs(r.solOut - 0.012189280) < 1e-9, String(r.solOut)); assert.ok(r.solOut <= buyLim.maxSolOut)   // + the 5000-lamport base fee
})
test('a drain inside the same buy is refused: SOL out beyond the trade', () => {
  assert.throws(() => G.checkIxs([other(), sys('transfer', { source: VS, destination: CURVE, lamports: 10_000_000 }), sys('transfer', { source: VS, destination: X, lamports: 500_000_000 })], VS, buyLim), /sends 0\.5100 SOL out/)
})
test('delegating, re-assigning, burning, closing to someone else, handing over authority: refused', () => {
  assert.throws(() => G.checkIxs([tok('approve', { source: otherAta, delegate: X, owner: VS, amount: '1' })], VS, buyLim), /approve signed by the vault/)
  assert.throws(() => G.checkIxs([tok('setAuthority', { account: ata, authorityType: 'accountOwner', newAuthority: X, authority: VS })], VS, buyLim), /setAuthority/)
  assert.throws(() => G.checkIxs([tok('burn', { account: ata, mint: M, amount: '5', authority: VS })], VS, buyLim), /burn/)
  assert.throws(() => G.checkIxs([tok('closeAccount', { account: wsol, destination: X, owner: VS })], VS, buyLim), /closes a vault account to someone else/)
  assert.throws(() => G.checkIxs([sys('assign', { account: VS, owner: X })], VS, buyLim), /system assign on the vault wallet/)
  assert.throws(() => G.checkIxs([sys('allocate', { account: VS, space: 10 })], VS, buyLim), /allocate/)
  // the same instructions on someone else's accounts are not the vault's business
  assert.doesNotThrow(() => G.checkIxs([tok('approve', { source: X, delegate: CURVE, owner: X, amount: '1' }), tok('closeAccount', { account: X, destination: CURVE, owner: X })], VS, buyLim))
})
test('another coin held by the shared wallet cannot move', () => {
  assert.throws(() => G.checkIxs([tok('transfer', { source: otherAta, destination: X, authority: VS, amount: '1000' })], VS, buyLim), /does not touch/)
  assert.throws(() => G.checkIxs([tok('transferChecked', { source: otherAta, mint: OTHER.toBase58(), destination: X, authority: VS, tokenAmount: { amount: '1000' } })], VS, buyLim), /does not touch/)
})
test('a multi-hop route may pass an intermediate token through the vault — no more out than came in, in the same tx', () => {
  const usd = Keypair.generate().publicKey.toBase58(), mid = getAssociatedTokenAddressSync(new PublicKey(usd), V, true).toBase58()
  const hop = (outAmt) => [sys('transfer', { source: VS, destination: wsol, lamports: 10_000_000 }), tok('transfer', { source: wsol, destination: CURVE, authority: VS, amount: '10000000' }),
    tok('transferChecked', { source: CURVE, mint: usd, destination: mid, authority: CURVE, tokenAmount: { amount: '1500000' } }), tok('transferChecked', { source: mid, mint: usd, destination: X, authority: VS, tokenAmount: { amount: String(outAmt) } }),
    tok('transferChecked', { source: X, mint: M, destination: ata, authority: X, tokenAmount: { amount: '42' } })]
  assert.doesNotThrow(() => G.checkIxs(hop(1500000), VS, buyLim))
  assert.throws(() => G.checkIxs(hop(1500001), VS, buyLim), /does not touch out of the vault/)   // one unit of the vault's own balance would leave
})
test('a checked transfer of the coin from a non-ATA account of the vault counts against the cap (Jupiter picks whatever account holds it)', () => {
  const sellLim = G.limitsFor('sell', M, '10%', { slippageBps: 100, expectSol: 1, balanceRaw: 1_000_000_000n }); const acct = Keypair.generate().publicKey.toBase58()
  assert.equal(G.checkIxs([tok('transferChecked', { source: acct, mint: M, destination: CURVE, authority: VS, tokenAmount: { amount: '100000000' } })], VS, sellLim).tokOut, 100_000_000n)
  assert.throws(() => G.checkIxs([tok('transferChecked', { source: acct, mint: M, destination: CURVE, authority: VS, tokenAmount: { amount: '200000000' } })], VS, sellLim), /sells 200000000 raw/)
  // an unchecked transfer names no mint: from an unknown account it is refused
  assert.throws(() => G.checkIxs([tok('transfer', { source: acct, destination: CURVE, authority: VS, amount: '1' })], VS, sellLim), /does not touch/)
})
test('a buy may not send the coin out; a sell may not take more than the share asked for', () => {
  assert.throws(() => G.checkIxs([tok('transfer', { source: ata, destination: X, authority: VS, amount: '1' })], VS, buyLim), /buy that sends the coin out/)
  const sellLim = G.limitsFor('sell', M, '10%', { slippageBps: 100, expectSol: 1, balanceRaw: 1_000_000_000n })
  assert.equal(sellLim.maxTokOutRaw, 100_000_001n)
  assert.doesNotThrow(() => G.checkIxs([tok('transferChecked', { source: ata, mint: M, destination: CURVE, authority: VS, tokenAmount: { amount: '100000000' } }), sys('transfer', { source: VS, destination: FEE, lamports: 5_000_000 })], VS, sellLim))
  assert.throws(() => G.checkIxs([tok('transferChecked', { source: ata, mint: M, destination: CURVE, authority: VS, tokenAmount: { amount: '100000002' } })], VS, sellLim), /sells 100000002 raw/)
  // a sell pays fees out of what it brings, nothing more: 3% of the expected SOL + 0.02
  assert.throws(() => G.checkIxs([tok('transferChecked', { source: ata, mint: M, destination: CURVE, authority: VS, tokenAmount: { amount: '1' } }), sys('transfer', { source: VS, destination: X, lamports: 60_000_000 })], VS, sellLim), /SOL out/)
  // a sell asked in tokens
  const tl = G.limitsFor('sell', M, 250, { slippageBps: 100, expectSol: 0.1, decimals: 6 }); assert.equal(tl.maxTokOutRaw, 250_250_001n)
})
test('wrapped SOL (Jupiter / PumpSwap / Raydium) counts once: the wrap is internal, the wSOL spent is the SOL out', () => {
  const r = G.checkIxs([
    { program: 'ata', programId: ATAP, type: 'createIdempotent', info: { source: VS, account: wsol, wallet: VS, mint: NATIVE_MINT.toBase58() }, accounts: [] },
    sys('createAccount', { source: VS, newAccount: wsol, lamports: 2039280, owner: TOK }),
    sys('transfer', { source: VS, destination: wsol, lamports: 10_000_000 }), tok('syncNative', { account: wsol }),
    other(), tok('transfer', { source: wsol, destination: CURVE, authority: VS, amount: '10000000' }), tok('transfer', { source: CURVE, destination: ata, authority: CURVE, amount: '777' }),
    tok('closeAccount', { account: wsol, destination: VS, owner: VS }),
  ], VS, buyLim)
  assert.ok(Math.abs(r.solOut - 0.010005) < 1e-9, String(r.solOut)); assert.ok(Math.abs(r.wrapped - 0.012039280) < 1e-9)
  // Raydium SDK style: a seed account created and funded in one go, initialized as the vault's wSOL
  const T = Keypair.generate().publicKey.toBase58()
  const r2 = G.checkIxs([sys('createAccountWithSeed', { source: VS, newAccount: T, base: VS, seed: 'x', lamports: 12_039_280, owner: TOK }), tok('initializeAccount', { account: T, mint: NATIVE_MINT.toBase58(), owner: VS }),
    other(), tok('transferChecked', { source: T, mint: NATIVE_MINT.toBase58(), destination: CURVE, authority: VS, tokenAmount: { amount: '10000000' } }), tok('closeAccount', { account: T, destination: VS, owner: VS })], VS, buyLim)
  assert.ok(Math.abs(r2.solOut - 0.010005) < 1e-9, String(r2.solOut))
})
test('decodeTop reads real System / Token / ATA instructions the same way the RPC parses inner ones', () => {
  const d = (ix) => G.decodeTop(ix.programId.toBase58(), ix.data, ix.keys.map((k) => k.pubkey.toBase58()))
  assert.deepEqual(d(SystemProgram.transfer({ fromPubkey: V, toPubkey: new PublicKey(X), lamports: 123 })).info, { source: VS, destination: X, lamports: 123 })
  const seeded = d(SystemProgram.createAccountWithSeed({ fromPubkey: V, newAccountPubkey: new PublicKey(X), basePubkey: V, seed: 'abc123', lamports: 4567, space: 165, programId: TOKEN_PROGRAM_ID }))
  assert.equal(seeded.type, 'createAccountWithSeed'); assert.equal(seeded.info.lamports, 4567); assert.equal(seeded.info.owner, TOK); assert.equal(seeded.info.source, VS)
  assert.equal(d(SystemProgram.assign({ accountPubkey: V, programId: new PublicKey(X) })).type, 'assign')
  const ap = d(createApproveInstruction(new PublicKey(otherAta), new PublicKey(X), V, 5n)); assert.equal(ap.type, 'approve'); assert.equal(ap.info.owner, VS)
  const tr = d(createTransferInstruction(new PublicKey(ata), new PublicKey(X), V, 99n)); assert.equal(tr.type, 'transfer'); assert.equal(tr.info.amount, '99'); assert.equal(tr.info.authority, VS)
  const tc = d(createTransferCheckedInstruction(new PublicKey(ata), MINT, new PublicKey(X), V, 77n, 6)); assert.equal(tc.info.tokenAmount.amount, '77'); assert.equal(tc.info.mint, M)
  const cl = d(createCloseAccountInstruction(new PublicKey(wsol), new PublicKey(X), V)); assert.equal(cl.type, 'closeAccount'); assert.equal(cl.info.destination, X)
  assert.equal(d(createSyncNativeInstruction(new PublicKey(wsol))).type, 'syncNative')
  assert.equal(d(createSetAuthorityInstruction(new PublicKey(ata), V, AuthorityType.AccountOwner, new PublicKey(X))).type, 'setAuthority')
  const a = d(createAssociatedTokenAccountIdempotentInstruction(V, new PublicKey(ata), V, MINT)); assert.equal(a.type, 'createIdempotent'); assert.equal(a.info.wallet, VS); assert.equal(a.info.account, ata)
})

// guardTx end to end against a fake RPC: the top-level instructions come from the tx, the CPIs from the simulation
const fakeConn = (sim) => ({ simulateTransaction: async () => { if (sim instanceof Error) throw sim; return { context: { slot: 1 }, value: sim } }, getAddressLookupTable: async () => ({ value: null }) })
const txOf = (ixs) => new VersionedTransaction(new TransactionMessage({ payerKey: V, recentBlockhash: '11111111111111111111111111111111', instructions: ixs }).compileToV0Message())
const parsedIx = (program, programId, type, info) => ({ program, programId: new PublicKey(programId), parsed: { type, info }, stackHeight: 2 })
test('guardTx: CPIs from the simulation are checked; a top-level drain is caught from the tx itself', async () => {
  const PP = new PublicKey('FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe')   // a venue the vault trades through (top-level allowlist)
  const wrapperIx = { programId: PP, keys: [{ pubkey: V, isSigner: true, isWritable: true }, { pubkey: MINT, isSigner: false, isWritable: false }], data: Buffer.from([1, 2, 3]) }
  const ok = await G.guardTx(fakeConn({ err: null, logs: [], unitsConsumed: 5, innerInstructions: [{ index: 0, instructions: [parsedIx('system', SYS, 'transfer', { source: VS, destination: CURVE, lamports: 10_000_000 })] }] }), txOf([wrapperIx]), V, buyLim)
  assert.ok(Math.abs(ok.solOut - 0.010005) < 1e-9, String(ok.solOut)); assert.equal(ok.cu, 5)   // + base fee
  // the wrapper's CPI drains the wallet
  await assert.rejects(G.guardTx(fakeConn({ err: null, logs: [], innerInstructions: [{ index: 0, instructions: [parsedIx('system', SYS, 'transfer', { source: VS, destination: X, lamports: 3_000_000_000 })] }] }), txOf([wrapperIx]), V, buyLim), (e) => e.kind === 'refused')
  // the wrapper's CPI hands the coin's account to someone else
  await assert.rejects(G.guardTx(fakeConn({ err: null, logs: [], innerInstructions: [{ index: 0, instructions: [parsedIx('spl-token', TOK, 'setAuthority', { account: otherAta, authorityType: 'accountOwner', newAuthority: X, authority: VS })] }] }), txOf([wrapperIx]), V, buyLim), (e) => e.kind === 'refused' && /setAuthority/.test(e.message))
  // an unparsed System CPI is decoded from its raw data
  const raw = SystemProgram.transfer({ fromPubkey: V, toPubkey: new PublicKey(X), lamports: 2_000_000_000 })
  await assert.rejects(G.guardTx(fakeConn({ err: null, logs: [], innerInstructions: [{ index: 0, instructions: [{ programId: SystemProgram.programId, accounts: raw.keys.map((k) => k.pubkey), data: bs58.encode(raw.data), stackHeight: 2 }] }] }), txOf([wrapperIx]), V, buyLim), (e) => e.kind === 'refused' && /2\.0000 SOL/.test(e.message))
  // a top-level transfer appended to the trade
  await assert.rejects(G.guardTx(fakeConn({ err: null, logs: [], innerInstructions: [] }), txOf([wrapperIx, SystemProgram.transfer({ fromPubkey: V, toPubkey: new PublicKey(X), lamports: 1e9 })]), V, buyLim), (e) => e.kind === 'refused')
})
test('guardTx: no simulation, no inner instructions, or a chain error → not signed', async () => {
  const t = txOf([SystemProgram.transfer({ fromPubkey: V, toPubkey: new PublicKey(CURVE), lamports: 1000 })])
  await assert.rejects(G.guardTx(fakeConn(new Error('fetch failed')), t, V, buyLim), (e) => e.kind === 'unavailable')
  await assert.rejects(G.guardTx(fakeConn({ err: null, logs: [] }), t, V, buyLim), (e) => e.kind === 'unavailable')
  await assert.rejects(G.guardTx(fakeConn({ err: { InstructionError: [0, { Custom: 6063 }] }, logs: [], innerInstructions: [] }), t, V, buyLim), (e) => e.kind === 'simFailed')
  const prev = process.env.TX_GUARD; process.env.TX_GUARD = '0'; try { assert.equal((await G.guardTx(fakeConn(new Error('x')), t, V, buyLim)).checked, 0) } finally { if (prev === undefined) delete process.env.TX_GUARD; else process.env.TX_GUARD = prev }
})

// ---- the bypasses the Oct 30 review found (each one passed the first version of the guard) ----
const topIx = (ix) => ({ ...G.decodeTop(ix.programId.toBase58(), ix.data, ix.keys.map((k) => k.pubkey.toBase58())), top: true })
const { createInitializeAccount3Instruction } = await import('@solana/spl-token')
test('review: an account opened as the vault\'s wSOL, closed, then refilled from the vault is SOL out, not a wrap', () => {
  const T = Keypair.generate().publicKey
  assert.throws(() => G.checkIxs([topIx(createInitializeAccount3Instruction(T, NATIVE_MINT, V)), topIx(createCloseAccountInstruction(T, V, V)), topIx(SystemProgram.transfer({ fromPubkey: V, toPubkey: T, lamports: 50e9 }))], VS, buyLim), /sends 50\.0000 SOL out/)
  // the classic wSOL ATA closed earlier in the same tx: a later transfer into it is out too
  assert.throws(() => G.checkIxs([tok('closeAccount', { account: wsol, destination: VS, owner: VS }), sys('transfer', { source: VS, destination: wsol, lamports: 5e9 })], VS, buyLim), /SOL out/)
})
test('review: the Token-2022-derived "wSOL ATA" (can never exist) and a seed account owned by another program are not wraps', () => {
  const t22wsol = getAssociatedTokenAddressSync(NATIVE_MINT, V, true, new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')).toBase58()
  assert.throws(() => G.checkIxs([sys('transfer', { source: VS, destination: t22wsol, lamports: 50e9 })], VS, buyLim), /SOL out/)
  const SEED = Keypair.generate().publicKey.toBase58(), EVIL = Keypair.generate().publicKey.toBase58()
  assert.throws(() => G.checkIxs([sys('createAccountWithSeed', { source: VS, newAccount: SEED, base: VS, seed: 'x', lamports: 50e9, space: 165, owner: EVIL }), other(), tok('initializeAccount3', { account: SEED, mint: NATIVE_MINT.toBase58(), owner: VS })], VS, buyLim), /SOL out/)
})
test('review: the priority fee counts as SOL out (1.4M CU × 5e10 µlamports = 70 SOL)', () => {
  assert.throws(() => G.checkIxs([topIx(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })), topIx(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000_000_000 }))], VS, buyLim), /70\.0000 SOL out/)
  // a normal one (PumpPortal's 0.001 SOL priority) fits
  const r = G.checkIxs([topIx(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 })), topIx(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000_000 }))], VS, buyLim); assert.ok(Math.abs(r.feeSol - 0.001005) < 1e-12, String(r.feeSol))
})
test('review: NaN fails closed', () => {
  assert.throws(() => G.checkIxs([sys('transfer', { source: VS, destination: X }), sys('transfer', { source: VS, destination: X, lamports: 99e9 })], VS, buyLim), /unreadable amount/)
  assert.throws(() => G.limitsFor('buy', M, 'abc', { slippageBps: 100 }), /bad buy amount/)
  assert.throws(() => G.checkIxs([], VS, { side: 'buy', mint: M, maxSolOut: NaN }), /no valid SOL bound/)
})
test('review: everything wrapped can go on chain, so it must fit the bound (wrap 50, spend 0.01 → refused)', () => {
  assert.throws(() => G.checkIxs([sys('transfer', { source: VS, destination: wsol, lamports: 50e9 }), tok('transfer', { source: wsol, destination: X, authority: VS, amount: '10000000' })], VS, buyLim), /could send 50\.0000 SOL out on chain/)
})
test('review: a buy instruction\'s on-chain ceiling must fit the bound; capBuyCeilings pulls padded ones down first', () => {
  const PUMPP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')
  const data = Buffer.alloc(26); Buffer.from('66063d1201daebea', 'hex').copy(data); data.writeBigUInt64LE(1000n, 8); data.writeBigUInt64LE(50_000_000_000n, 16)
  const ix = { programId: PUMPP, keys: [{ pubkey: V, isSigner: true, isWritable: true }, { pubkey: MINT, isSigner: false, isWritable: false }], data }
  assert.throws(() => G.checkIxs([topIx(ix)], VS, buyLim), /may take up to 50\.0000 SOL/)
  const tx = txOf([ix]); assert.equal(G.capBuyCeilings(tx, 15_000_000n), 1)
  const cix = tx.message.compiledInstructions[0]; assert.equal(Buffer.from(cix.data).readBigUInt64LE(16), 15_000_000n); assert.equal(Buffer.from(cix.data).readBigUInt64LE(8), 1000n)
  assert.equal(G.capBuyCeilings(tx, 20_000_000n), 0)   // never raised
})
test('review: only the venues and the plumbing may be called at top level; nonce instructions and extra signers are refused', async () => {
  const stranger = { programId: Keypair.generate().publicKey, keys: [{ pubkey: V, isSigner: true, isWritable: true }], data: Buffer.from([0]) }
  assert.throws(() => G.checkIxs([topIx(stranger)], VS, buyLim), /does not trade through/)
  const nonceAcct = Keypair.generate().publicKey, auth = Keypair.generate().publicKey
  assert.throws(() => G.checkIxs([topIx(SystemProgram.nonceAdvance({ noncePubkey: nonceAcct, authorizedPubkey: auth }))], VS, buyLim), /durable-nonce/)
  const two = new VersionedTransaction(new TransactionMessage({ payerKey: V, recentBlockhash: '11111111111111111111111111111111', instructions: [SystemProgram.transfer({ fromPubkey: auth, toPubkey: new PublicKey(X), lamports: 1 })] }).compileToV0Message())
  await assert.rejects(G.guardTx(fakeConn({ err: null, logs: [], innerInstructions: [] }), two, V, buyLim), /only signer and the fee payer/)
  const otherPayer = new VersionedTransaction(new TransactionMessage({ payerKey: auth, recentBlockhash: '11111111111111111111111111111111', instructions: [] }).compileToV0Message())
  await assert.rejects(G.guardTx(fakeConn({ err: null, logs: [], innerInstructions: [] }), otherPayer, V, buyLim), /only signer and the fee payer/)
})
test('review: a buy that brings none of the coin in is refused (post-state of the coin account)', async () => {
  const lim = { ...buyLim, coinAta: ata, preTokRaw: 500n }
  const acct = (amount) => { const b = Buffer.alloc(165); b.writeBigUInt64LE(amount, 64); return { executable: false, owner: TOK, lamports: 2039280, data: [b.toString('base64'), 'base64'] } }
  const t = txOf([SystemProgram.transfer({ fromPubkey: V, toPubkey: new PublicKey(X), lamports: 10_000_000 })])
  await assert.rejects(G.guardTx(fakeConn({ err: null, logs: [], innerInstructions: [], accounts: [acct(500n)] }), t, V, lim), /brings none of the coin/)
  await assert.rejects(G.guardTx(fakeConn({ err: null, logs: [], innerInstructions: [], accounts: [null] }), t, V, lim), /brings none of the coin/)
  const ok = await G.guardTx(fakeConn({ err: null, logs: [], innerInstructions: [], accounts: [acct(9500n)] }), t, V, lim); assert.equal(ok.tokIn, 9000n)
})

test('p-token unwrapLamports: back to the vault is fine, to anyone else is refused (mainnet Jupiter route, Oct 30)', () => {
  assert.doesNotThrow(() => G.checkIxs([tok('unwrapLamports', { source: wsol, destination: VS, authority: VS, amount: '1000' })], VS, buyLim))
  assert.throws(() => G.checkIxs([tok('unwrapLamports', { source: wsol, destination: X, authority: VS, amount: '1000' })], VS, buyLim), /unwraps a vault account/)
})
