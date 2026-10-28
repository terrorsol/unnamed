// Launch on OUR launchpad, end to end in the browser: burner wallet → Launch modal (UNNAMED launchpad is the default) → vault create →
// fund → /ll/launch/build → wallet signs the create → bundle [create, keeper-signed vault buy] → arm → coin page reads the pool as the
// exact source → a buy on the coin routes through /ll/trade. The server is a mock here (shapes copied from the real routes); the server
// itself is covered by its unit tests and the mainnet preflight.
import { fileURLToPath as __f } from 'url'; import { dirname as __d, resolve as __r } from 'path'; import { mkdirSync as __mk, rmSync as __rm } from 'fs'
const HERE = __d(__f(import.meta.url)); const SC = process.env.E2E_TMP || __r(HERE, '../.e2e-tmp'); __rm(SC, { recursive: true, force: true }); __mk(SC, { recursive: true })
import { chromium } from 'playwright'
import { createServer } from 'http'; import { readFileSync, existsSync, writeFileSync } from 'fs'; import { join, extname } from 'path'
import { Keypair, VersionedTransaction, TransactionMessage, SystemProgram, PublicKey } from '@solana/web3.js'
const DIST = __r(HERE, '../dist'); const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }
createServer((req, res) => { let p = join(DIST, req.url.split('?')[0]); if (!existsSync(p) || p.endsWith('/')) p = join(DIST, 'index.html'); res.setHeader('content-type', MIME[extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)) }).listen(4197)

// ---- mock UNNAMED server (:4198) ----
const vaultKp = Keypair.generate(); const mintKp = Keypair.generate(); const MINT = mintKp.publicKey.toBase58()
const calls = {}; const bh = '11111111111111111111111111111111'
const v0 = (payer, lamports = 1) => new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: bh, instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports })] }).compileToV0Message())
const b64 = (tx) => Buffer.from(tx.serialize()).toString('base64')
const vaultPub = { id: 'v1', pub: vaultKp.publicKey.toBase58(), venue: 'launchlab', mint: MINT, symbol: 'OURS', name: 'Ours', dev: '', stakeSol: 1, pct: 1.66, cut: 1.66, armed: false, renounced: false, chest: 0.5, tokens: 0, avgCost: 0, devPaid: 0, activity: [], createdAt: Date.now(), mode: 'mm', ceiling: 0.3, score: { captured: 0, captures: 0, deskBought: 0, deskFills: 0, dipBought: 0, dips: 0, redeployed: 0, floor0: 0 }, floor: 0, live: null, holders: null, feePaid: 0, depositedTokens: 0, funders: {}, streamed: 0, redeemed: 0, supply: 1e9, deskBid: 0, copies: [], taxClaimed: 0 }
createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*'); res.setHeader('access-control-allow-headers', '*'); res.setHeader('access-control-allow-methods', '*'); if (req.method === 'OPTIONS') return res.end()
  const u = new URL(req.url, 'http://x'); const p = u.pathname; let body = ''; for await (const c of req) body += c; const b = body ? JSON.parse(body) : {}
  ;(calls[p] ||= []).push(b); const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)) }
  if (p === '/health') return json({ ok: true, vaults: 0, desk: { openBids: 0 }, beta: { keeper: {} } })
  if (p === '/ll/platform') return json({ venue: 'launchlab', permTaxBps: 0, platformId: 'PLAT', admin: 'ADMIN', feeWallet: 'FEE', taxBps: 200, creatorFeeBps: 50, chain: { id: 'PLAT', exists: true, feeRate: 2, creatorFeeRate: 0.5 } })
  if (p === '/ipfs') return json({ uri: 'https://ipfs.io/ipfs/test' })
  if (p === '/vault/create') return json({ ...vaultPub, dev: b.dev, venue: b.venue })
  if (p === '/ll/launch/build') { const dev = new PublicKey(b.dev); const vt = v0(vaultKp.publicKey, 2); vt.sign([vaultKp]); return json({ venue: 'launchlab', mint: MINT, poolId: 'POOL', txs: [b64(v0(dev))], vaultTx: b.vaultId ? b64(vt) : null, vaultSpend: 0.5, vaultTokens: 16.5e6, devTokens: 17.1e6 }) }
  if (p === '/bundle') return json({ bundleId: 'bundle-1' })
  if (p === '/vault/arm') return json({ ...vaultPub, armed: true, tokens: 16.5e6, chest: 0.5 })
  if (p === '/vaults') return json(calls['/vault/arm'] ? [{ ...vaultPub, armed: true, tokens: 16.5e6, chest: 0.5 }] : [])
  if (p.startsWith('/vault/mint/')) return json(calls['/vault/arm'] ? { ...vaultPub, armed: true, tokens: 16.5e6, chest: 0.5 } : null)
  if (p.startsWith('/ll/pool/')) return json(p.endsWith(MINT) ? { poolId: 'POOL', status: 0, migrated: false, priceSol: 3.0e-8, liqSol: 31, soldPct: 0.4, platformId: 'PLAT', ours: true, platformFee: '12000000' } : null)
  if (p === '/ll/trade') { const owner = new PublicKey(b.owner); return json({ tx: b64(v0(owner, 3)) }) }
  if (p.startsWith('/book/')) return json({ mint: MINT, bids: [], asks: [], rules: { feeBps: 50 }, minBlock: 0.5, open: false, why: 'no volume yet' })
  if (p === '/vamps') return json({ at: Date.now(), vamps: [], families: [] })
  if (p.startsWith('/vamp/')) return json({ vamp: null, family: null, copies: [] })
  if (p.startsWith('/family/')) return json({ root: MINT, members: [] })
  if (p.startsWith('/tape/') || p === '/fills' || p === '/books' || p === '/mybids' || p === '/myasks' || p === '/leaderboard') return json([])
  json({})
}).listen(4198)

