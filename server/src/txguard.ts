// Tx guard: the last check before a vault key signs a trade that someone else built (PumpPortal, Jupiter, the Raydium SDK).
// Why: the shared vault wallet holds every chest. A trade tx names the vault as signer, so whatever program it calls gets the vault's
// signing power for that one tx. A wallet's SOL and tokens can only move through the System and Token programs, so the guard simulates
// the exact tx with inner instructions (every CPI, at every depth) and walks each System / Token instruction the tx would execute.
// It refuses the trade when any of them would:
//   - send SOL out beyond the trade's own bound (buy: the SOL asked for + slippage + fees; sell: fees only)
//   - move a token other than the coin being traded or wrapped SOL (the shared wallet holds other chests' coins)
//   - sell more of the coin than asked, or send the coin out on a buy
//   - delegate, burn, change an authority, close an account to anyone but the vault, or reassign / reallocate the wallet
// A simulation that cannot run (RPC down) refuses too: the tick retries, nothing is signed blind.
// Also: only programs the vault trades through may be called at top level; the vault must be the only signer and the fee payer; no
// durable nonce; the priority fee counts as SOL out; wrapped SOL only counts as the vault's own when it goes into the classic wSOL ATA or
// a Token account this same tx creates and opens for the vault; a buy's on-chain ceiling (pump max_sol_cost / PumpSwap max_quote_in /
// spendable_sol_in) and everything wrapped must fit the bound (a ceiling binds at execution, the simulation only at simulation time);
// a buy must actually bring the coin in (post-state of the coin's ATA).
// Limit (review, Oct 30): a program that behaves differently on chain than in the simulation (slot-gated, a flag flipped after the build)
// is outside what a simulation can prove. The program allowlist + on-chain ceilings narrow it; an on-chain assertion would close it.
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT } from '@solana/spl-token'
import bs58 from 'bs58'
import { resolveKeys } from './launch.ts'

const SYS = '11111111111111111111111111111111'
const TOK = TOKEN_PROGRAM_ID.toBase58(), T22 = TOKEN_2022_PROGRAM_ID.toBase58()
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
const WSOL = NATIVE_MINT.toBase58()
const CB = 'ComputeBudget111111111111111111111111111111'
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', PUMPPORTAL = 'FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe'
const JUP6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', LAUNCHLAB = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj'
/** programs a vault trade may call at top level: the venues (pump, PumpSwap, PumpPortal's wrapper, Jupiter, LaunchLab) and the plumbing.
 *  Anything else would get the vault's signature for a purpose no trade has (an upgrade / lookup-table / metadata authority, …). */
