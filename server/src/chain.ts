import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { addTip, sendFast, MIN_TIP_LAMPORTS } from './fast.ts'
import * as G from './txguard.ts'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import * as EV from './events.ts'
export const RPC = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com'
export const conn = new Connection(RPC, 'confirmed')
export const TREASURY = process.env.TREASURY || '11111111111111111111111111111111'
export async function balanceSol(pk: string) { return (await conn.getBalance(new PublicKey(pk))) / 1e9 }
export async function confirm(sig: string, timeoutMs = 60000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const st = (await conn.getSignatureStatuses([sig]).catch(() => null))?.value?.[0]
    // landed with an error: marked, so the caller books the fee and re-reads balances at once instead of treating it as still in flight
    if (st) { if (st.err) { const e: any = new Error('tx failed: ' + JSON.stringify(st.err)); e.landedErr = true; throw e } if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('confirm timeout ' + sig)
}
export async function decimals(mint: string) { return (await conn.getTokenSupply(new PublicKey(mint))).value.decimals }
const progCache = new Map<string, string>()
/** Owner program of the mint account: classic SPL Token or Token-2022 (newer pump.fun create_v2 coins). Never guess from the address. */
export async function tokenProgram(mint: string): Promise<string> {
  const c = progCache.get(mint); if (c) return c
  const info = await conn.getAccountInfo(new PublicKey(mint)); if (!info) throw new Error('mint not found')
  const o = info.owner.toBase58(); progCache.set(mint, o); return o
}
/** every token account `owner` holds for `mint`, summed (review: anyone can open a second, empty account for the vault — reading only the
 *  first one let that zero the vault's balance and freeze its exits) */
export async function tokenBalance(owner: string, mint: string) {
  const r = await conn.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) })
  let raw = 0n, dec = 0; for (const a of r.value) { const t = (a.account.data as any)?.parsed?.info?.tokenAmount; if (!t) continue; raw += BigInt(t.amount); dec = +t.decimals || dec }
  return { ui: dec ? Number(raw) / 10 ** dec : r.value.reduce((s, a) => s + (+(a.account.data as any)?.parsed?.info?.tokenAmount?.uiAmount || 0), 0), raw }
}
export let lastRoute: 'pumpportal' | 'jupiter' | 'launchlab' = 'pumpportal'
const WSOL = 'So11111111111111111111111111111111111111112'
const JUP = () => process.env.JUP_URL || 'https://api.jup.ag/swap/v1'
/** Jupiter swap tx for a vault wallet (routes pump curve, PumpSwap, Raydium, Meteora — including Token-2022 / mayhem coins). `amount` like PumpPortal's: SOL for buys, token ui amount or 'NN%' for sells. */
export async function jupBuild(owner: PublicKey, action: 'buy' | 'sell', mint: string, amount: number | string, denominatedInSol: boolean, slippageBps: number): Promise<VersionedTransaction> {
  const h: Record<string, string> = { 'content-type': 'application/json' }; if (process.env.JUP_KEY) h['x-api-key'] = process.env.JUP_KEY
  let inMint = WSOL, outMint = mint, raw: bigint
  if (action === 'buy') { if (!denominatedInSol) throw new Error('jupiter buy needs a SOL amount'); raw = BigInt(Math.floor(+amount * 1e9)) }
  else {
    inMint = mint; outMint = WSOL; const bal = await tokenBalance(owner.toBase58(), mint)
    if (typeof amount === 'string' && amount.endsWith('%')) raw = bal.raw * BigInt(Math.round(parseFloat(amount) * 100)) / 10000n
    else { const dec = (await conn.getTokenSupply(new PublicKey(mint))).value.decimals; raw = BigInt(Math.floor(+amount * 10 ** dec)) }
    if (raw > bal.raw) raw = bal.raw; if (raw <= 0n) throw new Error('nothing to sell')
  }
  const q: any = await (await fetch(`${JUP()}/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${raw}&slippageBps=${Math.round(slippageBps)}&restrictIntermediateTokens=true`, { headers: h, signal: AbortSignal.timeout(15000) })).json()
  if (q.error || !q.outAmount) throw new Error('jupiter quote: ' + (q.error || 'no route'))
  const sw: any = await (await fetch(`${JUP()}/swap`, { method: 'POST', headers: h, body: JSON.stringify({ quoteResponse: q, userPublicKey: owner.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 1_000_000, priorityLevel: 'high' } } }), signal: AbortSignal.timeout(15000) })).json()
  if (sw.error || !sw.swapTransaction) throw new Error('jupiter swap: ' + (sw.error || 'no tx'))
  return VersionedTransaction.deserialize(Buffer.from(sw.swapTransaction, 'base64'))
}
/** The guard's bound for one vault trade (see txguard.ts). A sell reads the coin balance first: the tx may take at most the share asked for. */
/** the coin's ATA for `owner` and what it holds now: a guarded buy must leave more in it than this */
export async function buyWatch(owner: PublicKey, mint: string): Promise<{ coinAta: string; preTokRaw: bigint }> {
  const prog = new PublicKey(await tokenProgram(mint)); const ata = getAssociatedTokenAddressSync(new PublicKey(mint), owner, true, prog)
  const info = await conn.getAccountInfo(ata); return { coinAta: ata.toBase58(), preTokRaw: info && info.data.length >= 72 ? info.data.readBigUInt64LE(64) : 0n }
}
export async function tradeLimits(owner: PublicKey, action: 'buy' | 'sell', mint: string, amount: number | string, denominatedInSol: boolean, slippageBps: number, expectSol?: number): Promise<G.GuardLimits> {
  if (action === 'buy') { if (!denominatedInSol) throw new Error('vault buys are sized in SOL'); const w = await buyWatch(owner, mint).catch(() => null); if (!w) throw new G.GuardError('tx guard: could not read the coin account — not signing blind', 'unavailable'); return { ...G.limitsFor('buy', mint, amount, { slippageBps }), ...w } }
  const bal = await tokenBalance(owner.toBase58(), mint).catch(() => null); if (!bal) throw new G.GuardError('tx guard: could not read the coin balance — not signing blind', 'unavailable')
  const pct = typeof amount === 'string' && amount.trim().endsWith('%'); const dec = pct ? undefined : await decimals(mint)
  return G.limitsFor('sell', mint, amount, { slippageBps, expectSol, balanceRaw: bal.raw, decimals: dec })
}
/** Guard a built trade; a route the chain rejects (or a refused build) is rebuilt through Jupiter and guarded again. Returns the tx to sign. */
async function guardOrJupiter(tx: VersionedTransaction, route: 'pumpportal' | 'launchlab', kp: Keypair, lim: G.GuardLimits, rebuild: () => Promise<VersionedTransaction>): Promise<{ tx: VersionedTransaction; route: 'pumpportal' | 'launchlab' | 'jupiter' }> {
  const cap = BigInt(Math.max(0, Math.floor((lim.maxSolOut - 0.015) * 1e9)))
  try { G.capBuyCeilings(tx, cap); await G.guardTx(conn, tx, kp.publicKey, lim); lastRoute = route; return { tx, route } }
  catch (e: any) {
    if (!(e instanceof G.GuardError) || e.kind === 'unavailable') throw e
    if (e.kind === 'refused') EV.log('guard', `${route} ${lim.side} ${lim.mint.slice(0, 6)}… refused: ${e.message}`, { route, side: lim.side, mint: lim.mint, vault: kp.publicKey.toBase58() })
    lastRoute = 'jupiter'; const jt = await rebuild(); G.capBuyCeilings(jt, cap); await G.guardTx(conn, jt, kp.publicKey, lim).catch((e2: any) => { if (e2 instanceof G.GuardError && e2.kind === 'refused') EV.log('guard', `jupiter ${lim.side} ${lim.mint.slice(0, 6)}… refused: ${e2.message}`, { route: 'jupiter', side: lim.side, mint: lim.mint }); throw e2 })
    return { tx: jt, route: 'jupiter' }
  }
}
/** pump.fun / PumpSwap / Raydium trade signed by a server-held keypair (vault). PumpPortal builds; the tx guard simulates it and checks every
 *  SOL/token movement before the key signs; a route the chain rejects falls back to Jupiter (guarded the same way). `expectSol` = what a sell
 *  should bring (bounds the fees it may pay). */