const curve = { chainId: 'solana', dexId: 'pumpfun', url: 'x', pairAddress: 'P2', baseToken: { address: 'CURVE111', name: 'Curvy', symbol: 'CURVY' }, quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' }, priceUsd: '0.00001', marketCap: 12000, liquidity: { usd: 6000 }, volume: { h24: 1000, h1: 100 }, priceChange: { m5: 1, h1: 3, h24: 2 }, txns: { h24: { buys: 10, sells: 5 } }, pairCreatedAt: Date.now() - 60000 }
const b = await chromium.launch(); const pg = await b.newPage({ viewport: { width: 1400, height: 900 } })
await pg.addInitScript(() => { localStorage.setItem('unnamed_server', 'http://localhost:4198') })
const errs = []; pg.on('pageerror', (e) => { errs.push(String(e)); console.log('PAGEERR', String(e.stack || e).slice(0, 700)) })
const sent = []
await pg.route(/api\.dexscreener\.com/, (r) => { const u = r.request().url(); if (u.includes('boosts')) return r.fulfill({ json: [{ chainId: 'solana', tokenAddress: 'CURVE111' }] }); if (u.includes('/tokens/v1/') && u.includes('So1111')) return r.fulfill({ json: [{ ...curve, priceUsd: '200', baseToken: { address: 'So11111111111111111111111111111111111111112', name: 'Wrapped SOL', symbol: 'SOL' } }] }); if (u.includes('/tokens/v1/') || u.includes('/token-pairs/')) return r.fulfill({ json: u.includes(MINT) ? [] : [curve] }); r.fulfill({ json: [] }) })
await pg.route(/geckoterminal\.com/, (r) => r.fulfill({ json: { data: [] } }))
await pg.route(/raw\.githubusercontent\.com/, (r) => r.fulfill({ status: 404, body: '' }))
await pg.route(/mainnet-beta\.solana\.com|helius-rpc\.com/, (r) => { const q = JSON.parse(r.request().postData()); const id = q.id
  if (q.method === 'getBalance') return r.fulfill({ json: { jsonrpc: '2.0', id, result: { context: { slot: 1 }, value: 40e9 } } })
  if (q.method === 'getTokenAccountsByOwner') return r.fulfill({ json: { jsonrpc: '2.0', id, result: { context: { slot: 1 }, value: [] } } })
  if (q.method === 'sendTransaction') { sent.push(q.params[0]); return r.fulfill({ json: { jsonrpc: '2.0', id, result: '5'.repeat(87) } }) }
  if (q.method === 'getLatestBlockhash') return r.fulfill({ json: { jsonrpc: '2.0', id, result: { context: { slot: 1 }, value: { blockhash: bh, lastValidBlockHeight: 999999999 } } } })
  if (q.method === 'getSignatureStatuses') return r.fulfill({ json: { jsonrpc: '2.0', id, result: { context: { slot: 1 }, value: [{ slot: 1, confirmations: 10, err: null, confirmationStatus: 'confirmed' }] } } })
  if (q.method === 'getBlockHeight') return r.fulfill({ json: { jsonrpc: '2.0', id, result: 1 } })
  if (q.method === 'simulateTransaction') return r.fulfill({ json: { jsonrpc: '2.0', id, result: { context: { slot: 1 }, value: { err: null, logs: [], unitsConsumed: 1 } } } })
  r.fulfill({ json: { jsonrpc: '2.0', id, result: null } }) })
const chk = (n, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + n); if (!ok) errs.push('FAIL ' + n) }

