// the live server's record of BANKER's vault: every activity entry that is not a capture, plus the server event log's buys
const S = 'https://unnamed-server.onrender.com'; const AK = process.env.ADMIN_KEY || ''
const vs: any = await fetch(S + '/vaults').then((r) => r.json())
for (const v of vs) { if (v.mint !== process.env.MINT) continue
  console.log('vault', v.id, v.symbol, 'pub', v.pub, 'chest', v.chest, 'tokens', v.tokens, 'activity entries', (v.activity || []).length, 'mm', JSON.stringify(v.mm || {}).slice(0, 300))
  for (const a of v.activity || []) if (a.kind !== 'capture') console.log(new Date(a.t).toISOString().slice(11, 19), a.kind, a.sol ?? '', a.tokens ?? '', String(a.msg || '').slice(0, 160), a.sig || '') }
if (AK) { const e: any = await fetch(S + '/admin/events?key=' + AK + '&since=' + (Date.now() - 3600_000)).then((r) => r.json())
  for (const x of e.events || []) if (!/capture /.test(x.msg || '')) console.log('EV', new Date(x.t).toISOString().slice(11, 19), x.kind, String(x.msg || '').slice(0, 220)) }
process.exit(0)
