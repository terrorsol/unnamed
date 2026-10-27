import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js'
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
export async function pumpTrade(kp: Keypair, action: 'buy' | 'sell', mint: string, amount: number | string, denominatedInSol: boolean, slippage = 10, priorityFee = 0.0005) {
  const r = await fetch('https://pumpportal.fun/api/trade-local', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey: kp.publicKey.toBase58(), action, mint, amount, denominatedInSol: denominatedInSol ? 'true' : 'false', slippage, priorityFee, pool: 'auto' }) })
  if (!r.ok) throw new Error('pumpportal ' + r.status + ' ' + (await r.text().catch(() => '')))
  const tx = VersionedTransaction.deserialize(new Uint8Array(await r.arrayBuffer())); tx.sign([kp])
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 }); await confirm(sig); return sig
}
