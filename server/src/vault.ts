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
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'

const DIR = process.env.DATA_DIR || './data'; const FILE = DIR + '/vaults.json'
/** Live tape: every swap seen on a vaulted coin, one JSON line {t,side,sol,trader,sig} → DATA_DIR/tape/<mint>.jsonl. Replay with `npm run replay -- <file>` in app/. Capped at ~20MB per coin. */
export function tape(mint: string, e: { t: number; side: 'buy' | 'sell'; sol: number; trader?: string; sig?: string }) {
  try { const d = DIR + '/tape'; if (!existsSync(d)) mkdirSync(d, { recursive: true }); const f = `${d}/${mint}.jsonl`; if (existsSync(f) && statSync(f).size > 20e6) return; appendFileSync(f, JSON.stringify(e) + '\n') } catch {}
}
const SECRET = process.env.VAULT_SECRET || 'dev-only-secret-change-me'
const key = scryptSync(SECRET, 'unnamed-vault', 32)
const enc = (u: Uint8Array) => { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); const ct = Buffer.concat([c.update(u), c.final()]); return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64') }
const dec = (s: string) => { const b = Buffer.from(s, 'base64'); const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return new Uint8Array(Buffer.concat([d.update(b.subarray(28)), d.final()])) }

export type Act = { t: number; kind: 'stake' | 'seed' | 'buy' | 'trim' | 'cut' | 'note' | 'redeem' | 'stream' | 'bid' | 'capture'; sol?: number; tokens?: number; price?: number; sig?: string; msg?: string }
export type Vault = { holders?: any; id: string; pub: string; sk: string; mint?: string; symbol?: string; name?: string; dev: string; stakeSol: number; pct: number; cut: number; armed: boolean; renounced: boolean; createdAt: number; copyOf?: string; streamed: number; redeemed: number; supply: number; deskBid: number; imported?: boolean; feePaid?: number; trimmedToday: number; trimDay: number; depositedTokens: number; funders: Record<string, number>; mode: 'floor' | 'mm'; ceiling: number; lastLiq: number; lastLiqT: number; buyTimes: number[]; tranchesFired: number[]; score: { captured: number; captures: number; deskBought: number; deskFills: number; dipBought: number; dips: number; redeployed: number; floor0: number }; lastCapture: number
  avgCost: number; tokens: number; chest: number; spentEpisode: number; high15: { t: number; p: number }[]; samples: { t: number; p: number; v: number }[]; ema5: number | null; ema15: number | null; lastBuy: number; lastTrim: number; activity: Act[]; devPaid: number }
let vaults: Record<string, Vault> = {}
const watched = new Map<string, () => void>()
let SOLUSD = 0; setInterval(() => fetch(`${process.env.DEX_URL || 'https://api.dexscreener.com'}/tokens/v1/solana/So11111111111111111111111111111111111111112`).then((r) => r.json()).then((a: any[]) => { const x = a?.[0]?.priceUsd; if (x) SOLUSD = +x }).catch(() => {}), 30000)
export function load() { if (existsSync(FILE)) vaults = JSON.parse(readFileSync(FILE, 'utf8')) }
function save() { mkdirSync(DIR, { recursive: true }); writeFileSync(FILE, JSON.stringify(vaults)) }
const kp = (v: Vault) => Keypair.fromSecretKey(dec(v.sk))
const pub = (v: Vault) => ({ id: v.id, pub: v.pub, mint: v.mint, symbol: v.symbol, name: v.name, dev: v.dev, stakeSol: v.stakeSol, pct: v.pct, cut: v.cut, armed: v.armed, renounced: v.renounced, avgCost: v.avgCost, tokens: v.tokens, chest: v.chest, devPaid: v.devPaid, activity: v.activity.slice(0, 50), createdAt: v.createdAt, copyOf: v.copyOf, imported: !!v.imported, mode: v.mode || 'floor', ceiling: v.ceiling ?? R.MM_MAX_CAPTURE, score: v.score || { captured: 0, captures: 0, deskBought: 0, deskFills: 0, dipBought: 0, dips: 0, redeployed: 0, floor0: 0 }, floor: v.supply ? v.chest / v.supply : 0, live: liveReadout(v), holders: v.holders || null, feePaid: v.feePaid || 0, depositedTokens: v.depositedTokens || 0, funders: v.funders || {}, streamed: v.streamed || 0, redeemed: v.redeemed || 0, supply: v.supply || 1e9, deskBid: v.deskBid || 0, copies: Object.values(vaults).filter((c) => c.copyOf === v.mint && c.armed).map((c) => ({ mint: c.mint, symbol: c.symbol, pub: c.pub })) })
export const vaultPct = (s: number) => Math.min(10, (s / (s + 1)) * 13.3)

