// Landing path: Helius Sender (dual-routes to validators + SWQOS/Jito) instead of plain RPC sendTransaction.
// Sender needs two things in the tx: a compute-unit price (we always set one) and a SOL tip to one of its tip accounts
// (≥ 0.001 SOL enters the priority tip buffer). Docs: helius.dev/docs/sending-transactions/sender
import { Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type AddressLookupTableAccount } from '@solana/web3.js'

export const TIP_ACCOUNTS = [
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE', 'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ', '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta', '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn', '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
  '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ', 'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF', '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT', '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey', '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
]
export const MIN_TIP_LAMPORTS = 1_000_000 // 0.001 SOL — below this Sender still forwards but outside the priority buffer
export const DONTFRONT = new PublicKey('jitodontfront111111111111111111111111111111')
export const tipAccount = () => new PublicKey(TIP_ACCOUNTS[Math.floor(Math.random() * TIP_ACCOUNTS.length)])

/** Sender URL derived from the RPC: a Helius api-key lifts the limit from 1 rps (keyless) to 50 rps. */
export function senderUrl(rpc: string, swqosOnly = false) {
  const key = /api-key=([\w-]+)/.exec(rpc)?.[1]
  const u = new URL('https://sender.helius-rpc.com/fast'); if (key) u.searchParams.set('api-key', key); if (swqosOnly) u.searchParams.set('swqos_only', 'true')
  return u.toString()
}

/** Append a tip transfer to an unsigned (or mint-only-signed) tx. Keeps blockhash, payer, version and lookup tables; returns a new unsigned tx. */
export async function addTip(conn: Connection, tx: VersionedTransaction, payer: PublicKey, lamports: number): Promise<VersionedTransaction> {
  if (lamports <= 0) return tx
  const msg = tx.message
  const alts: AddressLookupTableAccount[] = []
  if (msg.version !== 'legacy') for (const l of msg.addressTableLookups) { const r = await conn.getAddressLookupTable(l.accountKey); if (r.value) alts.push(r.value) }
  const tm = TransactionMessage.decompile(msg, { addressLookupTableAccounts: alts })
  const tip = SystemProgram.transfer({ fromPubkey: payer, toPubkey: tipAccount(), lamports })
  // jitodontfront: a read-only marker account. Jito's block engine rejects any bundle that puts another tx in front of this one (in-bundle sandwich guard). The system program ignores extra accounts.
  if (process.env.JITO_DONTFRONT !== '0') tip.keys.push({ pubkey: DONTFRONT, isSigner: false, isWritable: false })
  tm.instructions.push(tip)
  const out = msg.version === 'legacy' ? tm.compileToLegacyMessage() : tm.compileToV0Message(alts)
  return new VersionedTransaction(out)
}

/** Fire the signed tx at Sender and the RPC at once; the signature is the same either way. Falls back silently if Sender is unreachable. */
export async function sendFast(conn: Connection, raw: Uint8Array, rpc: string): Promise<string> {
  const b64 = Buffer.from(raw).toString('base64')
  const viaSender = fetch(senderUrl(rpc), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'sendTransaction', params: [b64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }] }) })
    .then(async (r) => { const d = await r.json(); if (d.error) throw new Error(d.error.message || 'sender'); return d.result as string })
  const viaRpc = conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 })
  // first success wins; if both fail, surface the RPC error (it is the more descriptive one)
  return new Promise<string>((res, rej) => { let fails = 0, rpcErr: any; const bad = (e: any, isRpc: boolean) => { if (isRpc) rpcErr = e; if (++fails === 2) rej(rpcErr || e) }; viaSender.then(res, (e) => bad(e, false)); viaRpc.then(res, (e) => bad(e, true)) })
}
