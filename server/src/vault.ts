// Off-chain vault market maker (beta). One keypair per coin, held here encrypted at rest.
// Rules: buy dips (≤40% of chest per crash), trim only above cost+5% AND 30-min VWAP AND uptrend, never withdraw.
import { Keypair } from '@solana/web3.js'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, statSync } from 'node:fs'
import bs58 from 'bs58'
import * as R from './rules.ts'
import { market } from './market.ts'
import { balanceSol, tokenBalance, pumpTrade, conn, confirm, decimals, TREASURY, holderStats } from './chain.ts'
import * as C from './chain.ts'
import * as D from './desk.ts'
import { watchPool, streamStats } from './stream.ts'
import * as KEEP from './keeper.ts'
import * as VM from './vamp.ts'
import * as MM from './mm.ts'
import * as EV from './events.ts'
import { taxWeights } from './tax.ts'
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { PublicKey, SystemProgram, Transaction, ComputeBudgetProgram } from '@solana/web3.js'

const DIR = process.env.DATA_DIR || './data'; const FILE = DIR + '/vaults.json'
/** Live tape: every swap seen on a vaulted coin, one JSON line {t,side,sol,trader,sig} → DATA_DIR/tape/<mint>.jsonl. Replay with `npm run replay -- <file>` in app/. Capped at ~20MB per coin. */
const recentTape = new Map<string, MM.Swap[]>()
// ---- price log → candles for our own coins (gecko/dexscreener do not index a fresh LaunchLab pool for a while, and the vault reads the pool exactly every tick)
const PX_DIR = () => (process.env.DATA_DIR || './data') + '/px'
const pxLog = new Map<string, { t: number; p: number }[]>(); const volLog = new Map<string, { t: number; sol: number; side: 'buy' | 'sell' }[]>()
function pxLoad(mint: string) { if (pxLog.has(mint)) return pxLog.get(mint)!; let l: { t: number; p: number }[] = []; try { const f = `${PX_DIR()}/${mint}.jsonl`; if (existsSync(f)) { const cut = Date.now() - 86400_000 * 3; l = readFileSync(f, 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x)).filter((x) => x.t > cut) } } catch {} pxLog.set(mint, l); return l }
export function pxPush(mint: string, t: number, p: number) { const l = pxLoad(mint); if (l.length && l[l.length - 1].p === p && t - l[l.length - 1].t < 30_000) return; l.push({ t, p }); if (l.length > 60000) l.splice(0, 20000); try { if (!existsSync(PX_DIR())) mkdirSync(PX_DIR(), { recursive: true }); appendFileSync(`${PX_DIR()}/${mint}.jsonl`, JSON.stringify({ t, p }) + '\n') } catch {} }
/** OHLCV from the vault's own price reads + the swap tape. tf in seconds. Prices in SOL per token. */
export function candles(mint: string, tf = 60, limit = 300) {
  const l = pxLoad(mint); if (!l.length) return []
  const vol = volLog.get(mint) || []; const by = new Map<number, { time: number; open: number; high: number; low: number; close: number; volume: number }>()
  for (const x of l) { const b = Math.floor(x.t / 1000 / tf) * tf; const c = by.get(b); if (!c) by.set(b, { time: b, open: x.p, high: x.p, low: x.p, close: x.p, volume: 0 }); else { c.high = Math.max(c.high, x.p); c.low = Math.min(c.low, x.p); c.close = x.p } }
  for (const v of vol) { const b = Math.floor(v.t / 1000 / tf) * tf; const c = by.get(b); if (c) c.volume += v.sol }
  const out = [...by.values()].sort((a, b) => a.time - b.time)
  // fill gaps with flat bars so the chart has no holes
  const filled: typeof out = []; for (const c of out) { const prev = filled[filled.length - 1]; if (prev) for (let t = prev.time + tf; t < c.time && filled.length < 5000; t += tf) filled.push({ time: t, open: prev.close, high: prev.close, low: prev.close, close: prev.close, volume: 0 }); filled.push(c) }
  return filled.slice(-limit)
}
/** last 10 minutes of swaps on a mint, in memory (seller-concentration check) */
export const recent = (mint: string) => recentTape.get(mint) || []
let lastTapeSave = 0
export function tape(mint: string, e: { t: number; side: 'buy' | 'sell'; sol: number; trader?: string; sig?: string }) {
  // the 2% platform fee lands in ONE launchlab vault for all our coins; per-coin credit comes from the volume we observe here
  { const v = Object.values(vaults).find((x) => x.mint === mint && x.armed && x.venue === 'launchlab'); if (v && e.sol > 0) { v.taxAccrued = +((v.taxAccrued || 0) + e.sol * LL.TAX_BPS / 1e4).toFixed(9); if (Date.now() - lastTapeSave > 20_000) { lastTapeSave = Date.now(); try { save() } catch {} } } }
  const r = recentTape.get(mint) || []; r.push({ t: e.t, side: e.side, sol: e.sol, trader: e.trader }); recentTape.set(mint, r.filter((x) => e.t - x.t < 600_000))
  const vl = volLog.get(mint) || []; vl.push({ t: e.t, sol: e.sol, side: e.side }); if (vl.length > 50000) vl.splice(0, 10000); volLog.set(mint, vl)
  try { const d = DIR + '/tape'; if (!existsSync(d)) mkdirSync(d, { recursive: true }); const f = `${d}/${mint}.jsonl`; if (existsSync(f) && statSync(f).size > 20e6) return; appendFileSync(f, JSON.stringify(e) + '\n') } catch {}
}
const SECRET = process.env.VAULT_SECRET || 'dev-only-secret-change-me'
const key = scryptSync(SECRET, 'unnamed-vault', 32)
const enc = (u: Uint8Array) => { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); const ct = Buffer.concat([c.update(u), c.final()]); return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64') }
const dec = (s: string) => { const b = Buffer.from(s, 'base64'); const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return new Uint8Array(Buffer.concat([d.update(b.subarray(28)), d.final()])) }

export type Act = { t: number; kind: 'stake' | 'seed' | 'buy' | 'trim' | 'cut' | 'note' | 'redeem' | 'stream' | 'bid' | 'capture'; sol?: number; tokens?: number; price?: number; sig?: string; msg?: string }
export type Vault = { armedAt?: number; launchSpend?: number; taxAccrued?: number; nextAutoArmAt?: number; shared?: boolean; ledgerDirty?: boolean; mmSpent?: number; mmGot?: number; mmTok?: number; mmCost?: number; invGot?: number; stoppedAt?: number; stopNoted?: boolean; epHigh?: number; epStart?: number; cooldownUntil?: number; dayKey?: number; dayDefense?: number; dayChest0?: number; deskPauseUntil?: number; lastDeskFill?: { t: number; p: number } | null; vaultBuySol?: number; lastPushed?: number; vampFlag?: boolean; askRefreshAt?: number; uri?: string; image?: string; permTax?: number; nextPermAt?: number; venue?: 'pump' | 'launchlab'; taxClaimed?: number; nextClaimAt?: number; nextHarvestAt?: number; vampChecked?: number; holders?: any; ddPrev?: number; nextCaptureAt?: number; levelJit?: number; bidRefreshAt?: number; nextTickAt?: number; paper?: boolean; crowd?: { goalSol: number; raised: number; contributors: Record<string, number>; expiresAt: number; refunded?: boolean }; id: string; pub: string; sk: string; mint?: string; symbol?: string; name?: string; dev: string; stakeSol: number; pct: number; cut: number; armed: boolean; renounced: boolean; createdAt: number; copyOf?: string; streamed: number; redeemed: number; supply: number; deskBid: number; imported?: boolean; feePaid?: number; trimmedToday: number; trimDay: number; depositedTokens: number; funders: Record<string, number>; mode: 'floor' | 'mm'; ceiling: number; lastLiq: number; lastLiqT: number; buyTimes: number[]; tranchesFired: number[]; score: { captured: number; captures: number; deskBought: number; deskFills: number; dipBought: number; dips: number; redeployed: number; floor0: number }; lastCapture: number
  avgCost: number; tokens: number; chest: number; spentEpisode: number; high15: { t: number; p: number }[]; samples: { t: number; p: number; v: number }[]; ema5: number | null; ema15: number | null; lastBuy: number; lastTrim: number; activity: Act[]; devPaid: number }
let vaults: Record<string, Vault> = {}
const watched = new Map<string, () => void>()
let SOLUSD = 0; setInterval(() => fetch(`${process.env.DEX_URL || 'https://api.dexscreener.com'}/tokens/v1/solana/So11111111111111111111111111111111111111112`).then((r) => r.json()).then((a: any[]) => { const x = a?.[0]?.priceUsd; if (x) SOLUSD = +x }).catch(() => {}), 30000)
export function load() { if (existsSync(FILE)) vaults = JSON.parse(readFileSync(FILE, 'utf8')) }
function save() { mkdirSync(DIR, { recursive: true }); writeFileSync(FILE, JSON.stringify(vaults)) }
const kp = (v: Vault) => Keypair.fromSecretKey(dec(v.sk))
/** One brand wallet for every vault (VAULT_KEY, base58 secret): the same address is the top holder on every coin we launch or import.
 *  Its SOL is many chests in one account, so a shared vault's chest is a ledger, moved by the exact pre/post delta of each tx it signs —
 *  never read off the wallet balance. Vaults made before VAULT_KEY was set keep their own keys. */