/** Step 1 (before launch): make a vault address the dev will fund */
/** Beta cap: vault keys are hot on this server, so no single chest may hold more than this until the on-chain program lands. 0 = no cap. */
export const MAX_CHEST_SOL = +(process.env.MAX_CHEST_SOL ?? 25)
const capCheck = (sol: number) => { if (MAX_CHEST_SOL > 0 && sol > MAX_CHEST_SOL) throw new Error(`beta cap: a vault chest holds at most ${MAX_CHEST_SOL} SOL right now (custodial keys) — the on-chain program lifts this`) }
export function create(dev: string, stakeSol: number, copyOf?: string, mode: 'floor' | 'mm' = 'mm', ceiling = R.MM_MAX_CAPTURE) {
  if (!Number.isFinite(stakeSol) || stakeSol < 0) throw new Error('bad stake'); capCheck(stakeSol)
  const k = Keypair.generate(); const id = bs58.encode(randomBytes(8))
  const pct = +vaultPct(stakeSol).toFixed(2)
  vaults[id] = { id, pub: k.publicKey.toBase58(), sk: enc(k.secretKey), dev, stakeSol, pct, cut: pct, armed: false, renounced: false, createdAt: Date.now(), copyOf: copyOf || undefined, streamed: 0, redeemed: 0, supply: 1e9, deskBid: 0, trimmedToday: 0, trimDay: 0, depositedTokens: 0, funders: {}, avgCost: 0, tokens: 0, chest: 0, spentEpisode: 0, high15: [], samples: [], ema5: null, ema15: null, lastBuy: 0, lastTrim: 0, activity: [], devPaid: 0 }
  vaults[id].mode = mode; vaults[id].ceiling = Math.min(R.MM_MAX_CAPTURE, Math.max(0.05, ceiling)); save(); return pub(vaults[id])
}
/** Step 2 (after the coin exists + dev sent the stake): bind mint, seed the position */
export async function arm(id: string, mint: string, symbol: string, name = '') {
  const v = vaults[id]; if (!v) throw new Error('no such vault'); if (v.armed) return pub(v)
  const bal = await balanceSol(v.pub); if (bal < v.stakeSol * 0.95) throw new Error(`vault not funded: ${bal.toFixed(3)} / ${v.stakeSol} SOL`)
  v.mint = mint; v.symbol = symbol; v.name = name; v.armed = true; v.chest = bal; try { const sup = await conn.getTokenSupply(new PublicKey(mint)); v.supply = +(sup.value.uiAmount || 1e9) } catch {} v.activity.unshift({ t: Date.now(), kind: 'stake', sol: bal, msg: 'dev stake received' })
  // seed: spend half the stake on supply at launch, keep half as chest for dips (skipped when the vault already bought in the block-zero bundle)
  const seed = +(bal * 0.5).toFixed(4)
  if (v.activity.some((a) => (a.msg || '').startsWith('signed block-zero'))) { await sync(v); v.avgCost = v.tokens ? (v.stakeSol * 0.5) / v.tokens : 0; v.activity.unshift({ t: Date.now(), kind: 'seed', sol: v.stakeSol * 0.5, tokens: v.tokens, msg: 'block-zero vault supply (bundled)' }); save(); return pub(v) }
  try { const sig = await pumpTrade(kp(v), 'buy', mint, seed, true, 15); await sync(v); v.avgCost = seed / Math.max(v.tokens, 1e-9); v.activity.unshift({ t: Date.now(), kind: 'seed', sol: seed, tokens: v.tokens, sig, msg: 'block-zero vault supply' }) }
  catch (e: any) { v.activity.unshift({ t: Date.now(), kind: 'note', msg: 'seed failed: ' + e.message }) }
  save(); return pub(v)
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
  const q = await importQuote(mint); const k = Keypair.generate(); const id = bs58.encode(randomBytes(8))
  vaults[id] = { id, pub: k.publicKey.toBase58(), sk: enc(k.secretKey), mint, symbol: q.symbol, dev: owner, stakeSol: R.IMPORT_SEED_SOL, pct: 0, cut: 5, armed: false, renounced: false, createdAt: Date.now(), streamed: 0, redeemed: 0, supply: 1e9, deskBid: 0, imported: true, feePaid: 0, trimmedToday: 0, trimDay: 0, depositedTokens: 0, funders: {}, mode: 'mm', ceiling: R.MM_MAX_CAPTURE, lastLiq: 0, lastLiqT: 0, buyTimes: [], tranchesFired: [], score: { captured: 0, captures: 0, deskBought: 0, deskFills: 0, dipBought: 0, dips: 0, redeployed: 0, floor0: 0 }, lastCapture: 0, avgCost: 0, tokens: 0, chest: 0, spentEpisode: 0, high15: [], samples: [], ema5: null, ema15: null, lastBuy: 0, lastTrim: 0, activity: [], devPaid: 0 }
  save(); return { ...pub(vaults[id]), quote: q }
}
/** Step 2: after the fee tx (10 → treasury, 5 → vault) confirms, arm it. Verifies the tx on-chain. */
export async function importActivate(id: string, sig: string) {
  const v = vaults[id]; if (!v || !v.imported) throw new Error('no such import'); if (v.armed) return pub(v)
  const tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }); if (!tx || tx.meta?.err) throw new Error('fee transaction not found or failed')
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58()); const pre = tx.meta!.preBalances, post = tx.meta!.postBalances
  const delta = (pk: string) => { const i = keys.indexOf(pk); return i < 0 ? 0 : (post[i] - pre[i]) / 1e9 }
  if (delta(TREASURY) < R.IMPORT_FEE_SOL - R.IMPORT_SEED_SOL - 0.001) throw new Error('treasury fee not found in tx')
  if (delta(v.pub) < R.IMPORT_SEED_SOL - 0.001) throw new Error('chest seed not found in tx')
  if (!keys.includes(v.dev)) throw new Error('tx not from the vault owner')
  v.feePaid = R.IMPORT_FEE_SOL; v.funders[v.dev] = (v.funders[v.dev] || 0) + R.IMPORT_SEED_SOL
  try { const sup = await conn.getTokenSupply(new PublicKey(v.mint!)); v.supply = +(sup.value.uiAmount || 1e9) } catch {}
  await sync(v); v.armed = true; v.activity.unshift({ t: Date.now(), kind: 'stake', sol: v.chest, sig, msg: `vault activated · ${R.IMPORT_FEE_SOL} SOL import (${R.IMPORT_SEED_SOL} seeded)` }); save(); return pub(v)
}
/** Anyone can top up a chest; the owner can also deposit tokens (cost basis = price at deposit). Verified against chain balances. */
export async function deposit(id: string, from: string, sig: string) {
  const v = vaults[id]; if (!v || !v.armed) throw new Error('vault not armed')
  const beforeSol = v.chest, beforeTok = v.tokens; await sync(v)
  const dSol = v.chest - beforeSol, dTok = v.tokens - beforeTok
  if (dSol < 0.001 && dTok <= 0) throw new Error('no deposit detected yet — wait a few seconds and retry')
  if (MAX_CHEST_SOL > 0 && v.chest > MAX_CHEST_SOL) v.activity.unshift({ t: Date.now(), kind: 'note', msg: `chest above the ${MAX_CHEST_SOL} SOL beta cap — further deposits are refused in the app until the program ships` })
  if (dSol >= 0.001) { v.funders[from] = (v.funders[from] || 0) + dSol; v.activity.unshift({ t: Date.now(), kind: 'stake', sol: dSol, sig, msg: `chest top-up from ${from.slice(0, 4)}…` }) }
  if (dTok > 0) { const m = await market(v.mint!); const px = m?.priceSol || 0; v.avgCost = (v.avgCost * beforeTok + px * dTok) / Math.max(v.tokens, 1e-9); v.depositedTokens += dTok; v.activity.unshift({ t: Date.now(), kind: 'seed', tokens: dTok, price: px, sig, msg: `${from === v.dev ? 'dev' : from.slice(0, 4) + '…'} vaulted ${(dTok / (v.supply || 1e9) * 100).toFixed(2)}% of supply` }); if (from === v.dev) v.pct = +Math.min(50, v.tokens / (v.supply || 1e9) * 100).toFixed(2) }
  save(); return pub(v)
}
export function renounce(id: string, dev: string) { const v = vaults[id]; if (!v || v.dev !== dev) throw new Error('not yours'); v.cut = 0; v.renounced = true; v.activity.unshift({ t: Date.now(), kind: 'note', msg: 'dev renounced cut' }); save(); return pub(v) }
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
  tx.partialSign(kp(v)); const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 }); await confirm(sig)
  v.redeemed = (v.redeemed || 0) + q.sol; await sync(v); v.activity.unshift({ t: Date.now(), kind: 'redeem', sol: q.sol, tokens: tokensUi, sig, msg: `burn-to-redeem by ${holder.slice(0, 4)}…` }); save()
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
  if (v.mode !== 'mm' || solIn < R.MM_MIN_BUY_SOL || v.tokens <= 0) return
  v.buyTimes = (v.buyTimes || []).filter((t) => now - t < 60000); v.buyTimes.push(now)
  const bpm = v.buyTimes.length; if (Math.random() > R.triggerRate(bpm)) return
  if (now - v.lastCapture < 4000) return
  const sig = R.sigma(v.samples); const vaultedPct = v.supply ? (v.tokens / v.supply) * 100 : 0
  const frac = R.captureFracV2(p, R.vwap(v.samples), v.avgCost, m.mcapUsd, sig, vaultedPct, v.pct || 5, v.ceiling ?? R.MM_MAX_CAPTURE); if (frac <= 0) return
  const day = Math.floor(now / 86400000); if (day !== v.trimDay) { v.trimDay = day; v.trimmedToday = 0 }
  const wantSol = solIn * frac; let tokens = wantSol / p
  const vol1hSol = (m.vol1h || 0) / (SOLUSD || 150); tokens = Math.min(tokens, (vol1hSol * R.MM_VOL_CAP) / p, v.tokens * R.MM_DAY_CAP - v.trimmedToday, v.tokens * 0.05)
  if (tokens * p < 0.05) return
  const sellFrac = tokens / v.tokens; const before = v.chest; v.lastCapture = now
  try {
    const sig = await pumpTrade(kp(v), 'sell', v.mint!, `${Math.max(1, Math.round(sellFrac * 100))}%`, false)
    await sync(v); const got = v.chest - before; v.trimmedToday += tokens
    v.score.captured += got; v.score.captures++
    v.activity.unshift({ t: now, kind: 'capture', sol: got, tokens, price: p, sig, msg: `countered a ${solIn.toFixed(2)} SOL buy · ${Math.round(frac * 100)}% · stretch +${Math.round((p / R.vwap(v.samples) - 1) * 100)}%` })
    const profit = got - v.avgCost * tokens; const cut = v.cut > 0 ? Math.max(0, profit) * (v.cut / 100) : 0
    if (cut > 0.001) { try { const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp(v).publicKey, toPubkey: new PublicKey(v.dev), lamports: Math.floor(cut * 1e9) })); const s2 = await sendAndConfirmTransaction(conn, tx, [kp(v)]); v.devPaid += cut; v.activity.unshift({ t: now, kind: 'cut', sol: cut, sig: s2, msg: `dev cut ${v.cut}% of capture profit` }) } catch {} }
  } catch (e: any) { v.activity.unshift({ t: now, kind: 'note', msg: 'capture failed: ' + String(e.message).slice(0, 80) }) }
}
function trimAllowed(v: Vault, m: any, p: number, now: number) {
  const day = Math.floor(now / 86400000); if (day !== v.trimDay) { v.trimDay = day; v.trimmedToday = 0 }
  const vol1hSol = (m.vol1h || 0) / (SOLUSD || 150)
  const size = R.trimSize(v.tokens, v.trimmedToday || 0, vol1hSol, p)
  return size >= v.tokens * 0.002 ? size : 0
}
async function sync(v: Vault) { v.chest = await balanceSol(v.pub); v.tokens = (await tokenBalance(v.pub, v.mint!)).ui }