export const TOP_PROGRAMS = new Set([CB, SYS, TOK, T22, ATA, PUMP, PUMP_AMM, PUMPPORTAL, JUP6, LAUNCHLAB, 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo'])
/** buy discriminators whose u64 at offset 16 (buy / pp_buy) or 8 (buy_exact_sol_in) is the most SOL the instruction may take on chain */
const BUY_CEIL: Record<string, number> = { '66063d1201daebea': 16, '66323d1201daebea': 16, '38fc74089edfcd5f': 8 }

export type GuardLimits = { side: 'buy' | 'sell'; mint: string; maxSolOut: number; maxTokOutRaw?: bigint; coinAta?: string; preTokRaw?: bigint }
export type GuardOk = { solOut: number; tokOut: bigint; wrapped: number; checked: number; cu?: number; feeSol?: number; tokIn?: bigint }
/** refused = the tx would do something the trade does not need · simFailed = the chain itself rejects it (the route is broken, not hostile)
 *  · unavailable = no simulation could run (RPC down): nothing is signed blind, the next tick retries */
export class GuardError extends Error { kind: 'refused' | 'simFailed' | 'unavailable'; constructor(m: string, kind: 'refused' | 'simFailed' | 'unavailable' = 'refused') { super(m); this.kind = kind } }

type Ix = { program: 'system' | 'token' | 'ata' | 'cb' | 'other'; programId: string; type: string; info: Record<string, any>; accounts: string[]; top?: boolean; data?: Buffer }

const u64 = (b: Buffer, o: number) => (b.length >= o + 8 ? b.readBigUInt64LE(o) : 0n)
const pk = (b: Buffer, o: number) => (b.length >= o + 32 ? new PublicKey(b.subarray(o, o + 32)).toBase58() : '')
/** decode a top-level System / Token / ATA instruction into the same shape the RPC's jsonParsed gives for inner ones */
export function decodeTop(programId: string, data: Uint8Array, accounts: string[]): Ix {
  const b = Buffer.from(data)
  if (programId === SYS) {
    const n = b.length >= 4 ? b.readUInt32LE(0) : -1
    if (n === 2) return { program: 'system', programId, type: 'transfer', info: { source: accounts[0], destination: accounts[1], lamports: Number(u64(b, 4)) }, accounts }
    if (n === 0) return { program: 'system', programId, type: 'createAccount', info: { source: accounts[0], newAccount: accounts[1], lamports: Number(u64(b, 4)), owner: pk(b, 20) }, accounts }
    if (n === 3) { const sl = Number(u64(b, 36)); const o = 44 + sl; return { program: 'system', programId, type: 'createAccountWithSeed', info: { source: accounts[0], newAccount: accounts[1], base: pk(b, 4), lamports: Number(u64(b, o)), owner: pk(b, o + 16) }, accounts } }
    const names: Record<number, string> = { 1: 'assign', 4: 'advanceNonce', 5: 'withdrawFromNonce', 6: 'initializeNonce', 7: 'authorizeNonce', 8: 'allocate', 9: 'allocateWithSeed', 10: 'assignWithSeed', 11: 'transferWithSeed', 12: 'upgradeNonce' }
    return { program: 'system', programId, type: names[n] || 'unknown' + n, info: { accounts }, accounts }
  }
  if (programId === TOK || programId === T22) {
    const n = b.length ? b[0] : -1; const t = (type: string, info: any): Ix => ({ program: 'token', programId, type, info, accounts })
    switch (n) {
      case 1: return t('initializeAccount', { account: accounts[0], mint: accounts[1], owner: accounts[2] })
      case 16: return t('initializeAccount2', { account: accounts[0], mint: accounts[1], owner: pk(b, 1) })
      case 18: return t('initializeAccount3', { account: accounts[0], mint: accounts[1], owner: pk(b, 1) })
      case 3: return t('transfer', { source: accounts[0], destination: accounts[1], authority: accounts[2], amount: String(u64(b, 1)) })
      case 12: return t('transferChecked', { source: accounts[0], mint: accounts[1], destination: accounts[2], authority: accounts[3], tokenAmount: { amount: String(u64(b, 1)) } })
      case 4: return t('approve', { source: accounts[0], delegate: accounts[1], owner: accounts[2] })
      case 13: return t('approveChecked', { source: accounts[0], mint: accounts[1], delegate: accounts[2], owner: accounts[3] })
      case 5: return t('revoke', { source: accounts[0], owner: accounts[1] })
      case 6: return t('setAuthority', { account: accounts[0], authority: accounts[1] })
      case 7: return t('mintTo', { mint: accounts[0], account: accounts[1], mintAuthority: accounts[2] })
      case 8: return t('burn', { account: accounts[0], mint: accounts[1], authority: accounts[2] })
      case 15: return t('burnChecked', { account: accounts[0], mint: accounts[1], authority: accounts[2] })
      case 9: return t('closeAccount', { account: accounts[0], destination: accounts[1], owner: accounts[2] })
      case 17: return t('syncNative', { account: accounts[0] })
      case 21: return t('getAccountDataSize', { mint: accounts[0] })
      case 22: return t('initializeImmutableOwner', { account: accounts[0] })
      default: return t('unknown' + n, { accounts })
    }
  }
  if (programId === ATA) return { program: 'ata', programId, type: b.length && b[0] === 1 ? 'createIdempotent' : b.length && b[0] === 2 ? 'recoverNested' : 'create', info: { source: accounts[0], account: accounts[1], wallet: accounts[2], mint: accounts[3] }, accounts }
  if (programId === CB) { const n = b.length ? b[0] : -1; return { program: 'cb', programId, type: n === 2 ? 'limit' : n === 3 ? 'price' : 'cb' + n, info: n === 2 && b.length >= 5 ? { units: b.readUInt32LE(1) } : n === 3 && b.length >= 9 ? { microLamports: b.readBigUInt64LE(1) } : {}, accounts } }
  return { program: 'other', programId, type: '', info: {}, accounts, data: b }
}
const top = (programId: string, data: Uint8Array, accounts: string[]): Ix => ({ ...decodeTop(programId, data, accounts), top: true })
/** an inner instruction as the RPC returns it (jsonParsed where it can parse, else program id + accounts) */
export function fromInner(x: any): Ix {
  const programId = String(x.programId?.toBase58?.() ?? x.programId ?? '')
  if (x.parsed && typeof x.parsed === 'object') {
    const program = programId === SYS ? 'system' : programId === TOK || programId === T22 ? 'token' : programId === ATA ? 'ata' : 'other'
    return { program, programId, type: String(x.parsed.type || ''), info: x.parsed.info || {}, accounts: [] }
  }
  const accounts = (x.accounts || []).map((a: any) => String(a?.toBase58?.() ?? a))
  // not parsed by the RPC: decode it ourselves from the raw data (base58) when it is a System/Token/ATA instruction
  if ((programId === SYS || programId === TOK || programId === T22 || programId === ATA) && typeof x.data === 'string') {
    try { return decodeTop(programId, bs58decode(x.data), accounts) } catch {}
  }
  return { program: programId === SYS ? 'system' : programId === TOK || programId === T22 ? 'token' : programId === ATA ? 'ata' : 'other', programId, type: 'unparsed', info: { accounts }, accounts }
}
const bs58decode = (s: string): Uint8Array => bs58.decode(s)

const amt = (info: any) => BigInt(String(info?.tokenAmount?.amount ?? info?.amount ?? '0'))
const mentions = (info: any, v: string) => JSON.stringify(info || {}).includes(v)

/** Walk the instructions (top-level + inner) of a trade and apply the limits. Pure: no RPC — `guardTx` feeds it the simulation.
 *  `sigs` = signatures the tx needs (the base fee); top-level instructions must carry `top: true` (decodeTop via guardTx does). */
export function checkIxs(ixs: Ix[], owner: string, lim: GuardLimits, sigs = 1): GuardOk {
  const V = owner
  const refuse = (why: string): never => { throw new GuardError('tx guard: ' + why) }
  if (!(lim.maxSolOut >= 0) || !Number.isFinite(lim.maxSolOut)) refuse('no valid SOL bound for this trade')
  const tradedAtas = new Set([TOK, T22].map((p) => getAssociatedTokenAddressSync(new PublicKey(lim.mint), new PublicKey(V), true, new PublicKey(p)).toBase58()))
  // wrapped SOL stays the vault's only inside the classic wSOL ATA, or a Token-owned account this tx creates and opens for the vault
  // (review: an account merely "initialized as the vault's wSOL" could be closed, then refilled from the vault and swept by whoever holds its key)
  const wsol = new Set([getAssociatedTokenAddressSync(NATIVE_MINT, new PublicKey(V), true, TOKEN_PROGRAM_ID).toBase58()])
  const createdTok = new Set<string>()
  for (const x of ixs) {
    if (x.program === 'system' && (x.type === 'createAccount' || x.type === 'createAccountWithSeed') && x.info.owner === TOK) createdTok.add(x.info.newAccount)
    if (x.program === 'token' && /^initializeAccount/.test(x.type) && x.info.owner === V) { if (x.info.mint === WSOL && createdTok.has(x.info.account)) wsol.add(x.info.account); else if (x.info.mint === lim.mint) tradedAtas.add(x.info.account) }
    if (x.program === 'ata' && x.info.wallet === V && x.info.mint === lim.mint && x.info.account) tradedAtas.add(x.info.account)
  }
  let out = 0n, wrapped = 0n, wsolSpent = 0n, tokOut = 0n, cuLimit: number | null = null, cuPrice = 0n, nonCb = 0, ceiling = 0n
  const closed = new Set<string>()
  const passIn = new Map<string, bigint>(), passOut = new Map<string, bigint>(), passMint = new Map<string, string>()
  const lam = (v: any) => { const f = Number(v); if (!(f >= 0) || !Number.isFinite(f)) refuse('an instruction moves an unreadable amount of SOL'); return BigInt(Math.round(f)) }
  for (const x of ixs) {
    if (x.top) {
      if (!TOP_PROGRAMS.has(x.programId)) refuse('calls a program the vault does not trade through (' + x.programId.slice(0, 8) + '…)')
      if (x.program === 'cb') { if (x.type === 'limit') cuLimit = +x.info.units; else if (x.type === 'price') cuPrice = BigInt(x.info.microLamports) } else nonCb++
      // a buy's own ceiling binds on chain: it must fit the bound whatever the simulation saw
      if ((x.programId === PUMP || x.programId === PUMP_AMM || x.programId === PUMPPORTAL) && x.data && x.data.length >= 16) { const o = BUY_CEIL[x.data.subarray(0, 8).toString('hex')]; if (o !== undefined && x.data.length >= o + 8) ceiling += x.data.readBigUInt64LE(o) }
    }
    if (x.program === 'system') {
      const i = x.info
      if (/nonce/i.test(x.type)) refuse('durable-nonce instruction in a trade')
      if (x.type === 'transfer') { if (i.source === V && i.destination !== V) { const n = lam(i.lamports); if (wsol.has(i.destination) && !closed.has(i.destination)) wrapped += n; else out += n } continue }
      if (x.type === 'createAccount' || x.type === 'createAccountWithSeed') { if (i.newAccount === V) refuse('creates over the vault wallet'); if (i.source === V) { const n = lam(i.lamports); if (wsol.has(i.newAccount) && i.owner === TOK && !closed.has(i.newAccount)) wrapped += n; else out += n } continue }
      if (mentions(i, V) || x.accounts.includes(V)) refuse(`system ${x.type || 'instruction'} on the vault wallet`)
      continue
    }
    if (x.program === 'token') {
      const i = x.info
      if (x.type === 'transfer' || x.type === 'transferChecked' || x.type === 'transferCheckedWithFee') {
        const auth = i.authority ?? i.multisigAuthority ?? i.owner
        if (auth !== V) { if (i.destination) passIn.set(i.destination, (passIn.get(i.destination) || 0n) + amt(i)); continue }   // tokens coming in (a hop's output lands here)
        if (wsol.has(i.source)) { wsolSpent += amt(i); continue }   // wrapped SOL spent on the buy
        // the coin leaving: from its ATA, or (a checked transfer names the mint) from any account of the vault's that holds it — the cap applies either way
        if ((tradedAtas.has(i.source) || (i.mint === lim.mint && x.type !== 'transfer')) && (!i.mint || i.mint === lim.mint)) { tokOut += amt(i); continue }
        // anything else the vault sends: only a multi-hop route's intermediate token passing through — out of an account no more than came
        // into it in this same tx (netted at the end). Another chest's coin sitting in the shared wallet can't leave this way.
        passOut.set(i.source, (passOut.get(i.source) || 0n) + amt(i)); passMint.set(i.source, String(i.mint || '?')); continue
      }
      if (x.type === 'closeAccount') { if ((i.owner ?? i.multisigOwner) === V) { if (i.destination !== V) refuse('closes a vault account to someone else'); closed.add(i.account) } continue }
      if (/^initializeAccount|^syncNative$|^getAccountDataSize$|^initializeImmutableOwner$|^revoke$|^amountToUiAmount$|^uiAmountToAmount$/.test(x.type)) continue
      if (/^approve|^setAuthority$|^burn|^mintTo|^freezeAccount$|^thawAccount$/.test(x.type)) { if (mentions(i, V)) refuse(`token ${x.type} signed by the vault`); continue }
      if (mentions(i, V) || x.accounts.includes(V)) refuse(`token ${x.type || 'instruction'} with the vault as a party`)
      continue
    }
  }
  // the fee the vault pays as fee payer: base + priority (an absurd CU price is a drain too — review)
  const limit = cuLimit ?? Math.min(1_400_000, 200_000 * Math.max(1, nonCb))
  const fee = BigInt(5000 * sigs) + (BigInt(limit) * cuPrice + 999_999n) / 1_000_000n
  const simOut = out + wsolSpent + fee                 // what the simulation spends
  const worst = out + wrapped + fee                     // what execution could spend: wrapped SOL can all go, whatever was simulated
  const solOut = Number(simOut) / 1e9, worstSol = Number(worst) / 1e9, ceilSol = Number(ceiling) / 1e9
  for (const [acct, o] of passOut) if (o > (passIn.get(acct) || 0n)) refuse('moves a token this trade does not touch out of the vault (' + (passMint.get(acct) || '?').slice(0, 6) + '… from ' + acct.slice(0, 6) + '…, ' + o + ' out vs ' + (passIn.get(acct) || 0n) + ' in)')
  if (lim.side === 'buy' && tokOut > 0n) refuse('a buy that sends the coin out')
  if (lim.maxTokOutRaw !== undefined && !(tokOut <= lim.maxTokOutRaw)) refuse(`sells ${tokOut} raw, asked for at most ${lim.maxTokOutRaw}`)
  if (!(solOut <= lim.maxSolOut + 1e-9)) refuse(`sends ${solOut.toFixed(4)} SOL out, the trade allows ${lim.maxSolOut.toFixed(4)}`)
  if (!(worstSol <= lim.maxSolOut + 1e-9)) refuse(`could send ${worstSol.toFixed(4)} SOL out on chain (${(Number(wrapped) / 1e9).toFixed(4)} wrapped), the trade allows ${lim.maxSolOut.toFixed(4)}`)
  if (!(ceilSol <= lim.maxSolOut + 1e-9)) refuse(`a buy instruction may take up to ${ceilSol.toFixed(4)} SOL on chain, the trade allows ${lim.maxSolOut.toFixed(4)}`)
  return { solOut, tokOut, wrapped: Number(wrapped) / 1e9, checked: ixs.length, feeSol: Number(fee) / 1e9 }
}

/** Pull every top-level pump / PumpSwap / PumpPortal buy's on-chain ceiling (max_sol_cost / max_quote_amount_in) down to `maxLamports`, in
 *  place, before the guard and the signature. PumpPortal pads the ceiling (3× in bundle mode); the guard refuses any ceiling above the
 *  trade's bound, so a padded build is tightened instead of refused. A ceiling too tight for the real cost fails the simulation (the route
 *  falls back), never the vault. `buy_exact_sol_in` is left alone: its number is the exact spend, not a ceiling. Returns how many it changed. */
export function capBuyCeilings(tx: VersionedTransaction, maxLamports: bigint): number {
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58()); let n = 0
  for (const ix of tx.message.compiledInstructions) {
    const prog = keys[ix.programIdIndex]; if (prog !== PUMP && prog !== PUMP_AMM && prog !== PUMPPORTAL) continue
    const b = Buffer.from(ix.data); const d = b.subarray(0, 8).toString('hex'); if ((d !== '66063d1201daebea' && d !== '66323d1201daebea') || b.length < 24) continue
    if (b.readBigUInt64LE(16) > maxLamports) { b.writeBigUInt64LE(maxLamports, 16); ix.data = new Uint8Array(b); n++ }
  }
  return n
}

/** Simulate `tx` (signature-free, fresh blockhash) with inner instructions and check every System/Token instruction it would run. */
export async function guardTx(conn: Connection, tx: VersionedTransaction, owner: PublicKey, lim: GuardLimits): Promise<GuardOk> {
  if (process.env.TX_GUARD === '0') return { solOut: 0, tokOut: 0n, wrapped: 0, checked: 0 }
  // the vault is the only signer and pays the fee: nobody else's signature can ride along, and no one else's fee settings apply
  if (tx.message.header.numRequiredSignatures !== 1 || !tx.message.staticAccountKeys[0]?.equals(owner)) throw new GuardError('tx guard: the vault must be the only signer and the fee payer')
  const keys = await resolveKeys(tx, conn)
  const tops: Ix[] = tx.message.compiledInstructions.map((ix) => top(keys[ix.programIdIndex] || '', ix.data, ix.accountKeyIndexes.map((k) => keys[k] || '')))
  const watch = lim.side === 'buy' && lim.coinAta ? [lim.coinAta] : []
  let sim: any = null, lastErr = ''
  for (let a = 0; a < 2 && !sim; a++) {
    sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, innerInstructions: true, ...(watch.length ? { accounts: { addresses: watch, encoding: 'base64' as const } } : {}) }).then((r) => r?.value ?? null, (e) => { lastErr = String(e?.message || e); return null })
    if (!sim && a === 0) await new Promise((r) => setTimeout(r, 300))
  }
  if (!sim) throw new GuardError('tx guard: simulation unavailable (' + lastErr.slice(0, 80) + ') — not signing blind', 'unavailable')
  if (sim.err) throw new GuardError('simulate err ' + JSON.stringify(sim.err), 'simFailed')
  if (!Array.isArray(sim.innerInstructions)) throw new GuardError('tx guard: the RPC returned no inner instructions — not signing blind', 'unavailable')
  // inner instructions belong to the top-level instruction at `index`: keep execution order (top, then its CPIs)
  const inner = new Map<number, Ix[]>(); for (const g of sim.innerInstructions) inner.set(g.index, (g.instructions || []).map(fromInner))
  const all: Ix[] = []; tops.forEach((x, i) => { all.push(x); for (const y of inner.get(i) || []) all.push(y) })
  const res = checkIxs(all, owner.toBase58(), lim, 1)
  // a buy has to bring the coin in (review: a "buy" that just pays the builder passed every other check)
  if (watch.length) {
    const acc = sim.accounts?.[0]; const data = acc?.data?.[0] ? Buffer.from(acc.data[0], 'base64') : null
    const post = data && data.length >= 72 ? data.readBigUInt64LE(64) : 0n; const got = post - (lim.preTokRaw ?? 0n)
    if (!(got > 0n)) throw new GuardError('tx guard: the buy brings none of the coin into the vault\'s account')
    res.tokIn = got
  }
  return { ...res, cu: sim.unitsConsumed }
}

