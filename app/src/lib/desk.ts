// Desk client. Bidder: holds a websocket, co-signs relayed fills after verifying them locally. Seller: builds + signs the fill tx.
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, ComputeBudgetProgram } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token'
/** Owner program of a mint (SPL Token or Token-2022). Cached per session. */
const progCache = new Map<string, PublicKey>()
export async function tokenProgram(conn: Connection, mint: string): Promise<PublicKey> { const c = progCache.get(mint); if (c) return c; const i = await conn.getAccountInfo(new PublicKey(mint)); if (!i) throw new Error('mint not found'); progCache.set(mint, i.owner); return i.owner }
import nacl from 'tweetnacl'
import bs58 from 'bs58'
import { S } from './fmt'
import { confirmByPolling } from './rpc'

/** Server resolution: build-time VITE_SERVER_URL → user override in localStorage → the live pointer the CI desk job publishes → Render default.
 *  `ready` resolves once discovery is done; every call awaits it, so the first request never races the lookup. */
const pinned = (import.meta as any).env?.VITE_SERVER_URL || (() => { try { return localStorage.getItem('unnamed_server') } catch { return null } })()
export let SERVER: string = pinned || 'https://unnamed-server.onrender.com'
export let SERVER_SOURCE: 'pinned' | 'live' | 'default' = pinned ? 'pinned' : 'default'
const LIVE_POINTER = 'https://raw.githubusercontent.com/terrorsol/unnamed/reports-live/server.json'
export const ready: Promise<void> = (async () => {
  if (pinned) return
  try { const r = await fetch(LIVE_POINTER + '?t=' + Math.floor(Date.now() / 60000), { cache: 'no-store' }); if (!r.ok) return; const d = await r.json(); if (d?.url && /^https:\/\//.test(d.url)) { const h = await fetch(d.url.replace(/\/$/, '') + '/health').then((x) => x.ok).catch(() => false); if (h) { SERVER = d.url.replace(/\/$/, ''); SERVER_SOURCE = 'live' } } } catch {}
})()
const WS = () => SERVER.replace(/^http/, 'ws')
export type BookBid = { id: string; mint: string; symbol: string; sol: number; discBps: number; placedAt: number; restable: boolean; away?: boolean; status: string; bidder: string; mine: boolean; vault?: boolean; block?: boolean; expiresAt?: number }
export type BookAsk = { id: string; mint: string; symbol: string; sol: number; discBps: number; placedAt: number; status: string; away?: boolean; seller: string; mine: boolean }
export type Book = { asks: BookAsk[]; open: boolean; why?: string | null; minBlock: number | null; market: any; bids: BookBid[]; rules: { discMin: number; discMax: number; restMs: number; feeBps: number; gateUsd: number } }
export type Expect = { mint: string; seller: string; bidder: string; treasury: string; base: string; sellerLamports: string; fee: string; priceSol: number; discBps: number; decimals: number; tokenProgram: string; payer?: 'seller' | 'bidder' }

async function j(path: string, body?: any) {
  await ready
  const r = await fetch(SERVER + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined)
  const d = await r.json().catch(() => ({ error: 'bad response' })); if (!r.ok || d?.error) throw new Error(d?.error || 'server ' + r.status); return d
}
export const getBook = (mint: string, me?: string): Promise<Book> => j(`/book/${mint}${me ? '?me=' + me : ''}`)
export const getBooks = (): Promise<{ mint: string; symbol: string; bids: number; sol: number; bestDisc: number }[]> => j('/books')
export const health = () => j('/health')
export const myBids = (me: string): Promise<BookBid[]> => j('/mybids?me=' + me)

/** Structural check of a fill tx — same rules as the server's verify.ts, run independently by the bidder */
export function verifyFill(tx: Transaction, e: Expect): string | null {
  const CB = 'ComputeBudget111111111111111111111111111111'; const ix = tx.instructions.filter((i, n) => !(n < 2 && i.programId.toBase58() === CB)); if (ix.length !== 4) return 'wrong instruction count'
  const payer = e.payer === 'bidder' ? e.bidder : e.seller
  if (!tx.feePayer || tx.feePayer.toBase58() !== payer) return 'fee payer mismatch'
  const bidder = new PublicKey(e.bidder), seller = new PublicKey(e.seller), mint = new PublicKey(e.mint), payerPk = new PublicKey(payer)
  const prog = new PublicKey(e.tokenProgram); if (!prog.equals(TOKEN_PROGRAM_ID) && !prog.equals(TOKEN_2022_PROGRAM_ID)) return 'unknown token program'
  const bAta = getAssociatedTokenAddressSync(mint, bidder, true, prog), sAta = getAssociatedTokenAddressSync(mint, seller, true, prog)
  const a = ix[0]; if (!a.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) || a.data[0] !== 1 || !a.keys[0].pubkey.equals(payerPk) || !a.keys[1].pubkey.equals(bAta) || !a.keys[2].pubkey.equals(bidder) || !a.keys[3].pubkey.equals(mint) || !a.keys[5].pubkey.equals(prog)) return 'ix0 bad'
  const t = ix[1]; if (!t.programId.equals(prog) || t.data[0] !== 12 || !t.keys[0].pubkey.equals(sAta) || !t.keys[1].pubkey.equals(mint) || !t.keys[2].pubkey.equals(bAta) || !t.keys[3].pubkey.equals(seller)) return 'ix1 bad'
  const amt = new DataView(t.data.buffer, t.data.byteOffset + 1, 8).getBigUint64(0, true); if (amt !== BigInt(e.base)) return 'token amount mismatch'
  if (t.data[9] !== e.decimals) return 'decimals mismatch'
  const dv = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset + 4, 8).getBigUint64(0, true)
  const s = ix[2]; if (!s.programId.equals(SystemProgram.programId) || !s.keys[0].pubkey.equals(bidder) || !s.keys[1].pubkey.equals(seller) || dv(s.data) !== BigInt(e.sellerLamports)) return 'sol transfer mismatch'
  const f = ix[3]; if (!f.programId.equals(SystemProgram.programId) || !f.keys[0].pubkey.equals(bidder) || f.keys[1].pubkey.toBase58() !== e.treasury || dv(f.data) !== BigInt(e.fee)) return 'fee mismatch'
  // economic check: implied price must honor my discount (within tolerance)
  const impliedPx = Number(BigInt(e.sellerLamports) + BigInt(e.fee)) / 1e9 / (Number(BigInt(e.base)) / 10 ** e.decimals)
  // bidder co-signing: must not pay more than spot·(1−disc); seller co-signing an ask: must not receive less than spot·(1−disc)
  if (e.payer === 'bidder') { if (impliedPx < e.priceSol * (1 - e.discBps / 10000) * 0.985) return 'price below my offer' } else if (impliedPx > e.priceSol * (1 - e.discBps / 10000) * 1.015) return 'price does not honor discount'
  return null
}