const inflight = new Set<string>()
/** One pass over all armed vaults, concurrently; a vault still confirming a trade from the last pass is skipped, never queued. */
export async function tick() {
  await Promise.all(Object.values(vaults).map((v) => tickOne(v)))
  save()
}
async function tickOne(v: Vault) {
  if (!v.armed || !v.mint || inflight.has(v.id)) return
  inflight.add(v.id)
  {
    try {
      const m = await market(v.mint); if (!m || !m.priceSol) return
      const now = Date.now(), p = m.priceSol
      v.samples.push({ t: now, p, v: 1 }); v.samples = v.samples.filter((s) => now - s.t < 30 * 60_000)
      v.high15.push({ t: now, p }); v.high15 = v.high15.filter((s) => now - s.t < 15 * 60_000)
      v.ema5 = R.ema(v.ema5, p, 5); v.ema15 = R.ema(v.ema15, p, 15)
      const high = Math.max(...v.high15.map((s) => s.p)); const dd = p / high - 1
      if (dd > -0.03) { v.spentEpisode = 0; v.tranchesFired = [] }
      if (!v.holders || now - v.holders.t > 60_000) { holderStats(v.mint, v.pub).then((h) => { v.holders = h }).catch(() => {}) }
      if (!v.score) v.score = { captured: 0, captures: 0, deskBought: 0, deskFills: 0, dipBought: 0, dips: 0, redeployed: 0, floor0: v.supply ? v.chest / v.supply : 0 }
      // graduated coins: exact per-swap buys from the pool websocket; reserve-delta only while the stream isn't attached
      if (!m.onCurve && m.pair && !watched.has(v.id)) { watched.set(v.id, watchPool(m.pair, async (sw) => { D.broadcast({ type: 'swap', mint: v.mint, symbol: v.symbol, ...sw }); tape(v.mint!, { t: sw.t, side: sw.side, sol: sw.sol, trader: sw.trader, sig: sw.sig }); if (sw.side !== 'buy' || sw.trader === v.pub) return; try { const mm = await market(v.mint!); if (mm) { await onBuy(v, sw.sol, mm, mm.priceSol, Date.now()); save() } } catch {} })) }
      // reserve-delta fallback when the pool websocket is not delivering (not connected, or no subscription yet)
      const curveNoStream = m.onCurve && !process.env.PUMPPORTAL_KEY
      if (m.liqSol && ((!m.onCurve && (!watched.has(v.id) || !streamStats().connected)) || curveNoStream)) { if (v.lastLiq && now - v.lastLiqT < 20000) { const inflow = m.liqSol - v.lastLiq; if (inflow >= R.MM_MIN_BUY_SOL) await onBuy(v, inflow, m, p, now) } v.lastLiq = m.liqSol; v.lastLiqT = now }
      // defense: three tranches at −20 / −35 / −50 from the 15-min high, each a third of the defense budget (40% of chest in mm, 40% in floor)
      const budget = v.chest * R.VAULT_MAX_CRASH_SPEND * R.inventorySkew(v.supply ? (v.tokens / v.supply) * 100 : 0, v.pct || 5).defend
      const level = R.DEFENSE_TRANCHES.findIndex((L, i) => dd <= L && !(v.tranchesFired || []).includes(i))
      if (level >= 0 && now - v.lastBuy > 15000) {
        const spend = +Math.min(budget / 3, v.chest - 0.02, Math.max(0, budget - v.spentEpisode)).toFixed(4)
        if (spend >= 0.05) {
          const before = v.tokens; const sig = await pumpTrade(kp(v), 'buy', v.mint, spend, true)
          await sync(v); const got = v.tokens - before; v.avgCost = (v.avgCost * before + spend) / Math.max(v.tokens, 1e-9)
          v.spentEpisode += spend; v.lastBuy = now; (v.tranchesFired ||= []).push(level); v.score.dipBought += spend; v.score.dips++; v.score.redeployed += spend
          v.activity.unshift({ t: now, kind: 'buy', sol: spend, tokens: got, price: p, sig, msg: `tranche ${level + 1} · ${(dd * 100).toFixed(0)}% from high` })
        }
      }
      // trim
      else if (v.mode !== 'mm' && v.tokens > 0 && R.mayTrim(p, v.avgCost, R.vwap(v.samples), v.ema5!, v.ema15!) && now - v.lastTrim > R.VAULT_TRIM_COOLDOWN_MS && trimAllowed(v, m, p, now) > 0) {
        const frac = trimAllowed(v, m, p, now) / v.tokens; const before = v.chest
        const sig = await pumpTrade(kp(v), 'sell', v.mint, `${Math.round(frac * 100)}%`, false)
        const sold = v.tokens * frac; await sync(v); const got = v.chest - before; v.lastTrim = now; v.trimmedToday += sold
        v.activity.unshift({ t: now, kind: 'trim', sol: got, price: p, sig, msg: 'above cost + VWAP' })
        const profit = got - v.avgCost * (v.tokens * frac / (1 - frac)); const cut = v.cut > 0 ? Math.max(0, profit) * (v.cut / 100) : 0
        // copies stream half their cut to the original's vault
        if (v.copyOf && cut > 0.002) { const orig = Object.values(vaults).find((x) => x.mint === v.copyOf && x.armed); if (orig) { try { const half = cut / 2; const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp(v).publicKey, toPubkey: new PublicKey(orig.pub), lamports: Math.floor(half * 1e9) })); const s3 = await sendAndConfirmTransaction(conn, tx, [kp(v)]); v.streamed = (v.streamed || 0) + half; v.activity.unshift({ t: now, kind: 'stream', sol: half, sig: s3, msg: `half of cut → original ${orig.symbol}` }); orig.activity.unshift({ t: now, kind: 'stream', sol: half, sig: s3, msg: `from copy ${v.symbol}` }) } catch {} } }
        if (cut > 0.001) { try { const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp(v).publicKey, toPubkey: new PublicKey(v.dev), lamports: Math.floor(cut * (v.copyOf ? 0.5 : 1) * 1e9) })); const s2 = await sendAndConfirmTransaction(conn, tx, [kp(v)]); v.devPaid += cut * (v.copyOf ? 0.5 : 1); v.activity.unshift({ t: now, kind: 'cut', sol: cut, sig: s2, msg: `dev cut ${v.cut}%` }) } catch {} }
      }
      // standing vault bid on the desk: −5%, ≈35% of chest, only when the desk is open for this coin
      try {
        const mb = R.minBlockSol(m); const want = +Math.max(v.chest * (v.mode === 'mm' ? 0.6 : 0.35), mb).toFixed(3)
        if (R.deskOpen(m) && want >= 0.2 && v.chest * 0.6 >= want) { if (Math.abs(want - v.deskBid) > 0.01 || (now % 60000) < 5000) { const disc = R.deskDiscountBps(R.sigma(v.samples)); await D.placeInternal(kp(v), 'VAULT', v.mint, want, disc, () => v.chest - 0.02); if (!v.deskBid) v.activity.unshift({ t: now, kind: 'bid', sol: want, msg: `vault bid resting on desk at −${(disc / 100).toFixed(1)}%` }); v.deskBid = want } }
        else if (v.deskBid) { D.cancelInternal(v.pub, v.mint); v.deskBid = 0 }
      } catch {}
      if (v.activity.length > 200) v.activity.length = 200
    } catch (e: any) { v.activity.unshift({ t: Date.now(), kind: 'note', msg: String(e.message || e).slice(0, 120) }) }
    finally { inflight.delete(v.id) }
  }
}