/** The bound a vault trade is checked against. Buy: the SOL asked for, plus slippage, the venue's fee (pump ≤1.25%, PumpPortal 0.5%) and
 *  0.02 for rent of new accounts and tips. Sell: fees only — 3% of what the sale should bring (PumpPortal's 0.5–1% comes out of it) + 0.02.
 *  Tokens: a sell may take at most the share of the balance it asked for. */
export function limitsFor(side: 'buy' | 'sell', mint: string, amount: number | string, opts: { slippageBps: number; expectSol?: number; balanceRaw?: bigint; decimals?: number }): GuardLimits {
  if (side === 'buy') { const sol = +amount; if (!(sol > 0) || !Number.isFinite(sol)) throw new GuardError('tx guard: bad buy amount ' + String(amount)); return { side, mint, maxSolOut: sol * (1 + opts.slippageBps / 1e4) * 1.03 + 0.02 } }
  let maxTokOutRaw: bigint | undefined
  if (typeof amount === 'string' && amount.trim().endsWith('%')) { if (opts.balanceRaw !== undefined) maxTokOutRaw = (opts.balanceRaw * BigInt(Math.ceil(Math.min(100, parseFloat(amount)) * 100))) / 10000n + 1n }
  else if (opts.decimals !== undefined) maxTokOutRaw = BigInt(Math.ceil(+amount * 10 ** opts.decimals * 1.001)) + 1n
  return { side, mint, maxSolOut: Math.max(0, opts.expectSol || 0) * 0.03 + 0.02, maxTokOutRaw }
}