export const SHARED = process.env.VAULT_KEY ? Keypair.fromSecretKey(bs58.decode(process.env.VAULT_KEY)) : null
export const sharedPub = () => SHARED?.publicKey.toBase58() || null
const newKey = () => SHARED || Keypair.generate()
/** SOL moved in/out of `pub` by a confirmed tx (post − pre, fee included). Retries while the parsed tx is not indexed yet. */
export async function txDelta(sig: string, pub: string): Promise<number> {
  for (let i = 0; i < 12; i++) {
    const tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' }).catch(() => null)
    if (tx?.meta) { if (tx.meta.err) return 0; const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58()); const i = keys.indexOf(pub); return i < 0 ? 0 : (tx.meta.postBalances[i] - tx.meta.preBalances[i]) / 1e9 }
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error('tx not indexed: ' + sig.slice(0, 12))
}
/** book a tx against a shared vault's chest ledger; a per-key vault reads its balance instead */
async function book(v: Vault, sig: string | undefined, fallback = 0) {
  if (PAPER || !sig || sig.startsWith('paper-')) return
  if (!v.shared) { v.chest = await balanceSol(v.pub); return }
  try { const d = await txDelta(sig, v.pub); v.chest = Math.max(0, +(v.chest + d).toFixed(9)) } catch (e: any) { v.chest = Math.max(0, v.chest + fallback); v.ledgerDirty = true; EV.log('error', `${v.symbol || v.id} ledger: ${String(e.message).slice(0, 80)} (fallback ${fallback})`, { mint: v.mint, sig }) }
}
/** trades whose confirmation timed out: the tx may still land. Retried every tick for ~10 min, booked by exact delta when it does. */
const lateBooks: { id: string; sig: string; fallback: number; until: number; after?: (v: Vault, chestBefore: number) => void }[] = []
export function deferBook(v: Vault, sig: string | undefined, fallback: number, after?: (v: Vault, chestBefore: number) => void) { if (!sig || PAPER) return; lateBooks.push({ id: v.id, sig, fallback, until: Date.now() + 10 * 60_000, after }); EV.log('vault', `${v.symbol || v.id} tx ${sig.slice(0, 8)}… not confirmed in time — will book it if it lands`, { sig }) }
export async function settleLateBooks() {
  for (const lb of lateBooks.slice()) {
    const v = vaults[lb.id]; if (!v) { lateBooks.splice(lateBooks.indexOf(lb), 1); continue }
    const st = (await conn.getSignatureStatuses([lb.sig]).catch(() => null))?.value?.[0]
    if (st && !st.err && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) { const cb = v.chest; await sync(v, lb.sig, lb.fallback).catch(() => {}); try { lb.after?.(v, cb) } catch {} v.activity.unshift({ t: Date.now(), kind: 'note', sig: lb.sig, msg: 'late-landing tx booked' }); lateBooks.splice(lateBooks.indexOf(lb), 1); save() }
    else if (st?.err || Date.now() > lb.until) lateBooks.splice(lateBooks.indexOf(lb), 1)
  }
}
/** SOL in the shared wallet that no ledger claims (dust, fees paid by the platform, unattributed deposits). Never spent. */
export async function sharedAudit() { if (!SHARED) return null; const bal = await balanceSol(SHARED.publicKey.toBase58()); const ledgers = Object.values(vaults).filter((v) => v.shared && !v.paper).reduce((a, v) => a + (v.chest || 0), 0); if (bal - ledgers < -0.01) EV.log('error', `ledger drift: wallet ${bal.toFixed(4)} < ledgers ${ledgers.toFixed(4)} — a spend was not booked`, { bal, ledgers }); return { wallet: SHARED.publicKey.toBase58(), balanceSol: +bal.toFixed(6), ledgersSol: +ledgers.toFixed(6), unattributedSol: +(bal - ledgers).toFixed(6), vaults: Object.values(vaults).filter((v) => v.shared && v.armed).length } }
const pub = (v: Vault) => ({ id: v.id, pub: v.pub, paper: !!v.paper, venue: v.venue || 'pump', taxClaimed: v.taxClaimed || 0, image: v.image, uri: v.uri, vampFlag: !!v.vampFlag, permTax: v.permTax || 0, crowd: v.crowd ? { goalSol: v.crowd.goalSol, raised: +v.crowd.raised.toFixed(3), backers: Object.keys(v.crowd.contributors).length, expiresAt: v.crowd.expiresAt, refunded: !!v.crowd.refunded } : undefined, mint: v.mint, symbol: v.symbol, name: v.name, dev: v.dev, stakeSol: v.stakeSol, pct: v.pct, cut: v.cut, armed: v.armed, renounced: v.renounced, avgCost: v.avgCost, tokens: v.tokens, chest: v.chest, devPaid: v.devPaid, activity: v.activity.slice(0, 50), createdAt: v.createdAt, copyOf: v.copyOf, imported: !!v.imported, mode: v.mode || 'floor', ceiling: v.ceiling ?? R.MM_MAX_CAPTURE, score: v.score || { captured: 0, captures: 0, deskBought: 0, deskFills: 0, dipBought: 0, dips: 0, redeployed: 0, floor0: 0 }, floor: v.supply ? v.chest / v.supply : 0, live: liveReadout(v), holders: v.holders || null, feePaid: v.feePaid || 0, depositedTokens: v.depositedTokens || 0, funders: v.funders || {}, streamed: v.streamed || 0, redeemed: v.redeemed || 0, supply: v.supply || 1e9, deskBid: v.deskBid || 0, shared: !!v.shared, vaultBuySol: v.vaultBuySol ?? null, mm: { spent: v.mmSpent || 0, got: v.mmGot || 0, tok: v.mmTok || 0, cost: v.mmCost || 0, inv: v.invGot || 0, stopped: !!v.stoppedAt }, copies: Object.values(vaults).filter((c) => c.copyOf === v.mint && c.armed).map((c) => ({ mint: c.mint, symbol: c.symbol, pub: c.pub })) })
export const vaultPct = (buySol: number) => Math.min(50, L.blockZero(0, buySol).vaultPct) // real curve: what the block-zero buy takes of supply (20–50% is the launch range)
/** SOL the block-zero buy needs for `pct` of supply (binary search on the curve) */
export function solForPct(pct: number, devSol = 0) { let lo = 0, hi = 500; for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (L.blockZero(devSol, mid).vaultPct > pct) hi = mid; else lo = mid } return +hi.toFixed(4) }

/** Step 1 (before launch): make a vault address the dev will fund */
/** Beta cap: vault keys are hot on this server, so no single chest may hold more than this until the on-chain program lands. 0 = no cap. */
export const MAX_CHEST_SOL = +(process.env.MAX_CHEST_SOL ?? 25)
const capCheck = (sol: number) => { if (MAX_CHEST_SOL > 0 && sol > MAX_CHEST_SOL) throw new Error(`beta cap: a vault chest holds at most ${MAX_CHEST_SOL} SOL right now (custodial keys) — the on-chain program lifts this`) }
export function create(dev: string, stakeSol: number, copyOf?: string, mode: 'floor' | 'mm' = 'mm', ceiling = R.MM_MAX_CAPTURE, venue: 'pump' | 'launchlab' = 'pump', vaultBuySol?: number, targetPct?: number) {
  if (!Number.isFinite(stakeSol) || stakeSol < 0) throw new Error('bad stake')
  // stake = block-zero buy + chest. Without an explicit buy, half of the stake buys supply (legacy / pump launches).
  // A launchpad vault may start with no buy at all: the 2% tax fills the chest and the bot accumulates toward targetPct under VWAP.
  const buy = vaultBuySol != null && Number.isFinite(vaultBuySol) ? Math.min(Math.max(0, vaultBuySol), stakeSol) : stakeSol * 0.5
  if (stakeSol - buy < 0.05) throw new Error('the chest needs at least 0.05 SOL for fees')
  capCheck(stakeSol - buy)
  const k = newKey(); const id = bs58.encode(randomBytes(8))
  const pct = targetPct != null && Number.isFinite(targetPct) ? +Math.min(50, Math.max(5, targetPct)).toFixed(2) : +vaultPct(buy).toFixed(2)
  vaults[id] = { id, venue, shared: !!SHARED, vaultBuySol: buy, pub: k.publicKey.toBase58(), sk: enc(k.secretKey), dev, stakeSol, pct, cut: pct, armed: false, renounced: false, createdAt: Date.now(), copyOf: copyOf || undefined, streamed: 0, redeemed: 0, supply: 1e9, deskBid: 0, trimmedToday: 0, trimDay: 0, depositedTokens: 0, funders: {}, avgCost: 0, tokens: 0, chest: 0, spentEpisode: 0, high15: [], samples: [], ema5: null, ema15: null, lastBuy: 0, lastTrim: 0, activity: [], devPaid: 0 }
  vaults[id].mode = mode; vaults[id].ceiling = Math.min(R.MM_MAX_CAPTURE, Math.max(0.05, ceiling)); save(); return pub(vaults[id])
}
/** Step 1b: the dev's stake transfer landed (sig). Required for shared-wallet vaults (the ledger can't see deposits in the wallet balance); harmless for per-key vaults. */
export async function fund(id: string, sig: string) {
  const v = vaults[id]; if (!v) throw new Error('no such vault'); if (v.armed) throw new Error('already armed')
  if (Object.values(vaults).some((x) => x.activity.some((a) => a.sig === sig))) return pub(v)
  const tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' }); if (!tx || tx.meta?.err) throw new Error('funding tx not found or failed')
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58()); const i = keys.indexOf(v.pub); const got = i < 0 ? 0 : (tx.meta!.postBalances[i] - tx.meta!.preBalances[i]) / 1e9
  if (got < 0.001) throw new Error('no SOL to the vault wallet in that tx'); if (!keys.includes(v.dev)) throw new Error('tx not from the vault owner')
  if (v.shared) v.chest = +(v.chest + got).toFixed(9); else v.chest = await balanceSol(v.pub)
  v.activity.unshift({ t: Date.now(), kind: 'stake', sol: got, sig, msg: 'dev stake received' }); save(); return pub(v)
}
/** Step 2 (after the coin exists + dev sent the stake): bind mint, seed the position */
export async function arm(id: string, mint: string, symbol: string, name = '', auth?: { msg?: string; sig?: string }, fundSig?: string) {
  const v = vaults[id]; if (!v) throw new Error('no such vault'); if (v.armed) return pub(v)
  // arming needs the dev: a session/message signature, OR the coin itself — a LaunchLab pool whose on-chain creator is the vault's dev (only that wallet could have created it)
  if (!v.imported) { try { devAuth(v, 'arm', mint, auth) } catch (e) { const pl = await LL.pool(mint).catch(() => null); if (!pl || pl.creator !== v.dev) throw e } }
  // after a block-zero bundle half the stake is already in tokens, so the SOL check is against the other half
  const bundled = v.activity.some((a) => (a.msg || '').startsWith('signed block-zero'))
  const buy = v.vaultBuySol ?? v.stakeSol * 0.5
  let bal: number
  if (v.shared) {
    // shared wallet: the stake is credited from the funding tx (dev → vault wallet), the bundle's spend from the bundle tx the vault signed
    if (fundSig) await fund(id, fundSig).catch(() => {})
    const funded = v.activity.filter((a) => a.kind === 'stake').reduce((a, x) => a + (x.sol || 0), 0)
    if (funded < v.stakeSol * 0.95 - 0.001) throw new Error(`vault not funded: ${funded.toFixed(3)} / ${v.stakeSol} SOL — send the stake and call /vault/fund with the tx`)
    // the bundle's block-zero buy (vault-signed, sent by the dev): book its real SOL delta if it landed
    for (const a of v.activity) if (a.msg?.startsWith('signed block-zero') && a.sig && !a.msg.includes('booked')) { try { v.chest = Math.max(0, +(v.chest + await txDelta(a.sig, v.pub)).toFixed(9)); a.msg += ' · booked' } catch {} }
    bal = v.chest
  } else { bal = await balanceSol(v.pub); if (bal < (bundled ? (v.stakeSol - buy) * 0.8 : v.stakeSol * 0.95)) throw new Error(`vault not funded: ${bal.toFixed(3)} / ${v.stakeSol} SOL`); v.chest = bal }
  v.mint = mint; v.symbol = symbol; v.name = name; v.armed = true; v.armedAt = Date.now(); VM.watch(mint); try { const sup = await conn.getTokenSupply(new PublicKey(mint)); v.supply = +(sup.value.uiAmount || 1e9) } catch {} if (!v.shared) v.activity.unshift({ t: Date.now(), kind: 'stake', sol: bal, msg: 'dev stake received' }); EV.log('vault', `${symbol} armed · chest ${bal.toFixed(3)} SOL`, { mint, id })
  // seed: the block-zero buy (skipped when the vault already bought in the bundle, or when the launch is tax-funded: no buy, the bot accumulates)
  const seed = +Math.min(buy, bal - 0.05).toFixed(4)
  if (seed < 0.05) { v.activity.unshift({ t: Date.now(), kind: 'note', msg: `tax-funded: no block-zero buy, accumulating toward ${v.pct}% under VWAP` }); save(); return pub(v) }
  if (!bundled && MM.P.profitOnly) { v.activity.unshift({ t: Date.now(), kind: 'note', msg: 'test mode: no market buy after launch (the vault only buys in block zero), the fees fill the chest' }); save(); return pub(v) }
  if (bundled) {
    await sync(v)
    // the bundle can be signed and still not land (Jito drops it, tip too low). Tokens on the vault wallet are the only proof.
    if (v.tokens > 0) { v.avgCost = buy / v.tokens; v.launchSpend = buy; v.activity.unshift({ t: Date.now(), kind: 'seed', sol: buy, tokens: v.tokens, msg: 'block-zero vault supply (bundled)' }); save(); return pub(v) }
    if (MM.P.profitOnly) { v.activity.unshift({ t: Date.now(), kind: 'note', msg: 'block-zero buy did not land — test mode: no market buy after launch, the fees fill the chest' }); save(); return pub(v) }
    v.activity.unshift({ t: Date.now(), kind: 'note', msg: 'bundle did not land — seeding now' })
  }
  try { const sig = await trade(v, 'buy', seed, true, 0); await sync(v, sig, -seed); v.avgCost = seed / Math.max(v.tokens, 1e-9); v.activity.unshift({ t: Date.now(), kind: 'seed', sol: seed, tokens: v.tokens, sig, msg: 'block-zero vault supply' }) }
  catch (e: any) { v.activity.unshift({ t: Date.now(), kind: 'note', msg: 'seed failed: ' + e.message }) }
  save(); return pub(v)
}
/** Every 15s: a funded vault whose coin is on chain but which never armed (bundle dropped, arm never signed, tab closed) arms itself —
 *  the dev already authorized the launch; arm needs no second signature. Unfunded vaults older than 2h are dropped. */
