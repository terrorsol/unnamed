const S = 'https://unnamed-server.onrender.com'
const vs: any = await fetch(S + '/vaults').then((r) => r.json())
for (const v of vs) console.log('ARMED', v.id, v.symbol, v.venue, v.mint, 'chest', v.chest, 'tokens', Math.round(v.tokens), 'dev', v.dev, 'created', new Date(v.createdAt || 0).toISOString().slice(11, 19), 'captured', v.score?.captured)
process.exit(0)
