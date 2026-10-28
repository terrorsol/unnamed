import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { addTip, sendFast, MIN_TIP_LAMPORTS } from './fast.ts'
export const RPC = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com'
export const conn = new Connection(RPC, 'confirmed')
export const TREASURY = process.env.TREASURY || '11111111111111111111111111111111'
export async function balanceSol(pk: string) { return (await conn.getBalance(new PublicKey(pk))) / 1e9 }
export async function confirm(sig: string, timeoutMs = 60000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const st = (await conn.getSignatureStatuses([sig]).catch(() => null))?.value?.[0]
    if (st) { if (st.err) throw new Error('tx failed: ' + JSON.stringify(st.err)); if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return }
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
export async function tokenBalance(owner: string, mint: string) {
  const r = await conn.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) })
  const a = r.value[0]; return a ? { ui: +(a.account.data as any).parsed.info.tokenAmount.uiAmount, raw: BigInt((a.account.data as any).parsed.info.tokenAmount.amount) } : { ui: 0, raw: 0n }
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
  const q: any = await (await fetch(`${JUP()}/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${raw}&slippageBps=${Math.round(slippageBps)}&restrictIntermediateTokens=true`, { headers: h })).json()
  if (q.error || !q.outAmount) throw new Error('jupiter quote: ' + (q.error || 'no route'))
  const sw: any = await (await fetch(`${JUP()}/swap`, { method: 'POST', headers: h, body: JSON.stringify({ quoteResponse: q, userPublicKey: owner.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 1_000_000, priorityLevel: 'high' } } }) })).json()
  if (sw.error || !sw.swapTransaction) throw new Error('jupiter swap: ' + (sw.error || 'no tx'))
  return VersionedTransaction.deserialize(Buffer.from(sw.swapTransaction, 'base64'))
}
/** pump.fun / PumpSwap / Raydium trade signed by a server-held keypair (vault). PumpPortal builds; a failed dry-run falls back to Jupiter. */
export async function pumpTrade(kp: Keypair, action: 'buy' | 'sell', mint: string, amount: number | string, denominatedInSol: boolean, slippage = 10, priorityFee = +(process.env.VAULT_PRIORITY_SOL || 0.001), signer?: (tx: VersionedTransaction) => VersionedTransaction) {
  const args = { publicKey: kp.publicKey.toBase58(), action, mint, amount, denominatedInSol: denominatedInSol ? 'true' : 'false', slippage, priorityFee, pool: 'auto' }
  const url = (process.env.PUMPPORTAL_URL || 'https://pumpportal.fun/api') + '/trade-local'
  const jito = process.env.JITO === '1'
  // Jito mode: PumpPortal's array body builds bundle-ready txs — the first tx's priorityFee becomes the Jito tip. Response is base58 strings.
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(jito ? [args] : args) })
  if (!r.ok) throw new Error('pumpportal ' + r.status + ' ' + (await r.text().catch(() => '')))
  let tx = jito ? VersionedTransaction.deserialize(bs58.decode((await r.json())[0])) : VersionedTransaction.deserialize(new Uint8Array(await r.arrayBuffer()))
  // dry-run before spending a fee: mayhem/Token-2022 curve coins have failed PumpPortal's builder in preflight (pump error 6063). On a sim error, rebuild through Jupiter.
  if (process.env.TRADE_SIM !== '0') {
    const simErr = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true }).then((x) => x?.value?.err ?? null, () => null)
    if (simErr) { lastRoute = 'jupiter'; tx = await jupBuild(kp.publicKey, action, mint, amount, denominatedInSol, slippage * 100) } else lastRoute = 'pumpportal'
  }
  return signSend(kp, tx, signer, jito)
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
  try { await confirm(sig); return sig } finally { clearInterval(rb) }
}
/** LaunchLab trade for a server-held key: built by the official SDK (no PumpPortal, no 0.5%), Jupiter if the build fails the dry-run. */
export async function llTrade(kp: Keypair, action: 'buy' | 'sell', mint: string, amount: number | string, slippageBps = 1000, signer?: (tx: VersionedTransaction) => VersionedTransaction) {
  const L = await import('./launchlab.ts')
  let tx = action === 'buy' ? await L.buildTrade(kp.publicKey, 'buy', mint, amount, { slippageBps }) : await L.sellPct(kp.publicKey, mint, typeof amount === 'string' ? parseFloat(amount) : +amount, slippageBps)
  if (process.env.TRADE_SIM !== '0') {
    const simErr = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true }).then((x) => x?.value?.err ?? null, () => null)
    if (simErr) { lastRoute = 'jupiter'; tx = await jupBuild(kp.publicKey, action, mint, amount, action === 'buy', slippageBps) } else lastRoute = 'launchlab'
  }
  return signSend(kp, tx, signer)
}
/** Helius Sender when the RPC is Helius (or FAST=1): tip + CU price, dual-routed. FAST=0 forces plain RPC. */
export const FAST = process.env.FAST ? process.env.FAST === '1' : /helius/.test(RPC)
export const TIP_LAMPORTS = Math.max(MIN_TIP_LAMPORTS, Math.floor(+(process.env.TIP_SOL || 0.001) * 1e9))
/** Jito bundle: ≤5 signed txs, base64 (Jito: base58 is "slow, DEPRECATED"; default is still base58 so the encoding option is explicit). Helius RPC proxies sendBundle (5 rps) so it is the default when the RPC is Helius. */
export async function sendBundle(raws: Uint8Array[]): Promise<string> {
  if (raws.length > 5) throw new Error('bundle > 5 txs')
  // helius proxies sendBundle only on paid plans ("Method not available on your current plan"); jito's public block engine takes bundles from anyone (tip tx required, rate-limited)
  const urls = [process.env.JITO_URL, /helius/.test(RPC) ? RPC : null, 'https://mainnet.block-engine.jito.wtf/api/v1/bundles', 'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles'].filter((x): x is string => !!x)
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendBundle', params: [raws.map((x) => Buffer.from(x).toString('base64')), { encoding: 'base64' }] })
  let last = ''
  for (const u of urls) {
    try { const b = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body }); const d: any = await b.json().catch(() => ({ error: { message: 'http ' + b.status } }))
      if (d.error) { last = JSON.stringify(d.error); if (/plan|not available|unauthorized|forbidden/i.test(last)) continue; throw new Error('jito: ' + last) }
      return d.result as string } catch (e: any) { last = String(e.message || e); if (!/plan|not available|fetch failed|http 4/i.test(last)) throw e }
  }
  throw new Error('jito: ' + last)
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