let armingNow = false
const AUTOARM_SINCE = Date.parse('2026-10-28T18:00:00Z') // vaults from before this feature (the first live launch, refunded by hand) are left alone
export async function autoArm() {
  if (armingNow || PAPER) return; armingNow = true
  try {
    for (const v of Object.values(vaults)) {
      if (v.armed || v.imported || v.paper || v.createdAt < AUTOARM_SINCE || (v as any).closedAt) continue
      const funded = v.activity.filter((a) => a.kind === 'stake').reduce((a, x) => a + (x.sol || 0), 0)
      if (!v.mint) { if (Date.now() - v.createdAt > 2 * 3600_000 && funded === 0 && v.chest === 0) { delete vaults[v.id]; save() } continue }
      if (v.shared ? funded < v.stakeSol * 0.95 - 0.001 : false) continue
      if (v.nextAutoArmAt && Date.now() < v.nextAutoArmAt) continue; v.nextAutoArmAt = Date.now() + 30_000
      const exists = await LL.pool(v.mint).then((p) => !!p).catch(() => false); if (!exists) continue
      try { await arm(v.id, v.mint, v.symbol || '', v.name || '', { sessionWallet: v.dev }); EV.log('vault', `${v.symbol} auto-armed (coin on chain, arm never signed)`, { id: v.id, mint: v.mint }) }
      catch (e: any) { v.activity.unshift({ t: Date.now(), kind: 'note', msg: 'auto-arm: ' + String(e.message || e).slice(0, 100) }); EV.log('error', `${v.symbol} auto-arm: ${String(e.message || e).slice(0, 140)}`, { id: v.id }) }
    }
  } finally { armingNow = false }
}
/** Bring-your-own-coin: quote the import for a mint */
export async function importQuote(mint: string) {
  if (Object.values(vaults).some((v) => v.mint === mint && v.armed)) throw new Error('this coin already has a vault')
  const m = await market(mint); if (!m) throw new Error('no market found for this mint')
  if (m.mcapUsd < R.IMPORT_MIN_MCAP_USD) throw new Error(`market cap below $${R.IMPORT_MIN_MCAP_USD / 1000}K`)
  return { mint, symbol: m.symbol, mcapUsd: m.mcapUsd, liqSol: m.liqSol, priceSol: m.priceSol, feeSol: R.IMPORT_FEE_SOL, seedSol: R.IMPORT_SEED_SOL, treasurySol: R.IMPORT_FEE_SOL - R.IMPORT_SEED_SOL, treasury: TREASURY }
}
/** Step 1: reserve a vault for an existing coin (owner = whoever pays) */
export async function importCreate(owner: string, mint: string) {
  const q = await importQuote(mint); const k = newKey(); const id = bs58.encode(randomBytes(8))
  const venue: 'pump' | 'launchlab' = (await LL.pool(mint).catch(() => null)) ? 'launchlab' : 'pump'
  vaults[id] = { id, venue, shared: !!SHARED, pub: k.publicKey.toBase58(), sk: enc(k.secretKey), mint, symbol: q.symbol, dev: owner, stakeSol: R.IMPORT_SEED_SOL, pct: 0, cut: 5, armed: false, renounced: false, createdAt: Date.now(), streamed: 0, redeemed: 0, supply: 1e9, deskBid: 0, imported: true, feePaid: 0, trimmedToday: 0, trimDay: 0, depositedTokens: 0, funders: {}, mode: 'mm', ceiling: R.MM_MAX_CAPTURE, lastLiq: 0, lastLiqT: 0, buyTimes: [], tranchesFired: [], score: { captured: 0, captures: 0, deskBought: 0, deskFills: 0, dipBought: 0, dips: 0, redeployed: 0, floor0: 0 }, lastCapture: 0, avgCost: 0, tokens: 0, chest: 0, spentEpisode: 0, high15: [], samples: [], ema5: null, ema15: null, lastBuy: 0, lastTrim: 0, activity: [], devPaid: 0 }
  save(); return { ...pub(vaults[id]), quote: q }
}
/** Step 2: after the fee tx (10 → treasury, 5 → vault) confirms, arm it. Verifies the tx on-chain. */
export async function importActivate(id: string, sig: string) {
  const v = vaults[id]; if (!v || !v.imported) throw new Error('no such import'); if (v.armed) return pub(v)
  const tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' }); if (!tx || tx.meta?.err) throw new Error('fee transaction not found or failed')
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58()); const pre = tx.meta!.preBalances, post = tx.meta!.postBalances
  const delta = (pk: string) => { const i = keys.indexOf(pk); return i < 0 ? 0 : (post[i] - pre[i]) / 1e9 }
  if (delta(TREASURY) < R.IMPORT_FEE_SOL - R.IMPORT_SEED_SOL - 0.001) throw new Error('treasury fee not found in tx')
  if (delta(v.pub) < R.IMPORT_SEED_SOL - 0.001) throw new Error('chest seed not found in tx')
  if (!keys.includes(v.dev)) throw new Error('tx not from the vault owner')
  if (Object.values(vaults).some((x) => x.activity.some((a) => a.sig === sig))) throw new Error('that tx is already booked')
  if (v.shared) v.chest = +(v.chest + delta(v.pub)).toFixed(9)
  v.feePaid = R.IMPORT_FEE_SOL; v.funders[v.dev] = (v.funders[v.dev] || 0) + R.IMPORT_SEED_SOL
  try { const sup = await conn.getTokenSupply(new PublicKey(v.mint!)); v.supply = +(sup.value.uiAmount || 1e9) } catch {}
  await sync(v); v.armed = true; v.armedAt = Date.now(); v.activity.unshift({ t: Date.now(), kind: 'stake', sol: v.chest, sig, msg: `vault activated · ${R.IMPORT_FEE_SOL} SOL import (${R.IMPORT_SEED_SOL} seeded)` }); save(); return pub(v)
}
/** PAPER only: arm a vault on any live coin with a virtual chest and inventory — no payment, no chain. */
export async function paperArm(mint: string, chestSol = 20, mode: 'floor' | 'mm' = 'mm') {
  if (!PAPER) throw new Error('paper vaults only exist when PAPER=1')
  const m = await market(mint); if (!m) throw new Error('no market'); const k = Keypair.generate(); const id = 'paper-' + bs58.encode(randomBytes(4))
  vaults[id] = { id, pub: k.publicKey.toBase58(), sk: enc(k.secretKey), mint, symbol: m.symbol, dev: k.publicKey.toBase58(), stakeSol: chestSol, pct: 0, cut: 0, armed: true, renounced: true, createdAt: Date.now(), streamed: 0, redeemed: 0, supply: 1e9, deskBid: 0, imported: true, feePaid: 0, trimmedToday: 0, trimDay: 0, depositedTokens: 0, funders: {}, activity: [], mode, ceiling: R.MM_MAX_CAPTURE, samples: [], high15: [], buyTimes: [], ema5: null, ema15: null, trimmedToday: 0, trimDay: 0, lastLiq: 0, lastLiqT: 0, score: { captured: 0, captures: 0, deskBought: 0, deskFills: 0, dipBought: 0, dips: 0, redeployed: 0, floor0: 0 }, lastCapture: 0, lastBuy: 0, lastTrim: 0, spentEpisode: 0, tranchesFired: [], avgCost: m.priceSol, tokens: (chestSol * 0.5) / m.priceSol, chest: chestSol * 0.5, devPaid: 0, paper: true, armedAt: Date.now() } as any
  try { const sup = await conn.getTokenSupply(new PublicKey(mint)); vaults[id].supply = +(sup.value.uiAmount || 1e9) } catch {}
  vaults[id].activity.unshift({ t: Date.now(), kind: 'note', msg: `paper vault · ${chestSol} SOL virtual · half seeded at ${m.priceSol.toPrecision(3)}` }); return pub(vaults[id])
}
/** SOL transfer signed by the vault key, confirmed by polling (no websocket dependency). */
async function payFrom(v: Vault, to: string, lamports: number, purpose: KEEP.Purpose = 'payout') {
  // priority fee + rebroadcast: a plain transfer with no priority fee gets dropped when the network is busy (refunds timed out on Oct 29)
  const k = kp(v); const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 5000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: +(process.env.PAYOUT_CU_PRICE || 400000) }), SystemProgram.transfer({ fromPubkey: k.publicKey, toPubkey: new PublicKey(to), lamports }))
  const lb = await conn.getLatestBlockhash('confirmed'); tx.feePayer = k.publicKey; tx.recentBlockhash = lb.blockhash; KEEP.sign({ id: v.id, chest: v.chest, sk: k }, tx, purpose, lamports / 1e9)
  const raw = tx.serialize(); const sig = await conn.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 0 })
  // resend the same signed tx every 2s until it confirms or its blockhash expires: it can only ever land once (same signature)
  const t0 = Date.now(); let landed = false
  while (Date.now() - t0 < 75_000) {
    const st = (await conn.getSignatureStatuses([sig]).catch(() => null))?.value?.[0]
    if (st?.err) throw new Error('payout failed: ' + JSON.stringify(st.err))
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) { landed = true; break }
    const h = await conn.getBlockHeight('confirmed').catch(() => 0); if (h && h > lb.lastValidBlockHeight) break
    conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {}); await wait(2000)
  }
  if (!landed) { (v as any)._payPending = { sig, t: Date.now() }; const e: any = new Error('payout not confirmed yet — nothing was double-paid; if it lands it is booked, otherwise press again in a minute'); e.sig = sig; deferBook(v, sig, -(lamports / 1e9 + 0.000005)); throw e }
  await book(v, sig, -(lamports / 1e9 + 0.000005)); return sig
}
/** Community takeover import: nobody pays 15 SOL alone. The vault wallet itself is the escrow — anyone sends ≥0.05 SOL to it; when
 *  the goal is reached the server pays the treasury share from the vault and arms it (cut 0, renounced). Not funded in 7 days → refunds pro-rata. */
