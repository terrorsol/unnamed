// PumpPortal: public tx-builder for pump.fun (create / buy / sell) + live data websocket. Docs: https://pumpportal.fun/
// Local Transaction API = no key, user signs everything, 0.5% fee on trades. We never hold keys.
import { VersionedTransaction, Keypair } from '@solana/web3.js'
import bs58 from 'bs58'

export type NewToken = { mint: string; name: string; symbol: string; uri?: string; image?: string; creator?: string; ts: number; solAmount?: number; mcapSol?: number; pool?: string }
export type TradeEvt = { mint: string; txType: 'buy' | 'sell'; sol: number; tokens: number; trader: string; mcapSol: number; ts: number }

// Since May 2026 subscribeTokenTrade/subscribeAccountTrade need a PumpPortal api key + funded wallet (metered); subscribeNewToken is free.
// Without a key we only stream new tokens; per-coin trades come from our server's swap feed instead.
const ppKey = () => { try { return localStorage.getItem('unnamed_pp_key') || (import.meta as any).env?.VITE_PP_KEY || '' } catch { return '' } }
export function openStream(onNew: (t: NewToken) => void, onTrade?: (t: TradeEvt) => void, mints: string[] = []) {
  let ws: WebSocket | null = null, closed = false, timer: any
  const canTrades = () => !!ppKey()
  const connect = () => {
    ws = new WebSocket('wss://pumpportal.fun/api/data' + (ppKey() ? '?api-key=' + ppKey() : ''))
    ws.onopen = () => { ws!.send(JSON.stringify({ method: 'subscribeNewToken' })); if (mints.length && canTrades()) ws!.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: mints })) }
    ws.onmessage = (m) => {
      try {
        const d = JSON.parse(m.data)
        if (d.txType === 'create') onNew({ mint: d.mint, name: d.name, symbol: d.symbol, uri: d.uri, creator: d.traderPublicKey, ts: Date.now(), solAmount: d.solAmount, mcapSol: d.marketCapSol, pool: d.pool })
        else if ((d.txType === 'buy' || d.txType === 'sell') && onTrade) onTrade({ mint: d.mint, txType: d.txType, sol: d.solAmount, tokens: d.tokenAmount, trader: d.traderPublicKey, mcapSol: d.marketCapSol, ts: Date.now() })
      } catch {}
    }
    ws.onclose = () => { if (!closed) timer = setTimeout(connect, 2000) }
    ws.onerror = () => ws?.close()
  }
  connect()
  return { close: () => { closed = true; clearTimeout(timer); ws?.close() }, subscribe: (ms: string[]) => { if (ws?.readyState === 1 && ms.length && canTrades()) ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: ms })) } }
}

type TradeArgs = { publicKey: string; action: 'buy' | 'sell'; mint: string; amount: number | string; denominatedInSol: boolean; slippage: number; priorityFee: number; pool?: 'pump' | 'raydium' | 'pump-amm' | 'auto' }
export async function buildTrade(a: TradeArgs): Promise<VersionedTransaction> {
  const r = await fetch('https://pumpportal.fun/api/trade-local', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey: a.publicKey, action: a.action, mint: a.mint, amount: a.amount, denominatedInSol: a.denominatedInSol ? 'true' : 'false', slippage: a.slippage, priorityFee: a.priorityFee, pool: a.pool || 'auto' }),
  })
  if (!r.ok) throw new Error('pumpportal: ' + (await r.text().catch(() => r.status)))
  return VersionedTransaction.deserialize(new Uint8Array(await r.arrayBuffer()))
}

export type CreateMeta = { name: string; symbol: string; description: string; file?: File; twitter?: string; telegram?: string; website?: string }
/** Uploads image + metadata JSON to IPFS through our server (Pinata; pump.fun/api/ipfs is dead). Returns the metadata URI. */
export async function uploadMetadata(m: CreateMeta, server: string): Promise<string> {
  const image = m.file ? await new Promise<string>((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = rej; fr.readAsDataURL(m.file!) }) : undefined
  const r = await fetch(server + '/ipfs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: m.name, symbol: m.symbol, description: m.description || '', twitter: m.twitter, telegram: m.telegram, website: m.website, image }) })
  if (!r.ok) throw new Error('metadata upload failed: ' + (await r.text().catch(() => r.status)))
  const d = await r.json(); return d.uri as string
}
/** Builds the create (+ optional dev buy) tx. Returns tx and the mint keypair that must co-sign. */
export async function buildCreate(publicKey: string, meta: { name: string; symbol: string; uri: string }, devBuySol: number, slippage: number, priorityFee: number) {
  const mintKp = Keypair.generate()
  const r = await fetch('https://pumpportal.fun/api/trade-local', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey, action: 'create', tokenMetadata: meta, mint: mintKp.publicKey.toBase58(), denominatedInSol: 'true', amount: devBuySol, slippage, priorityFee, pool: 'pump' }),
  })
  if (!r.ok) throw new Error('pumpportal create: ' + (await r.text().catch(() => r.status)))
  const tx = VersionedTransaction.deserialize(new Uint8Array(await r.arrayBuffer()))
  tx.sign([mintKp])
  return { tx, mint: mintKp.publicKey.toBase58() }
}

/** Block-zero bundle: [create+dev buy (dev signs + mint kp), vault buy (vault signs server-side)] built by PumpPortal in one call, with a Jito tip on the last tx. */
export async function buildLaunchBundle(dev: string, vaultPub: string, meta: { name: string; symbol: string; uri: string }, devBuySol: number, vaultBuySol: number, slippage: number, priorityFee: number) {
  const mintKp = Keypair.generate(); const mint = mintKp.publicKey.toBase58()
  const body = [
    { publicKey: dev, action: 'create', tokenMetadata: meta, mint, denominatedInSol: 'true', amount: devBuySol, slippage, priorityFee, pool: 'pump' },
    { publicKey: vaultPub, action: 'buy', mint, denominatedInSol: 'true', amount: vaultBuySol, slippage, priorityFee: 0.00005, pool: 'pump' },
  ]
  const r = await fetch('https://pumpportal.fun/api/trade-local', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error('pumpportal bundle: ' + (await r.text().catch(() => r.status)))
  const enc: string[] = await r.json()
  const txs = enc.map((e) => VersionedTransaction.deserialize(bs58.decode(e)))
  txs[0].sign([mintKp])
  return { mint, createTx: txs[0], vaultTx: txs[1] }
}
