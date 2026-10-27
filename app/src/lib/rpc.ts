import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js'
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
export async function sendAndConfirm(conn: Connection, tx: VersionedTransaction, signTx: (t: VersionedTransaction) => Promise<VersionedTransaction>, onStatus?: (s: string) => void) {
  onStatus?.('Waiting for your signature…')
  const signed = await signTx(tx)
  onStatus?.('Sending…')
  const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 3 })
  onStatus?.('Confirming…')
  await confirmByPolling(conn, sig)
  return sig
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
