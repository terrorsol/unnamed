import { existsSync, createReadStream, readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { uploadMetadata } from './ipfs.ts'
import * as IPFS from './ipfs.ts'
import * as VM from './vamp.ts'
import * as KEEP from './keeper.ts'
import * as LL from './launchlab.ts'
import { createServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import nacl from 'tweetnacl'
import bs58 from 'bs58'
import { PublicKey } from '@solana/web3.js'
import * as D from './desk.ts'
import * as V from './vault.ts'
import * as INV from './invite.ts'
import * as EV from './events.ts'
import * as MP from './mintpool.ts'
import { TREASURY, RPC } from './chain.ts'
import * as R from './rules.ts'
import * as C from './chain.ts'
import { streamStats } from './stream.ts'

const PORT = +(process.env.PORT || 8787)
const json = (res: any, code: number, body: any) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, x-banker-session', 'access-control-allow-methods': 'GET,POST,OPTIONS' }); res.end(JSON.stringify(body)) }
const readBody = (req: any) => new Promise<any>((ok, no) => { let s = ''; req.on('data', (c: any) => { s += c; if (s.length > 2_500_000) { no(new Error('body too large')); req.destroy() } }); req.on('end', () => { try { ok(JSON.parse(s || '{}')) } catch { ok({}) } }) })
// per-IP token bucket: 300 reads / 60 writes per 10s — a phone polls ~1 req/s, carrier NAT shares one IP across many phones
const buckets = new Map<string, { t: number; n: number }>()
function limited(ip: string, write: boolean) { const now = Date.now(); const k = ip + (write ? 'w' : 'r'); const b = buckets.get(k) || { t: now, n: 0 }; if (now - b.t > 10_000) { b.t = now; b.n = 0 } b.n++; buckets.set(k, b); return b.n > (write ? 60 : 300) }
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now - b.t > 60_000) buckets.delete(k) }, 60_000)
const isPk = (x: any) => typeof x === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x)

