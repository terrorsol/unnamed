// read-only: wait for the new build, then (after the books' 3-minute fit window) the audit, the new events and every chest
const S = 'https://unnamed-server.onrender.com'; const AK = process.env.ADMIN_KEY || ''; const WANT = 'f61c9548'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)); let up = 0
for (let i = 0; i < 60; i++) { const h: any = await fetch(S + '/health', { signal: AbortSignal.timeout(8000) }).then((r) => r.json()).catch(() => ({})); if (h.commit?.startsWith(WANT)) { up = Date.now(); console.log(new Date().toISOString().slice(11, 19), 'live', h.commit, 'stream', JSON.stringify(h.stream && { connected: h.stream.connected })); break } await sleep(10000) }
if (!up) { console.log('NOT LIVE'); process.exit(0) }
await sleep(250_000)
const w: any = await fetch(S + '/admin/wallet?key=' + AK).then((r) => r.json()).catch((e) => ({ err: String(e) })); console.log('AUDIT', JSON.stringify(w).slice(0, 400))
const e: any = await fetch(S + '/admin/events?key=' + AK + '&since=' + (up - 120_000)).then((r) => r.json()).catch(() => ({}))
for (const x of e.events || []) if (!/ capture [0-9.]+ SOL$/.test(x.msg || '')) console.log('EV', new Date(x.t).toISOString().slice(11, 19), x.kind, String(x.msg || '').slice(0, 240))
const vs: any = await fetch(S + '/vaults').then((r) => r.json()).catch(() => []); for (const v of vs) console.log('VAULT', v.symbol, v.venue, v.mint.slice(0, 6), 'chest', (+v.chest).toFixed(4), 'tokens', Math.round(v.tokens))
process.exit(0)
