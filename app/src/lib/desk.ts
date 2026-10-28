// Desk client. Bidder: holds a websocket, co-signs relayed fills after verifying them locally. Seller: builds + signs the fill tx.
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token'
import nacl from 'tweetnacl'
import bs58 from 'bs58'
import { confirmByPolling } from './rpc'

export const SERVER = (import.meta as any).env?.VITE_SERVER_URL || localStorage.getItem('unnamed_server') || 'https://unnamed-server.onrender.com'
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

export type BidderSession = { close: () => void; place: (mint: string, sol: number, discBps: number) => Promise<BookBid>; cancel: (id: string) => Promise<boolean>; connected: () => boolean; respond: (rfqId: string, discBps: number, sol: number) => Promise<any> }
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
      if (d.type === 'rfq' || d.type === 'swap') { onEvent(d); return }
      if (d.type === 'rfq_responded') { waiters.get('rfq')?.ok(d.rfq); waiters.delete('rfq'); onEvent(d); return }
      if (d.type === 'placed') { waiters.get('place')?.ok(d.bid); waiters.delete('place'); onEvent(d); return }
      if (d.type === 'cancelled') { waiters.get('cancel:' + d.id)?.ok(d.ok); waiters.delete('cancel:' + d.id); onEvent(d); return }
      if (d.type === 'error') { const w = d.re === 'place' ? waiters.get('place') : d.re === 'rfq_respond' ? waiters.get('rfq') : null; if (w) { w.no(new Error(d.error)); waiters.delete(d.re === 'place' ? 'place' : 'rfq') } onEvent(d); return }
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
    respond: (rfqId, discBps, sol) => new Promise((ok, no) => { if (!authed) return no(new Error('desk not connected')); waiters.set('rfq', { ok, no }); send({ type: 'rfq_respond', rfqId, discBps, sol }); setTimeout(() => { if (waiters.has('rfq')) { waiters.delete('rfq'); no(new Error('timeout')) } }, 15000) }),
  }
}

