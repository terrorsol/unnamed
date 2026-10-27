// Desk client. Bidder: holds a websocket, co-signs relayed fills after verifying them locally. Seller: builds + signs the fill tx.
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token'
import nacl from 'tweetnacl'
import bs58 from 'bs58'
import { confirmByPolling } from './rpc'

export const SERVER = (import.meta as any).env?.VITE_SERVER_URL || localStorage.getItem('unnamed_server') || 'https://unnamed-server.up.railway.app'
const WS = SERVER.replace(/^http/, 'ws')
export type BookBid = { id: string; mint: string; symbol: string; sol: number; discBps: number; placedAt: number; restable: boolean; status: string; bidder: string; mine: boolean }
export type Book = { open: boolean; minBlock: number | null; market: any; bids: BookBid[]; rules: { discMin: number; discMax: number; restMs: number; feeBps: number; gateUsd: number } }
export type Expect = { mint: string; seller: string; bidder: string; treasury: string; base: string; sellerLamports: string; fee: string; priceSol: number; discBps: number; decimals: number }

async function j(path: string, body?: any) {
  const r = await fetch(SERVER + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined)
  const d = await r.json().catch(() => ({ error: 'bad response' })); if (!r.ok || d?.error) throw new Error(d?.error || 'server ' + r.status); return d
}
export const getBook = (mint: string, me?: string): Promise<Book> => j(`/book/${mint}${me ? '?me=' + me : ''}`)
export const getBooks = (): Promise<{ mint: string; symbol: string; bids: number; sol: number; bestDisc: number }[]> => j('/books')
export const health = () => j('/health')

/** Structural check of a fill tx — same rules as the server's verify.ts, run independently by the bidder */
export function verifyFill(tx: Transaction, e: Expect): string | null {
  const ix = tx.instructions; if (ix.length !== 4) return 'wrong instruction count'
  if (!tx.feePayer || tx.feePayer.toBase58() !== e.seller) return 'fee payer must be seller'
  const bidder = new PublicKey(e.bidder), seller = new PublicKey(e.seller), mint = new PublicKey(e.mint)
  const bAta = getAssociatedTokenAddressSync(mint, bidder, true), sAta = getAssociatedTokenAddressSync(mint, seller, true)
  const a = ix[0]; if (!a.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) || a.data[0] !== 1 || !a.keys[0].pubkey.equals(seller) || !a.keys[1].pubkey.equals(bAta) || !a.keys[2].pubkey.equals(bidder) || !a.keys[3].pubkey.equals(mint)) return 'ix0 bad'
  const t = ix[1]; if (!t.programId.equals(TOKEN_PROGRAM_ID) || t.data[0] !== 3 || !t.keys[0].pubkey.equals(sAta) || !t.keys[1].pubkey.equals(bAta) || !t.keys[2].pubkey.equals(seller)) return 'ix1 bad'
  const amt = new DataView(t.data.buffer, t.data.byteOffset + 1, 8).getBigUint64(0, true); if (amt !== BigInt(e.base)) return 'token amount mismatch'
  const dv = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset + 4, 8).getBigUint64(0, true)
  const s = ix[2]; if (!s.programId.equals(SystemProgram.programId) || !s.keys[0].pubkey.equals(bidder) || !s.keys[1].pubkey.equals(seller) || dv(s.data) !== BigInt(e.sellerLamports)) return 'sol transfer mismatch'
  const f = ix[3]; if (!f.programId.equals(SystemProgram.programId) || !f.keys[0].pubkey.equals(bidder) || f.keys[1].pubkey.toBase58() !== e.treasury || dv(f.data) !== BigInt(e.fee)) return 'fee mismatch'
  // economic check: implied price must honor my discount (within tolerance)
  const impliedPx = Number(BigInt(e.sellerLamports) + BigInt(e.fee)) / 1e9 / (Number(BigInt(e.base)) / 10 ** e.decimals)
  if (impliedPx > e.priceSol * (1 - e.discBps / 10000) * 1.015) return 'price does not honor discount'
  return null
}

