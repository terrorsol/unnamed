// Pre-ground mint keypairs so every coin launched here ends in the brand suffix (…BANK), the way pump coins end in "pump".
// Pool lives in DATA_DIR/mints.json, secrets encrypted with VAULT_SECRET. Fed by POST /admin/mints (scripts/mints.ts on any machine
// with solana-keygen) or by MINT_KEYS in the env (base58 secrets, comma-separated). A launch pops one; an empty pool falls back to a random mint.
import { Keypair } from '@solana/web3.js'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import bs58 from 'bs58'

const DIR = () => process.env.DATA_DIR || './data'
const FILE = () => DIR() + '/mints.json'
export const SUFFIX = process.env.MINT_SUFFIX || 'BANK'
const key = scryptSync(process.env.VAULT_SECRET || 'dev-only-secret-change-me', 'unnamed-vault', 32)
const enc = (u: Uint8Array) => { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); const ct = Buffer.concat([c.update(u), c.final()]); return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64') }
const dec = (s: string) => { const b = Buffer.from(s, 'base64'); const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return new Uint8Array(Buffer.concat([d.update(b.subarray(28)), d.final()])) }

type Store = { keys: { pub: string; sk: string; addedAt: number }[]; used: { pub: string; usedAt: number }[] }
let st: Store | null = null
const load = (): Store => {
  if (st) return st
  try { st = existsSync(FILE()) ? JSON.parse(readFileSync(FILE(), 'utf8')) : null } catch { st = null }
  st ||= { keys: [], used: [] }; st.keys ||= []; st.used ||= []
  for (const s of String(process.env.MINT_KEYS || '').split(',').map((x) => x.trim()).filter(Boolean)) { try { add(s, false) } catch {} }
  return st
}
const save = () => { try { mkdirSync(DIR(), { recursive: true }); writeFileSync(FILE(), JSON.stringify(load())) } catch {} }

/** add a base58 secret (or a solana-keygen json array) to the pool; rejects keys that don't end in the suffix or are already in */
export function add(secret: string | number[], persist = true): string {
  const sk = Array.isArray(secret) ? Uint8Array.from(secret) : bs58.decode(secret)
  const kp = Keypair.fromSecretKey(sk); const pub = kp.publicKey.toBase58()
  if (!pub.endsWith(SUFFIX)) throw new Error(`${pub} does not end in ${SUFFIX}`)
  const s = load(); if (s.keys.some((k) => k.pub === pub) || s.used.some((k) => k.pub === pub)) throw new Error(pub + ' already in the pool')
  s.keys.push({ pub, sk: enc(sk), addedAt: Date.now() }); if (persist) save(); return pub
}
/** next branded mint, or a random keypair when the pool is empty (the launch still works, it just isn't branded) */
export function next(): { kp: Keypair; branded: boolean } {
  const s = load(); const k = s.keys.shift(); if (!k) return { kp: Keypair.generate(), branded: false }
  s.used.push({ pub: k.pub, usedAt: Date.now() }); if (s.used.length > 5000) s.used.splice(0, 1000); save()
  return { kp: Keypair.fromSecretKey(dec(k.sk)), branded: true }
}
/** a mint that was popped but whose launch never went out (build failed) goes back on top */
export function unuse(kp: Keypair) { const s = load(); const pub = kp.publicKey.toBase58(); if (!pub.endsWith(SUFFIX)) return; const i = s.used.findIndex((u) => u.pub === pub); if (i >= 0) s.used.splice(i, 1); if (!s.keys.some((k) => k.pub === pub)) s.keys.unshift({ pub, sk: enc(kp.secretKey), addedAt: Date.now() }); save() }
export const stats = () => { const s = load(); return { suffix: SUFFIX, available: s.keys.length, used: s.used.length } }
