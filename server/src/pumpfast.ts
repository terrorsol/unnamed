// pump.fun fast path for the chest: see a buy the moment it is processed, sell into it with a tx we build ourselves.
// Why: the sniper tax (mm.ts) sells a share of every buy in the first seconds after a launch straight back into it. Every hop between the
// buy landing and our sale landing is price the sniper keeps. The old path was: websocket at 'confirmed' → getTransaction → market() read
// → PumpPortal HTTP build → simulate (tx guard) → Sender → confirm polled every second. This one is: websocket at 'processed' → the trade
// event pump writes into its own logs (exact SOL, the curve's reserves after the trade — no extra read) → pump `sell` built locally from
// accounts we derive (no HTTP, no PumpPortal program, no 0.5% fee) → Sender + RPC → confirm polled every 300 ms.
// Only for SOL-quoted, non-mayhem coins still on the curve (our pump launches); anything else keeps the guarded PumpPortal/Jupiter path.
import { Connection, Keypair, PublicKey, SystemProgram, ComputeBudgetProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import bs58 from 'bs58'
import { sendFast, tipAccount, MIN_TIP_LAMPORTS, DONTFRONT } from './fast.ts'

export const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')
export const PUMP_FEES = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ')
const TRADE_EVENT = 'bddb7fd34ee661ee', SELL = '33e685a4017f83ad'
const pda = (seeds: Buffer[], prog = PUMP) => PublicKey.findProgramAddressSync(seeds, prog)[0]
export const curveOf = (mint: PublicKey) => pda([Buffer.from('bonding-curve'), mint.toBuffer()])

export type TradeEvent = { mint: string; sol: number; tokens: number; isBuy: boolean; user: string; ts: number; vSol: bigint; vTok: bigint; rSol: bigint; rTok: bigint; feeBps: number; creator: string; creatorFeeBps: number; buybackFeeBps: number }   // buyback bps is a share OF the protocol fee (5000 = half of it), not an extra charge
/** pump's TradeEvent (anchor event, "Program data: <base64>" in the logs), by the IDL's field order. Fields after creator_fee_bps are read
 *  when present (older events stop earlier). null when the data is not a TradeEvent. */
export function decodeTradeEvent(b64: string): TradeEvent | null {
  let b: Buffer; try { b = Buffer.from(b64, 'base64') } catch { return null }
  if (b.length < 8 + 32 + 8 + 8 + 1 + 32 + 8 + 32 || b.subarray(0, 8).toString('hex') !== TRADE_EVENT) return null
  let o = 8; const pk = () => { const k = new PublicKey(b.subarray(o, o + 32)).toBase58(); o += 32; return k }; const u64 = () => { const x = b.readBigUInt64LE(o); o += 8; return x }; const i64 = () => { const x = b.readBigInt64LE(o); o += 8; return x }; const bool = () => b[o++] === 1
  const mint = pk(), sol = u64(), tokens = u64(), isBuy = bool(), user = pk(), ts = i64(), vSol = u64(), vTok = u64(), rSol = u64(), rTok = u64()
  let feeBps = 95, creator = '', creatorFeeBps = 30, buybackFeeBps = 0
  try { pk(); feeBps = Number(u64()); u64(); creator = pk(); creatorFeeBps = Number(u64()); u64()
    // track_volume, total_unclaimed, total_claimed, current_sol_volume, last_update_ts, ix_name, mayhem_mode, cashback_bps, cashback, buyback_bps
    bool(); u64(); u64(); u64(); i64(); const n = b.readUInt32LE(o); o += 4 + n; bool(); u64(); u64(); buybackFeeBps = Number(u64())
  } catch {}
  return { mint, sol: Number(sol) / 1e9, tokens: Number(tokens), isBuy, user, ts: Number(ts), vSol, vTok, rSol, rTok, feeBps, creator, creatorFeeBps, buybackFeeBps }
}
/** every TradeEvent pump itself emitted in a tx's logs. The runtime prefixes nothing to "Program data:" lines, so any program could log
 *  bytes shaped like a TradeEvent (a forged buy to sell into): the invoke stack is tracked and a line only counts while pump is the program
 *  executing. Truncated logs stop the read (the stack can't be trusted past that point). */
const PUMP_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
export function tradesFromLogs(logs: string[] | null | undefined): TradeEvent[] {
  const out: TradeEvent[] = []; const stack: string[] = []
  for (const l of logs || []) {
    if (l.startsWith('Log truncated')) break
    let m = /^Program (\w{32,44}) invoke \[\d+\]$/.exec(l); if (m) { stack.push(m[1]); continue }
    m = /^Program (\w{32,44}) (success|failed)/.exec(l); if (m) { if (stack.at(-1) === m[1]) stack.pop(); continue }
    if (!l.startsWith('Program data: ') || stack.at(-1) !== PUMP_ID) continue
    const e = decodeTradeEvent(l.slice(14).trim()); if (e) out.push(e)
  } return out
}
/** pump's curve is constant-product on its virtual reserves: an honest event's vSol × vTok equals the curve's k (rounding only grows it a hair).
 *  A decoded event whose k is off by more than 2% from the coin's k (read with its facts) is not used to price a sale. */
export function plausible(ev: TradeEvent): boolean {
  const f = facts.get(ev.mint); if (!f?.k || ev.vSol <= 0n || ev.vTok <= 0n) return ev.vSol > 0n && ev.vTok > 0n
  const k = ev.vSol * ev.vTok; const d = k > f.k ? k - f.k : f.k - k; return d * 50n <= f.k
}

/** what a coin needs for a direct sell, read once from its curve account (+ the mint's owner program). null = not a fast-path coin. */
export type CoinFacts = { mint: string; curve: string; creator: string; tokenProgram: string; cashback: boolean; t: number; k?: bigint }
const facts = new Map<string, CoinFacts>()
export async function coinFacts(conn: Connection, mint: string, fresh = false): Promise<CoinFacts | null> {
  const c = facts.get(mint); if (c && !fresh && Date.now() - c.t < 600_000) return c
  const M = new PublicKey(mint); const curve = curveOf(M)
  const [ci, mi] = await conn.getMultipleAccountsInfo([curve, M], 'confirmed')
  if (!ci || !mi || !ci.owner.equals(PUMP) || ci.data.length < 81) return null
  const d = ci.data; if (d[48] === 1) { facts.delete(mint); return null }           // complete: migrated to the AMM
  if (d.length > 81 && d[81] === 1) return null                                      // mayhem coin: other fee recipients, other rules
  // quoted in another token (older curves predate the field: SOL)
  if (d.length >= 115) { const quote = new PublicKey(d.subarray(83, 115)); if (!quote.equals(PublicKey.default) && quote.toBase58() !== 'So11111111111111111111111111111111111111112') return null }
  const tp = mi.owner.toBase58(); if (tp !== TOKEN_PROGRAM_ID.toBase58() && tp !== TOKEN_2022_PROGRAM_ID.toBase58()) return null
  const f = { mint, curve: curve.toBase58(), creator: new PublicKey(d.subarray(49, 81)).toBase58(), tokenProgram: tp, cashback: d.length > 82 && d[82] === 1, t: Date.now(), k: d.readBigUInt64LE(8) * d.readBigUInt64LE(16) }
  facts.set(mint, f); return f
}
export const forget = (mint: string) => facts.delete(mint)

/** pump Global: fee recipients a trade may pay and the buyback recipients (layout: launch.ts pumpGlobalRecipients). Cached a minute. */
let globalCache: { fee: string[]; buyback: string[]; t: number } | null = null
export async function pumpGlobal(conn: Connection) {
  if (globalCache && Date.now() - globalCache.t < 60_000) return globalCache
  const gi = await conn.getAccountInfo(pda([Buffer.from('global')])); if (!gi) throw new Error('pump global unreadable')
  const { pumpGlobalRecipients } = await import('./launch.ts'); const g = pumpGlobalRecipients(gi.data)
  if (!g.fee.length || !g.buyback.length) throw new Error('pump global lists no recipients')
  globalCache = { ...g, t: Date.now() }; return globalCache
}
const pick = (a: string[]) => new PublicKey(a[Math.floor(Math.random() * a.length)])

/** pump `sell` for `owner`, accounts in the IDL's order + the remaining accounts the official SDK adds (cashback coins: the user's volume
 *  accumulator first; then bonding_curve_v2 and a buyback fee recipient). */
export function sellIx(owner: PublicKey, f: CoinFacts, g: { fee: string[]; buyback: string[] }, amountRaw: bigint, minSolLamports: bigint): TransactionInstruction {
  const M = new PublicKey(f.mint), C = new PublicKey(f.curve), TP = new PublicKey(f.tokenProgram)
  const keys = [
    [pda([Buffer.from('global')]), 0], [pick(g.fee), 1], [M, 0], [C, 1], [getAssociatedTokenAddressSync(M, C, true, TP), 1], [getAssociatedTokenAddressSync(M, owner, true, TP), 1], [owner, 1, 1],
    [SystemProgram.programId, 0], [pda([Buffer.from('creator-vault'), new PublicKey(f.creator).toBuffer()]), 1], [TP, 0], [pda([Buffer.from('__event_authority')]), 0], [PUMP, 0],
    [pda([Buffer.from('fee_config'), PUMP.toBuffer()], PUMP_FEES), 0], [PUMP_FEES, 0],
    ...(f.cashback ? [[pda([Buffer.from('user_volume_accumulator'), owner.toBuffer()]), 1]] : []),
    [pda([Buffer.from('bonding-curve-v2'), M.toBuffer()]), 0], [pick(g.buyback), 1],
  ].map(([pubkey, w, s]: any) => ({ pubkey, isWritable: !!w, isSigner: !!s }))
  const data = Buffer.alloc(24); Buffer.from(SELL, 'hex').copy(data); data.writeBigUInt64LE(amountRaw, 8); data.writeBigUInt64LE(minSolLamports, 16)
  return new TransactionInstruction({ programId: PUMP, keys, data })
}
/** SOL out of the curve for `amountRaw` tokens at reserves (vSol, vTok), after pump's fees (protocol + creator + buyback, bps). Integer math like the program. */
export function sellOut(vSol: bigint, vTok: bigint, amountRaw: bigint, feeBps: number): bigint {
  if (amountRaw <= 0n || vTok <= 0n) return 0n
  const gross = (amountRaw * vSol) / (vTok + amountRaw)
  return gross - (gross * BigInt(Math.max(0, Math.round(feeBps))) + 9999n) / 10000n
}
/** reserves now, from the curve account (when no fresh trade event is at hand) */
export async function reserves(conn: Connection, curve: string): Promise<{ vSol: bigint; vTok: bigint } | null> {
  const ci = await conn.getAccountInfo(new PublicKey(curve), 'processed'); if (!ci || ci.data.length < 49) return null
  if (ci.data[48] === 1) { for (const [m, f] of facts) if (f.curve === curve) facts.delete(m); return null }   // complete: no curve to sell into
  return { vTok: ci.data.readBigUInt64LE(8), vSol: ci.data.readBigUInt64LE(16) }
}

// a recent blockhash kept warm (with the block height it dies at): building a sale never waits on a getLatestBlockhash round trip
let bh: { hash: string; lvh: number; t: number } | null = null, bhTimer: any = null, bhUntil = 0
export function keepBlockhashWarm(conn: Connection, ms: number) {
  bhUntil = Math.max(bhUntil, Date.now() + ms); if (bhTimer) return
  const tick = async () => { try { const r = await conn.getLatestBlockhash('confirmed'); bh = { hash: r.blockhash, lvh: r.lastValidBlockHeight, t: Date.now() } } catch {} if (Date.now() < bhUntil) bhTimer = setTimeout(tick, 2000); else bhTimer = null }
  tick()
}
async function blockhash(conn: Connection) { if (bh && Date.now() - bh.t < 20_000) return bh; const r = await conn.getLatestBlockhash('confirmed'); bh = { hash: r.blockhash, lvh: r.lastValidBlockHeight, t: Date.now() }; return bh }

/** Priority fee for THIS pool, not the network average: the recent fees paid by txs that write-locked the curve (getRecentPrioritizationFees
 *  over ~150 slots), 75th percentile of the non-zero ones, clamped. Cached 2 s per curve — a sniper wave asks once, not per sale. */
const FEE_MIN = +(process.env.FAST_FEE_MIN_MICRO || 20_000), FEE_MAX = +(process.env.FAST_FEE_MAX_MICRO || 2_000_000)
const feeCache = new Map<string, { v: number; t: number }>()
export async function poolPriorityFee(conn: Connection, writable: PublicKey[]): Promise<number> {
  const key = writable[0].toBase58(); const c = feeCache.get(key); if (c && Date.now() - c.t < 2000) return c.v
  const r = await conn.getRecentPrioritizationFees({ lockedWritableAccounts: writable }).catch(() => [] as { prioritizationFee: number }[])
  const xs = r.map((x) => x.prioritizationFee).filter((x) => x > 0).sort((a, b) => a - b)
  const p75 = xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * .75))] : FEE_MIN
  const v = Math.round(Math.min(FEE_MAX, Math.max(FEE_MIN, p75 * 1.1))); feeCache.set(key, { v, t: Date.now() }); return v
}
const CU_LIMIT = +(process.env.FAST_SELL_CU || 75_000)    // the whole sale tx measured 54.5k CU on mainnet (preflight, Oct 30); the limit is what the priority fee is paid on

