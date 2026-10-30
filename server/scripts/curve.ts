// the brand wallet's real position: SOL + coin now (marked at the pool price), vs what it held right before the launch create
const LL = await import('../src/launchlab.ts'); const { PublicKey } = await import('@solana/web3.js'); const { conn } = await import('../src/chain.ts')
const mint = process.env.MINT!; const W = new PublicKey('BANKYubgHd48UQt2VFtEytyE8QyeBHhiuptC3tHmfVPH')
const p: any = await LL.pool(mint, 0); const f = (x: bigint, d = 9) => Number(x) / 10 ** d
const raised = f(p.realB), sold = f(p.realA, 6), vB = f(p.virtualB), vA = f(p.virtualA, 6); const price = (vB + raised) / (vA - sold)
const sol = (await conn.getBalance(W)) / 1e9
const accs = await conn.getParsedTokenAccountsByOwner(W, { mint: new PublicKey(mint) }); const tok = accs.value.reduce((a: number, x: any) => a + (x.account.data.parsed.info.tokenAmount.uiAmount || 0), 0)
// what selling all of it into the curve would actually return (constant product, 2.25% fees)
const x = vB + raised, y = vA - sold, k = x * y; const outGross = x - k / (y + tok); const out = outGross * (1 - 0.0225)
console.log(JSON.stringify({ t: new Date().toISOString(), bondedPct: +(100 * raised / f(p.totalFundRaisingB)).toFixed(2), priceSol: price, mcapSol: +(price * 1e9).toFixed(1), walletSol: +sol.toFixed(4), walletTokensM: +(tok / 1e6).toFixed(3), tokensAtSpotSol: +(tok * price).toFixed(4), tokensIfSoldAllSol: +out.toFixed(4) }))
for (const s of ['4UtXTnHY4sm4Cpy1VNF5vpmtFXpnYmhXEz7NKCkAUHDQvepJ1quEccXDq3ietaJaNXhrih9p6qBpVR6YaeLPJgym']) {
  const tx = await conn.getParsedTransaction(s, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }); const keys = tx!.transaction.message.accountKeys.map((k: any) => k.pubkey.toBase58()); const i = keys.indexOf(W.toBase58())
  console.log('create tx: wallet SOL before', tx!.meta!.preBalances[i] / 1e9, 'after', tx!.meta!.postBalances[i] / 1e9, 'signers', tx!.transaction.message.accountKeys.filter((k: any) => k.signer).map((k: any) => k.pubkey.toBase58()).join(' ')) }
const sigs = await conn.getSignaturesForAddress(W, { limit: 400 }); const t0 = Date.parse('2026-10-30T21:10:00Z') / 1000; const early = sigs.filter((x) => (x.blockTime || 0) < t0).slice(0, 3)
for (const e of early) { const tx = await conn.getParsedTransaction(e.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }); const keys = tx!.transaction.message.accountKeys.map((k: any) => k.pubkey.toBase58()); const i = keys.indexOf(W.toBase58()); console.log('before launch:', new Date((e.blockTime || 0) * 1000).toISOString(), 'wallet SOL after that tx', tx!.meta!.postBalances[i] / 1e9) }
process.exit(0)