export type BidderSession = { close: () => void; place: (mint: string, sol: number, discBps: number) => Promise<BookBid>; buyBlock: (mint: string, sol: number, premiumBps: number, ttlSec: number) => Promise<BookBid>; placeAsk: (mint: string, sol: number, discBps: number) => Promise<BookAsk>; cancelAsk: (id: string) => Promise<boolean>; cancel: (id: string) => Promise<boolean>; connected: () => boolean; respond: (rfqId: string, discBps: number, sol: number) => Promise<any> }
/** Open a bidder session. `sign` co-signs fills (in-app wallet: silent; extension: prompts). `spot` returns current SOL price of a mint for the economic check. */
export function openBidder(conn: Connection, pubkey: string, signMsg: (m: Uint8Array) => Promise<Uint8Array>, signTx: (t: Transaction) => Promise<Transaction>, spot: (mint: string) => Promise<number>, onEvent: (e: any) => void): BidderSession {
  let ws: WebSocket | null = null, closed = false, authed = false, timer: any, hb: any
  const mine = new Map<string, { mint: string; sol: number; discBps: number }>()
  const waiters = new Map<string, { ok: (v: any) => void; no: (e: any) => void }>()
  const send = (o: any) => ws?.readyState === 1 && ws.send(JSON.stringify(o))
  const connect = async () => {
    await ready; if (closed) return
    ws = new WebSocket(WS()); authed = false
    ws.onopen = async () => { const ts = Date.now(); const sig = await signMsg(new TextEncoder().encode(`unnamed-desk:${pubkey}:${ts}`)); send({ type: 'auth', pubkey, ts, sig: bs58.encode(sig) }) }
    ws.onmessage = async (m) => {
      const d = JSON.parse(m.data)
      if (d.type === 'authed') { authed = true; onEvent(d); hb = setInterval(() => send({ type: 'refresh' }), 20000)
        // server kept nothing (grace window passed) → re-place the bids this session owns
        if (!d.reattached && mine.size) { const again = [...mine.values()]; mine.clear(); for (const b of again) send({ type: 'place', mint: b.mint, sol: b.sol, discBps: b.discBps }) }
        return }
      if (d.type === 'rfq' || d.type === 'swap' || d.type === 'buy_rfq') { onEvent(d); return }
      if (d.type === 'rfq_responded') { waiters.get('rfq')?.ok(d.rfq); waiters.delete('rfq'); onEvent(d); return }
      if (d.type === 'placed') { if (d.bid && !d.bid.block) mine.set(d.bid.id, { mint: d.bid.mint, sol: d.bid.sol, discBps: d.bid.discBps }); waiters.get('place')?.ok(d.bid); waiters.delete('place'); onEvent(d); return }
      if (d.type === 'cancelled') { mine.delete(d.id); waiters.get('cancel:' + d.id)?.ok(d.ok); waiters.delete('cancel:' + d.id); onEvent(d); return }
      if (d.type === 'error') { const w = d.re === 'place' ? waiters.get('place') : d.re === 'rfq_respond' ? waiters.get('rfq') : null; if (w) { w.no(new Error(d.error)); waiters.delete(d.re === 'place' ? 'place' : 'rfq') } onEvent(d); return }
      if (d.type === 'fill_ask') {
        try {
          const tx = Transaction.from(Uint8Array.from(atob(d.tx), (c) => c.charCodeAt(0)))
          const e: Expect = d.expect; const why = verifyFill(tx, { ...e, priceSol: await spot(e.mint).catch(() => e.priceSol) })
          if (why) throw new Error(why)
          const signed = await signTx(tx)
          const raw = signed.serialize(); const sig = await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }); const rb = setInterval(() => conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {}), 2000); try { await confirmByPolling(conn, sig) } finally { clearInterval(rb) }
          send({ type: 'filled_ask', askId: d.askId, sig }); onEvent({ type: 'sold', askId: d.askId, sig, expect: e })
        } catch (err: any) { send({ type: 'reject_ask', askId: d.askId, err: String(err.message || err) }); onEvent({ type: 'fillfail', error: String(err.message || err) }) }
        return
      }
      if (d.type === 'placed_ask') { waiters.get('ask')?.ok(d.ask); waiters.delete('ask'); onEvent(d); return }
      if (d.type === 'cancelled_ask') { waiters.get('cancelask:' + d.id)?.ok(d.ok); waiters.delete('cancelask:' + d.id); onEvent(d); return }
      if (d.type === 'fill') {
        try {
          const tx = Transaction.from(Uint8Array.from(atob(d.tx), (c) => c.charCodeAt(0)))
          const e: Expect = d.expect; const why = verifyFill(tx, { ...e, priceSol: await spot(e.mint).catch(() => e.priceSol) })
          if (why) throw new Error(why)
          const signed = await signTx(tx)
          const raw = signed.serialize(); const sig = await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }); const rb = setInterval(() => conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {}), 2000); try { await confirmByPolling(conn, sig) } finally { clearInterval(rb) }
          send({ type: 'filled', bidId: d.bidId, sig }); onEvent({ type: 'filled', bidId: d.bidId, sig, expect: e })
        } catch (err: any) { send({ type: 'reject', bidId: d.bidId, err: String(err.message || err) }); onEvent({ type: 'fillfail', error: String(err.message || err) }) }
      }
    }
    ws.onclose = () => { clearInterval(hb); authed = false; onEvent({ type: 'disconnected' }); if (!closed) timer = setTimeout(connect, 3000) }
    // phone came back from the background / network returned → reconnect now instead of waiting for the backoff
    const wake = () => { if (!closed && (!ws || ws.readyState > 1) && document.visibilityState === 'visible') { clearTimeout(timer); connect() } }
    document.addEventListener('visibilitychange', wake, { once: true }); addEventListener('online', wake, { once: true })
    ws.onerror = () => ws?.close()
  }
  connect()
  return {
    close: () => { closed = true; clearTimeout(timer); clearInterval(hb); ws?.close() },
    connected: () => authed,
    place: (mint, sol, discBps) => new Promise((ok, no) => { if (!authed) return no(new Error('desk not connected')); waiters.set('place', { ok, no }); send({ type: 'place', mint, sol, discBps }); setTimeout(() => { if (waiters.has('place')) { waiters.delete('place'); no(new Error('timeout')) } }, 15000) }),
    buyBlock: (mint, sol, premiumBps, ttlSec) => new Promise((ok, no) => { if (!authed) return no(new Error('desk not connected')); waiters.set('place', { ok, no }); send({ type: 'buy_rfq', mint, sol, premiumBps, ttlSec }); setTimeout(() => { if (waiters.has('place')) { waiters.delete('place'); no(new Error('timeout')) } }, 15000) }),
    placeAsk: (mint, sol, discBps) => new Promise((ok, no) => { if (!authed) return no(new Error('desk not connected')); waiters.set('ask', { ok, no }); send({ type: 'place_ask', mint, sol, discBps }); setTimeout(() => { if (waiters.has('ask')) { waiters.delete('ask'); no(new Error('timeout')) } }, 15000) }),
    cancelAsk: (id) => new Promise((ok) => { waiters.set('cancelask:' + id, { ok, no: ok }); send({ type: 'cancel_ask', id }); setTimeout(() => ok(false), 8000) }),
    cancel: (id) => new Promise((ok) => { waiters.set('cancel:' + id, { ok, no: ok }); send({ type: 'cancel', id }); setTimeout(() => ok(false), 8000) }),
    respond: (rfqId, discBps, sol) => new Promise((ok, no) => { if (!authed) return no(new Error('desk not connected')); waiters.set('rfq', { ok, no }); send({ type: 'rfq_respond', rfqId, discBps, sol }); setTimeout(() => { if (waiters.has('rfq')) { waiters.delete('rfq'); no(new Error('timeout')) } }, 15000) }),
  }
}

