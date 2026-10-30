// read-only: every BANKY transaction since 21:00 UTC, each sorted into one bucket by what it did on chain; the buckets must sum to the
// balance change (proof nothing is missing). Buys: launch seeds (≥5 SOL), the server's policy buys (≤0.21 SOL), anything else = outside MM.
const { PublicKey } = await import('@solana/web3.js'); const { conn } = await import('../src/chain.ts')
const W = 'BANKYubgHd48UQt2VFtEytyE8QyeBHhiuptC3tHmfVPH'; const since = Date.parse('2026-10-30T21:00:00Z') / 1000
const NAMES: Record<string, string> = { nUCiRZJQz1xGbGpM5FthfiF8ZUiDqsy9QcnwxvFBANK: 'coin1', oLMoTt1bJbtPtY2QXmhWLneYYGXdZcLEeCwjuDRBANK: 'pump', '6XnV32nSmeYBZBmH5kczp8fLr6ttu2VSfZoK5HbBANK': 'coin3', J4RRpzuCK3TuVdVM6jCQ1jDQQkj1LSBFYJcUsZ6BANK: 'xyz' }
let before: string | undefined; const all: any[] = []
for (let page = 0; page < 6; page++) { const s = await conn.getSignaturesForAddress(new PublicKey(W), { limit: 1000, before }); if (!s.length) break; all.push(...s); before = s.at(-1)!.signature; if ((s.at(-1)!.blockTime || 0) < since) break }
const sigs = all.filter((x) => (x.blockTime || 0) >= since).reverse()
const B: Record<string, number> = {}; const N: Record<string, number> = {}; const add = (k: string, v: number) => { B[k] = (B[k] || 0) + v; N[k] = (N[k] || 0) + 1 }
let first: number | null = null, last = 0, parsed = 0, failed = 0
for (const x of sigs) {
  let tx: any = null; for (let i = 0; i < 6 && !tx; i++) { tx = await conn.getParsedTransaction(x.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null); if (!tx) await new Promise((r) => setTimeout(r, 800 * (i + 1))) }
  if (!tx?.meta) { failed++; console.log('UNREAD', x.signature); continue } parsed++
  const keys = tx.transaction.message.accountKeys.map((k: any) => k.pubkey.toBase58()); const wi = keys.indexOf(W); if (wi < 0) continue
  const pre = tx.meta.preBalances[wi] / 1e9, post = tx.meta.postBalances[wi] / 1e9, d = post - pre; if (first === null) first = pre; last = post
  const signers = tx.transaction.message.accountKeys.filter((k: any) => k.signer).map((k: any) => k.pubkey.toBase58())
  const coin: Record<string, number> = {}; for (const b of tx.meta.postTokenBalances || []) if (b.owner === W) coin[b.mint] = (coin[b.mint] || 0) + (b.uiTokenAmount.uiAmount || 0)
  for (const b of tx.meta.preTokenBalances || []) if (b.owner === W) coin[b.mint] = (coin[b.mint] || 0) - (b.uiTokenAmount.uiAmount || 0)
  const moved = Object.entries(coin).filter(([m, v]) => Math.abs(v) > 0.5 && m !== 'So11111111111111111111111111111111111111112'); const name = moved.length ? (NAMES[moved[0][0]] || 'other-token') : ''
  const logs = (tx.meta.logMessages || []).join(' ')
  let k: string
  if (tx.meta.err) k = 'failed tx fees'
  else if (!signers.includes(W)) k = d > 0 ? 'sent IN from another wallet' : 'other (not signed by BANKY)'
  else if (moved.length && moved[0][1] > 0 && /create|Create|initialize/i.test(logs) && signers.length > 1) k = `${name}: launch (create + dev buy)`
  else if (moved.length && moved[0][1] > 0) k = -d >= 4.5 ? `${name}: chest launch buy` : -d <= 0.215 ? `${name}: chest policy buy (≤0.2)` : `${name}: buys NOT by the chest (outside MM)`
  else if (moved.length && moved[0][1] < 0) k = `${name}: chest sells`
  else if (/collect_creator_fee|CollectCreatorFee|collectCreatorFee/i.test(logs)) k = 'pump creator fees claimed'
  else if (d > 0 && /LanMV9|ClaimPlatformFee|claim_platform_fee|ClaimVault|claim_vault/i.test(logs + keys.join(' '))) k = '2% tax claims (launchpad)'
  else { const out = (tx.meta.innerInstructions || []).flatMap((i: any) => i.instructions).concat(tx.transaction.message.instructions).filter((i: any) => i.program === 'system' && i.parsed?.type === 'transfer' && i.parsed.info.source === W && i.parsed.info.lamports > 5_000_000)
    if (out.length) { k = 'SENT OUT to another wallet'; for (const o of out) console.log('SENT OUT', new Date((tx.blockTime || 0) * 1000).toISOString().slice(11, 19), (o.parsed.info.lamports / 1e9).toFixed(4), 'to', o.parsed.info.destination, x.signature.slice(0, 12)) } else k = d > 0 ? 'other SOL in' : 'other (fees/rent/tips)' }
  add(k, d); if (/other|SENT|IN from/.test(k)) console.log('NOTE', k, d.toFixed(4), new Date((tx.blockTime || 0) * 1000).toISOString().slice(11, 19), x.signature.slice(0, 16), (tx.meta.logMessages || []).slice(0, 3).join(' | ').slice(0, 160))
}
console.log('txs', sigs.length, 'read', parsed, 'unread', failed)
for (const k of Object.keys(B).sort()) console.log('BUCKET', k.padEnd(48), String(N[k]).padStart(4), 'txs', B[k].toFixed(4).padStart(10), 'SOL')
const sum = Object.values(B).reduce((a, b) => a + b, 0); console.log('START', first?.toFixed(4), 'END', last.toFixed(4), 'change', (last - (first || 0)).toFixed(4), 'sum of buckets', sum.toFixed(4), 'BANKY now', ((await conn.getBalance(new PublicKey(W))) / 1e9).toFixed(4))
process.exit(0)
