// read-only: every SOL that came INTO BANKY from another wallet (plain transfers) since 21:00 UTC, and every SOL that left to another wallet
const { PublicKey } = await import('@solana/web3.js'); const { conn } = await import('../src/chain.ts')
const W = 'BANKYubgHd48UQt2VFtEytyE8QyeBHhiuptC3tHmfVPH'; const since = Date.parse('2026-10-30T21:00:00Z') / 1000
let before: string | undefined; const all: any[] = []
for (let page = 0; page < 6; page++) { const s = await conn.getSignaturesForAddress(new PublicKey(W), { limit: 1000, before }); if (!s.length) break; all.push(...s); before = s.at(-1)!.signature; if ((s.at(-1)!.blockTime || 0) < since) break }
const sigs = all.filter((x) => (x.blockTime || 0) >= since && !x.err); console.log('txs since 21:00', sigs.length)
let inSol = 0, outSol = 0
for (let i = 0; i < sigs.length; i += 50) {
  const txs = await conn.getParsedTransactions(sigs.slice(i, i + 50).map((x) => x.signature), { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => [])
  for (const tx of txs) { if (!tx?.meta) continue
    for (const ix of [...tx.transaction.message.instructions, ...(tx.meta.innerInstructions || []).flatMap((x: any) => x.instructions)] as any[]) {
      if (ix.program !== 'system' || ix.parsed?.type !== 'transfer') continue; const { source, destination, lamports } = ix.parsed.info
      if (destination === W && source !== W) { const signer = tx.transaction.message.accountKeys.find((k: any) => k.signer)?.pubkey.toBase58(); if (signer !== W) { inSol += lamports / 1e9; console.log('IN ', new Date((tx.blockTime || 0) * 1000).toISOString().slice(11, 19), (lamports / 1e9).toFixed(4), 'from', source) } }
      if (source === W && destination !== W && lamports >= 50_000_000) { outSol += lamports / 1e9; console.log('OUT', new Date((tx.blockTime || 0) * 1000).toISOString().slice(11, 19), (lamports / 1e9).toFixed(4), 'to', destination) } } }
  await new Promise((r) => setTimeout(r, 400)) }
console.log('external SOL in', inSol.toFixed(4), '· big transfers out', outSol.toFixed(4), '· BANKY now', (await conn.getBalance(new PublicKey(W))) / 1e9)
process.exit(0)