/** Seller side: take a bid in full. Builds the 4-instruction fill, signs, hands to the server which relays to the bidder. */
export async function takeBid(conn: Connection, seller: string, bidId: string, signTx: (t: Transaction) => Promise<Transaction>, onStatus?: (s: string) => void, gate?: (q: any) => Promise<boolean>, opts?: { sol?: number; cuPriceMicro?: number }): Promise<{ sig: string; quote: any }> {
  onStatus?.('Quoting…')
  const q = await j('/quote', { bidId, seller, sol: opts?.sol })
  if (q.refAgeMs > 3000) throw new Error('reference price is stale — try again')
  if (gate && !(await gate(q))) throw new Error('cancelled')
  const sellerPk = new PublicKey(seller), bidderPk = new PublicKey(q.bidder), mint = new PublicKey(q.mint)
  const prog = new PublicKey(q.tokenProgram)
  const bAta = getAssociatedTokenAddressSync(mint, bidderPk, true, prog), sAta = getAssociatedTokenAddressSync(mint, sellerPk, true, prog)
  const tx = new Transaction(); tx.feePayer = sellerPk; tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash
  // priority fee so the fill lands under load (seller pays; a token transfer is ~60K CU)
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 80_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.max(1000, Math.floor(opts?.cuPriceMicro || 50_000)) }))
  tx.add(createAssociatedTokenAccountIdempotentInstruction(sellerPk, bAta, bidderPk, mint, prog), createTransferCheckedInstruction(sAta, mint, bAta, sellerPk, BigInt(q.base), q.decimals, [], prog),
    SystemProgram.transfer({ fromPubkey: bidderPk, toPubkey: sellerPk, lamports: BigInt(q.sellerLamports) }), SystemProgram.transfer({ fromPubkey: bidderPk, toPubkey: new PublicKey(q.treasury), lamports: BigInt(q.fee) }))
  onStatus?.(q.partial ? `Sign to deliver ${S(q.takeSol, 2)} SOL of the block…` : 'Sign to deliver tokens…')
  const signed = await signTx(tx)
  onStatus?.('Waiting for bidder to co-sign…')
  const r = await j('/fill', { bidId, seller, sol: opts?.sol, tx: btoa(String.fromCharCode(...signed.serialize({ requireAllSignatures: false }))) })
  return { sig: r.sig, quote: q }
}
/** Buyer takes a resting sell offer: builds the fill (buyer pays, buyer's ATA), signs, server relays to the seller to co-sign. */
export async function takeAsk(conn: Connection, buyer: string, askId: string, signTx: (t: Transaction) => Promise<Transaction>, onStatus?: (s: string) => void, opts?: { sol?: number; cuPriceMicro?: number }): Promise<{ sig: string; quote: any }> {
  onStatus?.('Quoting…')
  const q = await j('/ask/quote', { askId, buyer, sol: opts?.sol })
  if (q.refAgeMs > 3000) throw new Error('reference price is stale — try again')
  const buyerPk = new PublicKey(buyer), sellerPk = new PublicKey(q.seller), mint = new PublicKey(q.mint), prog = new PublicKey(q.tokenProgram)
  const bAta = getAssociatedTokenAddressSync(mint, buyerPk, true, prog), sAta = getAssociatedTokenAddressSync(mint, sellerPk, true, prog)
  const tx = new Transaction(); tx.feePayer = buyerPk; tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 80_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.max(1000, Math.floor(opts?.cuPriceMicro || 50_000)) }))
  tx.add(createAssociatedTokenAccountIdempotentInstruction(buyerPk, bAta, buyerPk, mint, prog), createTransferCheckedInstruction(sAta, mint, bAta, sellerPk, BigInt(q.base), q.decimals, [], prog),
    SystemProgram.transfer({ fromPubkey: buyerPk, toPubkey: sellerPk, lamports: BigInt(q.sellerLamports) }), SystemProgram.transfer({ fromPubkey: buyerPk, toPubkey: new PublicKey(q.treasury), lamports: BigInt(q.fee) }))
  onStatus?.(q.partial ? `Sign to buy ${S(q.takeSol, 2)} SOL of the offer…` : 'Sign to pay…')
  const signed = await signTx(tx)
  onStatus?.('Waiting for the seller to co-sign…')
  const r = await j('/ask/fill', { askId, buyer, sol: opts?.sol, tx: btoa(String.fromCharCode(...signed.serialize({ requireAllSignatures: false }))) })
  return { sig: r.sig, quote: q }
}
export const myAsks = (me: string): Promise<BookAsk[]> => j('/myasks?me=' + me)
export const signMsgWith = (kp: Keypair) => async (m: Uint8Array) => nacl.sign.detached(m, kp.secretKey)
export const signLegacyWith = (kp: Keypair) => async (t: Transaction) => { t.partialSign(kp); return t }

