// one coin's LaunchLab pool, read straight from chain: how far up the curve it is
const LL = await import('../src/launchlab.ts')
const mint = process.env.MINT!
const p: any = await LL.pool(mint, 0)
if (!p) { console.log('no pool'); process.exit(0) }
const f = (x: bigint, d = 9) => Number(x) / 10 ** d
const raised = f(p.realB), target = f(p.totalFundRaisingB), sold = f(p.realA, 6), toSell = f(p.totalSellA, 6)
const vB = f(p.virtualB), vA = f(p.virtualA, 6)
const price = (vB + raised) / (vA - sold)
console.log(JSON.stringify({ t: new Date().toISOString(), status: p.status, raisedSol: +raised.toFixed(4), targetSol: target, bondedPct: +(100 * raised / target).toFixed(2), soldTokensM: +(sold / 1e6).toFixed(3), totalSellM: +(toSell / 1e6).toFixed(3), soldPct: +(100 * sold / toSell).toFixed(2), virtualSol: vB, virtualTokM: +(vA / 1e6).toFixed(3), priceSol: price, mcapSol: +(price * 1e9).toFixed(2), gradPriceSol: (vB + target) / (vA - toSell), gradMcapSol: +((vB + target) / (vA - toSell) * 1e9).toFixed(1) }, null, 1))
// the vault wallet's balance of this coin and every recent move of its coin account (who sent tokens in, what each tx did)
const { Connection, PublicKey } = await import('@solana/web3.js'); const conn = new Connection(process.env.RPC_URL!, 'confirmed')
const W = new PublicKey(process.env.WALLET || 'BANKYubgHd48UQt2VFtEytyE8QyeBHhiuptC3tHmfVPH')
const accs = await conn.getParsedTokenAccountsByOwner(W, { mint: new PublicKey(mint) })
for (const a of accs.value) console.log('account', a.pubkey.toBase58(), 'balance', a.account.data.parsed.info.tokenAmount.uiAmountString)
const ata = accs.value[0]?.pubkey; if (ata) {
  const sigs = await conn.getSignaturesForAddress(ata, { limit: 70 })
  for (const x of sigs) { await new Promise((r) => setTimeout(r, 120))
    const tx = await conn.getParsedTransaction(x.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null); if (!tx?.meta) continue
    const pre = tx.meta.preTokenBalances?.find((b: any) => b.owner === W.toBase58() && b.mint === mint)?.uiTokenAmount.uiAmount || 0
    const post = tx.meta.postTokenBalances?.find((b: any) => b.owner === W.toBase58() && b.mint === mint)?.uiTokenAmount.uiAmount || 0
    const keys = tx.transaction.message.accountKeys.map((k: any) => k.pubkey.toBase58()); const wi = keys.indexOf(W.toBase58())
    const sol = wi >= 0 ? (tx.meta.postBalances[wi] - tx.meta.preBalances[wi]) / 1e9 : 0
    const progs = [...new Set(tx.transaction.message.instructions.map((i: any) => (i.programId?.toBase58?.() || String(i.programId)).slice(0, 6)))].join(',')
    console.log(new Date((x.blockTime || 0) * 1000).toISOString().slice(11, 19), x.signature.slice(0, 10), x.err ? 'ERR' : 'ok ', 'tok', (post - pre).toFixed(0).padStart(12), 'sol', sol.toFixed(4).padStart(8), 'signer', keys[0].slice(0, 6), 'progs', progs) }
}
process.exit(0)
