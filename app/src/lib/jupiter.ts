// Jupiter swap. api.jup.ag is the current gateway (keyless 0.5 rps, free key 1 rps via x-api-key); lite-api.jup.ag is being
// phased out and only used as a fallback. Docs: https://dev.jup.ag/docs/swap/build-swap-transaction
import { VersionedTransaction } from '@solana/web3.js'
const BASES = ['https://api.jup.ag/swap/v1', 'https://lite-api.jup.ag/swap/v1']
const key = () => { try { return localStorage.getItem('unnamed_jup_key') || (import.meta as any).env?.VITE_JUP_KEY || '' } catch { return '' } }
const hdr = (json = false) => { const h: Record<string, string> = {}; if (json) h['Content-Type'] = 'application/json'; const k = key(); if (k) h['x-api-key'] = k; return h }
/** Try the gateway, fall back to lite-api on 429/5xx/network. */
async function jf(path: string, init?: RequestInit): Promise<Response> {
  let last: any
  for (const b of BASES) { try { const r = await fetch(b + path, { ...init, headers: { ...(init?.headers as any), ...hdr(!!init?.body) } }); if (r.ok || (r.status !== 429 && r.status < 500)) return r; last = new Error('jupiter ' + r.status + ' ' + (await r.text().catch(() => ''))) } catch (e) { last = e } }
  throw last
}
export type Quote = { inAmount: string; outAmount: string; priceImpactPct: string; routePlan: any[]; otherAmountThreshold: string; [k: string]: any }
export async function quote(inputMint: string, outputMint: string, amount: number | bigint, slippageBps: number): Promise<Quote> {
  const r = await jf(`/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`)
  if (!r.ok) throw new Error('jupiter quote: ' + (await r.text().catch(() => r.status))); return r.json()
}
export async function buildSwap(q: Quote, userPublicKey: string, priorityFeeLamports: number, jitoTipLamports = 0): Promise<VersionedTransaction> {
  const prio = jitoTipLamports > 0 ? { jitoTipLamports } : { priorityLevelWithMaxLamports: { maxLamports: Math.max(1000, priorityFeeLamports), priorityLevel: 'high' } }
  const r = await jf('/swap', { method: 'POST',
    body: JSON.stringify({ quoteResponse: q, userPublicKey, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, dynamicSlippage: false, prioritizationFeeLamports: prio }) })
  if (!r.ok) throw new Error('jupiter swap: ' + (await r.text().catch(() => r.status)))
  const d = await r.json()
  return VersionedTransaction.deserialize(Buffer.from(d.swapTransaction, 'base64'))
}
