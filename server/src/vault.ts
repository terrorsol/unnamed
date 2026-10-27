// Off-chain vault market maker (beta). One keypair per coin, held here encrypted at rest.
// Rules: buy dips (≤40% of chest per crash), trim only above cost+5% AND 30-min VWAP AND uptrend, never withdraw.
import { Keypair } from '@solana/web3.js'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import bs58 from 'bs58'
import * as R from './rules.ts'
import { market } from './market.ts'
import { balanceSol, tokenBalance, pumpTrade, conn } from './chain.ts'
import { PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'

const DIR = process.env.DATA_DIR || './data'; const FILE = DIR + '/vaults.json'
const SECRET = process.env.VAULT_SECRET || 'dev-only-secret-change-me'
const key = scryptSync(SECRET, 'unnamed-vault', 32)
const enc = (u: Uint8Array) => { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); const ct = Buffer.concat([c.update(u), c.final()]); return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64') }
const dec = (s: string) => { const b = Buffer.from(s, 'base64'); const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return new Uint8Array(Buffer.concat([d.update(b.subarray(28)), d.final()])) }

export type Act = { t: number; kind: 'stake' | 'seed' | 'buy' | 'trim' | 'cut' | 'note'; sol?: number; tokens?: number; price?: number; sig?: string; msg?: string }
export type Vault = { id: string; pub: string; sk: string; mint?: string; symbol?: string; dev: string; stakeSol: number; pct: number; cut: number; armed: boolean; renounced: boolean; createdAt: number
  avgCost: number; tokens: number; chest: number; spentEpisode: number; high15: { t: number; p: number }[]; samples: { t: number; p: number; v: number }[]; ema5: number | null; ema15: number | null; lastBuy: number; lastTrim: number; activity: Act[]; devPaid: number }
let vaults: Record<string, Vault> = {}
export function load() { if (existsSync(FILE)) vaults = JSON.parse(readFileSync(FILE, 'utf8')) }
function save() { mkdirSync(DIR, { recursive: true }); writeFileSync(FILE, JSON.stringify(vaults)) }
const kp = (v: Vault) => Keypair.fromSecretKey(dec(v.sk))
const pub = (v: Vault) => ({ id: v.id, pub: v.pub, mint: v.mint, symbol: v.symbol, dev: v.dev, stakeSol: v.stakeSol, pct: v.pct, cut: v.cut, armed: v.armed, renounced: v.renounced, avgCost: v.avgCost, tokens: v.tokens, chest: v.chest, devPaid: v.devPaid, activity: v.activity.slice(0, 50), createdAt: v.createdAt })
export const vaultPct = (s: number) => Math.min(10, (s / (s + 1)) * 13.3)

/** Step 1 (before launch): make a vault address the dev will fund */
export function create(dev: string, stakeSol: number) {
  const k = Keypair.generate(); const id = bs58.encode(randomBytes(8))
  const pct = +vaultPct(stakeSol).toFixed(2)
  vaults[id] = { id, pub: k.publicKey.toBase58(), sk: enc(k.secretKey), dev, stakeSol, pct, cut: pct, armed: false, renounced: false, createdAt: Date.now(), avgCost: 0, tokens: 0, chest: 0, spentEpisode: 0, high15: [], samples: [], ema5: null, ema15: null, lastBuy: 0, lastTrim: 0, activity: [], devPaid: 0 }
  save(); return pub(vaults[id])
}
/** Step 2 (after the coin exists + dev sent the stake): bind mint, seed the position */
export async function arm(id: string, mint: string, symbol: string) {
  const v = vaults[id]; if (!v) throw new Error('no such vault'); if (v.armed) return pub(v)
  const bal = await balanceSol(v.pub); if (bal < v.stakeSol * 0.95) throw new Error(`vault not funded: ${bal.toFixed(3)} / ${v.stakeSol} SOL`)
  v.mint = mint; v.symbol = symbol; v.armed = true; v.chest = bal; v.activity.unshift({ t: Date.now(), kind: 'stake', sol: bal, msg: 'dev stake received' })
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
        if (cut > 0.001) { try { const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp(v).publicKey, toPubkey: new PublicKey(v.dev), lamports: Math.floor(cut * 1e9) })); const s2 = await sendAndConfirmTransaction(conn, tx, [kp(v)]); v.devPaid += cut; v.activity.unshift({ t: now, kind: 'cut', sol: cut, sig: s2, msg: `dev cut ${v.cut}%` }) } catch {} }
      }
      if (v.activity.length > 200) v.activity.length = 200
    } catch (e: any) { v.activity.unshift({ t: Date.now(), kind: 'note', msg: String(e.message || e).slice(0, 120) }) }
  }
  save()
}