export async function importCrowd(initiator: string, mint: string) {
  const q = await importQuote(mint)
  const existing = Object.values(vaults).find((v) => v.mint === mint && v.crowd && !v.armed && !v.crowd.refunded); if (existing) return { ...pub(existing), quote: q }
  const v = await importCreate(initiator, mint); const vv = vaults[v.id]; vv.cut = 0; vv.renounced = true
  vv.crowd = { goalSol: R.IMPORT_FEE_SOL, raised: 0, contributors: {}, expiresAt: Date.now() + 7 * 86400000 }
  vv.activity.unshift({ t: Date.now(), kind: 'note', msg: `community takeover · raising ${R.IMPORT_FEE_SOL} SOL to activate` }); save(); return { ...pub(vv), quote: q }
}
export const crowdOpen = () => Object.values(vaults).filter((v) => v.crowd && !v.armed && !v.crowd.refunded).map(pub)
/** Record a contribution (verified on-chain: SOL from `from` landed in the vault wallet in `sig`). Arms when funded. */
export async function importContribute(id: string, from: string, sig: string) {
  const v = vaults[id]; if (!v || !v.crowd || v.armed) throw new Error('not an open crowd import')
  const tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' }); if (!tx || tx.meta?.err) throw new Error('contribution tx not found or failed')
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58()); const pre = tx.meta!.preBalances, post = tx.meta!.postBalances
  const i = keys.indexOf(v.pub); const got = i < 0 ? 0 : (post[i] - pre[i]) / 1e9
  if (got < 0.05 - 1e-6) throw new Error('contribution must be ≥ 0.05 SOL to the vault wallet'); if (!keys.includes(from)) throw new Error('tx not from contributor')
  if (v.activity.some((a) => a.sig === sig)) return pub(v)
  v.crowd.contributors[from] = (v.crowd.contributors[from] || 0) + got; v.crowd.raised += got; v.funders[from] = (v.funders[from] || 0) + got; if (v.shared) v.chest = +(v.chest + got).toFixed(9)
  v.activity.unshift({ t: Date.now(), kind: 'stake', sol: got, sig, msg: `${got.toFixed(2)} SOL toward the takeover (${v.crowd.raised.toFixed(2)}/${v.crowd.goalSol})` })
  if (v.crowd.raised >= v.crowd.goalSol - 1e-6) await crowdArm(v)
  save(); return pub(v)
}
async function crowdArm(v: Vault) {
  const treasurySol = R.IMPORT_FEE_SOL - R.IMPORT_SEED_SOL
  const sig = await payFrom(v, TREASURY, Math.floor(treasurySol * 1e9), 'treasury')
  v.feePaid = R.IMPORT_FEE_SOL; try { const sup = await conn.getTokenSupply(new PublicKey(v.mint!)); v.supply = +(sup.value.uiAmount || 1e9) } catch {}
  await sync(v); v.armed = true; v.armedAt = Date.now(); v.activity.unshift({ t: Date.now(), kind: 'stake', sol: v.chest, sig, msg: `vault activated by ${Object.keys(v.crowd!.contributors).length} backers · community takeover` })
}
/** Refund crowd imports that did not reach the goal in time (vault key pays everyone back pro-rata, minus tx fees). */
export async function crowdSweep() {
  for (const v of Object.values(vaults)) {
    if (!v.crowd || v.armed || v.crowd.refunded || Date.now() < v.crowd.expiresAt) continue
    try {
      const bal = v.shared ? v.chest : await balanceSol(v.pub); const total = v.crowd.raised || 1; const payable = Math.max(0, bal - 0.002)
      for (const [who, amt] of Object.entries(v.crowd.contributors)) { const lam = Math.floor((amt / total) * payable * 1e9); if (lam > 5000) await payFrom(v, who, lam, 'refund') }
      v.crowd.refunded = true; v.activity.unshift({ t: Date.now(), kind: 'note', msg: 'takeover not funded in 7 days — contributions refunded' }); save()
    } catch (e: any) { v.activity.unshift({ t: Date.now(), kind: 'note', msg: 'refund attempt failed: ' + String(e.message).slice(0, 80) }) }
  }
}
/** Anyone can top up a chest; the owner can also deposit tokens (cost basis = price at deposit). Verified against chain balances. */
export async function deposit(id: string, from: string, sig: string) {
  const v = vaults[id]; if (!v || !v.armed) throw new Error('vault not armed')
  if (Object.values(vaults).some((x) => x.activity.some((a) => a.sig === sig))) throw new Error('that tx is already booked')
  const beforeSol = v.chest, beforeTok = v.tokens; await sync(v)
  let dSol = v.chest - beforeSol; const dTok = v.tokens - beforeTok
  if (v.shared) { dSol = await txDelta(sig, v.pub); if (dSol > 0) v.chest = +(v.chest + dSol).toFixed(9) }
  if (dSol < 0.001 && dTok <= 0) throw new Error('no deposit detected yet — wait a few seconds and retry')
  if (MAX_CHEST_SOL > 0 && v.chest > MAX_CHEST_SOL) v.activity.unshift({ t: Date.now(), kind: 'note', msg: `chest above the ${MAX_CHEST_SOL} SOL beta cap — further deposits are refused in the app until the program ships` })
  if (dSol >= 0.001) { v.funders[from] = (v.funders[from] || 0) + dSol; v.activity.unshift({ t: Date.now(), kind: 'stake', sol: dSol, sig, msg: `chest top-up from ${from.slice(0, 4)}…` }) }
  if (dTok > 0) { const m = await market(v.mint!); const px = m?.priceSol || 0; v.avgCost = (v.avgCost * beforeTok + px * dTok) / Math.max(v.tokens, 1e-9); v.depositedTokens += dTok; v.activity.unshift({ t: Date.now(), kind: 'seed', tokens: dTok, price: px, sig, msg: `${from === v.dev ? 'dev' : from.slice(0, 4) + '…'} vaulted ${(dTok / (v.supply || 1e9) * 100).toFixed(2)}% of supply` }); if (from === v.dev) v.pct = +Math.min(50, v.tokens / (v.supply || 1e9) * 100).toFixed(2) }
  save(); return pub(v)
}
export function renounce(id: string, dev: string) { const v = vaults[id]; if (!v || v.dev !== dev) throw new Error('not yours'); v.cut = 0; v.renounced = true; v.activity.unshift({ t: Date.now(), kind: 'note', msg: 'dev renounced cut' }); save(); return pub(v) }
/** A launch that never armed (bundle dropped, arm never signed, coin abandoned): the dev takes the stake back. Signed by the dev; only before arm; pays to the wallet that funded it. */
export async function refund(id: string, auth?: { msg?: string; sig?: string }) {
  const v = vaults[id]; if (!v) throw new Error('no such vault')
  // an armed vault never pays out its chest — unless it never did anything: no tokens, no fills, no tax. Then the dev can still take the stake back and the vault is dropped.
  const untouched = v.tokens <= 0 && !(v.score && (v.score.captures || v.score.dips || v.score.deskFills)) && !v.activity.some((a) => a.kind === 'buy' || a.kind === 'capture' || a.kind === 'redeem')
  // TEST_RECLAIM=1 (private-beta test launches only): the dev takes the WHOLE chest back — stake, tax collected and market-making gains.
  // Tokens the vault still holds are sold first, so everything comes back as SOL. Off by default; with it off the chest never pays out, as designed.
  const reclaim = process.env.TEST_RECLAIM === '1'
  if (v.armed && !untouched && !reclaim) throw new Error(v.tokens > 0 && process.env.TEST_RECLAIM === '1' ? 'the vault still holds tokens — it sells them only above cost, then the chest can be reclaimed' : 'an armed vault that has traded never pays out its chest — that is the point of it')
  devAuth(v, 'refund', v.mint || 'none', auth)
  // a payout that did not confirm in time must never be paid twice: wait until its blockhash can no longer land, or until it is found landed
  { const pp = (v as any)._payPending; if (pp) { const st = (await conn.getSignatureStatuses([pp.sig]).catch(() => null))?.value?.[0]
    if (st && !st.err) throw new Error('the last payout landed — refresh, it is in your wallet')
    if (Date.now() - pp.t < 90_000) throw new Error('the last payout is still confirming — try again in a minute'); (v as any)._payPending = undefined } }
  if (reclaim && v.mint && v.tokens > 0 && !PAPER) {
    // close-out: sell everything back to SOL in slices. Each slice is sized so it moves the pool price ≤ ~15%, is quoted fresh
    // (min-out from the pool read at build time, 1% for other flow), and a few seconds apart so buyers can step in between.
    // A slice that misses its min-out fails for the fee only and is retried at half size.
    ;(v as any).closing = true
    try {
      const start = v.tokens; let fails = 0
      for (let i = 0; i < 40 && v.tokens > 0.5; i++) {
        while (inflight.has(v.id)) await wait(500)
        const m = await market(v.mint); const p = m?.priceSol || 0
        const poolTok = p > 0 && m?.liqSol ? m.liqSol / p : 0
        let slice = poolTok > 0 ? Math.min(v.tokens, poolTok * 0.085 / 2 ** fails) : v.tokens
        if (slice >= v.tokens * 0.98) slice = v.tokens
        const pctStr = `${Math.min(100, Math.max(0.01, +(slice / v.tokens * 100).toFixed(2)))}%`
        try { const ssig = await trade(v, 'sell', pctStr, false, p); await sync(v, ssig, slice * p * 0.97); fails = 0 }
        catch (e: any) { fails++; if (e?.sig) deferBook(v, e.sig, slice * p * 0.97); if (fails >= 4) throw new Error('close-out: sells keep missing their min-out (' + String(e.message || e).slice(0, 80) + ') — nothing paid yet, try again in a minute') }
        if (v.tokens > 0.5) await wait(2500 + Math.random() * 2000)
      }
      v.activity.unshift({ t: Date.now(), kind: 'note', msg: `close-out: sold ${((start - v.tokens) / 1e6).toFixed(2)}M tokens back to SOL in slices` }); save()
    } finally { (v as any).closing = false }
  }
  // only the stake goes back; tax the chest collected meanwhile belongs to the holders and stays
  const staked = v.activity.filter((a) => a.kind === 'stake').reduce((a, x) => a + (x.sol || 0), 0) || v.stakeSol
  const avail = (v.shared ? v.chest : await balanceSol(v.pub)) - 0.001
  const sol = +Math.max(0, reclaim ? avail : Math.min(staked, avail)).toFixed(6); if (sol < 0.001) throw new Error('nothing to refund')
  const sig = await payFrom(v, v.dev, Math.floor(sol * 1e9), 'refund')
  v.activity.unshift({ t: Date.now(), kind: 'note', sol, sig, msg: `stake refunded to ${v.dev.slice(0, 4)}… (vault never traded)` }); if (v.shared) v.chest = Math.max(0, +(v.chest - sol).toFixed(9)); if (reclaim) (v as any).closedAt = Date.now(); if (v.armed && v.chest < 0.05) { v.armed = false; if (v.deskBid) { try { D.cancelInternal(v.pub, v.mint!) } catch {} v.deskBid = 0 } }
  EV.log('vault', `${v.symbol || id} refunded ${sol} SOL to the dev (${reclaim ? 'test reclaim: whole chest' : 'stake back, vault never traded'})`, { id, sig }); save(); return { sig, sol }
}
/** admin: drop a vault that never armed (its stake was returned by hand from the shared wallet); refuses armed vaults */
export function retire(id: string) { const v = vaults[id]; if (!v) throw new Error('no such vault'); if (v.armed) throw new Error('armed vaults cannot be retired'); const out = { id, chest: v.chest, mint: v.mint }; delete vaults[id]; save(); EV.log('vault', `retired unarmed vault ${id} (ledger ${out.chest} SOL)`, out); return out }
export const get = (id: string) => vaults[id] ? pub(vaults[id]) : null
export const byMint = (mint: string) => { const v = Object.values(vaults).find((x) => x.mint === mint); return v ? pub(v) : null }
export const list = () => Object.values(vaults).filter((v) => v.armed).map(pub)
export const byDev = (dev: string) => Object.values(vaults).filter((v) => v.dev === dev).map(pub)
/** Family tree + leader flag: L = aged_mcap × √(1h vol). The leader is whichever member scores highest. */
export async function family(mint: string) {
  const root = Object.values(vaults).find((v) => v.mint === mint)?.copyOf || mint
  const members = [root, ...Object.values(vaults).filter((v) => v.copyOf === root && v.mint).map((v) => v.mint!)]
  const out = [] as any[]
  for (const m of members) { const mk = await market(m).catch(() => null); const v = Object.values(vaults).find((x) => x.mint === m); const ageH = v ? (Date.now() - v.createdAt) / 3.6e6 : 48; const aged = (mk?.mcapUsd || 0) * Math.min(1, ageH / 24); out.push({ mint: m, symbol: mk?.symbol || v?.symbol || '?', mcapUsd: mk?.mcapUsd || 0, vol1h: (mk as any)?.vol1h || 0, score: aged * Math.sqrt((mk as any)?.vol1h || 0), original: m === root, vault: !!v }) }
  const leader = out.reduce((a, b) => (b.score > a.score ? b : a), out[0]); if (leader) leader.leader = true
  return { root, members: out }
}
/** Burn-to-redeem quote: holder's share of supply × chest × 93% */
export function redeemQuote(mint: string, tokensUi: number) {
  const v = Object.values(vaults).find((x) => x.mint === mint && x.armed); if (!v) throw new Error('no vault on this coin')
  const share = tokensUi / (v.supply || 1e9); const sol = share * v.chest * (1 - 0.07)
  if (sol < 0.001) throw new Error('redeem value below 0.001 SOL'); if (sol > v.chest * 0.25) throw new Error('max 25% of chest per redeem')
  return { vaultId: v.id, vaultPub: v.pub, chest: v.chest, supply: v.supply, share, sol, lamports: Math.floor(sol * 1e9) }
}
/** Holder-signed tx: [create vault ATA idempotent (payer holder), spl transfer holder→vault tokens, SOL vault→holder]. Server verifies + co-signs with the vault key. */
export async function redeem(mint: string, holder: string, tokensUi: number, txB64: string) {
  const q = redeemQuote(mint, tokensUi); const v = vaults[q.vaultId]
  const tx = Transaction.from(Buffer.from(txB64, 'base64')); const ix = tx.instructions
  const d = await decimals(mint); const base = BigInt(Math.floor(tokensUi * 10 ** d))
  const hp = new PublicKey(holder), vp = new PublicKey(v.pub), mp = new PublicKey(mint), prog = new PublicKey(await C.tokenProgram(mint))
  const vAta = getAssociatedTokenAddressSync(mp, vp, true, prog), hAta = getAssociatedTokenAddressSync(mp, hp, true, prog)
  if (ix.length !== 3 || !tx.feePayer?.equals(hp)) throw new Error('bad tx shape')
  if (!ix[0].programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) || !ix[0].keys[1].pubkey.equals(vAta) || !ix[0].keys[2].pubkey.equals(vp)) throw new Error('ix0')
  if (!ix[1].programId.equals(prog) || ix[1].data[0] !== 12 || !ix[1].keys[0].pubkey.equals(hAta) || !ix[1].keys[2].pubkey.equals(vAta) || Buffer.from(ix[1].data.subarray(1, 9)).readBigUInt64LE() !== base || ix[1].data[9] !== d) throw new Error('token transfer mismatch')
  if (!ix[2].programId.equals(SystemProgram.programId) || !ix[2].keys[0].pubkey.equals(vp) || !ix[2].keys[1].pubkey.equals(hp) || Buffer.from(ix[2].data.subarray(4, 12)).readBigUInt64LE() !== BigInt(q.lamports)) throw new Error('sol transfer mismatch')
  if (!tx.signatures.find((s) => s.publicKey.equals(hp))?.signature) throw new Error('not signed by holder')
  KEEP.sign({ id: v.id, chest: v.chest, sk: kp(v) }, tx, 'redeem', q.sol); const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 }); await confirm(sig)
  v.redeemed = (v.redeemed || 0) + q.sol; await sync(v, sig, -q.sol); v.activity.unshift({ t: Date.now(), kind: 'redeem', sol: q.sol, tokens: tokensUi, sig, msg: `burn-to-redeem by ${holder.slice(0, 4)}…` }); save()
  return { sig, sol: q.sol }
}

