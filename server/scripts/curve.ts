// the pump launch's vault: every activity entry (oldest first) + its curve now
const S = 'https://unnamed-server.onrender.com'; const MINT = 'oLMoTt1bJbtPtY2QXmhWLneYYGXdZcLEeCwjuDRBANK'
const vs: any = await fetch(S + '/vaults').then((r) => r.json())
for (const v of vs) { if (v.mint !== MINT) continue
  console.log('vault', v.id, 'chest', v.chest, 'tokens', v.tokens, 'avgCost', v.avgCost, 'score', JSON.stringify(v.score), 'sniper', JSON.stringify(v.sniper || null).slice(0, 600))
  for (const a of [...(v.activity || [])].reverse()) console.log(new Date(a.t).toISOString().slice(11, 23), a.kind, a.sol ?? '', a.tokens != null ? Math.round(a.tokens) : '', String(a.msg || '').slice(0, 200), a.sig ? a.sig.slice(0, 12) : '') }
const PF = await import('../src/pumpfast.ts'); const { conn } = await import('../src/chain.ts'); const { PublicKey } = await import('@solana/web3.js')
const ci = await conn.getAccountInfo(PF.curveOf(new PublicKey(MINT))); if (ci) { const vTok = ci.data.readBigUInt64LE(8), vSol = ci.data.readBigUInt64LE(16), rTok = ci.data.readBigUInt64LE(24), rSol = ci.data.readBigUInt64LE(32), complete = ci.data[48]
  const price = (Number(vSol) / 1e9) / (Number(vTok) / 1e6); console.log('CURVE', JSON.stringify({ realSol: Number(rSol) / 1e9, realTokM: Number(rTok) / 1e12, bondedPct: +(100 * (1 - Number(rTok) / 793.1e12)).toFixed(2), priceSol: price, mcapSol: +(price * 1e9).toFixed(1), complete })) }
process.exit(0)
