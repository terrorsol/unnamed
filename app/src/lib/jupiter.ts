// Jupiter swap (lite API: free, no key). Docs: https://dev.jup.ag/docs/swap-api
import { VersionedTransaction } from '@solana/web3.js'
const BASE = 'https://lite-api.jup.ag/swap/v1'
export type Quote = { inAmount: string; outAmount: string; priceImpactPct: string; routePlan: any[]; otherAmountThreshold: string; [k: string]: any }
export async function quote(inputMint: string, outputMint: string, amount: number | bigint, slippageBps: number): Promise<Quote> {
  const u = `${BASE}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`
  const r = await fetch(u); if (!r.ok) throw new Error('jupiter quote: ' + (await r.text().catch(() => r.status))); return r.json()
}
export async function buildSwap(q: Quote, userPublicKey: string, priorityFeeLamports: number): Promise<VersionedTransaction> {
  const r = await fetch(`${BASE}/swap`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quoteResponse: q, userPublicKey, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, dynamicSlippage: false, prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: Math.max(1000, priorityFeeLamports), priorityLevel: 'high' } } }) })
  if (!r.ok) throw new Error('jupiter swap: ' + (await r.text().catch(() => r.status)))
  const d = await r.json()
  return VersionedTransaction.deserialize(Buffer.from(d.swapTransaction, 'base64'))
}
