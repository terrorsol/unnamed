// Off-chain vault market maker (beta). One keypair per coin, held here encrypted at rest.
// Rules: buy dips (≤40% of chest per crash), trim only above cost+5% AND 30-min VWAP AND uptrend, never withdraw.
import { Keypair } from '@solana/web3.js'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import bs58 from 'bs58'
import * as R from './rules.ts'
import { market } from './market.ts'
import { balanceSol, tokenBalance, pumpTrade, conn, confirm, decimals } from './chain.ts'
import * as D from './desk.ts'
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'

const DIR = process.env.DATA_DIR || './data'; const FILE = DIR + '/vaults.json'
const SECRET = process.env.VAULT_SECRET || 'dev-only-secret-change-me'
const key = scryptSync(SECRET, 'unnamed-vault', 32)
const enc = (u: Uint8Array) => { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); const ct = Buffer.concat([c.update(u), c.final()]); return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64') }
const dec = (s: string) => { const b = Buffer.from(s, 'base64'); const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return new Uint8Array(Buffer.concat([d.update(b.subarray(28)), d.final()])) }

export type Act = { t: number; kind: 'stake' | 'seed' | 'buy' | 'trim' | 'cut' | 'note' | 'redeem' | 'stream' | 'bid'; sol?: number; tokens?: number; price?: number; sig?: string; msg?: string }
export type Vault = { id: string; pub: string; sk: string; mint?: string; symbol?: string; name?: string; dev: string; stakeSol: number; pct: number; cut: number; armed: boolean; renounced: boolean; createdAt: number; copyOf?: string; streamed: number; redeemed: number; supply: number; deskBid: number
  avgCost: number; tokens: number; chest: number; spentEpisode: number; high15: { t: number; p: number }[]; samples: { t: number; p: number; v: number }[]; ema5: number | null; ema15: number | null; lastBuy: number; lastTrim: number; activity: Act[]; devPaid: number }
let vaults: Record<string, Vault> = {}
export function load() { if (existsSync(FILE)) vaults = JSON.parse(readFileSync(FILE, 'utf8')) }
function save() { mkdirSync(DIR, { recursive: true }); writeFileSync(FILE, JSON.stringify(vaults)) }
const kp = (v: Vault) => Keypair.fromSecretKey(dec(v.sk))
const pub = (v: Vault) => ({ id: v.id, pub: v.pub, mint: v.mint, symbol: v.symbol, name: v.name, dev: v.dev, stakeSol: v.stakeSol, pct: v.pct, cut: v.cut, armed: v.armed, renounced: v.renounced, avgCost: v.avgCost, tokens: v.tokens, chest: v.chest, devPaid: v.devPaid, activity: v.activity.slice(0, 50), createdAt: v.createdAt, copyOf: v.copyOf, streamed: v.streamed || 0, redeemed: v.redeemed || 0, supply: v.supply || 1e9, deskBid: v.deskBid || 0, copies: Object.values(vaults).filter((c) => c.copyOf === v.mint && c.armed).map((c) => ({ mint: c.mint, symbol: c.symbol, pub: c.pub })) })
export const vaultPct = (s: number) => Math.min(10, (s / (s + 1)) * 13.3)

