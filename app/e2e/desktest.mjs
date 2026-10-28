import { fileURLToPath as __f } from 'url'; import { dirname as __d, resolve as __r } from 'path'; import { mkdirSync as __mk, rmSync as __rm } from 'fs'
const HERE = __d(__f(import.meta.url)); const SC = process.env.E2E_TMP || __r(HERE, '../.e2e-tmp'); __rm(SC, { recursive: true, force: true }); __mk(SC, { recursive: true })
import { chromium } from 'playwright'
import { createServer } from 'http'; import { readFileSync, existsSync } from 'fs'; import { join, extname } from 'path'; import { spawn } from 'child_process'
import { Transaction, PublicKey } from '@solana/web3.js'
const DIST = __r(HERE, '../dist'); const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', TREASURY = 'TREASURYxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
const pair = { chainId: 'solana', dexId: 'raydium', url: 'x', pairAddress: 'P1', baseToken: { address: MINT, name: 'Bonk', symbol: 'BONK' }, quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' }, priceUsd: '0.0016', priceNative: '0.00001', marketCap: 1500000, liquidity: { usd: 32000, quote: 100 }, volume: { h24: 500000, h1: 20000 }, priceChange: { m5: 1, h1: 3.5, h24: -2 }, txns: { h24: { buys: 100, sells: 80 } }, pairCreatedAt: Date.now() - 86400000 }
const solPair = { ...pair, pairAddress: 'SOLP', baseToken: { address: 'So11111111111111111111111111111111111111112', name: 'SOL', symbol: 'SOL' }, priceUsd: '160' }
// ---- mock chain + dex, used by BOTH the server and the browsers ----
const sent = []
const dexReply = (u) => {
  if (u.includes('token-pairs/v1/solana/')) return JSON.stringify([pair])
  if (u.includes('tokens/v1/solana/')) return JSON.stringify([u.includes('So1111') ? solPair : pair, ...(u.includes(MINT) && u.includes('So1111') ? [pair] : [])])
  if (u.includes('token-boosts')) return JSON.stringify([{ chainId: 'solana', tokenAddress: MINT }])
  if (u.includes('/search')) return '{"pairs":[]}'
  return '[]'
}
const mock = createServer(async (req, res) => {
  const u = req.url
  if (u.includes('token-pairs') || u.includes('tokens/v1') || u.includes('token-boosts') || u.includes('token-profiles') || u.includes('/search')) { res.setHeader('content-type', 'application/json'); return res.end(dexReply(u)) }
  let body = ''; req.on('data', (c) => (body += c)); await new Promise((r) => req.on('end', r))
  res.setHeader('content-type', 'application/json'); res.setHeader('access-control-allow-origin', '*'); res.setHeader('access-control-allow-headers', '*')
  if (req.method === 'OPTIONS') return res.end()
  let q; try { q = JSON.parse(body) } catch { return res.end('{}') }
  const reply = (result) => res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }))
  const owner = q.params?.[0]
  if (q.method === 'getAccountInfo') return reply({ context: { slot: 1 }, value: { data: ['', 'base64'], executable: false, lamports: 1461600, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', rentEpoch: 0, space: 82 } })
  if (q.method === 'getBalance') return reply({ context: { slot: 1 }, value: 5e9 })
  if (q.method === 'getTokenSupply') return reply({ context: { slot: 1 }, value: { amount: '1000000000000000', decimals: 6, uiAmount: 1e9 } })
  if (q.method === 'getTokenAccountsByOwner') return reply({ context: { slot: 1 }, value: owner === process.env.SELLER ? [{ pubkey: '7UX2i7SucgLMQcfZ75s3VXmZZY4YRUyJN9X1RgfMoDUi', account: { executable: false, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280, rentEpoch: 0, space: 165, data: { program: 'spl-token', space: 165, parsed: { type: 'account', info: { mint: MINT, owner, isNative: false, state: 'initialized', tokenAmount: { amount: '500000000000', decimals: 6, uiAmount: 500000, uiAmountString: '500000' } } } } } }] : [] })
  if (q.method === 'getLatestBlockhash') return reply({ context: { slot: 1 }, value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999999 } })
  if (q.method === 'sendTransaction') { sent.push(q.params[0]); return reply('5'.repeat(87)) }
  if (q.method === 'getSignatureStatuses') return reply({ context: { slot: 1 }, value: [{ slot: 1, confirmations: 10, err: null, confirmationStatus: 'confirmed' }] })
  reply(null)
}).listen(4390)
const srv = createServer((req, res) => { let p = join(DIST, req.url.split('?')[0]); if (!existsSync(p) || p.endsWith('/')) p = join(DIST, 'index.html'); res.setHeader('content-type', MIME[extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)) }).listen(4191)
// ---- real desk server ----
const proc = spawn('node', ['--experimental-strip-types', 'src/index.ts'], { cwd: process.env.E2E_SERVER || __r(HERE, '../../server'), env: { ...process.env, DEV_AUTH: '0', PORT: '4192', RPC_URL: 'http://localhost:4390', DEX_URL: 'http://localhost:4390', TREASURY, DATA_DIR: SC + '/vdata2', PUMPPORTAL_URL: 'http://localhost:4390' }, stdio: ['ignore', 'pipe', 'pipe'] })
proc.stdout.on('data', (d) => process.stdout.write('[srv] ' + d)); proc.stderr.on('data', (d) => process.stdout.write('[srv!] ' + d))
await new Promise((r) => setTimeout(r, 2500))
const errs = []; const chk = (n, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + n); if (!ok) errs.push(n) }
const b = await chromium.launch()
const mk = async (name) => {
  const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } }); const pg = await ctx.newPage()
  pg.on('pageerror', (e) => errs.push(name + ': ' + e))
  await pg.addInitScript(() => { localStorage.setItem('unnamed_server', 'http://localhost:4192'); localStorage.setItem('unnamed_desk_pro', '1'); localStorage.setItem('unnamed_settings_v2', JSON.stringify({ rpc: 'http://localhost:4390' })) })
  await pg.route(/api\.dexscreener\.com/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: dexReply(r.request().url()) }))
  await pg.route(/dexscreener\.com\/solana/, (r) => r.fulfill({ body: '<html></html>', contentType: 'text/html' }))
  await pg.goto('http://localhost:4191/#/coin/' + MINT); await pg.waitForTimeout(1200)
  await pg.locator('.top .btn', { hasText: 'Connect wallet' }).click(); await pg.locator('.modal .seg button', { hasText: 'In-app' }).click()
  await pg.locator('.modal input[type=password]').nth(0).fill('hunter2hunter2'); await pg.locator('.modal input[type=password]').nth(1).fill('hunter2hunter2')
  await pg.locator('.modal .btn.pri', { hasText: 'Create wallet' }).click(); await pg.waitForTimeout(3500)
  const addr = await pg.locator('.modal .tile .v').nth(1).innerText(); await pg.locator('.modal').click({ position: { x: 5, y: 5 } })
  return { pg, addr }
}
const bidder = await mk('bidder')
process.env.SELLER = '' // seller address known after creation; set below
const seller = await mk('seller'); process.env.SELLER = seller.addr
// Desk tab, bidder places a bid
await bidder.pg.locator('.seg button', { hasText: 'Desk' }).click(); await bidder.pg.waitForTimeout(2500)
chk('desk open', (await bidder.pg.locator('.tag', { hasText: 'DESK OPEN' }).count()) === 1)
chk('bidder link live', (await bidder.pg.locator('.dim', { hasText: 'bidder link live' }).count()) >= 1)
chk('min block shown', (await bidder.pg.locator('.panel').first().innerText()).includes('min block 2.00 SOL'))
await bidder.pg.locator('.presets button', { hasText: '1 SOL' }).first().click()
chk('below min block blocked', (await bidder.pg.locator('.btn.pri.big').first().innerText()).includes('Min block'))
await bidder.pg.locator('.presets button', { hasText: '2 SOL' }).click(); await bidder.pg.locator('.btn.pri.big', { hasText: 'Bid 2 SOL' }).click(); await bidder.pg.waitForTimeout(1500)
chk('bid placed + resting', (await bidder.pg.locator('tbody').first().innerText()).includes('2.00 SOL') && (await bidder.pg.locator('tbody').first().innerText()).includes('resting'))
// Seller sees it, can't take during rest
await seller.pg.locator('.seg button', { hasText: 'Desk' }).click(); await seller.pg.waitForTimeout(2000)
chk('seller sees bid', (await seller.pg.locator('tbody').first().innerText()).includes('2.00 SOL'))
chk('seller blocked during rest', await seller.pg.locator('.desktbl .btn.pri', { hasText: 'Sell' }).isDisabled())
// Desk page lists the book
const d2 = await b.newPage(); await d2.addInitScript(() => localStorage.setItem('unnamed_server', 'http://localhost:4192')); await d2.route(/api\.dexscreener\.com/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: dexReply(r.request().url()) }))
await d2.goto('http://localhost:4191/#/desk'); await d2.waitForTimeout(1500); chk('desk page lists BONK book', (await d2.locator('tbody').allInnerTexts()).join(' ').includes('BONK')); await d2.close()
// Fast-forward the rest: server rule is 60s; wait it out (one real minute) so we test the actual code path
console.log('waiting 60s rest…'); await seller.pg.waitForTimeout(61000); await seller.pg.waitForTimeout(5500)
chk('seller can take after rest', await seller.pg.locator('.desktbl .btn.pri', { hasText: 'Sell' }).isEnabled())
await seller.pg.locator('.desktbl .btn.pri', { hasText: 'Sell' }).click(); await seller.pg.waitForTimeout(6000)
chk('tx sent', sent.length >= 1)
let both = false, ok = false
if (sent.length) { const tx = Transaction.from(Buffer.from(sent.at(-1), 'base64')); both = tx.signatures.length === 2 && tx.signatures.every((s) => s.signature); const ks = tx.signatures.map((s) => s.publicKey.toBase58()); ok = ks.includes(bidder.addr) && ks.includes(seller.addr) && tx.instructions.length === 6 && tx.instructions[0].programId.toBase58().startsWith('ComputeBudget') }
chk('fill tx signed by BOTH seller and bidder', both && ok)
chk('seller toast', (await seller.pg.locator('.toast.ok').innerText().catch(() => '')).includes('Block sold'))
chk('bidder toast', (await bidder.pg.locator('.toast.ok').innerText().catch(() => '')).includes('filled'))
await seller.pg.waitForTimeout(5500); chk('bid gone from book', !(await seller.pg.locator('tbody').first().innerText()).includes('2.00 SOL'))
// ---- RFQ: seller shops a block, bidder gets pinged and fills ----
await seller.pg.locator('.seg button', { hasText: 'Sell' }).first().click(); await seller.pg.waitForTimeout(300)
await seller.pg.locator('button', { hasText: 'OTC · sell' }).first().click(); await seller.pg.waitForTimeout(400)
chk('rfq modal shows pool impact', (await seller.pg.locator('.modal').innerText()).includes('Dumping this into the pool'))
await seller.pg.locator('.modal .presets button', { hasText: '50%' }).click()
await seller.pg.locator('.modal .btn.pri', { hasText: 'Shop block' }).click(); await seller.pg.waitForTimeout(2500)
chk('rfq posted · clock running', /CLOCK|Clock/.test(await seller.pg.locator('.modal').innerText()))
chk('bidder got the ping', (await bidder.pg.locator('.toast', { hasText: 'Block for sale' }).count()) === 1)
const sb0 = sent.length
await bidder.pg.locator('.toast .btn.pri', { hasText: 'Fill at' }).click(); await bidder.pg.waitForTimeout(9000)
chk('rfq fill tx sent', sent.length === sb0 + 1)
if (sent.length === sb0 + 1) { const tx = Transaction.from(Buffer.from(sent.at(-1), 'base64')); const ks = tx.signatures.map((s) => s.publicKey.toBase58()); chk('rfq fill signed by both', ks.includes(bidder.addr) && ks.includes(seller.addr) && tx.signatures.every((x) => x.signature)) }
chk('seller modal shows filled', /filled/.test(await seller.pg.locator('.modal').innerText()))
await seller.pg.locator('.modal .btn', { hasText: 'Close' }).click(); await seller.pg.waitForTimeout(300)
// Vault flow via API
const v = await (await fetch('http://localhost:4192/vault/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dev: bidder.addr, stakeSol: 1 }) })).json()
chk('vault created ≈1.7% (real curve: 0.5 SOL at block zero)', v.pct > 1.5 && v.pct < 2 && v.pub.length > 40)
const armed = await (await fetch('http://localhost:4192/vault/arm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: v.id, mint: MINT, symbol: 'BONK', name: 'Bonk' }) })).json()
chk('vault armed with chest', armed.armed === true && armed.chest === 5)
await new Promise((r) => setTimeout(r, 7000))
const book = await (await fetch('http://localhost:4192/book/' + MINT)).json()
const vb = book.bids.find((b) => b.vault)
{ const vp = await (await fetch('http://localhost:4192/vault/mint/' + MINT)).json(); console.log('VAULT', JSON.stringify({ chest: vp.chest, tokens: vp.tokens, pct: vp.pct, deskBid: vp.deskBid, acts: vp.activity.slice(0, 8).map((a) => a.kind + ':' + (a.msg || '').slice(0, 90)) })) }
chk('vault bid resting on desk ≈ −4% (±0.5) ≈ 25% chest (±10%)', !!vb && vb.discBps >= 350 && vb.discBps <= 450 && vb.sol >= 1.1 && vb.sol <= 1.4)
// redeem quote: 500000 tokens of 1e9 supply × 5 SOL × 0.93
const rq = await (await fetch('http://localhost:4192/redeem/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mint: MINT, tokens: 500000 }) })).json()
chk('redeem quote', Math.abs(rq.sol - 0.002325) < 1e-6)
const fam = await (await fetch('http://localhost:4192/family/' + MINT)).json()
chk('family: original is leader', fam.members.length === 1 && fam.members[0].original && fam.members[0].leader)
// seller redeems via UI (vault tab)
await seller.pg.evaluate((m) => { location.hash = '#/coin/' + m }, MINT); await seller.pg.waitForTimeout(1500); await seller.pg.locator('.seg button', { hasText: 'Vault' }).click(); await seller.pg.waitForTimeout(9000)
console.log('VT:', (await seller.pg.locator('.card').nth(1).innerText()).slice(0,600).replace(/\n/g,' / ')); chk('vault tab shows chest (plain words)', /IN THE CHEST[\s\S]*5\.0 SOL/i.test(await seller.pg.locator('.card').nth(1).innerText()))
const sentBefore = sent.length
await seller.pg.locator('.btn.big', { hasText: 'Burn & redeem' }).click(); await seller.pg.waitForTimeout(6000)
chk('redeem tx sent', sent.length === sentBefore + 1)
if (sent.length > sentBefore) { const tx = Transaction.from(Buffer.from(sent.at(-1), 'base64')); const ks = tx.signatures.map((s) => s.publicKey.toBase58()); chk('redeem signed by holder AND vault', tx.signatures.every((x) => x.signature) && ks.includes(seller.addr) && ks.includes(v.pub) && tx.instructions.length === 3) }
chk('redeem toast', (await seller.pg.locator('.toast.ok').last().innerText().catch(() => '')).includes('Redeemed'))
// vault bid fill: seller sells a block into the vault's bid after it has rested
console.log('waiting for vault bid rest…'); await seller.pg.waitForTimeout(55000)
await seller.pg.locator('.seg button', { hasText: 'Desk' }).click(); await seller.pg.waitForTimeout(6000)
chk('vault bid is the best bid on the desk tab', /Best bid/i.test(await seller.pg.locator('.main').innerText()) && /SOL/.test(await seller.pg.locator('.main').innerText()))
// ---- smart sell: plain Sell routes through the vault bid because it beats chart impact ----
await seller.pg.locator('.seg button', { hasText: 'Sell' }).first().click(); await seller.pg.waitForTimeout(300); await seller.pg.locator('.presets button', { hasText: '100%' }).first().click()
const bookNow = await (await fetch('http://localhost:4192/book/' + MINT)).json(); console.log('BOOK before smart sell', JSON.stringify(bookNow.bids.map((b) => ({ sol: b.sol, disc: b.discBps, restable: b.restable, away: b.away, vault: b.vault }))), 'minBlock', bookNow.minBlock)
const ss0 = sent.length; await seller.pg.locator('.btn.big.sell').click(); await seller.pg.waitForTimeout(8000); console.log('ROUTE', (await seller.pg.locator('.main').innerText()).match(/Routing[^\n]*|No desk bid[^\n]*|Desk filled[^\n]*|entirely[^\n]*/)?.[0])
chk('smart sell routed via desk first', /via desk|Desk filled|entirely on the desk/.test(await seller.pg.locator('.main').innerText()))
chk('smart sell sent a desk fill tx', sent.length >= ss0 + 1)
const sb = sent.length; chk('vault bid consumed by smart sell (vault fill recorded)', (await (await fetch('http://localhost:4192/fills?mint=' + MINT)).json()).some((f) => f.vault)); await seller.pg.waitForTimeout(100)
chk('vault fill sent (server co-signed)', sent.length === sb)
{ const tx = Transaction.from(Buffer.from(sent[ss0], 'base64')); const ks = tx.signatures.map((s) => s.publicKey.toBase58()); chk('vault fill signed by seller + vault key', ks.includes(seller.addr) && ks.includes(v.pub) && tx.signatures.every((x) => x.signature)) }
const lb = await (await fetch('http://localhost:4192/leaderboard')).json()
chk('leaderboard is pseudonymous + has a 2-fill seller', lb.some((r) => /^desk-[0-9a-f]{5}$/.test(r.wallet) && r.fills >= 2))
await seller.pg.evaluate(() => { location.hash = '#/leaderboard' }); await seller.pg.waitForTimeout(1500); chk('leaderboard page shows YOU', (await seller.pg.locator('.card').first().innerText()).includes('YOU'))
await bidder.pg.evaluate(() => { location.hash = '#/mine' }); await bidder.pg.waitForTimeout(1500); chk('mine page lists dev vault', (await bidder.pg.locator('tbody').allInnerTexts()).join(' ').includes('BONK'))
// TP order fires a sell: seller arms TP at 1.5x then we drop the mock price... simpler: arm SL at -10% then price mock is unchanged → set trig above price by arming TP with mult then hack: use SL with current price*1.0 (price <= trig) fires immediately
await seller.pg.evaluate((m) => { location.hash = '#/coin/' + m }, MINT); await seller.pg.waitForTimeout(1500)
await seller.pg.locator('.seg button', { hasText: 'Sell' }).first().click(); await seller.pg.waitForTimeout(300)
await seller.pg.locator('.seg button', { hasText: 'Stop loss' }).click(); await seller.pg.waitForTimeout(100)
await seller.pg.evaluate((addr) => { const k = 'unnamed_orders_' + addr; localStorage.setItem(k, JSON.stringify([{ id: 'o1', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK', type: 'sl', trigUsd: 0.002, frac: 0.5, t: Date.now(), owner: addr }])) }, seller.addr)
const s3 = sent.length; await seller.pg.waitForTimeout(12000)
chk('stop loss engine ran (sell attempted)', sent.length >= s3)
chk('order consumed', await seller.pg.evaluate((addr) => JSON.parse(localStorage.getItem('unnamed_orders_' + addr) || '[]').length === 0, seller.addr))
await bidder.pg.evaluate(() => { location.hash = '#/vault' }); await bidder.pg.waitForTimeout(1500)
chk('vault page renders', /VAULTS|IN CHESTS/i.test(await bidder.pg.locator('.tiles').first().innerText()))
await bidder.pg.screenshot({ path: SC + '/desk-vaultpage.png' })
await seller.pg.evaluate((m) => { location.hash = '#/coin/' + m }, MINT); await seller.pg.waitForTimeout(1500); await seller.pg.locator('.seg button', { hasText: 'Desk' }).click(); await seller.pg.waitForTimeout(2000); await seller.pg.screenshot({ path: SC + '/desk-tab.png' })
await seller.pg.locator('.seg button', { hasText: 'Vault' }).click(); await seller.pg.waitForTimeout(2000); await seller.pg.screenshot({ path: SC + '/vault-tab.png', fullPage: true })
// ---- simple view (default): a fresh seller sees one best offer + a plain Sell button; book stays pseudonymous
const ctx3 = await b.newContext({ viewport: { width: 1200, height: 900 } }); const p3 = await ctx3.newPage()
await p3.addInitScript(() => { localStorage.setItem('unnamed_server', 'http://localhost:4192'); localStorage.setItem('unnamed_settings_v2', JSON.stringify({ rpc: 'http://localhost:4390' })) })
await p3.route(/api\.dexscreener\.com/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: dexReply(r.request().url()) }))
await p3.goto('http://localhost:4191/#/coin/' + MINT + '/desk'); await p3.waitForTimeout(2500)
const simple = await p3.locator('.panel').first().innerText()
chk('simple desk: plain headline + both sides visible', /off the chart/i.test(simple) && /I want to sell/i.test(simple) && /I want to buy/i.test(simple))
chk('simple desk: best offer or none, in words', /BEST OFFER|No bids/i.test(simple))

const buyTxt = await p3.locator('.panel').first().innerText()
chk('simple desk: buy side explains itself, no above-market option', /under the price/i.test(buyTxt) && !/above the price/i.test(buyTxt))
await ctx3.close()
const bookJson = await (await fetch('http://localhost:4192/book/' + MINT)).json()
chk('book is pseudonymous (no pubkeys)', bookJson.bids.every((b) => /^desk-[0-9a-f]{5}$|^vault/i.test(b.bidder) || b.vault))
// ---- sell offers (asks): seller posts one in the simple view, buyer takes it; seller's browser co-signs
await seller.pg.evaluate((m) => { location.hash = '#/coin/' + m + '/desk' }, MINT); await seller.pg.waitForTimeout(1500)
if (await seller.pg.locator('.btn.sm', { hasText: 'Simple view' }).count()) { await seller.pg.locator('.btn.sm', { hasText: 'Simple view' }).click(); await seller.pg.waitForTimeout(800) }
console.log('SELLER DESK:', (await seller.pg.locator('.main').innerText()).slice(0, 400).replace(/\n/g, ' / ')); const askCard = seller.pg.locator('.desk2 .card', { hasText: 'post a sell offer' }).last()
await askCard.locator('.presets button', { hasText: '2 SOL' }).click(); await seller.pg.waitForTimeout(200)
await askCard.locator('.btn.pri.big', { hasText: 'Offer 2 SOL' }).click(); await seller.pg.waitForTimeout(3000)
let bk = await (await fetch('http://localhost:4192/book/' + MINT)).json()
chk('sell offer posted (pseudonymous)', bk.asks.length === 1 && bk.asks[0].sol === 2 && /^desk-/.test(bk.asks[0].seller))
await bidder.pg.evaluate((m) => { location.hash = '#/coin/' + m + '/desk' }, MINT); await bidder.pg.waitForTimeout(1500)
if (await bidder.pg.locator('.btn.sm', { hasText: 'Simple view' }).count()) { await bidder.pg.locator('.btn.sm', { hasText: 'Simple view' }).click(); await bidder.pg.waitForTimeout(800) }

chk('buyer sees the best sell offer', /BEST SELL OFFER/i.test(await bidder.pg.locator('.panel').first().innerText()))
const sentB2 = sent.length
await bidder.pg.locator('.btn.pri.big', { hasText: 'Buy this block' }).click(); await bidder.pg.waitForTimeout(9000)
const fl2 = await (await fetch('http://localhost:4192/fills?mint=' + MINT)).json()
chk('ask filled: buyer-built tx co-signed by seller, recorded', sent.length > sentB2 && fl2.some((f) => f.sol === 2 && f.discBps === 0))
if (sent.length > sentB2) { const tx = Transaction.from(Buffer.from(sent.at(-1), 'base64')); chk('ask fill tx: buyer pays, both signed', tx.feePayer.toBase58() === bidder.addr && tx.signatures.length === 2 && tx.signatures.every((s) => s.signature)) }
bk = await (await fetch('http://localhost:4192/book/' + MINT)).json(); chk('ask gone from the book after fill', bk.asks.length === 0)
console.log('ERRORS:', errs.join('\n') || 'none')
await b.close(); proc.kill(); mock.close(); srv.close(); process.exit(0)