// ---- vault ----
export type VaultPub = { id: string; pub: string; crowd?: { goalSol: number; raised: number; backers: number; expiresAt: number; refunded: boolean }; mint?: string; symbol?: string; dev: string; stakeSol: number; pct: number; cut: number; armed: boolean; renounced: boolean; avgCost: number; tokens: number; chest: number; devPaid: number; createdAt: number; copyOf?: string; streamed: number; redeemed: number; supply: number; deskBid: number; name?: string; copies: { mint: string; symbol: string; pub: string }[]; imported?: boolean; feePaid?: number; depositedTokens?: number; funders?: Record<string, number>; mode: 'floor' | 'mm'; ceiling: number; floor: number; score: { captured: number; captures: number; deskBought: number; deskFills: number; dipBought: number; dips: number; redeployed: number; floor0: number }; live: { price: number; vwap30: number; stretch: number; captureNow: number; triggerRate: number; buysPerMin: number; tier: string; tranchesFired: number[]; sigma?: number; skew?: number; deskDisc?: number }; activity: { t: number; kind: string; sol?: number; tokens?: number; price?: number; sig?: string; msg?: string }[] }
export const vaultCreate = (dev: string, stakeSol: number, copyOf?: string, mode: 'floor' | 'mm' = 'mm', ceiling = 0.3): Promise<VaultPub> => j('/vault/create', { dev, stakeSol, copyOf, mode, ceiling })
export const vaultSetMode = (id: string, dev: string, mode: 'floor' | 'mm', ceiling?: number): Promise<VaultPub> => j('/vault/mode', { id, dev, mode, ceiling })
export const vaultArm = (id: string, mint: string, symbol: string, name = ''): Promise<VaultPub> => j('/vault/arm', { id, mint, symbol, name })
export const vaultRenounce = (id: string, dev: string): Promise<VaultPub> => j('/vault/renounce', { id, dev })
export const vaultByMint = (mint: string): Promise<VaultPub | null> => j('/vault/mint/' + mint)
export const vaults = (): Promise<VaultPub[]> => j('/vaults')

