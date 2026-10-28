import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
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
export async function tokenBalance(owner: string, mint: string) {
  const r = await conn.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) })
  const a = r.value[0]; return a ? { ui: +(a.account.data as any).parsed.info.tokenAmount.uiAmount, raw: BigInt((a.account.data as any).parsed.info.tokenAmount.amount) } : { ui: 0, raw: 0n }
}
/** pump.fun / PumpSwap / Raydium trade signed by a server-held keypair (vault) */
export async function pumpTrade(kp: Keypair, action: 'buy' | 'sell', mint: string, amount: number | string, denominatedInSol: boolean, slippage = 10, priorityFee = +(process.env.VAULT_PRIORITY_SOL || 0.001)) {
  const r = await fetch((process.env.PUMPPORTAL_URL || 'https://pumpportal.fun/api') + '/trade-local', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey: kp.publicKey.toBase58(), action, mint, amount, denominatedInSol: denominatedInSol ? 'true' : 'false', slippage, priorityFee, pool: 'auto' }) })
  if (!r.ok) throw new Error('pumpportal ' + r.status + ' ' + (await r.text().catch(() => '')))
  const tx = VersionedTransaction.deserialize(new Uint8Array(await r.arrayBuffer())); tx.sign([kp])
  const raw = tx.serialize(); const sig = bs58.encode(tx.signatures[0])
  if (process.env.JITO === '1') {
    // land it as a single-tx bundle with the priorityFee acting as the Jito tip (PumpPortal convention); fall back to RPC if the block engine refuses
    try { const b = await fetch(process.env.JITO_URL || 'https://mainnet.block-engine.jito.wtf/api/v1/bundles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendBundle', params: [[bs58.encode(raw)]] }) }); const d = await b.json(); if (d.error) throw new Error(JSON.stringify(d.error)) }
    catch { await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }) }
  } else await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 })
  const rb = setInterval(() => conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {}), 2000)
  try { await confirm(sig); return sig } finally { clearInterval(rb) }
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
