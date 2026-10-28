import { createServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import nacl from 'tweetnacl'
import bs58 from 'bs58'
import * as D from './desk.ts'
import * as V from './vault.ts'
import { TREASURY, RPC } from './chain.ts'
import { streamStats } from './stream.ts'

const PORT = +(process.env.PORT || 8787)
const json = (res: any, code: number, body: any) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' }); res.end(JSON.stringify(body)) }
const readBody = (req: any) => new Promise<any>((ok) => { let s = ''; req.on('data', (c: any) => (s += c)); req.on('end', () => { try { ok(JSON.parse(s || '{}')) } catch { ok({}) } }) })

const server = createServer(async (req, res) => {
  const u = new URL(req.url!, 'http://x'); const p = u.pathname
  if (req.method === 'OPTIONS') return json(res, 204, {})
  try {
    if (p === '/health') return json(res, 200, { ok: true, rpc: RPC.replace(/api-key=.*/, 'api-key=…'), treasury: TREASURY, desk: D.stats(), vaults: V.list().length, stream: streamStats() })
    if (p === '/books') return json(res, 200, D.books())
    if (p === '/fills') return json(res, 200, D.history(u.searchParams.get('mint') || undefined))
    if (p === '/leaderboard') return json(res, 200, D.leaderboard())
    if (p.startsWith('/family/')) return json(res, 200, await V.family(p.slice(8)))
    if (p.startsWith('/dev/')) return json(res, 200, V.byDev(p.slice(5)))
    if (p === '/redeem/quote' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, V.redeemQuote(b.mint, +b.tokens)) }
    if (p === '/redeem' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, await V.redeem(b.mint, b.holder, +b.tokens, b.tx)) }
    if (p.startsWith('/book/')) return json(res, 200, await D.book(p.slice(6), u.searchParams.get('me') || undefined))
    if (p === '/rfq' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, await D.rfqCreate(b.mint, b.seller, +b.sizeSol, +b.maxBps, +b.ttlMs)) }
    if (p.startsWith('/rfq/') && req.method === 'GET') return json(res, 200, D.rfqGet(p.slice(5)))
    if (p === '/rfq/cancel' && req.method === 'POST') { const b = await readBody(req); D.rfqCancel(b.id, b.seller); return json(res, 200, { ok: true }) }
    if (p === '/rfqs') return json(res, 200, D.rfqOpenFor(u.searchParams.get('mint') || undefined))
    if (p === '/quote' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, await D.quote(b.bidId, b.seller)) }
    if (p === '/fill' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, await D.fill(b.bidId, b.seller, b.tx)) }
    if (p === '/vaults') return json(res, 200, V.list())
    if (p.startsWith('/vault/mint/')) return json(res, 200, V.byMint(p.slice(12)))
    if (p.startsWith('/vault/') && req.method === 'GET') return json(res, 200, V.get(p.slice(7)))
    if (p === '/vault/create' && req.method === 'POST') { const b = await readBody(req); if (!(b.stakeSol > 0)) throw new Error('stake required'); return json(res, 200, V.create(b.dev, +b.stakeSol, b.copyOf, b.mode === 'floor' ? 'floor' : 'mm', b.ceiling != null ? +b.ceiling : undefined)) }
    if (p === '/vault/arm' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, await V.arm(b.id, b.mint, b.symbol || '', b.name || '')) }
    if (p.startsWith('/import/quote/')) return json(res, 200, await V.importQuote(p.slice(14)))
    if (p === '/import/create' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, await V.importCreate(b.owner, b.mint)) }
    if (p === '/import/activate' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, await V.importActivate(b.id, b.sig)) }
    if (p === '/vault/deposit' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, await V.deposit(b.id, b.from, b.sig)) }
    if (p === '/vault/bundle-sign' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, await V.signBundleTx(b.id, b.mint, b.tx, +b.maxSol)) }
    if (p === '/bundle' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, { bundleId: await V.sendBundle(b.txs) }) }
    if (p === '/vault/mode' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, V.setMode(b.id, b.dev, b.mode, b.ceiling != null ? +b.ceiling : undefined)) }
    if (p === '/vault/renounce' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, V.renounce(b.id, b.dev)) }
    json(res, 404, { error: 'not found' })
  } catch (e: any) { json(res, 400, { error: String(e.message || e) }) }
})

// Bidders hold a websocket: auth by signing a message, then place/cancel/refresh; fills are relayed here for co-signing.
const wss = new WebSocketServer({ server })
wss.on('connection', (ws: WebSocket) => {
  let who = ''
  const send = (o: any) => ws.readyState === 1 && ws.send(JSON.stringify(o))
  ws.on('message', async (raw) => {
    let m: any; try { m = JSON.parse(String(raw)) } catch { return }
    try {
      if (m.type === 'auth') {
        const msg = `unnamed-desk:${m.pubkey}:${m.ts}`; if (Math.abs(Date.now() - m.ts) > 120000) throw new Error('stale auth')
        if (!nacl.sign.detached.verify(new TextEncoder().encode(msg), bs58.decode(m.sig), bs58.decode(m.pubkey))) throw new Error('bad signature')
        who = m.pubkey; D.registerBidderSocket(ws); return send({ type: 'authed', pubkey: who, rfqs: D.rfqOpenFor() })
      }
      if (!who) throw new Error('auth first')
      if (m.type === 'place') return send({ type: 'placed', bid: await D.place(ws, who, m.mint, +m.sol, +m.discBps) })
      if (m.type === 'cancel') return send({ type: 'cancelled', id: m.id, ok: D.cancel(who, m.id) })
      if (m.type === 'refresh') return D.refresh(who)
      if (m.type === 'rfq_respond') return send({ type: 'rfq_responded', rfq: await D.rfqRespond(ws, who, m.rfqId, +m.discBps, +m.sol) })
      if (m.type === 'filled') return D.settle(m.bidId, true, m.sig)
      if (m.type === 'reject') return D.settle(m.bidId, false, undefined, m.err)
    } catch (e: any) { send({ type: 'error', error: String(e.message || e), re: m?.type }) }
  })
  ws.on('close', () => D.dropSocket(ws))
})
setInterval(D.sweep, 10000); setInterval(D.rfqSweep, 5000)
D.setVaultResponder(V.respondRfq)
V.load(); V.startStream(); setInterval(() => V.tick().catch(() => {}), 5000)
server.listen(PORT, () => console.log(`unnamed server on :${PORT} · treasury ${TREASURY}`))