/** Step 1 (before launch): make a vault address the dev will fund */
export function create(dev: string, stakeSol: number, copyOf?: string) {
  const k = Keypair.generate(); const id = bs58.encode(randomBytes(8))
  const pct = +vaultPct(stakeSol).toFixed(2)
  vaults[id] = { id, pub: k.publicKey.toBase58(), sk: enc(k.secretKey), dev, stakeSol, pct, cut: pct, armed: false, renounced: false, createdAt: Date.now(), copyOf: copyOf || undefined, streamed: 0, redeemed: 0, supply: 1e9, deskBid: 0, avgCost: 0, tokens: 0, chest: 0, spentEpisode: 0, high15: [], samples: [], ema5: null, ema15: null, lastBuy: 0, lastTrim: 0, activity: [], devPaid: 0 }
  save(); return pub(vaults[id])
}
/** Step 2 (after the coin exists + dev sent the stake): bind mint, seed the position */
export async function arm(id: string, mint: string, symbol: string, name = '') {
  const v = vaults[id]; if (!v) throw new Error('no such vault'); if (v.armed) return pub(v)
  const bal = await balanceSol(v.pub); if (bal < v.stakeSol * 0.95) throw new Error(`vault not funded: ${bal.toFixed(3)} / ${v.stakeSol} SOL`)
  v.mint = mint; v.symbol = symbol; v.name = name; v.armed = true; v.chest = bal; try { const sup = await conn.getTokenSupply(new PublicKey(mint)); v.supply = +(sup.value.uiAmount || 1e9) } catch {} v.activity.unshift({ t: Date.now(), kind: 'stake', sol: bal, msg: 'dev stake received' })
  // seed: spend half the stake on supply at launch, keep half as chest for dips
  const seed = +(bal * 0.5).toFixed(4)
  try { const sig = await pumpTrade(kp(v), 'buy', mint, seed, true, 15); await sync(v); v.avgCost = seed / Math.max(v.tokens, 1e-9); v.activity.unshift({ t: Date.now(), kind: 'seed', sol: seed, tokens: v.tokens, sig, msg: 'block-zero vault supply' }) }
  catch (e: any) { v.activity.unshift({ t: Date.now(), kind: 'note', msg: 'seed failed: ' + e.message }) }
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
  const hp = new PublicKey(holder), vp = new PublicKey(v.pub), mp = new PublicKey(mint)
  const vAta = getAssociatedTokenAddressSync(mp, vp, true), hAta = getAssociatedTokenAddressSync(mp, hp, true)
  if (ix.length !== 3 || !tx.feePayer?.equals(hp)) throw new Error('bad tx shape')
  if (!ix[0].programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) || !ix[0].keys[1].pubkey.equals(vAta) || !ix[0].keys[2].pubkey.equals(vp)) throw new Error('ix0')
  if (!ix[1].programId.equals(TOKEN_PROGRAM_ID) || ix[1].data[0] !== 3 || !ix[1].keys[0].pubkey.equals(hAta) || !ix[1].keys[1].pubkey.equals(vAta) || Buffer.from(ix[1].data.subarray(1, 9)).readBigUInt64LE() !== base) throw new Error('token transfer mismatch')
  if (!ix[2].programId.equals(SystemProgram.programId) || !ix[2].keys[0].pubkey.equals(vp) || !ix[2].keys[1].pubkey.equals(hp) || Buffer.from(ix[2].data.subarray(4, 12)).readBigUInt64LE() !== BigInt(q.lamports)) throw new Error('sol transfer mismatch')
  if (!tx.signatures.find((s) => s.publicKey.equals(hp))?.signature) throw new Error('not signed by holder')
  tx.partialSign(kp(v)); const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 }); await confirm(sig)
  v.redeemed = (v.redeemed || 0) + q.sol; await sync(v); v.activity.unshift({ t: Date.now(), kind: 'redeem', sol: q.sol, tokens: tokensUi, sig, msg: `burn-to-redeem by ${holder.slice(0, 4)}…` }); save()
  return { sig, sol: q.sol }
}

async function sync(v: Vault) { v.chest = await balanceSol(v.pub); v.tokens = (await tokenBalance(v.pub, v.mint!)).ui }