function liveReadout(v: Vault) {
  const p = v.samples.at(-1)?.p || 0; const vw = R.vwap(v.samples); const now = Date.now(); const bpm = v.buyTimes ? v.buyTimes.filter((t) => now - t < 60000).length : 0
  const m = v.samples.length ? { mcapUsd: (v.supply || 1e9) * p * (SOLUSD || 150) } : { mcapUsd: 0 }
  return { price: p, vwap30: vw, stretch: vw ? p / vw - 1 : 0, captureNow: v.mode === 'mm' ? R.captureFracV2(p, vw, v.avgCost, m.mcapUsd, R.sigma(v.samples), v.supply ? (v.tokens / v.supply) * 100 : 0, v.pct || 5, v.ceiling ?? R.MM_MAX_CAPTURE, 0.5) : 0, triggerRate: R.triggerRate(bpm), buysPerMin: bpm, tier: R.tierLabel(m.mcapUsd), tranchesFired: v.tranchesFired || [], sigma: R.sigma(v.samples), skew: R.inventorySkew(v.supply ? (v.tokens / v.supply) * 100 : 0, v.pct || 5).q, deskDisc: R.deskDiscountBps(R.sigma(v.samples)) }
}
export function setMode(id: string, dev: string, mode: 'floor' | 'mm', ceiling?: number) { const v = vaults[id]; if (!v || v.dev !== dev) throw new Error('not yours'); v.mode = mode; if (ceiling != null) v.ceiling = Math.min(R.MM_MAX_CAPTURE, Math.max(0.05, ceiling)); v.activity.unshift({ t: Date.now(), kind: 'note', msg: `mode → ${mode}${mode === 'mm' ? ` · capture ceiling ${Math.round((v.ceiling) * 100)}%` : ''}` }); save(); return pub(v) }
/** A buy was observed (stream or inferred). MM mode may counter it. */
export async function onBuy(v: Vault, solIn: number, m: any, p: number, now: number) {
  const initials = MM.initialsOn(v); if (initials && (v as any)._capBusy) return
  const tokens = MM.capture(v, m, p, solIn, now); if (tokens <= 0) return
  if (initials) (v as any)._capBusy = true
  const frac = R.captureFracV2(p, R.vwap(v.samples), v.avgCost, m.mcapUsd, R.sigma(v.samples), MM.vaultedPct(v), v.pct || 5, v.ceiling ?? R.MM_MAX_CAPTURE, 0.5)
  const sellFrac = tokens / v.tokens; const before = v.chest; MM.onCaptured(v, tokens, now)
  // no fingerprint: random 3–9s cooldown, random 0–2.5s delay before the sell lands, size already ±20% random in captureFracV2
  try {
    if (!initials) await wait(Math.random() * 2500)
    const sig = await trade(v, 'sell', `${Math.max(0.01, +(sellFrac * 100).toFixed(2))}%`, false, p)
    await sync(v, sig, tokens * p * 0.97); const got = v.chest - before; MM.bookSell(v, tokens, got)
    v.score.captured += got; v.score.captures++
    v.activity.unshift({ t: now, kind: 'capture', sol: got, tokens, price: p, sig, msg: initials ? `sold into a ${solIn.toFixed(2)} SOL buy · launch buy ${((v.invGot || 0)).toFixed(2)} / ${(v.launchSpend || 0).toFixed(2)} SOL back` : `countered a ${solIn.toFixed(2)} SOL buy · ${Math.round(frac * 100)}% · stretch +${Math.round((p / R.vwap(v.samples) - 1) * 100)}%` }); EV.log('vault', `${v.symbol} capture ${got.toFixed(3)} SOL`, { mint: v.mint, sig })
    const profit = got - v.avgCost * tokens; const cut = v.cut > 0 ? Math.max(0, profit) * (v.cut / 100) : 0
    await payCut(v, cut, now, 'capture profit')
  } catch (e: any) { v.activity.unshift({ t: now, kind: 'note', msg: 'capture failed: ' + String(e.message).slice(0, 80) }); if (e?.sig) deferBook(v, e.sig, tokens * p * 0.97, (vv, cb) => MM.bookSell(vv, tokens, vv.chest - cb)) }
  finally { if (initials) (v as any)._capBusy = false }
}
/** the dev cut on realized profit. A copy (declared at launch, or flagged by the vamp detector) streams half of every cut to the original's chest. */
async function payCut(v: Vault, cut: number, now: number, why: string) {
  if (!(cut > 0.001) || PAPER) return
  let devShare = cut
  if (v.copyOf) { const orig = Object.values(vaults).find((x) => x.mint === v.copyOf && x.armed); if (orig) { try { const half = cut / 2; const s3 = await payFrom(v, orig.pub, Math.floor(half * 1e9)); v.streamed = (v.streamed || 0) + half; devShare = cut - half; v.activity.unshift({ t: now, kind: 'stream', sol: half, sig: s3, msg: `half of cut → original ${orig.symbol}` }); orig.activity.unshift({ t: now, kind: 'stream', sol: half, sig: s3, msg: `received from copy ${v.symbol}` }); orig.chest += half } catch {} } }
  try { const s2 = await payFrom(v, v.dev, Math.floor(devShare * 1e9)); v.devPaid += devShare; v.activity.unshift({ t: now, kind: 'cut', sol: devShare, sig: s2, msg: `dev cut ${v.cut}% of ${why}` }) } catch {}
}
function trimAllowed(v: Vault, m: any, p: number, now: number) {
  const day = Math.floor(now / 86400000); if (day !== v.trimDay) { v.trimDay = day; v.trimmedToday = 0 }
  const vol1hSol = (m.vol1h || 0) / (SOLUSD || 150)
  const size = R.trimSize(v.tokens, v.trimmedToday || 0, vol1hSol, p)
  return size >= v.tokens * 0.002 ? size : 0
}
/** PAPER=1: the bot runs on live market data but never touches the chain — fills are simulated at the observed price (1% fee, 0.5% slippage).
 *  Used to watch the exact decisions it would make on a real coin for hours before a single real trade. */
export const PAPER = process.env.PAPER === '1'
const jitter = (base: number, pct: number) => base * (1 + (Math.random() * 2 - 1) * pct)
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** vault slippage: the min-out is computed from the pool state read at build time, so this only has to cover 1–2 slots of other flow. It was 10% — a free 10% for any sandwich bot. A trade that misses fails (fee only, no fill) and the next tick re-decides. */
const SLIP_BUY_BPS = Math.max(10, +(process.env.VAULT_SLIP_BUY_BPS || 150)), SLIP_SELL_BPS = Math.max(10, +(process.env.VAULT_SLIP_SELL_BPS || 100))
async function trade(v: Vault, action: 'buy' | 'sell', amount: number | string, denominatedInSol: boolean, price: number): Promise<string> {
  if (!PAPER) { const signer = (tx: any) => KEEP.sign({ id: v.id, chest: v.chest, sk: kp(v) }, tx, 'trade', action === 'buy' ? +amount : 0); const onLL = v.venue === 'launchlab' && !!(await LL.pool(v.mint!).catch(() => null))?.migrated === false; const slip = action === 'buy' ? SLIP_BUY_BPS : SLIP_SELL_BPS; return onLL ? C.llTrade(kp(v), action, v.mint!, amount, slip, signer) : pumpTrade(kp(v), action, v.mint!, amount, denominatedInSol, slip / 100, undefined, signer) }
  if (action === 'buy') { const sol = +amount; v.chest -= sol; v.tokens += (sol / price) * 0.985 }
  else { const frac = typeof amount === 'string' ? parseFloat(amount) / 100 : +amount / v.tokens; const tok = v.tokens * frac; v.tokens -= tok; v.chest += tok * price * 0.985 }
  return 'paper-' + Math.random().toString(36).slice(2, 10)
}
/** refresh tokens from chain; chest from the wallet (own key) or from the booked tx (shared key — `sig` of the trade that just landed, `fallback` = its expected SOL delta) */
async function sync(v: Vault, sig?: string, fallback = 0) { if (PAPER) return; await syncChain(v, sig, fallback) }
async function syncChain(v: Vault, sig?: string, fallback = 0) { v.tokens = (await tokenBalance(v.pub, v.mint!)).ui; if (v.shared) { if (sig) await book(v, sig, fallback) } else v.chest = await balanceSol(v.pub) }

