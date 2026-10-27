// In-app "burner" wallet: keypair generated client-side, secret encrypted with the user's password (PBKDF2 → AES-GCM)
// and kept in this browser only. Unlocked key lives in memory for the session. We never see it.
import { Keypair, VersionedTransaction, SystemProgram, Transaction, PublicKey, Connection, LAMPORTS_PER_SOL } from '@solana/web3.js'
import bs58 from 'bs58'
import { confirmByPolling } from './rpc'
const K = 'unnamed_burner_v1'
type Stored = { pub: string; salt: string; iv: string; ct: string }
const enc = new TextEncoder()
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u)); const ub64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
async function key(pw: string, salt: Uint8Array) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt as BufferSource, iterations: 310000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
export function stored(): Stored | null { try { return JSON.parse(localStorage.getItem(K) || 'null') } catch { return null } }
export function hasBurner() { return !!stored() }
export async function createBurner(pw: string, secret?: Uint8Array): Promise<Keypair> {
  const kp = secret ? Keypair.fromSecretKey(secret) : Keypair.generate()
  const salt = crypto.getRandomValues(new Uint8Array(16)); const iv = crypto.getRandomValues(new Uint8Array(12))
  const k = await key(pw, salt)
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, k, kp.secretKey as BufferSource))
  localStorage.setItem(K, JSON.stringify({ pub: kp.publicKey.toBase58(), salt: b64(salt), iv: b64(iv), ct: b64(ct) } as Stored))
  return kp
}
export async function unlockBurner(pw: string): Promise<Keypair> {
  const s = stored(); if (!s) throw new Error('No burner wallet')
  const k = await key(pw, ub64(s.salt))
  try { const sk = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub64(s.iv) as BufferSource }, k, ub64(s.ct) as BufferSource)); return Keypair.fromSecretKey(sk) }
  catch { throw new Error('Wrong password') }
}
export function removeBurner() { localStorage.removeItem(K) }
export const exportSecret = (kp: Keypair) => bs58.encode(kp.secretKey)
export function parseSecret(s: string): Uint8Array {
  const t = s.trim()
  if (t.startsWith('[')) return Uint8Array.from(JSON.parse(t))
  const b = bs58.decode(t); if (b.length !== 64) throw new Error('Expected a 64-byte secret key'); return b
}
export const signWith = (kp: Keypair) => async (tx: VersionedTransaction) => { tx.sign([kp]); return tx }
export async function withdraw(conn: Connection, kp: Keypair, to: string, sol: number): Promise<string> {
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(to), lamports: Math.floor(sol * LAMPORTS_PER_SOL) }))
  const bh = await conn.getLatestBlockhash('confirmed'); tx.recentBlockhash = bh.blockhash; tx.feePayer = kp.publicKey; tx.sign(kp)
  const sig = await conn.sendRawTransaction(tx.serialize()); await confirmByPolling(conn, sig); return sig
}