/** the whole sale as one lean tx: CU limit (sized to the measured sell), CU price, pump sell, tip carrying the jitodontfront marker
 *  (no bundle may put a tx in front of ours). Legacy-size, no lookup tables needed: ~17 accounts. */
export function buildSellTx(owner: PublicKey, f: CoinFacts, g: { fee: string[]; buyback: string[] }, amountRaw: bigint, minSol: bigint, cuPrice: number, tipLamports: number, recentBlockhash: string, cuLimit = CU_LIMIT) {
  const tipIx = SystemProgram.transfer({ fromPubkey: owner, toPubkey: tipAccount(), lamports: tipLamports }); tipIx.keys.push({ pubkey: DONTFRONT, isSigner: false, isWritable: false })
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }), sellIx(owner, f, g, amountRaw, minSol), tipIx]
  return new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash, instructions: ixs }).compileToV0Message())
}
export type FastSell = { sig: string; minSol: number; expectSol: number; amountRaw: bigint; ms: number; feeLamports: number; cuPrice: number }
/** Build, sign (through `signer`, the keeper) and send a direct pump sell; resolves once it is confirmed (polled every 300 ms).
 *  - never pays more than FAST_MAX_FEE_FRAC (default 4%) of what the sale should bring in fees + tip: the CU price is cut to fit, or the sale
 *    is not sent (code 'uneconomic')
 *  - the same signed bytes are rebroadcast until they land or the blockhash dies; a tx whose blockhash died without landing rejects with
 *    `expired: true` and NO sig (it can never land, nothing to book) — anything else that times out rejects with `e.sig` so it can be booked late */