export async function tick() {
  for (const v of Object.values(vaults)) {
    if (!v.armed || !v.mint) continue
    try {
      const m = await market(v.mint); if (!m || !m.priceSol) continue
      const now = Date.now(), p = m.priceSol
      v.samples.push({ t: now, p, v: 1 }); v.samples = v.samples.filter((s) => now - s.t < 30 * 60_000)
      v.high15.push({ t: now, p }); v.high15 = v.high15.filter((s) => now - s.t < 15 * 60_000)
      v.ema5 = R.ema(v.ema5, p, 5); v.ema15 = R.ema(v.ema15, p, 15)
      const high = Math.max(...v.high15.map((s) => s.p)); const dd = p / high - 1
      if (dd > -0.03) v.spentEpisode = 0
      // dip buy
      const budget = R.dipBudget(v.chest, dd, v.spentEpisode)
      if (budget >= 0.05 && now - v.lastBuy > 30_000) {
        const spend = +Math.min(budget, v.chest * 0.15, v.chest - 0.02).toFixed(4)
        if (spend >= 0.05) {
          const before = v.tokens; const sig = await pumpTrade(kp(v), 'buy', v.mint, spend, true)
          await sync(v); const got = v.tokens - before; v.avgCost = (v.avgCost * before + spend) / Math.max(v.tokens, 1e-9)
          v.spentEpisode += spend; v.lastBuy = now; v.activity.unshift({ t: now, kind: 'buy', sol: spend, tokens: got, price: p, sig, msg: `dip ${(dd * 100).toFixed(1)}%` })
        }
      }
      // trim
      else if (v.tokens > 0 && R.mayTrim(p, v.avgCost, R.vwap(v.samples), v.ema5!, v.ema15!) && now - v.lastTrim > R.VAULT_TRIM_COOLDOWN_MS) {
        const frac = R.VAULT_TRIM_FRAC; const before = v.chest
        const sig = await pumpTrade(kp(v), 'sell', v.mint, `${Math.round(frac * 100)}%`, false)
        await sync(v); const got = v.chest - before; v.lastTrim = now
        v.activity.unshift({ t: now, kind: 'trim', sol: got, price: p, sig, msg: 'above cost + VWAP' })
        const profit = got - v.avgCost * (v.tokens * frac / (1 - frac)); const cut = v.cut > 0 ? Math.max(0, profit) * (v.cut / 100) : 0
        // copies stream half their cut to the original's vault
        if (v.copyOf && cut > 0.002) { const orig = Object.values(vaults).find((x) => x.mint === v.copyOf && x.armed); if (orig) { try { const half = cut / 2; const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp(v).publicKey, toPubkey: new PublicKey(orig.pub), lamports: Math.floor(half * 1e9) })); const s3 = await sendAndConfirmTransaction(conn, tx, [kp(v)]); v.streamed = (v.streamed || 0) + half; v.activity.unshift({ t: now, kind: 'stream', sol: half, sig: s3, msg: `half of cut → original ${orig.symbol}` }); orig.activity.unshift({ t: now, kind: 'stream', sol: half, sig: s3, msg: `from copy ${v.symbol}` }) } catch {} } }
        if (cut > 0.001) { try { const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp(v).publicKey, toPubkey: new PublicKey(v.dev), lamports: Math.floor(cut * (v.copyOf ? 0.5 : 1) * 1e9) })); const s2 = await sendAndConfirmTransaction(conn, tx, [kp(v)]); v.devPaid += cut * (v.copyOf ? 0.5 : 1); v.activity.unshift({ t: now, kind: 'cut', sol: cut, sig: s2, msg: `dev cut ${v.cut}%` }) } catch {} }
      }
      // standing vault bid on the desk: −5%, ≈35% of chest, only when the desk is open for this coin
      try {
        const mb = R.minBlockSol(m); const want = +Math.max(v.chest * 0.35, mb).toFixed(3)
        if (R.deskOpen(m) && want >= 0.2 && v.chest * 0.6 >= want) { if (Math.abs(want - v.deskBid) > 0.01) { await D.placeInternal(kp(v), 'VAULT', v.mint, want, 500, () => v.chest - 0.02); if (!v.deskBid) v.activity.unshift({ t: now, kind: 'bid', sol: want, msg: 'vault bid resting on desk at −5%' }); v.deskBid = want } }
        else if (v.deskBid) { D.cancelInternal(v.pub, v.mint); v.deskBid = 0 }
      } catch {}
      if (v.activity.length > 200) v.activity.length = 200
    } catch (e: any) { v.activity.unshift({ t: Date.now(), kind: 'note', msg: String(e.message || e).slice(0, 120) }) }
  }
  save()
}
