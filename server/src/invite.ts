// Invite keys for the private beta. A key is bound to the first wallet that redeems it (the wallet signs a message);
// redeeming returns a session token that every write route and the bidder socket require while GATE=1.
// Keys are stored hashed in DATA_DIR/invites.json; `npm run invites -- 10 "wave 1"` prints ten fresh ones once.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import nacl from 'tweetnacl'
import bs58 from 'bs58'

const DIR = () => process.env.DATA_DIR || './data'
const FILE = () => DIR() + '/invites.json'
export const GATE = process.env.GATE === '1'
type Store = { keys: Record<string, { label: string; madeAt: number; wallet?: string; redeemedAt?: number }> }
const SECRET = process.env.INVITE_SECRET || process.env.VAULT_SECRET || 'dev-only-secret-change-me'
let st: Store | null = null
const load = (): Store => {
  if (st) return st; try { st = existsSync(FILE()) ? JSON.parse(readFileSync(FILE(), 'utf8')) : null } catch { st = null } st ||= { keys: {} }; if (!st.keys) st.keys = {}
  // keys can also be shipped as hashes in the env (INVITE_HASHES=sha256,sha256,…): the tunnel desk has no disk between runs
  for (const h of String(process.env.INVITE_HASHES || '').split(',').map((x) => x.trim()).filter((x) => /^[0-9a-f]{64}$/.test(x))) if (!st.keys[h]) st.keys[h] = { label: 'env', madeAt: 0 }
  return st }
const save = () => { try { mkdirSync(DIR(), { recursive: true }); writeFileSync(FILE(), JSON.stringify(load(), null, 1)) } catch {} }
// keyed hash: the bindings file can sit on a public branch without the 40-bit codes being brute-forceable from it
const hash = (code: string) => createHmac('sha256', SECRET).update('banker-invite').update(code.trim().toUpperCase()).digest('hex')
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const chunk = () => [...randomBytes(4)].map((b) => ALPHA[b % 32]).join('')

/** make n keys; returns the plaintext codes (shown once) */
export function mint(n: number, label = ''): string[] {
  const s = load(); const out: string[] = []
  for (let i = 0; i < n; i++) { const code = `BANK-${chunk()}-${chunk()}`; s.keys[hash(code)] = { label, madeAt: Date.now() }; out.push(code) }
  save(); return out
}
const fails = new Map<string, number[]>()
/** redeem: code + wallet + signature over `banker:invite:<wallet>:<minute>` → session token (30 days). A key already bound to another wallet is refused. */
export function redeem(code: string, wallet: string, msg: string, sig: string, ip = ''): { token: string; wallet: string; exp: number } {
  const now = Date.now(); const f = (fails.get(ip) || []).filter((t) => now - t < 3600_000); if (f.length >= 10) throw new Error('too many tries — wait an hour')
  const fail = (e: string) => { f.push(now); fails.set(ip, f); throw new Error(e) }
  const m = /^banker:invite:([1-9A-HJ-NP-Za-km-z]{32,44}):(\d+)$/.exec(msg || ''); if (!m || m[1] !== wallet) fail('bad auth message')
  if (Math.abs(now / 60000 - +m![2]) > 10) fail('auth message expired')
  try { if (!nacl.sign.detached.verify(new TextEncoder().encode(msg), bs58.decode(sig), bs58.decode(wallet))) fail('bad signature') } catch { fail('bad signature') }
  const s = load(); const h = hash(code || ''); const k = s.keys[h]; if (!k) fail('that key is not valid')
  if (k!.wallet && k!.wallet !== wallet) fail('that key is already in use by another wallet')
  if (!k!.wallet) { k!.wallet = wallet; k!.redeemedAt = now }
  save(); const exp = now + 30 * 86400_000; return { token: tokenFor(wallet, exp), wallet, exp }
}
/** session token = wallet(32) ‖ expiry(6) ‖ hmac(16): stateless, survives restarts, verifiable with VAULT_SECRET alone */
const mac = (w: Buffer, e: Buffer) => createHmac('sha256', SECRET).update('banker-session').update(w).update(e).digest().subarray(0, 16)
function tokenFor(wallet: string, exp: number) { const w = Buffer.from(bs58.decode(wallet)); const e = Buffer.alloc(6); e.writeUIntBE(Math.floor(exp / 1000), 0, 6); return bs58.encode(Buffer.concat([w, e, mac(w, e)])) }
/** wallet behind a session token, or null */
export function session(token?: string | null): string | null {
  if (!token) return null
  try { const b = Buffer.from(bs58.decode(token)); if (b.length !== 54) return null; const w = b.subarray(0, 32), e = b.subarray(32, 38), m = b.subarray(38)
    if (!timingSafeEqual(m, mac(w, e))) return null; if (e.readUIntBE(0, 6) * 1000 < Date.now()) return null
    const wallet = bs58.encode(w); const bound = Object.values(load().keys).some((k) => k.wallet === wallet); return bound ? wallet : null } catch { return null }
}
export const stats = () => { const s = load(); const ks = Object.values(s.keys); return { gate: GATE, keys: ks.length, redeemed: ks.filter((k) => k.wallet).length } }
export const hashOf = hash
export const redeemed = () => Object.entries(load().keys).filter(([, k]) => k.wallet).map(([h, k]) => ({ key: h.slice(0, 8), label: k.label, wallet: k.wallet, redeemedAt: k.redeemedAt }))
