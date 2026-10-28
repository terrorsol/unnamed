import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js'
import { addTip, sendFast } from './fast'
export type Fast = { rpc: string; payer: PublicKey; tipLamports: number }
export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
export const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
export type Holding = { mint: string; amount: number; decimals: number; raw: string }
export async function holdings(conn: Connection, owner: PublicKey): Promise<Holding[]> {
  const [a, b] = await Promise.all([conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM }), conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022 }).catch(() => ({ value: [] as any[] }))])
  const out: Holding[] = []
  for (const acc of [...a.value, ...b.value]) {
    const info = (acc.account.data as any).parsed.info; const amt = info.tokenAmount
    if (+amt.uiAmount > 0) out.push({ mint: info.mint, amount: +amt.uiAmount, decimals: amt.decimals, raw: amt.amount })
  }
  return out
}
/** Helius priority-fee estimate (falls back to the configured fee on any other RPC) */
export async function priorityFee(conn: Connection, fallbackSol: number): Promise<number> {
  try {
    const ep = (conn as any)._rpcEndpoint as string; if (!/helius/.test(ep)) return fallbackSol
    const r = await fetch(ep, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getPriorityFeeEstimate', params: [{ options: { priorityLevel: 'High' } }] }) })
    const d = await r.json(); const microLamportsPerCu = d?.result?.priorityFeeEstimate; if (!microLamportsPerCu) return fallbackSol
    const sol = (microLamportsPerCu * 200_000) / 1e6 / 1e9; return Math.min(0.01, Math.max(0.0001, sol))
  } catch { return fallbackSol }
}
let bhCache: { bh: string; t: number } | null = null
export async function warmBlockhash(conn: Connection) { try { const b = await conn.getLatestBlockhash('confirmed'); bhCache = { bh: b.blockhash, t: Date.now() }; return b.blockhash } catch { return bhCache?.bh } }
export async function sendAndConfirm(conn: Connection, tx: VersionedTransaction, signTx: (t: VersionedTransaction) => Promise<VersionedTransaction>, onStatus?: (s: string) => void, fast?: Fast) {
  if (fast && fast.tipLamports > 0) { try { tx = await addTip(conn, tx, fast.payer, fast.tipLamports) } catch { fast = undefined } }
  onStatus?.('Waiting for your signature…')
  const signed = await signTx(tx)
  onStatus?.('Sending…')
  const raw = signed.serialize()
  const sig = fast ? await sendFast(conn, raw, fast.rpc) : await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0, preflightCommitment: 'confirmed' })
  // re-broadcast a few times while confirming — the cheap way to beat dropped txs without a Jito bundle
  const rb = setInterval(() => conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {}), 2000); setTimeout(() => clearInterval(rb), 20000)
  try { onStatus?.('Confirming…'); await confirmByPolling(conn, sig); return sig } finally { clearInterval(rb) }
}
/** Poll signature status (no websocket dependency). Throws on on-chain error or ~60s timeout. */
export async function confirmByPolling(conn: Connection, sig: string, timeoutMs = 60000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const st = (await conn.getSignatureStatuses([sig]).catch(() => null))?.value?.[0]
    if (st) { if (st.err) throw new Error('Transaction failed on-chain: ' + JSON.stringify(st.err)); if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('Confirmation timed out — check Solscan: ' + solscan(sig))
}
export const solscan = (sig: string) => `https://solscan.io/tx/${sig}`

/** Rug check: authorities + holder concentration, straight from the chain */
export type RugCheck = { mintAuthority: boolean; freezeAuthority: boolean; top10Pct: number; top1Pct: number; holders: { address: string; pct: number }[]; supply: number; decimals: number }
export async function rugCheck(conn: Connection, mint: string, knownVault?: string): Promise<RugCheck> {
  const mp = new PublicKey(mint)
  const [info, largest, supply] = await Promise.all([conn.getParsedAccountInfo(mp), conn.getTokenLargestAccounts(mp), conn.getTokenSupply(mp)])
  const parsed = (info.value?.data as any)?.parsed?.info || {}
  const total = +(supply.value.uiAmount || 0) || 1
  // largest accounts are token accounts; resolve owners so we can label pool / vault
  const accs = largest.value.slice(0, 10)
  const owners = await conn.getMultipleParsedAccounts(accs.map((a) => a.address)).then((r) => r.value.map((v) => (v?.data as any)?.parsed?.info?.owner || '')).catch(() => accs.map(() => ''))
  const holders = accs.map((a, i) => ({ address: owners[i] || a.address.toBase58(), pct: (+(a.uiAmount || 0) / total) * 100 }))
  const nonPool = holders.filter((h) => h.address !== knownVault)
  return { mintAuthority: !!parsed.mintAuthority, freezeAuthority: !!parsed.freezeAuthority, top10Pct: holders.reduce((s, h) => s + h.pct, 0), top1Pct: nonPool[0]?.pct || 0, holders, supply: total, decimals: supply.value.decimals }
}