/** Seller side: take a bid in full. Builds the 4-instruction fill, signs, hands to the server which relays to the bidder. */
export async function takeBid(conn: Connection, seller: string, bidId: string, signTx: (t: Transaction) => Promise<Transaction>, onStatus?: (s: string) => void, gate?: (q: any) => Promise<boolean>): Promise<{ sig: string; quote: any }> {
  onStatus?.('Quoting…')
  const q = await j('/quote', { bidId, seller })
  if (q.refAgeMs > 3000) throw new Error('reference price is stale — try again')
  if (gate && !(await gate(q))) throw new Error('cancelled')
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
export type VaultPub = { id: string; pub: string; mint?: string; symbol?: string; dev: string; stakeSol: number; pct: number; cut: number; armed: boolean; renounced: boolean; avgCost: number; tokens: number; chest: number; devPaid: number; createdAt: number; copyOf?: string; streamed: number; redeemed: number; supply: number; deskBid: number; name?: string; copies: { mint: string; symbol: string; pub: string }[]; imported?: boolean; feePaid?: number; depositedTokens?: number; funders?: Record<string, number>; mode: 'floor' | 'mm'; ceiling: number; floor: number; score: { captured: number; captures: number; deskBought: number; deskFills: number; dipBought: number; dips: number; redeployed: number; floor0: number }; live: { price: number; vwap30: number; stretch: number; captureNow: number; triggerRate: number; buysPerMin: number; tier: string; tranchesFired: number[]; sigma?: number; skew?: number; deskDisc?: number }; activity: { t: number; kind: string; sol?: number; tokens?: number; price?: number; sig?: string; msg?: string }[] }
export const vaultCreate = (dev: string, stakeSol: number, copyOf?: string, mode: 'floor' | 'mm' = 'mm', ceiling = 0.3): Promise<VaultPub> => j('/vault/create', { dev, stakeSol, copyOf, mode, ceiling })
export const vaultSetMode = (id: string, dev: string, mode: 'floor' | 'mm', ceiling?: number): Promise<VaultPub> => j('/vault/mode', { id, dev, mode, ceiling })
export const vaultArm = (id: string, mint: string, symbol: string, name = ''): Promise<VaultPub> => j('/vault/arm', { id, mint, symbol, name })
export const vaultRenounce = (id: string, dev: string): Promise<VaultPub> => j('/vault/renounce', { id, dev })
export const vaultByMint = (mint: string): Promise<VaultPub | null> => j('/vault/mint/' + mint)
export const vaults = (): Promise<VaultPub[]> => j('/vaults')

// ---- history / leaderboard / family / dev / redeem ----
export type FillRec = { t: number; mint: string; symbol: string; seller: string; bidder: string; sol: number; discBps: number; tokens: number; sig: string; vault: boolean }
export const fills = (mint?: string): Promise<FillRec[]> => j('/fills' + (mint ? '?mint=' + mint : ''))
export const leaderboard = (): Promise<{ wallet: string; soldSol: number; boughtSol: number; fills: number; saved: number }[]> => j('/leaderboard')
export type SwapEvt = { type: 'swap'; mint: string; symbol: string; pool: string; sig: string; slot: number; side: 'buy' | 'sell'; sol: number; trader: string; t: number }
export type Family = { root: string; members: { mint: string; symbol: string; mcapUsd: number; vol1h: number; score: number; original: boolean; vault: boolean; leader?: boolean }[] }
export const family = (mint: string): Promise<Family> => j('/family/' + mint)
export const devVaults = (dev: string): Promise<VaultPub[]> => j('/dev/' + dev)
export const redeemQuote = (mint: string, tokens: number): Promise<{ vaultId: string; vaultPub: string; chest: number; supply: number; share: number; sol: number; lamports: number }> => j('/redeem/quote', { mint, tokens })
/** Burn-to-redeem: holder delivers tokens to the vault, vault pays SOL in the same tx (server co-signs with the vault key). */
export async function redeem(conn: Connection, holder: string, mint: string, tokensUi: number, decimals: number, signTx: (t: Transaction) => Promise<Transaction>, onStatus?: (s: string) => void) {
  onStatus?.('Quoting…'); const q = await redeemQuote(mint, tokensUi)
  const hp = new PublicKey(holder), vp = new PublicKey(q.vaultPub), mp = new PublicKey(mint)
  const vAta = getAssociatedTokenAddressSync(mp, vp, true), hAta = getAssociatedTokenAddressSync(mp, hp, true)
  const tx = new Transaction(); tx.feePayer = hp; tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash
  tx.add(createAssociatedTokenAccountIdempotentInstruction(hp, vAta, vp, mp), createTransferInstruction(hAta, vAta, hp, BigInt(Math.floor(tokensUi * 10 ** decimals))), SystemProgram.transfer({ fromPubkey: vp, toPubkey: hp, lamports: q.lamports }))
  onStatus?.('Sign to redeem…'); const signed = await signTx(tx)
  onStatus?.('Vault co-signing…'); const r = await j('/redeem', { mint, holder, tokens: tokensUi, tx: btoa(String.fromCharCode(...signed.serialize({ requireAllSignatures: false }))) })
  return { sig: r.sig as string, sol: r.sol as number }
}

// ---- import a coin / activate vault ----
export type ImportQuote = { mint: string; symbol: string; mcapUsd: number; liqSol: number; priceSol: number; feeSol: number; seedSol: number; treasurySol: number; treasury: string }
export const importQuote = (mint: string): Promise<ImportQuote> => j('/import/quote/' + mint)
export const importCreate = (owner: string, mint: string): Promise<VaultPub & { quote: ImportQuote }> => j('/import/create', { owner, mint })
export const importActivate = (id: string, sig: string): Promise<VaultPub> => j('/import/activate', { id, sig })
export const vaultDeposit = (id: string, from: string, sig: string): Promise<VaultPub> => j('/vault/deposit', { id, from, sig })
/** One signature: fee → treasury, seed → vault chest */
export async function payImport(conn: Connection, owner: string, v: VaultPub & { quote: ImportQuote }, signTx: (t: Transaction) => Promise<Transaction>, onStatus?: (s: string) => void) {
  const op = new PublicKey(owner); const tx = new Transaction(); tx.feePayer = op; tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash
  tx.add(SystemProgram.transfer({ fromPubkey: op, toPubkey: new PublicKey(v.quote.treasury), lamports: Math.floor(v.quote.treasurySol * 1e9) }), SystemProgram.transfer({ fromPubkey: op, toPubkey: new PublicKey(v.pub), lamports: Math.floor(v.quote.seedSol * 1e9) }))
  onStatus?.('Sign to activate the vault…'); const signed = await signTx(tx)
  const sig = await conn.sendRawTransaction(signed.serialize(), { maxRetries: 3 }); onStatus?.('Confirming…'); await confirmByPolling(conn, sig)
  onStatus?.('Arming vault…'); return { sig, vault: await importActivate(v.id, sig) }
}
/** Deposit SOL and/or tokens into an armed vault */
export async function depositToVault(conn: Connection, from: string, v: VaultPub, sol: number, tokensUi: number, decimals: number, signTx: (t: Transaction) => Promise<Transaction>, onStatus?: (s: string) => void) {
  const fp = new PublicKey(from), vp = new PublicKey(v.pub); const tx = new Transaction(); tx.feePayer = fp; tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash
  if (sol > 0) tx.add(SystemProgram.transfer({ fromPubkey: fp, toPubkey: vp, lamports: Math.floor(sol * 1e9) }))
  if (tokensUi > 0) { const mp = new PublicKey(v.mint!); const vAta = getAssociatedTokenAddressSync(mp, vp, true), fAta = getAssociatedTokenAddressSync(mp, fp, true); tx.add(createAssociatedTokenAccountIdempotentInstruction(fp, vAta, vp, mp), createTransferInstruction(fAta, vAta, fp, BigInt(Math.floor(tokensUi * 10 ** decimals)))) }
  onStatus?.('Sign deposit…'); const signed = await signTx(tx); const sig = await conn.sendRawTransaction(signed.serialize(), { maxRetries: 3 }); onStatus?.('Confirming…'); await confirmByPolling(conn, sig)
  onStatus?.('Recording…'); await new Promise((r) => setTimeout(r, 1500)); return { sig, vault: await vaultDeposit(v.id, from, sig) }
}

// ---- RFQ ----
export type Rfq = { id: string; mint: string; symbol: string; seller: string; sizeSol: number; maxBps: number; createdAt: number; expiresAt: number; status: 'open' | 'done' | 'expired' | 'cancelled'; matches: string[]; counters: { bidId: string; bidder: string; discBps: number; sol: number; vault: boolean }[]; filledSol: number; priceSol: number; liqSol: number; remainingSol: number; secondsLeft: number }
export const rfqCreate = (mint: string, seller: string, sizeSol: number, maxBps: number, ttlMs: number): Promise<Rfq> => j('/rfq', { mint, seller, sizeSol, maxBps, ttlMs })
export const rfqGet = (id: string): Promise<Rfq> => j('/rfq/' + id)
export const rfqCancel = (id: string, seller: string) => j('/rfq/cancel', { id, seller })
/** constant-product chart impact of selling `sol` worth into a pool with `liqSol` reserve */
export const poolImpactBps = (sol: number, liqSol: number) => liqSol > 0 ? Math.round((1 - 1 / (1 + sol / liqSol) ** 2) * 10000) : 10000
export const bundleSign = (id: string, mint: string, tx: string, maxSol: number): Promise<{ tx: string; spend: number }> => j('/vault/bundle-sign', { id, mint, tx, maxSol })
export const sendBundle = (txs: string[]): Promise<{ bundleId: string }> => j('/bundle', { txs })

/** Read-only firehose of vault-pool swaps (no auth). */
export function openSwapFeed(onSwap: (s: SwapEvt) => void) {
  let ws: WebSocket | null = null, closed = false, timer: any
  const connect = () => { ws = new WebSocket(WS); ws.onmessage = (m) => { try { const d = JSON.parse(m.data); if (d.type === 'swap') onSwap(d) } catch {} }; ws.onclose = () => { if (!closed) timer = setTimeout(connect, 3000) }; ws.onerror = () => ws?.close() }
  connect(); return () => { closed = true; clearTimeout(timer); ws?.close() }
}