export type BidderSession = { close: () => void; place: (mint: string, sol: number, discBps: number) => Promise<BookBid>; cancel: (id: string) => Promise<boolean>; connected: () => boolean }
/** Open a bidder session. `sign` co-signs fills (in-app wallet: silent; extension: prompts). `spot` returns current SOL price of a mint for the economic check. */
export function openBidder(conn: Connection, pubkey: string, signMsg: (m: Uint8Array) => Promise<Uint8Array>, signTx: (t: Transaction) => Promise<Transaction>, spot: (mint: string) => Promise<number>, onEvent: (e: any) => void): BidderSession {
  let ws: WebSocket | null = null, closed = false, authed = false, timer: any, hb: any
  const waiters = new Map<string, { ok: (v: any) => void; no: (e: any) => void }>()
  const send = (o: any) => ws?.readyState === 1 && ws.send(JSON.stringify(o))
  const connect = () => {
    ws = new WebSocket(WS); authed = false
    ws.onopen = async () => { const ts = Date.now(); const sig = await signMsg(new TextEncoder().encode(`unnamed-desk:${pubkey}:${ts}`)); send({ type: 'auth', pubkey, ts, sig: bs58.encode(sig) }) }
    ws.onmessage = async (m) => {
      const d = JSON.parse(m.data)
      if (d.type === 'authed') { authed = true; onEvent(d); hb = setInterval(() => send({ type: 'refresh' }), 20000); return }
      if (d.type === 'placed') { waiters.get('place')?.ok(d.bid); waiters.delete('place'); onEvent(d); return }
      if (d.type === 'cancelled') { waiters.get('cancel:' + d.id)?.ok(d.ok); waiters.delete('cancel:' + d.id); onEvent(d); return }
      if (d.type === 'error') { const w = d.re === 'place' ? waiters.get('place') : null; if (w) { w.no(new Error(d.error)); waiters.delete('place') } onEvent(d); return }
      if (d.type === 'fill') {
        try {
          const tx = Transaction.from(Uint8Array.from(atob(d.tx), (c) => c.charCodeAt(0)))
          const e: Expect = d.expect; const why = verifyFill(tx, { ...e, priceSol: await spot(e.mint).catch(() => e.priceSol) })
          if (why) throw new Error(why)
          const signed = await signTx(tx)
          const sig = await conn.sendRawTransaction(signed.serialize(), { maxRetries: 3 }); await confirmByPolling(conn, sig)
          send({ type: 'filled', bidId: d.bidId, sig }); onEvent({ type: 'filled', bidId: d.bidId, sig, expect: e })
        } catch (err: any) { send({ type: 'reject', bidId: d.bidId, err: String(err.message || err) }); onEvent({ type: 'fillfail', error: String(err.message || err) }) }
      }
    }
    ws.onclose = () => { clearInterval(hb); authed = false; onEvent({ type: 'disconnected' }); if (!closed) timer = setTimeout(connect, 3000) }
    ws.onerror = () => ws?.close()
  }
  connect()
  return {
    close: () => { closed = true; clearTimeout(timer); clearInterval(hb); ws?.close() },
    connected: () => authed,
    place: (mint, sol, discBps) => new Promise((ok, no) => { if (!authed) return no(new Error('desk not connected')); waiters.set('place', { ok, no }); send({ type: 'place', mint, sol, discBps }); setTimeout(() => { if (waiters.has('place')) { waiters.delete('place'); no(new Error('timeout')) } }, 15000) }),
    cancel: (id) => new Promise((ok) => { waiters.set('cancel:' + id, { ok, no: ok }); send({ type: 'cancel', id }); setTimeout(() => ok(false), 8000) }),
  }
}

/** Seller side: take a bid in full. Builds the 4-instruction fill, signs, hands to the server which relays to the bidder. */
export async function takeBid(conn: Connection, seller: string, bidId: string, signTx: (t: Transaction) => Promise<Transaction>, onStatus?: (s: string) => void): Promise<{ sig: string; quote: any }> {
  onStatus?.('Quoting…')
  const q = await j('/quote', { bidId, seller })
  const sellerPk = new PublicKey(seller), bidderPk = new PublicKey(q.bidder), mint = new PublicKey(q.mint)
  const bAta = getAssociatedTokenAddressSync(mint, bidderPk, true), sAta = getAssociatedTokenAddressSync(mint, sellerPk, true)
  const tx = new Transaction(); tx.feePayer = sellerPk; tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash
  tx.add(createAssociatedTokenAccountIdempotentInstruction(sellerPk, bAta, bidderPk, mint), createTransferInstruction(sAta, bAta, sellerPk, BigInt(q.base)),
    SystemProgram.transfer({ fromPubkey: bidderPk, toPubkey: sellerPk, lamports: BigInt(q.sellerLamports) }), SystemProgram.transfer({ fromPubkey: bidderPk, toPubkey: new PublicKey(q.treasury), lamports: BigInt(q.fee) }))
  onStatus?.('Sign to deliver tokens…')
  const signed = await signTx(tx)
  onStatus?.('Waiting for bidder to co-sign…')
  const r = await j('/fill', { bidId, seller, tx: btoa(String.fromCharCode(...signed.serialize({ requireAllSignatures: false }))) })
  return { sig: r.sig, quote: q }
}
export const signMsgWith = (kp: Keypair) => async (m: Uint8Array) => nacl.sign.detached(m, kp.secretKey)
export const signLegacyWith = (kp: Keypair) => async (t: Transaction) => { t.partialSign(kp); return t }

// ---- vault ----
export type VaultPub = { id: string; pub: string; mint?: string; symbol?: string; dev: string; stakeSol: number; pct: number; cut: number; armed: boolean; renounced: boolean; avgCost: number; tokens: number; chest: number; devPaid: number; createdAt: number; activity: { t: number; kind: string; sol?: number; tokens?: number; price?: number; sig?: string; msg?: string }[] }
export const vaultCreate = (dev: string, stakeSol: number): Promise<VaultPub> => j('/vault/create', { dev, stakeSol })
export const vaultArm = (id: string, mint: string, symbol: string): Promise<VaultPub> => j('/vault/arm', { id, mint, symbol })
export const vaultRenounce = (id: string, dev: string): Promise<VaultPub> => j('/vault/renounce', { id, dev })
export const vaultByMint = (mint: string): Promise<VaultPub | null> => j('/vault/mint/' + mint)
export const vaults = (): Promise<VaultPub[]> => j('/vaults')
