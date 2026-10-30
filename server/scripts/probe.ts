// probe branch: live watch of a launch — every armed vault's new activity (captures, sniper tax, notes), chest/tokens, and the server's
// vault/error/guard events, polled from the live server for ~13 min. Read-only: no keys used except ADMIN_KEY for the event log.
const S = process.env.SERVER || 'https://unnamed-server.onrender.com'; const AK = process.env.ADMIN_KEY || ''
const get = (p: string) => fetch(S + p, { signal: AbortSignal.timeout(8000) }).then((r) => r.json()).catch((e) => ({ err: String(e.message) }))
const ts = (t: number) => new Date(t).toISOString().slice(11, 23)
const seenAct = new Set<string>(); const state = new Map<string, string>(); let evSince = Date.now() - 10 * 60_000; const t0 = Date.now(); let lastHealth = 0
const h0: any = await get('/health'); console.log('start', ts(Date.now()), 'commit', h0.commit, 'stream', JSON.stringify(h0.stream && { connected: h0.stream.connected, polling: h0.stream.polling }))
// existing activity is history: only print what is new from here (plus the last 3 per vault for context)
{ const vs: any = await get('/vaults'); for (const v of Array.isArray(vs) ? vs : []) { const a = v.activity || []; a.forEach((x: any, i: number) => { const k = v.id + x.t + x.msg; if (i >= 3) seenAct.add(k) }) } }
while (Date.now() - t0 < 12.5 * 60_000) {
  const vs: any = await get('/vaults')
  if (Array.isArray(vs)) for (const v of vs) {
    const st = `${v.symbol} ${v.venue} mint ${v.mint} chest ${(+v.chest).toFixed(4)} tokens ${Math.round(v.tokens)} avgCost ${v.avgCost} captures ${v.score?.captures} captured ${(+(v.score?.captured || 0)).toFixed(4)}`
    if (state.get(v.id) !== st) { state.set(v.id, st); console.log(ts(Date.now()), 'STATE', st) }
    for (const x of [...(v.activity || [])].reverse()) { const k = v.id + x.t + x.msg; if (seenAct.has(k)) continue; seenAct.add(k)
      console.log(ts(Date.now()), 'ACT', v.symbol, ts(x.t), x.kind, x.sol != null ? (+x.sol).toFixed(4) : '', x.msg || '', x.sig ? 'sig ' + x.sig : '') }
  } else console.log(ts(Date.now()), 'vaults err', JSON.stringify(vs).slice(0, 120))
  if (AK) { const e: any = await get('/admin/events?key=' + AK + '&since=' + evSince)
    for (const x of e.events || []) { evSince = Math.max(evSince, (x.t || 0) + 1); if (!/vault|error|guard|launch|jito/i.test(x.kind || x.type || '')) continue
      console.log(ts(Date.now()), 'EV', ts(x.t || 0), x.kind || x.type, String(x.msg || x.message || '').slice(0, 300)) } }
  if (Date.now() - lastHealth > 60_000) { lastHealth = Date.now(); const h: any = await get('/health'); console.log(ts(Date.now()), 'HEALTH', h.commit, h.ok, JSON.stringify(h.stream && { connected: h.stream.connected, polling: h.stream.polling }), 'mints', h.mints?.available) }
  await new Promise((r) => setTimeout(r, 4000))
}
console.log('end', ts(Date.now()))