// ---- history / leaderboard / family / dev / redeem ----
export type FillRec = { t: number; mint: string; symbol: string; seller: string; bidder: string; sol: number; discBps: number; tokens: number; sig: string; vault: boolean }
export const fills = (mint?: string): Promise<FillRec[]> => j('/fills' + (mint ? '?mint=' + mint : ''))
export const leaderboard = (me?: string): Promise<{ wallet: string; soldSol: number; boughtSol: number; fills: number; saved: number; mine?: boolean }[]> => j('/leaderboard' + (me ? '?me=' + me : ''))
export type SwapEvt = { type: 'swap'; mint: string; symbol: string; pool: string; sig: string; slot: number; side: 'buy' | 'sell'; sol: number; trader: string; t: number }
export type Family = { root: string; members: { mint: string; symbol: string; mcapUsd: number; vol1h: number; score: number; original: boolean; vault: boolean; leader?: boolean }[] }
export const family = (mint: string): Promise<Family> => j('/family/' + mint)
export const devVaults = (dev: string): Promise<VaultPub[]> => j('/dev/' + dev)
export const redeemQuote = (mint: string, tokens: number): Promise<{ vaultId: string; vaultPub: string; chest: number; supply: number; share: number; sol: number; lamports: number }> => j('/redeem/quote', { mint, tokens })
/** Burn-to-redeem: holder delivers tokens to the vault, vault pays SOL in the same tx (server co-signs with the vault key). */
export async function redeem(conn: Connection, holder: string, mint: string, tokensUi: number, decimals: number, signTx: (t: Transaction) => Promise<Transaction>, onStatus?: (s: string) => void) {
  onStatus?.('Quoting…'); const q = await redeemQuote(mint, tokensUi)
  const hp = new PublicKey(holder), vp = new PublicKey(q.vaultPub), mp = new PublicKey(mint)
  const prog = await tokenProgram(conn, mint)
  const vAta = getAssociatedTokenAddressSync(mp, vp, true, prog), hAta = getAssociatedTokenAddressSync(mp, hp, true, prog)
  const tx = new Transaction(); tx.feePayer = hp; tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash
  tx.add(createAssociatedTokenAccountIdempotentInstruction(hp, vAta, vp, mp, prog), createTransferCheckedInstruction(hAta, mp, vAta, hp, BigInt(Math.floor(tokensUi * 10 ** decimals)), decimals, [], prog), SystemProgram.transfer({ fromPubkey: vp, toPubkey: hp, lamports: q.lamports }))
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
export type Crowd = { goalSol: number; raised: number; backers: number; expiresAt: number; refunded: boolean }
export const importCrowd = (owner: string, mint: string): Promise<VaultPub & { quote: ImportQuote; crowd?: Crowd }> => j('/import/crowd', { owner, mint })
export const crowdOpen = (): Promise<(VaultPub & { crowd?: Crowd })[]> => j('/import/open')
/** Send SOL to the takeover escrow (the vault wallet) and record it. ≥0.05 SOL. */
export async function contribute(conn: Connection, from: string, v: VaultPub, sol: number, signTx: (t: Transaction) => Promise<Transaction>, onStatus?: (s: string) => void) {
  const fp = new PublicKey(from); const tx = new Transaction(); tx.feePayer = fp; tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash
  tx.add(SystemProgram.transfer({ fromPubkey: fp, toPubkey: new PublicKey(v.pub), lamports: Math.floor(sol * 1e9) }))
  onStatus?.('Sign contribution…'); const signed = await signTx(tx); const sig = await conn.sendRawTransaction(signed.serialize(), { maxRetries: 3 }); onStatus?.('Confirming…'); await confirmByPolling(conn, sig)
  onStatus?.('Recording…'); await new Promise((r) => setTimeout(r, 1500)); return { sig, vault: await j('/import/contribute', { id: v.id, from, sig }) as VaultPub & { crowd?: Crowd } }
}
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
  if (tokensUi > 0) { const mp = new PublicKey(v.mint!); const prog = await tokenProgram(conn, v.mint!); const vAta = getAssociatedTokenAddressSync(mp, vp, true, prog), fAta = getAssociatedTokenAddressSync(mp, fp, true, prog); tx.add(createAssociatedTokenAccountIdempotentInstruction(fp, vAta, vp, mp, prog), createTransferCheckedInstruction(fAta, mp, vAta, fp, BigInt(Math.floor(tokensUi * 10 ** decimals)), decimals, [], prog)) }
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

/** In-page bus: 'book' events (detail = mint) whenever the server says a book changed. */
export const bookBus = new EventTarget()
/** Read-only firehose of vault-pool swaps + book-change notes (no auth). */
export function openSwapFeed(onSwap: (s: SwapEvt) => void) {
  let ws: WebSocket | null = null, closed = false, timer: any
  const connect = async () => { await ready; if (closed) return; ws = new WebSocket(WS()); ws.onmessage = (m) => { try { const d = JSON.parse(m.data); if (d.type === 'swap') onSwap(d); else if (d.type === 'book') bookBus.dispatchEvent(new CustomEvent('book', { detail: d.mint })) } catch {} }; ws.onclose = () => { if (!closed) timer = setTimeout(connect, 3000) }; ws.onerror = () => ws?.close() }
  connect(); return () => { closed = true; clearTimeout(timer); ws?.close() }
}