const inflight = new Set<string>()
/** One pass over all armed vaults, concurrently; a vault still confirming a trade from the last pass is skipped, never queued. */
/** REBIND=<vaultId>:<mint>[,…] (operator): a vault armed onto a mint that never went live is moved to the coin that did — only when the
 *  old mint has no pool and the new one does. Then it re-arms on the live coin. */
let rebound = false
async function rebind() {
  if (rebound || !process.env.REBIND) return; rebound = true
  for (const pair of process.env.REBIND.split(',')) {
    const [id, mint] = pair.split(':').map((x) => x.trim()); const v = vaults[id]; if (!v || !mint || v.mint === mint) continue
    try {
      const oldPool = v.mint ? await LL.pool(v.mint).catch(() => null) : null; const newPool = await LL.pool(mint).catch(() => null)
      if (oldPool || !newPool) { EV.log('error', `rebind ${id}: refused (old mint live: ${!!oldPool}, new mint has a pool: ${!!newPool})`); continue }
      const from = v.mint; v.armed = false; v.mint = mint; v.venue = 'launchlab'
      await arm(v.id, mint, v.symbol || '', v.name || '', { sessionWallet: v.dev })
      v.activity.unshift({ t: Date.now(), kind: 'note', msg: `moved from ${from?.slice(0, 4)}… (never went live) to the live coin ${mint.slice(0, 4)}…` }); EV.log('vault', `${v.symbol || id} re-armed on the live coin ${mint}`, { id, from, mint }); save()
    } catch (e: any) { EV.log('error', `rebind ${id}: ${String(e.message || e).slice(0, 140)}`) }
  }
}
/** CREDIT=<vaultId>:<sol>[,…] (operator, once): book SOL that sits in the shared wallet unattributed (fees no chest was credited with) to a
 *  vault's chest, so its dev can withdraw it. Only up to what is actually unattributed; never twice (marked on the vault). */
let credited = false
async function creditUnattributed() {
  if (credited || !process.env.CREDIT || !SHARED) return; credited = true
  for (const pair of process.env.CREDIT.split(',')) {
    const [id, amt] = pair.split(':').map((x) => x.trim()); const v = vaults[id]; const sol = +amt; if (!v || !(sol > 0)) continue
    const tag = 'credit:' + pair; if (v.activity.some((a) => a.msg === tag)) continue
    try {
      const audit = await sharedAudit(); const room = Math.max(0, (audit?.unattributedSol || 0) - 0.01); const add = +Math.min(sol, room).toFixed(6); if (add <= 0) continue
      v.chest = +(v.chest + add).toFixed(9); v.activity.unshift({ t: Date.now(), kind: 'tax', sol: add, msg: tag }); EV.log('vault', `${v.symbol || id} credited ${add} SOL of unattributed fees to its chest`, { id, add }); save()
    } catch (e: any) { EV.log('error', `credit ${id}: ${String(e.message || e).slice(0, 120)}`) }
  }
}
export async function tick() {
  await rebind().catch(() => {})
  await creditUnattributed().catch(() => {})
  await Promise.all(Object.values(vaults).map((v) => tickOne(v)))
  await settleLateBooks().catch(() => {})
  save()
}
async function tickOne(v: Vault) {
  if (!v.armed || !v.mint || inflight.has(v.id) || (v as any).closing) return
  if (Date.now() < (v.nextTickAt || 0)) return; v.nextTickAt = Date.now() + 3500 + Math.random() * 3000
  inflight.add(v.id)
  {
    try {
      const m = await market(v.mint); if (!m || !m.priceSol) return
      const now = Date.now(), p = m.priceSol
      if (p !== v.lastPushed) { v.lastPushed = p; D.broadcast({ type: 'price', mint: v.mint, priceSol: p, mcapUsd: m.mcapUsd, liqSol: m.liqSol, t: now }) }
      pxPush(v.mint, now, p)
      // vamp feeding runners: when the detector is sure this coin copies a vaulted runner, it becomes a copy — half of every cut streams to the original
      if (!v.copyOf && !v.vampChecked || now > (v.vampChecked || 0)) { v.vampChecked = now + 300000; try { const vf = VM.forMint(v.mint); if (vf.vamp && vf.vamp.score >= 0.8 && Object.values(vaults).some((x) => x.mint === vf.vamp!.original && x.armed)) { v.copyOf = vf.vamp.original; v.vampFlag = true; v.activity.unshift({ t: now, kind: 'note', msg: `flagged as a copy of ${vf.vamp.originalSymbol} (${vf.vamp.reasons.join(', ')}) — half of every cut now streams to its chest` }) } } catch {} }
      if (v.permTax && now > (v.nextPermAt || 0)) { v.nextPermAt = now + 1.2e6 + Math.random() * 6e5; harvestPermTax(v).catch((e) => v.activity.unshift({ t: now, kind: 'note', msg: 'transfer tax harvest failed: ' + String(e.message).slice(0, 80) })) }
      if (v.venue === 'launchlab' && now > (v.nextClaimAt || 0)) { v.nextClaimAt = now + 120000 + Math.random() * 120000; const migrated = (m as any).venue !== 'launchlab'; (migrated ? (now > (v.nextHarvestAt || 0) ? (v.nextHarvestAt = now + 1.8e6, harvestLp(v)) : Promise.resolve(0)) : claimTax(v)).catch((e) => v.activity.unshift({ t: now, kind: 'note', msg: (migrated ? 'lp harvest' : 'tax claim') + ' failed: ' + String(e.message).slice(0, 80) })) }
      const { dd } = MM.observe(v, p, now); const ddNow = dd
      { const st = MM.stopped(v, p, now); if (st && !v.stopNoted) { v.stopNoted = true; v.activity.unshift({ t: now, kind: 'note', msg: `drawdown stop: mm leg ${(MM.mmPnl(v, p) / Math.max(v.mmSpent || 0, 1e-9) * 100).toFixed(0)}% on ${(v.mmSpent || 0).toFixed(2)} SOL deployed — no new buys, desk bid halved at −15%, resumes at break-even` }); EV.log('vault', `${v.symbol} drawdown stop`, { mint: v.mint, pnl: MM.mmPnl(v, p), spent: v.mmSpent }) } else if (!st && v.stopNoted) { v.stopNoted = false; v.activity.unshift({ t: now, kind: 'note', msg: 'drawdown stop cleared: mm leg back at break-even' }) } }
      if (!v.holders || now - v.holders.t > 60_000) { holderStats(v.mint, v.pub).then((h) => { v.holders = h }).catch(() => {}) }
      if (!v.score) v.score = { captured: 0, captures: 0, deskBought: 0, deskFills: 0, dipBought: 0, dips: 0, redeployed: 0, floor0: v.supply ? v.chest / v.supply : 0 }
      // graduated coins: exact per-swap buys from the pool websocket; reserve-delta only while the stream isn't attached
      // graduated coins AND our launchlab pools (the quote vault is WSOL, same decode): exact per-swap buys from the pool websocket
      if ((!m.onCurve || (m as any).venue === 'launchlab') && m.pair && !watched.has(v.id)) { watched.set(v.id, watchPool(m.pair, async (sw) => { D.broadcast({ type: 'swap', mint: v.mint, symbol: v.symbol, ...sw }); tape(v.mint!, { t: sw.t, side: sw.side, sol: sw.sol, trader: sw.trader, sig: sw.sig }); if (sw.side !== 'buy' || sw.trader === v.pub) return; try { const mm = await market(v.mint!); if (mm) { await onBuy(v, sw.sol, mm, mm.priceSol, Date.now()); save() } } catch {} })) }
      // reserve-delta fallback when the pool websocket is not delivering (not connected, or no subscription yet)
      const llStreaming = (m as any).venue === 'launchlab' && watched.has(v.id) && streamStats().connected
      // launchlab coins without the websocket: every tick compares the pool's real SOL; a change is a swap (buy if up, sell if down) → tape + live ticker
      if ((m as any).venue === 'launchlab' && !llStreaming && m.liqSol) { const d = m.liqSol - (v.lastLiq || m.liqSol); if (v.lastLiq && Math.abs(d) >= 0.01) { const sw = { t: now, side: d > 0 ? 'buy' as const : 'sell' as const, sol: Math.abs(d), trader: '' }; tape(v.mint!, sw); D.broadcast({ type: 'swap', mint: v.mint, symbol: v.symbol, ...sw }) } }
      // pump curve coins without the PumpPortal stream, and launchlab coins until the websocket attaches: the pool read every tick is the buy detector
      const curveNoStream = m.onCurve && (!process.env.PUMPPORTAL_KEY || ((m as any).venue === 'launchlab' && !llStreaming))
      if (m.liqSol && ((!m.onCurve && (!watched.has(v.id) || !streamStats().connected)) || curveNoStream)) { if (v.lastLiq && now - v.lastLiqT < 20000) { const inflow = m.liqSol - v.lastLiq; if (inflow >= R.MM_MIN_BUY_SOL) await onBuy(v, inflow, m, p, now) } v.lastLiq = m.liqSol; v.lastLiqT = now }
      // a failed trade (rpc down, pumpportal unreachable) must not skip the quoting below: the action block has its own catch
      try {
      // defense: tranches at −20 / −35 / −50 from the high the crash started at (mm.ts: episode anchor, day cap, pool-impact cap, seller-concentration check, cooldown)
      // MM_BUYS=0 (beta knob): the vault never buys from the pool — no dip tranches, no accumulation; captures, the standing ask and a capped desk bid still run
      const NOBUY = process.env.MM_BUYS === '0' && process.env.MM_ON !== '1'
      const dec = NOBUY ? null : MM.defense(v, m, p, now, dd, MM.sellerShare(recent(v.mint), now))
      if (dec) {
        const { spend, level } = dec; (v as any)._lastSpend = spend
        await wait(Math.random() * 4000)
        const before = v.tokens; const sig = await trade(v, 'buy', spend, true, p)
        await sync(v, sig, -spend); const got = v.tokens - before; MM.onDefended(v, spend, got, level, now)
        v.score.dipBought += spend; v.score.dips++; v.score.redeployed += spend
        v.activity.unshift({ t: now, kind: 'buy', sol: spend, tokens: got, price: p, sig, msg: `tranche ${level + 1} · ${(dd * 100).toFixed(0)}% from high` }); EV.log('vault', `${v.symbol} dip buy ${spend} SOL (tranche ${level + 1})`, { mint: v.mint, sig })
      }
      // tax-funded vault: under its supply target → small buys under VWAP from the chest (the 2% tax keeps refilling it)
      else if (!NOBUY && (() => { const a = MM.accumulate(v, m, p, now); if (a) (v as any)._acc = a; return !!a })()) {
        const spend = (v as any)._acc as number; delete (v as any)._acc; (v as any)._lastSpend = spend
        const before = v.tokens; const sig = await trade(v, 'buy', spend, true, p)
        await sync(v, sig, -spend); const got = v.tokens - before; MM.onAccumulated(v, spend, got, now)
        v.score.redeployed += spend
        v.activity.unshift({ t: now, kind: 'buy', sol: spend, tokens: got, price: p, sig, msg: `accumulating · ${MM.vaultedPct(v).toFixed(1)}% of ${v.pct}% target` })
      }
      // trim
      else if (v.mode !== 'mm' && v.tokens > 0 && p >= MM.sellFloor(v.avgCost) && R.mayTrim(p, v.avgCost, R.vwap(v.samples), v.ema5!, v.ema15!) && now - v.lastTrim > R.VAULT_TRIM_COOLDOWN_MS && trimAllowed(v, m, p, now) > 0) {
        const frac = trimAllowed(v, m, p, now) / v.tokens; const before = v.chest
        const sig = await trade(v, 'sell', `${Math.round(frac * 100)}%`, false, p)
        const sold = v.tokens * frac; await sync(v, sig, v.tokens * frac * p * 0.97); const got = v.chest - before; v.lastTrim = now; v.trimmedToday += sold
        v.activity.unshift({ t: now, kind: 'trim', sol: got, price: p, sig, msg: 'above cost + VWAP' })
        const profit = got - v.avgCost * (v.tokens * frac / (1 - frac)); const cut = v.cut > 0 ? Math.max(0, profit) * (v.cut / 100) : 0
        await payCut(v, cut, now, 'trim profit')
      }
      } catch (e: any) { v.activity.unshift({ t: now, kind: 'note', msg: 'trade failed: ' + String(e.message || e).slice(0, 100) }); EV.log('error', `${v.symbol} vault trade failed: ${String(e.message || e).slice(0, 120)}`, { mint: v.mint }); if (e?.sig) deferBook(v, e.sig, -((v as any)._lastSpend || 0)) }
      // standing switch offer: a slice of the vault's tokens at spot, fee 0 — the off-chart way INTO this coin for anyone leaving a vamp. Only when the desk is open.
      try {
        if (v.mode === 'mm' && v.tokens > 0 && R.deskOpen(m) && !PAPER && p >= MM.sellFloor(v.avgCost)) { const mb = R.minBlockSol(m); const want = +Math.max(Math.min(v.tokens * 0.1 * p, v.chest * 2), mb).toFixed(3)
          if (v.tokens * p >= want && want >= 0.1 && (!v.askRefreshAt || now > v.askRefreshAt)) { v.askRefreshAt = now + 60000 + Math.random() * 60000; await D.placeInternalAsk(kp(v), 'VAULT', v.mint, want, 0, (tx) => { KEEP.sign({ id: v.id, chest: v.chest, sk: kp(v) }, tx, 'trade', 0) }) } }
      } catch {}
      // standing vault bid on the desk: −4%, ≤25% of chest, pulled for 15 min after toxic flow, only when the desk is open for this coin
      try {
        const mb = R.minBlockSol(m); let want = MM.deskBid(v, mb, now, MM.P, Math.random(), p, m.liqSol || 0, MM.volSol(v, m)); const bidMax = +(process.env.DESK_BID_MAX_SOL || 0); if (bidMax > 0 && want > bidMax) want = +Math.min(want, bidMax).toFixed(3)
        if (!v.bidRefreshAt || now > v.bidRefreshAt) v.bidRefreshAt = now + 45000 + Math.random() * 60000 // re-quote at random 45–105s, not on the minute
        if (R.deskOpen(m) && want > 0 && !PAPER) { if (Math.abs(want - v.deskBid) > v.chest * 0.05 || now > v.bidRefreshAt - 1000) { const stop = MM.stopped(v, p, now); const disc = Math.round(Math.max(stop ? 1500 : 0, R.deskDiscountBps(R.sigma(v.samples))) + (Math.random() * 100 - 50)); await D.placeInternal(kp(v), 'VAULT', v.mint, want, disc, () => v.chest - 0.02, (tx, solOut) => { KEEP.sign({ id: v.id, chest: v.chest, sk: kp(v) }, tx, 'desk_fill', solOut) }, (seller) => MM.deskDenied(v, seller, Date.now())); if (!v.deskBid) v.activity.unshift({ t: now, kind: 'bid', sol: want, msg: `vault bid resting on desk at −${(disc / 100).toFixed(1)}%` }); v.deskBid = want } }
        else if (v.deskBid) { D.cancelInternal(v.pub, v.mint); v.deskBid = 0 }
      } catch {}
      v.ddPrev = ddNow
      if (v.activity.length > 200) v.activity.length = 200
    } catch (e: any) { v.activity.unshift({ t: Date.now(), kind: 'note', msg: String(e.message || e).slice(0, 120) }); EV.log('error', `${v.symbol || v.id} tick: ${String(e.message || e).slice(0, 120)}`, { mint: v.mint }) }
    finally { inflight.delete(v.id) }
  }
}