await pg.goto('http://localhost:4197/#/'); await pg.waitForTimeout(1500)
await pg.locator('.top .btn', { hasText: 'Connect wallet' }).click(); await pg.waitForTimeout(300)
await pg.locator('.modal .seg button', { hasText: 'In-app' }).click()
await pg.locator('.modal input[type=password]').nth(0).fill('hunter2hunter2'); await pg.locator('.modal input[type=password]').nth(1).fill('hunter2hunter2')
await pg.locator('.modal .btn.pri', { hasText: 'Create wallet' }).click(); await pg.waitForTimeout(2500)
const addr = await pg.locator('.modal .tile .v').nth(1).innerText(); chk('burner wallet', addr.length > 40)
await pg.keyboard.press('Escape'); await pg.locator('.modal').click({ position: { x: 5, y: 5 } }); await pg.waitForTimeout(300)

// ---- launch ----
await pg.locator('.top .btn', { hasText: 'Launch' }).click(); await pg.waitForTimeout(500)
chk('launch modal: UNNAMED launchpad is the default', (await pg.locator('.venue button.on').innerText()).includes('BANKER'))
const tagTxt = await pg.locator('.modal .tag').allInnerTexts(); chk('launch modal: tax shown from the server ' + JSON.stringify(tagTxt), tagTxt.some((t) => /2.0% tax/i.test(t)))
chk('launch modal: pump is the other option, not recommended', (await pg.locator('.venue button').nth(1).innerText()).includes('no tax'))
await pg.locator('.modal input:not([type=checkbox])').nth(0).fill('Ours'); await pg.locator('.modal input:not([type=checkbox])').nth(1).fill('OURS')
const png = join(SC, 'logo.png'); writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
await pg.locator('.modal input[type=file]').setInputFiles(png); await pg.waitForTimeout(200)
const noteTxt = await pg.locator('.modal .note').first().innerText()
chk('launch modal: default is tax-funded (no SOL next to the 20% target) ' + JSON.stringify(noteTxt.slice(0, 40)), /Vault supply\s+20%\s*\n/.test(noteTxt) && (await pg.locator('.modal .seg button.on', { hasText: 'Tax builds it' }).count()) === 1)
await pg.locator('.modal .seg button', { hasText: 'Buy at launch' }).click(); await pg.waitForTimeout(100)
const noteTxt2 = await pg.locator('.modal .note').first().innerText()
chk('buy at launch: 20% priced off the real curve ≈ 7 SOL ' + JSON.stringify(noteTxt2.slice(0, 40)), /20% · [67]\.\d+ SOL/.test(noteTxt2))
await pg.locator('.modal input[type=range]').nth(0).fill('50'); await pg.waitForTimeout(100)
chk('slider to 50%: ≈ 27 SOL', /50% · 2[6-9]\.\d+ SOL/.test(await pg.locator('.modal .note').first().innerText()))
await pg.locator('.modal input[type=range]').nth(0).fill('20'); await pg.waitForTimeout(100)
const seenToasts = new Set(); await pg.locator('.modal .btn.pri', { hasText: 'Create coin' }).click(); for (let i = 0; i < 16; i++) { await pg.waitForTimeout(500); for (const t of await pg.locator('.toast').allInnerTexts().catch(() => [])) seenToasts.add(t) }
chk('vault created on the launchlab venue with the explicit block-zero buy (20% ≈ 7 SOL) + 0.5 SOL chest', calls['/vault/create']?.[0]?.venue === 'launchlab' && calls['/vault/create'][0].dev === addr && calls['/vault/create'][0].vaultBuySol > 6.5 && calls['/vault/create'][0].targetPct === 20 && Math.abs(calls['/vault/create'][0].stakeSol - calls['/vault/create'][0].vaultBuySol - 0.5) < 0.01)
chk('vault funded first (stake transfer sent)', sent.length >= 1)
const lb = calls['/ll/launch/build']?.[0]
chk('server asked to build the launch for the dev', !!lb && lb.dev === addr && lb.symbol === 'OURS' && lb.vaultId === 'v1' && lb.vaultBuySol > 6.5 && lb.vaultBuySol < 7.8 && lb.devBuySol === 0.5)
chk('transfer tax off by default (one fee: the curve tax)', lb?.permTax === false)
chk('launch build carries a dev signature (unnamed:launch:<vault>:<dev>:<minute>)', !!lb?.auth && lb.auth.msg.startsWith('unnamed:launch:v1:' + addr + ':') && lb.auth.sig.length > 60)
chk('arm carries a dev signature', !!calls['/vault/arm']?.[0]?.auth && calls['/vault/arm'][0].auth.msg.startsWith('unnamed:arm:v1:' + MINT))
const bundle = calls['/bundle']?.[0]?.txs || []
chk('bundle = [create signed by dev, keeper-signed vault buy]', bundle.length === 2 && VersionedTransaction.deserialize(Buffer.from(bundle[0], 'base64')).signatures[0].some((x) => x) && VersionedTransaction.deserialize(Buffer.from(bundle[0], 'base64')).message.staticAccountKeys[0].toBase58() === addr && VersionedTransaction.deserialize(Buffer.from(bundle[1], 'base64')).message.staticAccountKeys[0].toBase58() === vaultKp.publicKey.toBase58())
chk('vault armed after launch', calls['/vault/arm']?.[0]?.id === 'v1' && calls['/vault/arm'][0].mint === MINT)
const toasts = [...seenToasts]; console.log('TOASTS', toasts.map((t) => t.replace(/\n/g, ' / ').slice(0, 90)).join(' || '))
chk('success toast says live on UNNAMED · vault in block zero', toasts.some((t) => t.includes('live on BANKER') && t.includes('vault in block zero')))
chk('navigated to the coin page', pg.url().includes('#/coin/' + MINT))
await pg.waitForTimeout(2500); console.log('COINPAGE', (await pg.locator('.main').innerText().catch(() => '')).replace(/\n/g, ' / ').slice(0, 400))
chk('coin page reads the pool as the exact source (price from /ll/pool, not the indexer)', (await pg.locator('.tile', { hasText: 'Price' }).innerText({ timeout: 3000 }).catch(() => '')).includes('$0.00000600'))
// ---- buy on our launchpad coin ----
await pg.locator('.btn.pri.big', { hasText: 'Buy' }).first().click().catch(() => {}); await pg.waitForTimeout(3000)
const tr = calls['/ll/trade']?.[0]
chk('buy routed through /ll/trade (sdk-built, no pumpportal)', !!tr && tr.action === 'buy' && tr.mint === MINT && tr.owner === addr && tr.amount === 0.1)
chk('buy tx signed by the burner and sent', sent.length >= 2 && VersionedTransaction.deserialize(Buffer.from(sent[sent.length - 1], 'base64')).signatures[0].some((x) => x))
chk('no page errors', errs.filter((e) => !e.startsWith('FAIL') && !/net::|WebSocket|ERR_|Failed to fetch|localStorage/.test(e)).length === 0)
await pg.screenshot({ path: join(SC, 'launch-coinpage.png') })
await b.close(); const fails = errs.filter((e) => e.startsWith('FAIL')); if (fails.length) { console.log('ERRORS:', fails.join('; ')); process.exit(1) } process.exit(0)