/** Vault answers an RFQ: fills at −4% when the seller allows it, otherwise counters at −4%. Sized to what the chest can carry. */
export async function respondRfq(mint: string, sizeSol: number, maxBps: number, rfqId: string) {
  const v = Object.values(vaults).find((x) => x.mint === mint && x.armed); if (!v) return null
  const sol = +Math.min(sizeSol, v.chest * 0.6 - 0.02).toFixed(3); if (sol < 0.2) return null
  const m = await market(mint); if (!m || sol < R.minBlockSol(m)) return null
  const b = await D.placeInternalRaw(kp(v), 'VAULT', mint, sol, 400, () => v.chest - 0.02, true); b.rfq = rfqId
  v.activity.unshift({ t: Date.now(), kind: 'bid', sol, msg: `answered block request at −4%` })
  return b
}

D.setOnVaultFill((pub, sol, tokens) => { const v = Object.values(vaults).find((x) => x.pub === pub); if (!v || !v.score) return; const before = v.tokens; v.avgCost = (v.avgCost * before + sol) / Math.max(before + tokens, 1e-9); v.score.deskBought += sol; v.score.deskFills++; v.score.redeployed += sol; v.deskBid = 0; v.activity.unshift({ t: Date.now(), kind: 'buy', sol, tokens, msg: 'desk fill · bought a block off-chart' }); sync(v).then(save).catch(() => {}) })
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
export async function signBundleTx(id: string, mint: string, txB64: string, maxSol: number) {
  const v = vaults[id]; if (!v) throw new Error('no such vault'); if (v.armed) throw new Error('already armed')
  const bal = await balanceSol(v.pub); if (bal < v.stakeSol * 0.95) throw new Error(`vault not funded: ${bal.toFixed(3)} / ${v.stakeSol} SOL`)
  const spend = Math.min(maxSol, bal * 0.5); if (spend < 0.05) throw new Error('nothing to spend')
  const tx = VersionedTransaction.deserialize(Buffer.from(txB64, 'base64'))
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58()); if (keys[0] !== v.pub) throw new Error('tx fee payer is not the vault')
  if (!keys.includes(mint)) throw new Error('tx does not reference the mint')
  tx.sign([kp(v)]); v.mint = mint; v.activity.unshift({ t: Date.now(), kind: 'note', msg: `signed block-zero buy · ${spend.toFixed(3)} SOL` }); save()
  return { tx: Buffer.from(tx.serialize()).toString('base64'), spend }
}
/** Submit a Jito bundle (array of base64 signed txs). Returns bundle id. */
export async function sendBundle(txs: string[]) { return C.sendBundle(txs.map((b64) => new Uint8Array(Buffer.from(b64, 'base64')))) }