const wlSet = new Set<string>(); const wlIp = new Map<string, number[]>()
const WL_OFF = Math.max(0, Math.floor(+(process.env.WAITLIST_OFFSITE ?? 334))) // sign-ups from other platforms (334 + 8 here = 342 on Oct 29); override in the Render env
const server = createServer(async (req, res) => {
  const u = new URL(req.url!, 'http://x'); const p = u.pathname; IPFS.learnBase(req as any)
    // private beta gate: every write route needs a session from a redeemed invite key (GATE=1). Reads stay open so the terminal is visible without one.
    const sessionWallet = INV.session(String(req.headers['x-banker-session'] || u.searchParams.get('session') || '')); (req as any).sessionWallet = sessionWallet
    const isAdmin = p.startsWith('/admin/') && !!process.env.ADMIN_KEY && u.searchParams.get('key') === process.env.ADMIN_KEY
    if (INV.GATE && req.method === 'POST' && !isAdmin && !['/invite/redeem', '/invite/session', '/waitlist', '/ipfs'].includes(p) && !sessionWallet) return json(res, 401, { error: 'invite key required', gate: true })
  if (req.method === 'OPTIONS') return json(res, 204, {})
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()
  if (limited(ip, req.method === 'POST')) return json(res, 429, { error: 'slow down' })
  try {
    // pubkey-shaped path params only
    for (const seg of [p.startsWith('/book/') && p.slice(6), p.startsWith('/vault/mint/') && p.slice(12), p.startsWith('/family/') && p.slice(8), p.startsWith('/vamp/') && p.slice(6), p.startsWith('/dev/') && p.slice(5), p.startsWith('/import/quote/') && p.slice(14)]) if (seg && !isPk(seg)) throw new Error('bad address')
    if (p === '/health') return json(res, 200, { ok: true, commit: (process.env.RENDER_GIT_COMMIT || '').slice(0, 8) || undefined, gate: INV.GATE, invites: INV.stats(), rpc: RPC.replace(/api-key=.*/, 'api-key=…'), treasury: TREASURY, desk: D.stats(), vaults: V.list().length, vaultWallet: V.sharedPub(), mints: MP.stats(), stream: streamStats(), curve: LL.curveInfo(), beta: { deskOnly: DESK_ONLY, paper: V.PAPER, importFeeSol: R.IMPORT_FEE_SOL, importSeedSol: R.IMPORT_SEED_SOL, keeper: KEEP.status(), feeBps: R.CROSS_FEE_BPS, profitOnly: process.env.PROFIT_ONLY === '1', testReclaim: process.env.TEST_RECLAIM === '1', mmBuys: process.env.MM_BUYS !== '0' || process.env.MM_ON === '1', deskBid: process.env.DESK_BID !== '0', maxChestSol: V.MAX_CHEST_SOL, pumpStream: !!process.env.PUMPPORTAL_KEY, ipfs: process.env.PINATA_JWT ? 'pinata' : 'self-hosted', landing: process.env.JITO === '1' ? 'jito' : C.FAST ? 'sender' : 'rpc', lastRoute: C.lastRoute } })
    if (p === '/ask/quote' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, await D.askQuote(b.askId, b.buyer, b.sol ? +b.sol : undefined)) }
    if (p === '/ask/fill' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, await D.askFill(b.askId, b.buyer, b.tx, b.sol ? +b.sol : undefined)) }
    if (p === '/myasks') { const me = u.searchParams.get('me') || ''; if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(me)) return json(res, 400, { error: 'me' }); return json(res, 200, D.myAsks(me)) }
    if (p === '/mybids') { const me = u.searchParams.get('me') || ''; if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(me)) return json(res, 400, { error: 'me' }); return json(res, 200, D.myBids(me)) }
    if (p === '/books') return json(res, 200, D.books())
    if (p === '/fills') return json(res, 200, D.history(u.searchParams.get('mint') || undefined))
    if (p === '/leaderboard') return json(res, 200, D.leaderboard(u.searchParams.get('me') || undefined))
    if (p === '/vamps') return json(res, 200, VM.list())
    if (p.startsWith('/vamp/')) { const m = p.slice(6); VM.watch(m); return json(res, 200, VM.forMint(m)) }
    if (p.startsWith('/family/')) return json(res, 200, await V.family(p.slice(8)))
    if (p.startsWith('/dev/')) return json(res, 200, V.byDev(p.slice(5)))
    if (DESK_ONLY && (p.startsWith('/vault') || p.startsWith('/import') || p.startsWith('/redeem') || p === '/bundle' || p === '/ipfs' || p.startsWith('/tape') || p.startsWith('/ll/launch') || p.startsWith('/pump/launch') || p === '/ll/platform/build')) return json(res, 503, { error: 'this server runs the desk only — vaults live on the main server' })
    if (p.startsWith('/meta/') && req.method === 'GET') { const f = IPFS.serveMeta(p.slice(6)); if (!f) return json(res, 404, { error: 'no such file' }); res.writeHead(200, { 'content-type': f.type, 'cache-control': 'public, max-age=31536000, immutable', 'access-control-allow-origin': '*' }); return res.end(f.body) }
    if (p === '/ipfs' && req.method === 'POST') { const b = await readBody(req); try { return json(res, 200, await uploadMetadata(b)) } catch (e: any) { return json(res, e.status || 400, { error: e.message }) } }
    if (p === '/redeem/quote' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, V.redeemQuote(b.mint, +b.tokens)) }
    if (p === '/redeem' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, await V.redeem(b.mint, b.holder, +b.tokens, b.tx)) }
    if (p.startsWith('/book/')) return json(res, 200, await D.book(p.slice(6), u.searchParams.get('me') || undefined))
    if (p === '/rfq' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, await D.rfqCreate(b.mint, b.seller, +b.sizeSol, +b.maxBps, +b.ttlMs)) }
    if (p.startsWith('/rfq/') && req.method === 'GET') return json(res, 200, D.rfqGet(p.slice(5)))
    if (p === '/rfq/cancel' && req.method === 'POST') { const b = await readBody(req); D.rfqCancel(b.id, b.seller); return json(res, 200, { ok: true }) }
    if (p === '/rfqs') return json(res, 200, D.rfqOpenFor(u.searchParams.get('mint') || undefined))
    if (p === '/quote' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, await D.quote(b.bidId, b.seller, b.sol ? +b.sol : undefined)) }
    if (p === '/fill' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, await D.fill(b.bidId, b.seller, b.tx, b.sol ? +b.sol : undefined)) }
    if (p === '/vaults') return json(res, 200, V.list())
    // waitlist (banker.cash landing): wallet + optional x handle → DATA_DIR/waitlist.jsonl. Open CORS, rate-limited per ip.
    // WAITLIST_OFFSITE: sign-ups collected on other platforms (forms, Discord, X), added to the public total; /admin/waitlist shows the split.
    if (p === '/invite/redeem' && req.method === 'POST') { const b = await readBody(req); const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0]; const rr = INV.redeem(String(b.code || ''), String(b.wallet || ''), String(b.msg || ''), String(b.sig || ''), ip); EV.log('gate', 'key redeemed', { wallet: rr.wallet }); return json(res, 200, rr) }
    if (p === '/invite/link' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, INV.link(String(req.headers['x-banker-session'] || b.token || ''), String(b.wallet || ''), String(b.msg || ''), String(b.sig || ''))) }
    if (p === '/invite/session' && req.method === 'POST') { const b = await readBody(req); const w = INV.session(String(b.token || '')); return json(res, w ? 200 : 401, w ? { ok: true, wallet: w } : { ok: false, gate: INV.GATE }) }
    if (p === '/admin/events' && req.method === 'GET') { if (!process.env.ADMIN_KEY || u.searchParams.get('key') !== process.env.ADMIN_KEY) return json(res, 403, { error: 'admin key' }); return json(res, 200, { stats: EV.stats(), events: EV.since(+(u.searchParams.get('since') || 0)).slice(-300) }) }
    if (p === '/admin/mints' && req.method === 'POST') { if (!process.env.ADMIN_KEY || u.searchParams.get('key') !== process.env.ADMIN_KEY) return json(res, 403, { error: 'admin key' }); const b = await readBody(req); const out: any = { added: [], rejected: [] }; for (const k of (b.keys || [])) { try { out.added.push(MP.add(k)) } catch (e: any) { out.rejected.push(String(e.message).slice(0, 80)) } } return json(res, 200, { ...out, pool: MP.stats() }) }
    if (p === '/admin/vault/stop' && req.method === 'POST') { if (!process.env.ADMIN_KEY || u.searchParams.get('key') !== process.env.ADMIN_KEY) return json(res, 403, { error: 'admin key' }); const b = await readBody(req); return json(res, 200, V.stop(String(b.id || ''))) }
    if (p === '/admin/vault/reconcile' && req.method === 'POST') { if (!process.env.ADMIN_KEY || u.searchParams.get('key') !== process.env.ADMIN_KEY) return json(res, 403, { error: 'admin key' }); const b = await readBody(req); return json(res, 200, await V.reconcile(String(b.id || ''))) }
    if (p === '/admin/vault/retire' && req.method === 'POST') { if (!process.env.ADMIN_KEY || u.searchParams.get('key') !== process.env.ADMIN_KEY) return json(res, 403, { error: 'admin key' }); const b = await readBody(req); return json(res, 200, V.retire(b.id)) }
    if (p === '/admin/waitlist' && req.method === 'GET') { if (!process.env.ADMIN_KEY || u.searchParams.get('key') !== process.env.ADMIN_KEY) return json(res, 403, { error: 'admin key' }); const f = (process.env.DATA_DIR || './data') + '/waitlist.jsonl'; const rows = existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) : []; return json(res, 200, { count: rows.length, offsite: WL_OFF, total: rows.length + WL_OFF, rows }) }
    if (p === '/admin/wallet' && req.method === 'GET') { if (!process.env.ADMIN_KEY || u.searchParams.get('key') !== process.env.ADMIN_KEY) return json(res, 403, { error: 'admin key' }); return json(res, 200, await V.sharedAudit()) }
    if (p === '/invite/redeemed' && req.method === 'GET') { if (!process.env.ADMIN_KEY || u.searchParams.get('key') !== process.env.ADMIN_KEY) return json(res, 403, { error: 'admin key' }); return json(res, 200, INV.redeemed()) }
    if (p === '/waitlist' && req.method === 'POST') { const b = await readBody(req); const wallet = String(b.wallet || '').trim(); const x = String(b.x || '').trim().replace(/^@/, '').slice(0, 32)
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) return json(res, 400, { error: 'that is not a Solana address' })
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0]; const now = Date.now(); const h = wlIp.get(ip) || []; const recent = h.filter((t) => now - t < 3600_000); if (recent.length >= 20) return json(res, 429, { error: 'slow down' }); recent.push(now); wlIp.set(ip, recent)
      const dir = process.env.DATA_DIR || './data'; const f = dir + '/waitlist.jsonl'; if (!wlSet.size && existsSync(f)) for (const l of readFileSync(f, 'utf8').split('\n')) { try { const e = JSON.parse(l); if (e.wallet) wlSet.add(e.wallet) } catch {} }
      const fresh = !wlSet.has(wallet); if (fresh) { wlSet.add(wallet); try { mkdirSync(dir, { recursive: true }); appendFileSync(f, JSON.stringify({ t: now, wallet, x, ua: String(req.headers['user-agent'] || '').slice(0, 80) }) + '\n') } catch {} }
      return json(res, 200, { ok: true, position: WL_OFF + (fresh ? wlSet.size : [...wlSet].indexOf(wallet) + 1), count: WL_OFF + wlSet.size }) }
    if (p === '/waitlist' && req.method === 'GET') { const dir = process.env.DATA_DIR || './data'; const f = dir + '/waitlist.jsonl'; if (!wlSet.size && existsSync(f)) for (const l of readFileSync(f, 'utf8').split('\n')) { try { const e = JSON.parse(l); if (e.wallet) wlSet.add(e.wallet) } catch {} } return json(res, 200, { count: WL_OFF + wlSet.size }) }
    if (p.startsWith('/candles/')) { const mint = p.slice(9).replace(/[^1-9A-HJ-NP-Za-km-z]/g, ''); const tf = Math.max(5, Math.min(3600, +(u.searchParams.get('tf') || 60))); return json(res, 200, V.candles(mint, tf, Math.min(2000, +(u.searchParams.get('limit') || 300)))) }
    if (p.startsWith('/tape/')) { const f = (process.env.DATA_DIR || './data') + '/tape/' + p.slice(6).replace(/[^1-9A-HJ-NP-Za-km-z]/g, '') + '.jsonl'; if (!existsSync(f)) return json(res, 404, { error: 'no tape' }); res.writeHead(200, { 'content-type': 'application/x-ndjson', 'access-control-allow-origin': '*' }); return createReadStream(f).pipe(res) }
    if (p.startsWith('/vault/mint/')) return json(res, 200, V.byMint(p.slice(12)))
    if (p.startsWith('/vault/') && req.method === 'GET') return json(res, 200, V.get(p.slice(7)))
    if (p === '/vault/create' && req.method === 'POST') { const b = await readBody(req); if (!(b.stakeSol > 0)) throw new Error('stake required'); if (sessionWallet && b.dev !== sessionWallet) return json(res, 403, { error: 'a vault is created for the signed-in wallet' }); return json(res, 200, V.create(b.dev, +b.stakeSol, b.copyOf, b.mode === 'floor' ? 'floor' : 'mm', b.ceiling != null ? +b.ceiling : undefined, b.venue === 'launchlab' ? 'launchlab' : 'pump', b.vaultBuySol != null ? +b.vaultBuySol : undefined, b.targetPct != null ? +b.targetPct : undefined)) }
    if (p === '/vault/refund' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, await V.refund(b.id, { ...(b.auth || {}), sessionWallet })) }
    if (p === '/vault/fund' && req.method === 'POST') { const b = await readBody(req); const v0 = V.devOf(b.id); if (sessionWallet && v0 && v0 !== sessionWallet) return json(res, 403, { error: 'not your vault' }); return json(res, 200, await V.fund(b.id, b.sig)) }
    if (p === '/vault/arm' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, await V.arm(b.id, b.mint, b.symbol || '', b.name || '', { ...(b.auth || {}), sessionWallet }, b.fundSig)) }
    if (p.startsWith('/import/quote/')) return json(res, 200, await V.importQuote(p.slice(14)))
    if (p === '/import/create' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, await V.importCreate(b.owner, b.mint)) }
    if (p === '/import/crowd' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, await V.importCrowd(b.owner, b.mint)) }
    if (p === '/import/contribute' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, await V.importContribute(b.id, b.from, b.sig, sessionWallet)) }
    if (p === '/import/open') return json(res, 200, V.crowdOpen())
    if (p === '/vault/paper' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, await V.paperArm(b.mint, +(b.chestSol || 20), b.mode || 'mm')) }
    if (p === '/import/activate' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, await V.importActivate(b.id, b.sig)) }
    if (p === '/vault/attach' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, await V.attach(String(b.dev || ''), String(b.mint || ''), { ...(b.auth || {}), sessionWallet }, { symbol: b.symbol, name: b.name })) }
    if (p === '/vault/deposit' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, await V.deposit(b.id, b.from, b.sig, sessionWallet)) }
    // ---- LaunchLab: our launchpad ----
    if (p === '/ll/platform' && req.method === 'GET') { const chain = await LL.platform(); const walletSol = (await C.conn.getBalance(LL.platformKeypair().publicKey).catch(() => 0)) / 1e9; return json(res, 200, { ...LL.status(), chain, ready: !!chain?.exists, walletSol, setup: chain?.exists ? null : LL.SELF_ADMIN ? `send 0.02 SOL to ${LL.platformKeypair().publicKey.toBase58()} — the server creates the platform config itself within a minute` : 'the admin wallet signs the one-time setup in Settings' }) }
    if (p === '/ll/platform/build' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, await LL.buildPlatformTx(new PublicKey(b.admin))) }
    if (p.startsWith('/ll/pool/') && req.method === 'GET') { const pl = await LL.pool(p.slice(9), 0); return json(res, 200, pl ? { ...pl, virtualA: String(pl.virtualA), virtualB: String(pl.virtualB), realA: String(pl.realA), realB: String(pl.realB), totalSellA: String(pl.totalSellA), totalFundRaisingB: String(pl.totalFundRaisingB), platformFee: String(pl.platformFee), ours: LL.isOurs(pl) } : null) }
    if (p === '/ll/quote' && req.method === 'GET') { const pct = u.searchParams.get('pct'); const dev = +(u.searchParams.get('dev') || 0); const vault = pct ? V.solForPct(+pct, dev) : +(u.searchParams.get('vault') || 0); return json(res, 200, { ...LL.blockZero(dev, vault), vaultSol: vault }) }
    if (p === '/pump/launch/build' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, await V.buildPumpLaunch({ ...b, auth: { ...(b.auth || {}), sessionWallet } })) }
    if (p === '/ll/launch/build' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, await V.buildLaunch({ ...b, auth: { ...(b.auth || {}), sessionWallet } })) }
    if (p.startsWith('/ll/permtax/') && req.method === 'GET') return json(res, 200, await LL.permTaxOf(p.slice(12)))
    if (p === '/ll/trade' && req.method === 'POST') { const b = await readBody(req); const tx = await LL.buildTrade(new PublicKey(b.owner), b.action === 'sell' ? 'sell' : 'buy', b.mint, b.amount, { slippageBps: b.slippageBps ? +b.slippageBps : undefined }); return json(res, 200, { tx: Buffer.from(tx.serialize()).toString('base64') }) }
    if (p === '/vault/bundle-sign' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, await V.signBundleTx(b.id, b.mint, b.tx, +b.maxSol, b.createTx, { ...(b.auth || {}), sessionWallet })) }
    if (p.startsWith('/market/') && req.method === 'GET') { const { market } = await import('./market.ts'); const m: any = await market(p.slice(8).replace(/[^1-9A-HJ-NP-Za-km-z]/g, '')).catch(() => null); return json(res, 200, m ? { priceSol: m.priceSol, mcapUsd: m.mcapUsd, liqSol: m.liqSol, onCurve: !!m.onCurve, venue: m.venue || (m.dexId === 'pumpfun' ? 'pump' : m.dexId), dexId: m.dexId, symbol: m.symbol || '', pair: m.pair || '', vol1h: m.vol1h || 0 } : null) }
    if (p.startsWith('/bundle/status/') && req.method === 'GET') { return json(res, 200, (await C.bundleStatus(p.slice(15)).catch(() => null)) || { status: 'unknown' }) }
    if (p === '/bundle' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, { bundleId: await V.sendBundle(b.txs) }) }
    if (p === '/vault/mode' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, V.setMode(b.id, b.dev, b.mode, b.ceiling != null ? +b.ceiling : undefined)) }
    if (p === '/vault/renounce' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, V.renounce(b.id, b.dev)) }
    json(res, 404, { error: 'not found' })
  } catch (e: any) { if (req.method === 'POST') EV.log('error', `${p}: ${String(e.message || e)}`, { ip: String(req.headers['x-forwarded-for'] || '').split(',')[0] }); json(res, 400, { error: String(e.message || e) }) }
})