export async function pumpTrade(kp: Keypair, action: 'buy' | 'sell', mint: string, amount: number | string, denominatedInSol: boolean, slippage = 10, priorityFee = +(process.env.VAULT_PRIORITY_SOL || 0.001), signer?: (tx: VersionedTransaction) => VersionedTransaction, opts: { expectSol?: number } = {}) {
  const args = { publicKey: kp.publicKey.toBase58(), action, mint, amount, denominatedInSol: denominatedInSol ? 'true' : 'false', slippage, priorityFee, pool: 'auto' }
  const url = (process.env.PUMPPORTAL_URL || 'https://pumpportal.fun/api') + '/trade-local'
  const jito = process.env.JITO === '1'
  const guardOn = process.env.TX_GUARD !== '0'
  const jup = () => jupBuild(kp.publicKey, action, mint, amount, denominatedInSol, slippage * 100)
  // the guard's bound (a sell reads the balance) is fetched while PumpPortal builds, so the guard adds one simulation and nothing else
  const limP = guardOn ? tradeLimits(kp.publicKey, action, mint, amount, denominatedInSol, slippage * 100, opts.expectSol) : Promise.resolve(null)
  limP.catch(() => {})
  // Jito mode: PumpPortal's array body builds bundle-ready txs — the first tx's priorityFee becomes the Jito tip. Response is base58 strings.
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(jito ? [args] : args), signal: AbortSignal.timeout(15000) }).catch(() => null)
  const lim = await limP
  // PumpPortal refusing to build (HTTP 4xx/5xx, unreachable) is the same case as a failed dry-run: build the trade through Jupiter instead
  if (!r || !r.ok) { lastRoute = 'jupiter'; const jt = await jup(); if (lim) await G.guardTx(conn, jt, kp.publicKey, lim); return signSend(kp, jt, signer, false) }
  let tx = jito ? VersionedTransaction.deserialize(bs58.decode((await r.json())[0])) : VersionedTransaction.deserialize(new Uint8Array(await r.arrayBuffer()))
  let route: string = 'pumpportal'
  if (lim) ({ tx, route } = await guardOrJupiter(tx, 'pumpportal', kp, lim, jup))
  // guard off (TX_GUARD=0): the old dry-run — mayhem/Token-2022 curve coins have failed PumpPortal's builder in preflight (pump error 6063). On a sim error, rebuild through Jupiter.
  else if (process.env.TRADE_SIM !== '0') {
    const simErr = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true }).then((x) => x?.value?.err ?? null, () => null)
    if (simErr) { lastRoute = route = 'jupiter'; tx = await jup() } else lastRoute = 'pumpportal'
  }
  return signSend(kp, tx, signer, jito && route === 'pumpportal')
}
/** tip (Sender) → sign → send fast with rebroadcast → confirm. Shared by every venue. */
export async function signSend(kp: Keypair, tx: VersionedTransaction, signer?: (tx: VersionedTransaction) => VersionedTransaction, jito = process.env.JITO === '1') {
  if (!jito && FAST) tx = await addTip(conn, tx, kp.publicKey, TIP_LAMPORTS).catch(() => tx)
  if (signer) tx = signer(tx); else tx.sign([kp])
  const raw = tx.serialize(); const sig = bs58.encode(tx.signatures[0])
  if (jito) {
    try { await sendBundle([raw]) } catch { await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }) }
  } else if (FAST) await sendFast(conn, raw, RPC)
  else await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 })
  const rb = setInterval(() => conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {}), 2000)
  try { await confirm(sig); return sig } catch (e: any) { e.sig = sig; throw e } finally { clearInterval(rb) }   // the signature rides on the error: a tx that lands after the timeout can still be booked
}
/** LaunchLab trade for a server-held key: built by the official SDK (no PumpPortal, no 0.5%), guarded like every vault trade; Jupiter if the chain rejects it. */
export async function llTrade(kp: Keypair, action: 'buy' | 'sell', mint: string, amount: number | string, slippageBps = 1000, signer?: (tx: VersionedTransaction) => VersionedTransaction, opts: { expectSol?: number } = {}) {
  const L = await import('./launchlab.ts')
  const lim = process.env.TX_GUARD !== '0' ? await tradeLimits(kp.publicKey, action, mint, amount, action === 'buy', slippageBps, opts.expectSol) : null
  const jup = () => jupBuild(kp.publicKey, action, mint, amount, action === 'buy', slippageBps)
  let tx = action === 'buy' ? await L.buildTrade(kp.publicKey, 'buy', mint, amount, { slippageBps }) : await L.sellPct(kp.publicKey, mint, typeof amount === 'string' ? parseFloat(amount) : +amount, slippageBps)
  if (lim) tx = (await guardOrJupiter(tx, 'launchlab', kp, lim, jup)).tx
  else if (process.env.TRADE_SIM !== '0') {
    const simErr = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true }).then((x) => x?.value?.err ?? null, () => null)
    if (simErr) { lastRoute = 'jupiter'; tx = await jup() } else lastRoute = 'launchlab'
  }
  return signSend(kp, tx, signer)
}
/** Helius Sender when the RPC is Helius (or FAST=1): tip + CU price, dual-routed. FAST=0 forces plain RPC. */
export const FAST = process.env.FAST ? process.env.FAST === '1' : /helius/.test(RPC)
export const TIP_LAMPORTS = Math.max(MIN_TIP_LAMPORTS, Math.floor(+(process.env.TIP_SOL || 0.001) * 1e9))
/** Jito bundle: ≤5 signed txs, base64 (Jito: base58 is "slow, DEPRECATED"; default is still base58 so the encoding option is explicit). Helius RPC proxies sendBundle (5 rps) so it is the default when the RPC is Helius. */
const bundleAt = new Map<string, string>()   // bundle id → the block-engine URL that accepted it
/** Jito's own view of a bundle we sent: Landed | Pending | Failed | Invalid (null when the engine does not know it) */
export async function bundleStatus(id: string): Promise<{ status: string; slot?: number } | null> {
  const u = bundleAt.get(id); if (!u || !/jito/.test(u)) return null
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getInflightBundleStatuses', params: [[id]] })
  for (const url of [u.replace(/\/bundles$/, '/getInflightBundleStatuses'), u]) {   // the docs list both paths; whichever answers
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).catch(() => null)
    const d: any = r ? await r.json().catch(() => null) : null; const v = d?.result?.value?.[0]; if (v) return { status: String(v.status), slot: v.landed_slot ?? undefined }
  }
  return null
}
export async function sendBundle(raws: Uint8Array[]): Promise<string> {
  if (raws.length > 5) throw new Error('bundle > 5 txs')
  // helius proxies sendBundle only on paid plans ("Method not available on your current plan"); jito's public block engine takes bundles from anyone (tip tx required, rate-limited)
  // every Jito region: a block engine that is a few slots behind answers 'expired blockhash' for a fresh one — the next region usually takes it
  const urls = [process.env.JITO_URL, /helius/.test(RPC) ? RPC : null, ...['mainnet', 'ny.mainnet', 'slc.mainnet', 'amsterdam.mainnet', 'frankfurt.mainnet', 'london.mainnet', 'tokyo.mainnet'].map((r) => `https://${r}.block-engine.jito.wtf/api/v1/bundles`)].filter((x): x is string => !!x)
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendBundle', params: [raws.map((x) => Buffer.from(x).toString('base64')), { encoding: 'base64' }] })
  let last = ''
  for (const u of urls) {
    try { const b = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body }); const d: any = await b.json().catch(() => ({ error: { message: 'http ' + b.status } }))
      if (d.error) { last = JSON.stringify(d.error); if (/plan|not available|unauthorized|forbidden|expired|blockhash|rate|limit|congest/i.test(last)) continue; throw new Error('jito: ' + last) }
      if (d.result) { bundleAt.set(String(d.result), u)
        // the same bundle to every other region as well (fire-and-forget): the slot leader may sit behind any of them, and a bundle can only land once
        if (process.env.JITO_FANOUT !== '0') for (const o of urls) if (o !== u && !/helius/.test(o)) fetch(o, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).catch(() => {}) }
      return d.result as string } catch (e: any) { last = String(e.message || e); if (!/plan|not available|fetch failed|http 4|http 5/i.test(last)) throw e }
  }
  // say whether OUR node still thinks the blockhash is valid: tells a slow signer (really expired) from a block engine that disagrees
  let why = ''; try { const tx = VersionedTransaction.deserialize(raws[0]); const ok = (await conn.isBlockhashValid(tx.message.recentBlockhash, { commitment: 'processed' })).value; why = ` · our node says the create's blockhash is ${ok ? 'STILL VALID' : 'expired'}` } catch {}
  throw new Error('jito: ' + last + why)
}

