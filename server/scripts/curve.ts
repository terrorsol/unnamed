// read-only: what BANKY holds right now, per coin, and each coin's price
const { PublicKey } = await import('@solana/web3.js'); const { conn } = await import('../src/chain.ts')
const W = new PublicKey('BANKYubgHd48UQt2VFtEytyE8QyeBHhiuptC3tHmfVPH'); console.log('BANKY SOL', (await conn.getBalance(W)) / 1e9)
const all = await conn.getParsedTokenAccountsByOwner(W, { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') })
const all22 = await conn.getParsedTokenAccountsByOwner(W, { programId: new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') }).catch(() => ({ value: [] as any[] }))
for (const a of [...all.value, ...all22.value]) { const i = a.account.data.parsed.info; if ((i.tokenAmount.uiAmount || 0) > 0) console.log('TOKEN', i.mint, i.tokenAmount.uiAmountString, 'account', a.pubkey.toBase58()) }
const S = 'https://unnamed-server.onrender.com'; const vs: any = await fetch(S + '/vaults').then((r) => r.json()).catch(() => [])
for (const v of vs) console.log('VAULT', v.id, v.symbol, v.venue, v.mint, 'ledger tokens', Math.round(v.tokens), 'chest', v.chest)
process.exit(0)