export async function fastSell(conn: Connection, rpc: string, owner: PublicKey, mint: string, amountRaw: bigint, opts: { vSol?: bigint; vTok?: bigint; feeBps?: number; slipBps?: number; tipLamports?: number; cuPrice?: number; floorLamports?: bigint },
  signer: (tx: VersionedTransaction) => VersionedTransaction): Promise<FastSell> {
  const t0 = Date.now()
  const [f, g] = await Promise.all([coinFacts(conn, mint), pumpGlobal(conn)]); if (!f) throw new Error('not a fast-path pump coin')
  const curve = new PublicKey(f.curve)
  const [rs, fee0, b] = await Promise.all([opts.vSol !== undefined && opts.vTok !== undefined ? Promise.resolve({ vSol: opts.vSol, vTok: opts.vTok }) : reserves(conn, f.curve), opts.cuPrice !== undefined ? Promise.resolve(opts.cuPrice) : poolPriorityFee(conn, [curve]), blockhash(conn)])
  if (!rs) throw new Error('curve unreadable')
  const expect = sellOut(rs.vSol, rs.vTok, amountRaw, opts.feeBps ?? 125)
  let minSol = (expect * BigInt(10000 - Math.max(0, Math.min(5000, opts.slipBps ?? 300)))) / 10000n
  if (minSol <= 0n) { const e: any = new Error('sale too small'); e.code = 'uneconomic'; throw e }
  // a cost floor (sniper tax / initials: never under cost +1%) is the min-out itself — the chain refuses a fill below it, whatever moved in between
  if (opts.floorLamports && opts.floorLamports > 0n) { if (opts.floorLamports > expect) { const e: any = new Error(`sale would fill under cost (${(Number(expect) / 1e9).toFixed(4)} < ${(Number(opts.floorLamports) / 1e9).toFixed(4)} SOL)`); e.code = 'below_cost'; throw e } if (minSol < opts.floorLamports) minSol = opts.floorLamports }
  // fee guard: base fee + priority (CU price × limit) + tip ≤ maxFeeFrac of the expected proceeds
  const tip = Math.max(MIN_TIP_LAMPORTS, opts.tipLamports ?? MIN_TIP_LAMPORTS); const budget = Number(expect) * +(process.env.FAST_MAX_FEE_FRAC || 0.04) - 5000 - tip
  if (budget <= 0) { const e: any = new Error(`sale of ${(Number(expect) / 1e9).toFixed(4)} SOL can't carry the tip`); e.code = 'uneconomic'; throw e }
  const cuPrice = Math.max(0, Math.min(fee0, Math.floor((budget * 1e6) / CU_LIMIT)))
  let tx = buildSellTx(owner, f, g, amountRaw, minSol, cuPrice, tip, b.hash)
  selfCheck(tx, owner); tx = signer(tx); const raw = tx.serialize(); const sig = bs58.encode(tx.signatures[0])
  // from here on the signed bytes exist and may land: every error carries the sig (booked late, never retried by another route) unless the
  // blockhash is provably dead with the tx nowhere (expired). A failed first send is not an error: the rebroadcast and the confirm loop decide.
  await sendFast(conn, raw, rpc).catch(() => conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 })).catch(() => {})
  const rb = setInterval(() => { sendFast(conn, raw, rpc).catch(() => {}) }, 1200)
  const done = (): FastSell => ({ sig, minSol: Number(minSol) / 1e9, expectSol: Number(expect) / 1e9, amountRaw, ms: Date.now() - t0, feeLamports: 5000 + Math.ceil(CU_LIMIT * cuPrice / 1e6) + tip, cuPrice })
  try {
    let lastHeightCheck = 0, deadMisses = 0
    for (const tEnd = Date.now() + 120_000; Date.now() < tEnd;) {
      const st = (await conn.getSignatureStatuses([sig]).catch(() => null))?.value?.[0]
      if (st?.err) { forget(mint); const e: any = new Error('sell failed: ' + JSON.stringify(st.err)); e.sig = sig; e.landedErr = true; throw e }
      if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return done()
      if (Date.now() - lastHeightCheck > 1500) { lastHeightCheck = Date.now()
        const h = await conn.getBlockHeight('confirmed').catch(() => 0)
        // the blockhash is dead well past its last valid height (a margin for a lagging node and forks), and the tx was not found twice in a
        // row with history searched: it can never land. One miss alone is not proof (a node behind the cluster answers null).
        if (h > b.lvh + 32) {
          const st2 = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true }).catch(() => undefined))?.value?.[0]
          if (st2 && !st2.err) return done()
          if (st2?.err) { forget(mint); const e: any = new Error('sell failed: ' + JSON.stringify(st2.err)); e.sig = sig; e.landedErr = true; throw e }
          if (st2 === null && ++deadMisses >= 2) { const e: any = new Error('sell expired unlanded (blockhash died)'); e.expired = true; throw e } } }
      await new Promise((r) => setTimeout(r, 300))
    }
    const e: any = new Error('confirm timeout ' + sig); e.sig = sig; throw e
  } catch (e: any) { if (!e?.expired && !e?.sig) { try { e.sig = sig } catch {} } throw e } finally { clearInterval(rb) }
}
/** the vault's keypair-free check of its own fast sell: one signer (the vault, paying), only compute budget + pump sell + one tip transfer */
export function selfCheck(tx: VersionedTransaction, owner: PublicKey): void {
  const m = tx.message; const k = m.staticAccountKeys
  if (m.header.numRequiredSignatures !== 1 || !k[0].equals(owner)) throw new Error('fast sell: signer')
  for (const ix of m.compiledInstructions) { const p = k[ix.programIdIndex].toBase58()
    if (p === 'ComputeBudget111111111111111111111111111111') continue
    if (p === PUMP.toBase58() && Buffer.from(ix.data.subarray(0, 8)).toString('hex') === SELL) continue
    if (p === SystemProgram.programId.toBase58() && ix.data.length === 12 && Buffer.from(ix.data).readUInt32LE(0) === 2 && Number(Buffer.from(ix.data).readBigUInt64LE(4)) <= 5_000_000) continue
    throw new Error('fast sell: unexpected instruction ' + p.slice(0, 8)) }
}
export { Keypair }