/** Holder concentration + authorities straight from chain (used for signals on vaulted coins) */
export async function holderStats(mint: string, vaultPub?: string) {
  const mp = new PublicKey(mint)
  const [info, largest, supply] = await Promise.all([conn.getParsedAccountInfo(mp), conn.getTokenLargestAccounts(mp), conn.getTokenSupply(mp)])
  const parsed = (info.value?.data as any)?.parsed?.info || {}; const total = +(supply.value.uiAmount || 0) || 1
  const accs = largest.value.slice(0, 10)
  const owners = await conn.getMultipleParsedAccounts(accs.map((a) => a.address)).then((r) => r.value.map((v) => (v?.data as any)?.parsed?.info?.owner || '')).catch(() => accs.map(() => ''))
  const holders = accs.map((a, i) => ({ address: owners[i] || a.address.toBase58(), pct: (+(a.uiAmount || 0) / total) * 100 }))
  const ex = holders.filter((h) => h.address !== vaultPub)
  return { mintAuthority: !!parsed.mintAuthority, freezeAuthority: !!parsed.freezeAuthority, top1Pct: ex[0]?.pct || 0, top10Pct: holders.reduce((s, h) => s + h.pct, 0), vaultPct: holders.find((h) => h.address === vaultPub)?.pct || 0, t: Date.now() }
}