// Bidders hold a websocket: auth by signing a message, then place/cancel/refresh; fills are relayed here for co-signing.
const wss = new WebSocketServer({ server })
wss.on('connection', (ws: WebSocket) => {
  let who = ''; D.registerBidderSocket(ws) // every socket gets public broadcasts (swaps, rfq pings); bids need auth
  const send = (o: any) => ws.readyState === 1 && ws.send(JSON.stringify(o))
  ws.on('message', async (raw) => {
    let m: any; try { m = JSON.parse(String(raw)) } catch { return }
    try {
      if (m.type === 'auth') {
        // an invite session token is an HMAC bound to the wallet that signed to get it: with one, no fresh signature per reconnect (no wallet popup every restart)
        const viaSession = !!m.session && INV.session(m.session) === m.pubkey
        if (!viaSession) {
          const msg = `unnamed-desk:${m.pubkey}:${m.ts}`; if (Math.abs(Date.now() - m.ts) > 120000) throw new Error('stale auth')
          if (!m.sig || !nacl.sign.detached.verify(new TextEncoder().encode(msg), bs58.decode(m.sig), bs58.decode(m.pubkey))) throw new Error('bad signature')
          if (INV.GATE) throw new Error('invite key required')
        }
        who = m.pubkey; const back = D.reattach(ws, who); return send({ type: 'authed', pubkey: who, rfqs: D.rfqOpenFor(), reattached: back })
      }
      if (!who) throw new Error('auth first')
      if (m.type === 'place') return send({ type: 'placed', bid: await D.place(ws, who, m.mint, +m.sol, +m.discBps) })
      if (m.type === 'cancel') return send({ type: 'cancelled', id: m.id, ok: D.cancel(who, m.id) })
      if (m.type === 'place_ask') return send({ type: 'placed_ask', ask: await D.placeAsk(ws, who, m.mint, +m.sol, +m.discBps) })
      if (m.type === 'cancel_ask') return send({ type: 'cancelled_ask', id: m.id, ok: D.cancelAsk(who, m.id) })
      if (m.type === 'filled_ask') return D.settleAsk(m.askId, true, m.sig)
      if (m.type === 'reject_ask') return D.settleAsk(m.askId, false, undefined, m.err)
      if (m.type === 'buy_rfq') return send({ type: 'placed', bid: await D.rfqBuy(ws, who, m.mint, +m.sol, +m.premiumBps, +m.ttlSec) })
      if (m.type === 'refresh') return D.refresh(who)
      if (m.type === 'rfq_respond') return send({ type: 'rfq_responded', rfq: await D.rfqRespond(ws, who, m.rfqId, +m.discBps, +m.sol) })
      if (m.type === 'filled') return D.settle(m.bidId, true, m.sig)
      if (m.type === 'reject') return D.settle(m.bidId, false, undefined, m.err)
    } catch (e: any) { if (m?.type !== 'auth') EV.log('ws-error', `${m?.type}: ${String(e.message || e)}`, { who: who.slice(0, 8) }); send({ type: 'error', error: String(e.message || e), re: m?.type }) }
  })
  ws.on('close', () => D.dropSocket(ws))
})
setInterval(D.sweep, 10000); setInterval(D.rfqSweep, 5000)
D.setVaultResponder(V.respondRfq)
// DESK_ONLY=1: ephemeral/public-tunnel deployments — the desk is non-custodial so it is safe to run anywhere; vaults (server-held keys) stay off.
export const DESK_ONLY = process.env.DESK_ONLY === '1'
if (!DESK_ONLY) { V.load(); V.startStream(); setInterval(() => V.tick().catch(() => {}), 5000); setInterval(() => V.crowdSweep().catch(() => {}), 60000); setInterval(() => V.autoArm().catch(() => {}), 15000); setInterval(() => V.trackTick().catch(() => {}), 4000); const ep = () => LL.ensurePlatform().catch((e) => console.log('platform setup: ' + String(e.message).slice(0, 120))); setTimeout(ep, 8000); setInterval(ep, 60000) }
else console.log('desk-only mode: vault/import routes disabled')
if (process.env.VAMPS !== '0') VM.start()
server.listen(PORT, () => console.log(`banker server on :${PORT} · treasury ${TREASURY}`))