/** Vault answers an RFQ: fills at −4% when the seller allows it, otherwise counters at −4%. Sized to what the chest can carry. */
export async function respondRfq(mint: string, sizeSol: number, maxBps: number, rfqId: string) {
  const v = Object.values(vaults).find((x) => x.mint === mint && x.armed); if (!v) return null
  if (Date.now() < (v.deskPauseUntil || 0) || PAPER) return null
  // same guards as the standing bid (MM.deskBid): VWAP gate, warmup, drawdown halving, day budget, pool-liquidity cap, 25 SOL cap. An RFQ is just a desk bid someone asked for.
  const m = await market(mint); if (!m || !m.priceSol) return null
  const room = MM.deskBid(v, R.minBlockSol(m), Date.now(), MM.P, Math.random(), m.priceSol, m.liqSol || 0, MM.volSol(v, m)); const bidMax = +(process.env.DESK_BID_MAX_SOL || 0)
  const sol = +Math.min(sizeSol, room, v.chest - 0.02, bidMax > 0 ? bidMax : Infinity).toFixed(3); if (sol < 0.2 || sol < R.minBlockSol(m)) return null
  const b = await D.placeInternalRaw(kp(v), 'VAULT', mint, sol, 400, () => v.chest - 0.02, true, (tx, solOut) => { KEEP.sign({ id: v.id, chest: v.chest, sk: kp(v) }, tx, 'desk_fill', solOut) }, (seller) => MM.deskDenied(v, seller, Date.now())); b.rfq = rfqId
  v.activity.unshift({ t: Date.now(), kind: 'bid', sol, msg: `answered block request at −4%` })
  return b
}

D.setOnVaultFill((pub, sol, tokens, seller) => { const v = Object.values(vaults).find((x) => x.pub === pub); if (!v || !v.score) return; MM.onDeskFill(v, sol, tokens, v.samples.at(-1)?.p || 0, Date.now(), seller); if (v.shared) v.chest = Math.max(0, +(v.chest - sol).toFixed(9)); v.score.deskBought += sol; v.score.deskFills++; v.score.redeployed += sol; v.deskBid = 0; v.activity.unshift({ t: Date.now(), kind: 'buy', sol, tokens, msg: 'desk fill · bought a block off-chart' }); sync(v).then(save).catch(() => {}) })
// exact buys for curve coins via the pump.fun stream
let pws: any = null
export function startStream() {
  const WS = (globalThis as any).WebSocket; if (!WS) return
  const connect = () => {
    // token-trade streams are key-gated + metered since May 2026 (PUMPPORTAL_KEY, linked wallet ≥0.02 SOL). Without a key we skip the stream and curve coins use the reserve-delta fallback.
    if (!process.env.PUMPPORTAL_KEY) return
    try { pws = new WS('wss://pumpportal.fun/api/data?api-key=' + process.env.PUMPPORTAL_KEY) } catch { return }
    pws.onopen = () => { const mints = Object.values(vaults).filter((v) => v.armed && v.mint).map((v) => v.mint!); if (mints.length) pws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: mints })) }
    pws.onmessage = async (ev: any) => { try { const d = JSON.parse(ev.data); if (d.txType !== 'buy' && d.txType !== 'sell') return; const v = Object.values(vaults).find((x) => x.mint === d.mint && x.armed); if (!v) return; tape(v.mint!, { t: Date.now(), side: d.txType, sol: +d.solAmount || 0, trader: d.traderPublicKey, sig: d.signature }); if (d.txType !== 'buy' || v.pub === d.traderPublicKey) return; const m = await market(v.mint!); if (!m) return; await onBuy(v, +d.solAmount || 0, m, m.priceSol, Date.now()); save() } catch {} }
    pws.onclose = () => setTimeout(connect, 5000); pws.onerror = () => { try { pws.close() } catch {} }
  }
  connect(); setInterval(() => { try { if (pws?.readyState === 1) { const mints = Object.values(vaults).filter((v) => v.armed && v.mint).map((v) => v.mint!); if (mints.length) pws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: mints })) } } catch {} }, 60000)
}

/** Block-zero: sign the vault's buy tx inside a launch bundle. Verifies it is a PumpPortal buy for this vault's mint-to-be, within chest. */
import { VersionedTransaction } from '@solana/web3.js'
import * as L from './launch.ts'
import * as LL from './launchlab.ts'
import { devAuth } from './auth.ts'
export { devAuth }
import { PublicKey as PK, SystemProgram as SP, Transaction as TX } from '@solana/web3.js'
export async function signBundleTx(id: string, mint: string, txB64: string, maxSol: number, createB64?: string, auth?: { msg?: string; sig?: string }) {
  const v = vaults[id]; if (!v) throw new Error('no such vault'); if (v.armed) throw new Error('already armed'); devAuth(v, 'bundle', mint, auth)
  const bal = v.shared ? v.chest : await balanceSol(v.pub); if (bal < v.stakeSol * 0.95) throw new Error(`vault not funded: ${bal.toFixed(3)} / ${v.stakeSol} SOL${v.shared ? ' — call /vault/fund with the stake tx first' : ''}`)
  const spend = Math.min(maxSol, v.vaultBuySol ?? bal * 0.5, bal - 0.05, MM.P.profitOnly ? +(process.env.PROFIT_LAUNCH_BUY_SOL ?? 0) : Infinity); if (spend < 0.05) throw new Error(MM.P.profitOnly ? 'profit-only test mode: no block-zero vault buy (set PROFIT_LAUNCH_BUY_SOL to allow one)' : 'nothing to spend')
  v.vaultBuySol = +spend.toFixed(4)
  const tx = VersionedTransaction.deserialize(Buffer.from(txB64, 'base64'))
  // decode the buy itself: the client chose the numbers PumpPortal built from, so policy is enforced on what the tx really does
  const dec = await decimals(mint).catch(() => 6)
  const b = L.inspectBuy(tx, v.pub, mint, dec, await L.resolveKeys(tx, conn))
  // PumpPortal pads max_sol_cost ~3× in bundle mode. The real cost is fixed by the curve: the create tx pins the dev buy, our tokens pin the rest.
  let cost = b.maxSolCost
  if (createB64) {
    const ct = VersionedTransaction.deserialize(Buffer.from(createB64, 'base64'))
    const c = L.inspectCreate(ct, mint, dec, await L.resolveKeys(ct, conn))
    cost = L.bundleCost(c.buy?.tokens || 0, b.tokens).cost
    if (!Number.isFinite(cost)) throw new Error('bundle buy asks for more tokens than the curve holds')
    if (b.maxSolCost < cost) throw new Error(`max_sol_cost ${b.maxSolCost.toFixed(4)} below the real cost ${cost.toFixed(4)} — the buy would fail`)
  }
  if (cost + b.tipSol > spend * 1.05 + 0.01) throw new Error(`block-zero buy costs ${cost.toFixed(3)} SOL, policy allows ${spend.toFixed(3)}`)
  if (b.maxSolCost > bal) throw new Error(`max_sol_cost ${b.maxSolCost.toFixed(3)} exceeds the vault balance`)
  KEEP.sign({ id: v.id, chest: bal, sk: kp(v) }, tx, 'launch', cost + b.tipSol)
  v.mint = mint; v.activity.unshift({ t: Date.now(), kind: 'note', sig: bs58.encode(tx.signatures[0]), msg: `signed block-zero buy · ${cost.toFixed(3)} SOL for ${(b.tokens / 1e6).toFixed(2)}M tokens (${(b.tokens / (v.supply || 1e9) * 100).toFixed(2)}% of supply)` }); save()
  return { tx: Buffer.from(tx.serialize()).toString('base64'), spend: cost, tokens: b.tokens }
}
/** Submit a Jito bundle (array of base64 signed txs). Returns bundle id. */
export async function sendBundle(txs: string[]) { return C.sendBundle(txs.map((b64) => new Uint8Array(Buffer.from(b64, 'base64')))) }

