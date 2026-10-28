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
/** pump.fun / PumpSwap / Raydium trade signed by a server-held keypair (vault) */
export async function pumpTrade(kp: Keypair, action: 'buy' | 'sell', mint: string, amount: number | string, denominatedInSol: boolean, slippage = 10, priorityFee = +(process.env.VAULT_PRIORITY_SOL || 0.001), signer?: (tx: VersionedTransaction) => VersionedTransaction) {
  const args = { publicKey: kp.publicKey.toBase58(), action, mint, amount, denominatedInSol: denominatedInSol ? 'true' : 'false', slippage, priorityFee, pool: 'auto' }
  const url = (process.env.PUMPPORTAL_URL || 'https://pumpportal.fun/api') + '/trade-local'
  const jito = process.env.JITO === '1'
  // Jito mode: PumpPortal's array body builds bundle-ready txs — the first tx's priorityFee becomes the Jito tip. Response is base58 strings.
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(jito ? [args] : args) })
  if (!r.ok) throw new Error('pumpportal ' + r.status + ' ' + (await r.text().catch(() => '')))
  let tx = jito ? VersionedTransaction.deserialize(bs58.decode((await r.json())[0])) : VersionedTransaction.deserialize(new Uint8Array(await r.arrayBuffer()))
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
/** Helius Sender when the RPC is Helius (or FAST=1): tip + CU price, dual-routed. FAST=0 forces plain RPC. */
export const FAST = process.env.FAST ? process.env.FAST === '1' : /helius/.test(RPC)
export const TIP_LAMPORTS = Math.max(MIN_TIP_LAMPORTS, Math.floor(+(process.env.TIP_SOL || 0.001) * 1e9))
/** Jito bundle: ≤5 signed txs, base64 (Jito: base58 is "slow, DEPRECATED"; default is still base58 so the encoding option is explicit). Helius RPC proxies sendBundle (5 rps) so it is the default when the RPC is Helius. */
export async function sendBundle(raws: Uint8Array[]): Promise<string> {
  if (raws.length > 5) throw new Error('bundle > 5 txs')
  const u = process.env.JITO_URL || (/helius/.test(RPC) ? RPC : 'https://mainnet.block-engine.jito.wtf/api/v1/bundles')
  const b = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendBundle', params: [raws.map((x) => Buffer.from(x).toString('base64')), { encoding: 'base64' }] }) })
  const d: any = await b.json(); if (d.error) throw new Error('jito: ' + JSON.stringify(d.error)); return d.result as string
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
