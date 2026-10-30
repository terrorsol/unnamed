// every vault the live server knows (armed or not, newest first) + the last hour of launch/vault events
const S = 'https://unnamed-server.onrender.com'; const AK = process.env.ADMIN_KEY || ''
const vs: any = await fetch(S + '/vaults').then((r) => r.json())
for (const v of vs) console.log('ARMED', v.id, v.symbol, v.venue, v.mint, 'chest', v.chest, 'tokens', Math.round(v.tokens), 'created', new Date(v.createdAt || 0).toISOString())
if (AK) { const e: any = await fetch(S + '/admin/events?key=' + AK + '&since=' + (Date.now() - 2 * 3600_000)).then((r) => r.json())
  for (const x of e.events || []) if (!/ capture |platform fees claimed/.test(' ' + (x.msg || ''))) console.log('EV', new Date(x.t).toISOString().slice(11, 19), x.kind, String(x.msg || '').slice(0, 260)) }
process.exit(0)
