// shared wallet vs the chest ledgers (the server's own audit), and every BANKY tx on this coin with who signed
const S = 'https://unnamed-server.onrender.com'; const AK = process.env.ADMIN_KEY || ''
if (AK) { const w: any = await fetch(S + '/admin/wallet?key=' + AK).then((r) => r.json()).catch((e) => ({ err: String(e) })); console.log('AUDIT', JSON.stringify(w).slice(0, 1500)) }
const { PublicKey } = await import('@solana/web3.js'); const { conn } = await import('../src/chain.ts')
const W = new PublicKey('BANKYubgHd48UQt2VFtEytyE8QyeBHhiuptC3tHmfVPH'); const mint = process.env.MINT!
console.log('BANKY SOL', (await conn.getBalance(W)) / 1e9)
const accs = await conn.getParsedTokenAccountsByOwner(W, { mint: new PublicKey(mint) }); for (const a of accs.value) console.log('BANKY coin', a.account.data.parsed.info.tokenAmount.uiAmountString)
// every tx of the wallet itself in the last hour: SOL move, coin move, and whether its compute-budget/tip shape is the server's or the app's
const sigs = await conn.getSignaturesForAddress(W, { limit: 200 }); const since = Date.now() / 1000 - 3 * 3600
let n = 0, buys = 0, buySol = 0
for (const x of sigs) { if ((x.blockTime || 0) < since) break; await new Promise((r) => setTimeout(r, 300))
  const tx = await conn.getParsedTransaction(x.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null); if (!tx?.meta) continue; n++
  const keys = tx.transaction.message.accountKeys.map((k: any) => k.pubkey.toBase58()); const wi = keys.indexOf(W.toBase58())
  const sol = wi >= 0 ? (tx.meta.postBalances[wi] - tx.meta.preBalances[wi]) / 1e9 : 0
  const pre = tx.meta.preTokenBalances?.find((b: any) => b.owner === W.toBase58() && b.mint === mint)?.uiTokenAmount.uiAmount || 0
  const post = tx.meta.postTokenBalances?.find((b: any) => b.owner === W.toBase58() && b.mint === mint)?.uiTokenAmount.uiAmount || 0
  const signers = tx.transaction.message.accountKeys.filter((k: any) => k.signer).map((k: any) => k.pubkey.toBase58().slice(0, 6)).join('+')
  const progs = [...new Set(tx.transaction.message.instructions.map((i: any) => (i.programId?.toBase58?.() || String(i.programId)).slice(0, 6)))].join(',')
  if (post - pre > 0 && sol < -0.5) { buys++; buySol += -sol }
  if (Math.abs(sol) > 0.3 || post - pre > 0) console.log(new Date((x.blockTime || 0) * 1000).toISOString().slice(11, 19), x.signature.slice(0, 12), x.err ? 'ERR' : 'ok ', 'sol', sol.toFixed(4).padStart(9), 'coin', (post - pre).toFixed(0).padStart(11), 'signers', signers, 'progs', progs) }
console.log('txs read', n, 'big coin buys', buys, 'SOL', buySol.toFixed(4))
process.exit(0)
