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
  const bh = await conn.getLatestBlockhash('confirmed')
  const res = await conn.confirmTransaction({ signature: sig, ...bh }, 'confirmed')
  if (res.value.err) throw new Error('Transaction failed on-chain: ' + JSON.stringify(res.value.err))
  return sig
}
export const solscan = (sig: string) => `https://solscan.io/tx/${sig}`
