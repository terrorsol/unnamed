// PumpPortal: public tx-builder for pump.fun (create / buy / sell) + live data websocket. Docs: https://pumpportal.fun/
// Local Transaction API = no key, user signs everything, 0.5% fee on trades. We never hold keys.
import { VersionedTransaction, Keypair } from '@solana/web3.js'
import bs58 from 'bs58'

export type NewToken = { mint: string; name: string; symbol: string; uri?: string; image?: string; creator?: string; ts: number; solAmount?: number; mcapSol?: number; pool?: string }
export type TradeEvt = { mint: string; txType: 'buy' | 'sell'; sol: number; tokens: number; trader: string; mcapSol: number; ts: number }

export function openStream(onNew: (t: NewToken) => void, onTrade?: (t: TradeEvt) => void, mints: string[] = []) {
  let ws: WebSocket | null = null, closed = false, timer: any
  const connect = () => {
    ws = new WebSocket('wss://pumpportal.fun/api/data')
    ws.onopen = () => { ws!.send(JSON.stringify({ method: 'subscribeNewToken' })); if (mints.length) ws!.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: mints })) }
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
  return { close: () => { closed = true; clearTimeout(timer); ws?.close() }, subscribe: (ms: string[]) => { if (ws?.readyState === 1 && ms.length) ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: ms })) } }
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
/** Uploads metadata+image to pump.fun IPFS, returns metadata URI */
export async function uploadMetadata(m: CreateMeta): Promise<string> {
  const fd = new FormData()
  if (m.file) fd.append('file', m.file)
  fd.append('name', m.name); fd.append('symbol', m.symbol); fd.append('description', m.description || '')
  if (m.twitter) fd.append('twitter', m.twitter); if (m.telegram) fd.append('telegram', m.telegram); if (m.website) fd.append('website', m.website)
  fd.append('showName', 'true')
  const r = await fetch('https://pump.fun/api/ipfs', { method: 'POST', body: fd })
  if (!r.ok) throw new Error('metadata upload failed: ' + r.status)
  const d = await r.json(); return d.metadataUri
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