/** LaunchLab launch: create(+dev buy) tx(s) for the dev to sign, plus the vault's block-zero buy already keeper-signed, to go out as one Jito bundle.
 *  The vault must be funded first (stake transferred) — same flow as the pump path. Without a vault it is just the create tx(s). */
export async function buildLaunch(b: { dev: string; name: string; symbol: string; uri: string; devBuySol?: number; vaultId?: string; vaultBuySol?: number; permTax?: boolean; auth?: { msg?: string; sig?: string } }) {
  const dev = new PK(b.dev); const devBuy = Math.max(0, +(b.devBuySol || 0))
  if (b.vaultId) { const v = vaults[b.vaultId]; if (!v) throw new Error('no such vault'); if (v.dev !== b.dev) throw new Error('not your vault'); devAuth(v, 'launch', b.dev, b.auth) }
  const built = await LL.buildLaunch(dev, { name: b.name, symbol: b.symbol, uri: b.uri }, devBuy, LL.PLATFORM_ID, !!b.permTax)
  let vaultTx: string | null = null, vaultSpend = 0, vaultTokens = 0
  if (b.vaultId) {
    const v = vaults[b.vaultId]; if (!v) throw new Error('no such vault'); if (v.armed) throw new Error('already armed')
    v.venue = 'launchlab'
    const bal = v.shared ? v.chest : await balanceSol(v.pub); if (bal < v.stakeSol * 0.95) throw new Error(`vault not funded: ${bal.toFixed(3)} / ${v.stakeSol} SOL${v.shared ? ' — call /vault/fund with the stake tx first' : ''}`)
    vaultSpend = +Math.min(+(b.vaultBuySol ?? v.vaultBuySol ?? v.stakeSol * 0.5), bal - 0.05, MM.P.profitOnly ? +(process.env.PROFIT_LAUNCH_BUY_SOL ?? 0) : Infinity).toFixed(4)   // 0 = tax-funded: no block-zero buy at all. Profit-only tests: none unless PROFIT_LAUNCH_BUY_SOL
    v.mint = built.mint; v.uri = b.uri; v.symbol = b.symbol; v.name = b.name   // bound now even with no vault buy, so the vault can arm itself once the coin is on chain
    v.vaultBuySol = vaultSpend   // the real block-zero spend (after caps): it is the vault's cost basis and the initials to recover
    if (vaultSpend >= 0.05) {
      const tx = await LL.buildTrade(kp(v).publicKey, 'buy', built.mint, vaultSpend, { poolState: built.afterDev, fromCreate: true, slippageBps: 3000, tipLamports: Math.floor(+(process.env.TIP_SOL || 0.001) * 1e9), permTaxBps: built.permTax })
      KEEP.sign({ id: v.id, chest: bal, sk: kp(v) }, tx, 'launch', vaultSpend)
      vaultTx = Buffer.from(tx.serialize()).toString('base64'); vaultTokens = LL.quote(built.afterDev, vaultSpend).tokens
      v.mint = built.mint; v.uri = b.uri; v.symbol = b.symbol; v.name = b.name; v.permTax = built.permTax; resolveImage(v); v.activity.unshift({ t: Date.now(), kind: 'note', sig: bs58.encode(tx.signatures[0]), msg: `signed block-zero buy · ${vaultSpend.toFixed(3)} SOL for ${(vaultTokens / 1e6).toFixed(2)}M tokens (launchlab)` }); save()
    }
  }
  return { venue: 'launchlab', mint: built.mint, poolId: built.poolId, txs: built.txs, vaultTx, vaultSpend, vaultTokens, devTokens: built.devTokens, permTax: built.permTax, tax: LL.status() }
}
/** the tax: claim this coin's accrued platform fee from its pool to the platform wallet, then forward it to the chest. Runs from the tick, every ~2–4 min per vault. */
let claiming = false; let nextClaimAt = 0
/** Every few minutes: claim the platform fee vault (all pools at once) into the platform wallet and credit each coin's chest by its share of
 *  observed taxed volume. Vamp routing on top: a flagged copy's share goes to the original, a declared copy's half. Runs from the tick loop. */
export async function claimPlatformFees(force = false): Promise<number> {
  if (PAPER || claiming || !LL.PLATFORM_ID) return 0; if (!force && Date.now() < nextClaimAt) return 0
  claiming = true; nextClaimAt = Date.now() + 180_000 + Math.random() * 60_000
  try {
    const pending = await LL.platformVaultSol(); if (pending < 0.005) return 0
    const pk = LL.platformKeypair(); const pkB58 = pk.publicKey.toBase58()
    const tx = await LL.buildClaimVault(); const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 }); await confirm(sig)
    const got = Math.max(0, await txDelta(sig, pkB58).catch(() => pending)); if (got < 0.0005) return 0
    const ours = Object.values(vaults).filter((v) => v.armed && v.venue === 'launchlab' && !v.paper)
    const W = taxWeights(ours); const total = W.reduce((a, w) => a + w, 0)
    const credits: { v: Vault; sol: number; why: string }[] = []
    for (const [i, v] of ours.entries()) { const share = total > 0 ? got * W[i] / total : 0; v.taxAccrued = 0; if (share < 0.0001) continue
      const orig = v.copyOf ? ours.find((x) => x.mint === v.copyOf) : null; const toOrig = orig ? (v.vampFlag ? share : share / 2) : 0
      if (share - toOrig > 0) credits.push({ v, sol: share - toOrig, why: toOrig ? `tax → chest (${v.vampFlag ? 'all' : 'half'} of it to original ${orig!.symbol})` : 'tax → chest' })
      if (orig && toOrig > 0) credits.push({ v: orig, sol: toOrig, why: `tax from ${v.vampFlag ? 'flagged copy' : 'copy'} ${v.symbol}` }) }
    // the platform wallet IS the shared vault wallet: crediting a shared chest is a ledger move. A per-key vault gets a real transfer.
    const fwd = new TX(); let fwdAny = false
    for (const c of credits) { if (c.v.shared && c.v.pub === pkB58) { c.v.chest = +(c.v.chest + c.sol).toFixed(9) } else { fwd.add(SP.transfer({ fromPubkey: pk.publicKey, toPubkey: new PK(c.v.pub), lamports: Math.floor(c.sol * 1e9) })); fwdAny = true } }
    let sig2 = sig; if (fwdAny) { fwd.feePayer = pk.publicKey; fwd.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash; fwd.sign(pk); sig2 = await conn.sendRawTransaction(fwd.serialize(), { maxRetries: 3 }); await confirm(sig2); for (const c of credits) if (!(c.v.shared && c.v.pub === pkB58)) await book(c.v, sig2, c.sol) }
    for (const c of credits) { c.v.taxClaimed = (c.v.taxClaimed || 0) + c.sol; c.v.activity.unshift({ t: Date.now(), kind: 'tax', sol: c.sol, sig: sig2, msg: c.why }) }
    const credited = credits.reduce((a, c) => a + c.sol, 0); EV.log('vault', `platform fees claimed ${got.toFixed(4)} SOL → ${credits.length} chest(s) ${credited.toFixed(4)} SOL${got - credited > 0.0005 ? ` (${(got - credited).toFixed(4)} unattributed → treasury)` : ''}`, { sig })
    save(); return got
  } catch (e: any) { EV.log('error', 'platform fee claim: ' + String(e.message || e).slice(0, 140)); return 0 } finally { claiming = false }
}
/** kept for callers: per-coin claim is now the platform-wide one */
export async function claimTax(_v: Vault): Promise<number> { return claimPlatformFees() }
/** permanent tax: withheld transfer fees (tokens) → platform wallet → sold on the pool → SOL to the chest. Every ~20 min. */
export async function harvestPermTax(v: Vault): Promise<number> {
  if (PAPER || !v.permTax || !v.mint) return 0
  const pk = LL.platformKeypair()
  const h = await LL.buildPermTaxHarvest(v.mint, kp(v).publicKey); if (!h) return 0
  h.tx.partialSign(pk); KEEP.sign({ id: v.id, chest: v.chest, sk: kp(v) }, h.tx, 'payout', 0)
  const sig = await conn.sendRawTransaction(h.tx.serialize(), { skipPreflight: false, maxRetries: 3 }); await confirm(sig)
  // sell the harvested tokens for SOL (platform wallet sells, the vault pays the fee), then forward
  const before = await balanceSol(pk.publicKey.toBase58())
  const st = await LL.sellPct(pk.publicKey, v.mint, 100, 1500, kp(v).publicKey); st.sign([pk]); KEEP.sign({ id: v.id, chest: v.chest, sk: kp(v) }, st, 'payout', 0)
  const sig2 = await conn.sendRawTransaction(st.serialize(), { skipPreflight: false, maxRetries: 3 }); await confirm(sig2)
  const got = Math.max(0, (await balanceSol(pk.publicKey.toBase58())) - before); if (got < 0.001) return 0
  const fwd = new TX().add(SP.transfer({ fromPubkey: pk.publicKey, toPubkey: new PK(v.pub), lamports: Math.floor(got * 1e9) }))
  fwd.feePayer = pk.publicKey; fwd.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash; fwd.sign(pk)
  const sig3 = await conn.sendRawTransaction(fwd.serialize(), { maxRetries: 3 }); await confirm(sig3)
  v.taxClaimed = (v.taxClaimed || 0) + got; if (v.shared) v.chest = +(v.chest + got).toFixed(9); v.activity.unshift({ t: Date.now(), kind: 'tax', sol: got, sig: sig3, msg: `transfer tax → chest · ${(h.tokens / 1e6).toFixed(2)}M tokens from ${h.accounts} wallets → ${got.toFixed(4)} SOL` }); await sync(v); save(); return got
}
/** after graduation: harvest the locked LP's fees to the platform wallet and forward the SOL side to the chest (every ~30 min). */
export async function harvestLp(v: Vault): Promise<number> {
  if (PAPER || v.venue !== 'launchlab' || !v.mint) return 0
  const pk = LL.platformKeypair(); const before = await balanceSol(pk.publicKey.toBase58())
  const tx = await LL.buildHarvest(v.mint, kp(v).publicKey); if (!tx) return 0
  tx.sign([pk]); KEEP.sign({ id: v.id, chest: v.chest, sk: kp(v) }, tx, 'payout', 0)
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 }); await confirm(sig)
  const got = Math.max(0, (await balanceSol(pk.publicKey.toBase58())) - before - 0.002); if (got < 0.001) return 0
  const fwd = new TX().add(SP.transfer({ fromPubkey: pk.publicKey, toPubkey: new PK(v.pub), lamports: Math.floor(got * 1e9) }))
  fwd.feePayer = pk.publicKey; fwd.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash; fwd.sign(pk)
  const sig2 = await conn.sendRawTransaction(fwd.serialize(), { maxRetries: 3 }); await confirm(sig2)
  v.taxClaimed = (v.taxClaimed || 0) + got; if (v.shared) v.chest = +(v.chest + got).toFixed(9); v.activity.unshift({ t: Date.now(), kind: 'tax', sol: got, sig: sig2, msg: `LP fees → chest · ${got.toFixed(4)} SOL` }); await sync(v); save(); return got
}

/** the coin's image from its metadata json — so the app shows name + picture the second it launches, before any indexer */
function resolveImage(v: Vault) { if (!v.uri || v.image) return; fetch(v.uri).then((r) => r.json()).then((j: any) => { if (j?.image) { v.image = j.image; save() } }).catch(() => {}) }
