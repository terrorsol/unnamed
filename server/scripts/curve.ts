// BANKY's moves on the pump coin since its launch: which buys came from the wallet itself (not the server's sells), and the wallet now
const { PublicKey } = await import('@solana/web3.js'); const { conn } = await import('../src/chain.ts'); const PF = await import('../src/pumpfast.ts')
const W = new PublicKey('BANKYubgHd48UQt2VFtEytyE8QyeBHhiuptC3tHmfVPH'); const mint = 'oLMoTt1bJbtPtY2QXmhWLneYYGXdZcLEeCwjuDRBANK'
console.log('BANKY SOL', (await conn.getBalance(W)) / 1e9)
const accs = await conn.getParsedTokenAccountsByOwner(W, { mint: new PublicKey(mint) }); for (const a of accs.value) console.log('BANKY coin', a.account.data.parsed.info.tokenAmount.uiAmountString)
const ci = await conn.getAccountInfo(PF.curveOf(new PublicKey(mint))); if (ci) { const vTok = ci.data.readBigUInt64LE(8), vSol = ci.data.readBigUInt64LE(16), rTok = ci.data.readBigUInt64LE(24), rSol = ci.data.readBigUInt64LE(32); const price = (Number(vSol) / 1e9) / (Number(vTok) / 1e6); console.log('CURVE', JSON.stringify({ realSol: Number(rSol) / 1e9, bondedPct: +(100 * (1 - Number(rTok) / 793.1e12)).toFixed(2), priceSol: price, mcapSol: +(price * 1e9).toFixed(1), complete: ci.data[48] })) }
const sigs = await conn.getSignaturesForAddress(W, { limit: 200 }); const t0 = Date.parse('2026-10-30T22:02:00Z') / 1000
let buys = 0, buySol = 0, sells = 0, sellSol = 0
for (const x of sigs) { if ((x.blockTime || 0) < t0) break; await new Promise((r) => setTimeout(r, 300))
  const tx = await conn.getParsedTransaction(x.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null); if (!tx?.meta) continue
  const keys = tx.transaction.message.accountKeys.map((k: any) => k.pubkey.toBase58()); const wi = keys.indexOf(W.toBase58()); const sol = wi >= 0 ? (tx.meta.postBalances[wi] - tx.meta.preBalances[wi]) / 1e9 : 0
  const pre = tx.meta.preTokenBalances?.find((b: any) => b.owner === W.toBase58() && b.mint === mint)?.uiTokenAmount.uiAmount || 0
  const post = tx.meta.postTokenBalances?.find((b: any) => b.owner === W.toBase58() && b.mint === mint)?.uiTokenAmount.uiAmount || 0
  const progs = [...new Set(tx.transaction.message.instructions.map((i: any) => (i.programId?.toBase58?.() || String(i.programId)).slice(0, 6)))].join(',')
  if (post - pre > 0) { buys++; buySol += -sol } else if (post - pre < 0) { sells++; sellSol += sol }
  if (post !== pre || Math.abs(sol) > 0.3) console.log(new Date((x.blockTime || 0) * 1000).toISOString().slice(11, 19), x.signature.slice(0, 10), x.err ? 'ERR' : 'ok ', 'sol', sol.toFixed(4).padStart(9), 'coin', (post - pre).toFixed(0).padStart(11), 'progs', progs) }
console.log('wallet buys', buys, buySol.toFixed(4), 'SOL · sells', sells, sellSol.toFixed(4), 'SOL')
process.exit(0)
