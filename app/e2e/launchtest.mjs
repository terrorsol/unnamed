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
const vaultKp = Keypair.generate(); const mintKp = Keypair.generate(); const MINT = mintKp.publicKey.toBase58(); const MINT2 = Keypair.generate().publicKey.toBase58(); const MINT3 = Keypair.generate().publicKey.toBase58(); const MINT4 = Keypair.generate().publicKey.toBase58(); let alreadyLive = false; let creatorAddr = ''
const calls = {}; const bh = '11111111111111111111111111111111'
const v0 = (payer, lamports = 1) => new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: bh, instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports })] }).compileToV0Message())
const b64 = (tx) => Buffer.from(tx.serialize()).toString('base64')
const vaultPub = { id: 'v1', pub: vaultKp.publicKey.toBase58(), venue: 'launchlab', mint: MINT, symbol: 'OURS', name: 'Ours', dev: '', stakeSol: 1, pct: 1.66, cut: 1.66, armed: false, renounced: false, chest: 0.5, tokens: 0, avgCost: 0, devPaid: 0, activity: [], createdAt: Date.now(), mode: 'mm', ceiling: 0.3, score: { captured: 0, captures: 0, deskBought: 0, deskFills: 0, dipBought: 0, dips: 0, redeployed: 0, floor0: 0 }, floor: 0, live: null, holders: null, feePaid: 0, depositedTokens: 0, funders: {}, streamed: 0, redeemed: 0, supply: 1e9, deskBid: 0, copies: [], taxClaimed: 0 }
createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*'); res.setHeader('access-control-allow-headers', '*'); res.setHeader('access-control-allow-methods', '*'); if (req.method === 'OPTIONS') return res.end()
  const u = new URL(req.url, 'http://x'); const p = u.pathname; let body = ''; for await (const c of req) body += c; const b = body ? JSON.parse(body) : {}
  ;(calls[p] ||= []).push(b); const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)) }
  if (p.startsWith('/vault/mint/') && p.endsWith(MINT4)) return json(calls['/vault/attach'] ? { ...vaultPub, id: 'v4', mint: MINT4, armed: true, chest: 0 } : null)
  if (p === '/health') return json({ ok: true, vaults: 0, desk: { openBids: 0 }, beta: { keeper: {} } })
  if (p === '/ll/platform') return json({ venue: 'launchlab', permTaxBps: 0, platformId: 'PLAT', admin: 'ADMIN', feeWallet: 'FEE', taxBps: 200, creatorFeeBps: 50, chain: { id: 'PLAT', exists: true, feeRate: 2, creatorFeeRate: 0.5 } })
  if (p === '/ipfs') return json({ uri: 'https://ipfs.io/ipfs/test' })
  if (p === '/vault/create') return json({ ...vaultPub, dev: b.dev, venue: b.venue })
  if (p === '/ll/launch/build') {
    if (alreadyLive) { res.statusCode = 400; return json({ error: 'already live: ' + MINT2 }) }
    await new Promise((r) => setTimeout(r, 900))   // a real build takes ~1–4 s: long enough to see the progress row
    // one-signature launch: the real server appends the dev → vault stake transfer to the create tx (fundInBundle) and reports fundSol
    const dev = new PublicKey(b.dev); const vt = v0(vaultKp.publicKey, 2); vt.sign([vaultKp]); const fund = b.vaultId && b.fundInBundle ? 7.5 : 0
    const ct = new VersionedTransaction(new TransactionMessage({ payerKey: dev, recentBlockhash: bh, instructions: [SystemProgram.transfer({ fromPubkey: dev, toPubkey: dev, lamports: 1 }), ...(fund ? [SystemProgram.transfer({ fromPubkey: dev, toPubkey: vaultKp.publicKey, lamports: fund * 1e9 })] : [])] }).compileToV0Message())
    return json({ venue: 'launchlab', mint: MINT, poolId: 'POOL', txs: [b64(ct)], vaultTx: b.vaultId ? b64(vt) : null, vaultSpend: 0.5, vaultTokens: 16.5e6, devTokens: 17.1e6, fundSol: fund }) }
  if (p === '/pump/launch/build') { const dev = new PublicKey(b.dev); const vt = v0(vaultKp.publicKey, 2); vt.sign([vaultKp]); const fund = b.vaultId && b.fundInBundle ? 7.5 : 0
    const ct = new VersionedTransaction(new TransactionMessage({ payerKey: dev, recentBlockhash: bh, instructions: [SystemProgram.transfer({ fromPubkey: dev, toPubkey: dev, lamports: 1 }), ...(fund ? [SystemProgram.transfer({ fromPubkey: dev, toPubkey: vaultKp.publicKey, lamports: fund * 1e9 })] : [])] }).compileToV0Message())
    return json({ venue: 'pump', mint: MINT3, txs: [b64(ct)], vaultTx: b.vaultId ? b64(vt) : null, vaultSpend: 0.5, vaultTokens: 16.5e6, fundSol: fund }) }
  if (p === '/bundle') return json({ bundleId: 'bundle-1' })
  if (p === '/vault/arm') return json({ ...vaultPub, armed: true, tokens: 16.5e6, chest: 0.5 })
  if (p === '/vaults') return json(calls['/vault/arm'] ? [{ ...vaultPub, armed: true, tokens: 16.5e6, chest: 0.5 }] : [])
  if (p.startsWith('/vault/mint/')) return json(calls['/vault/arm'] ? { ...vaultPub, armed: true, tokens: 16.5e6, chest: 0.5, vaultBuySol: 7.29, mm: { spent: 0, got: 3.1, tok: 0, cost: 0, inv: 3.1, stopped: false }, activity: [{ t: Date.now() - 20000, kind: 'capture', sol: 0.62, msg: 'sold into a 2.10 SOL buy · launch buy 3.10 / 7.29 SOL back' }, { t: Date.now() - 50000, kind: 'tax', sol: 0.041, msg: 'tax → chest' }, { t: Date.now() - 70000, kind: 'capture', sol: 0.35, msg: 'sold into a 1.40 SOL buy · launch buy 2.48 / 7.29 SOL back' }] } : null)
  if (p === '/vault/attach') return json({ ...vaultPub, id: 'v4', mint: b.mint, armed: true, chest: 0, dev: b.dev })
  if (p.startsWith('/ll/pool/') && p.endsWith(MINT4)) return json({ poolId: 'POOL4', status: 0, migrated: false, priceSol: 3.0e-8, liqSol: 31, soldPct: 0.4, platformId: 'PLAT', ours: true, platformFee: '0', creator: creatorAddr })
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
await pg.route(/api\.dexscreener\.com/, (r) => { const u = r.request().url(); if (u.includes('boosts')) return r.fulfill({ json: [{ chainId: 'solana', tokenAddress: 'CURVE111' }] }); if (u.includes('/tokens/v1/') && u.includes('So1111')) return r.fulfill({ json: [{ ...curve, priceUsd: '200', baseToken: { address: 'So11111111111111111111111111111111111111112', name: 'Wrapped SOL', symbol: 'SOL' } }] }); if (u.includes('/tokens/v1/') || u.includes('/token-pairs/')) return r.fulfill({ json: u.includes(MINT) || u.includes(MINT4) ? [] : [curve] }); r.fulfill({ json: [] }) })
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
const tagTxt = await pg.locator('.modal .tag').allInnerTexts(); chk('launch modal: tax shown from the server ' + JSON.stringify(tagTxt), tagTxt.some((t) => /2.0% of trades/i.test(t)))
chk('launch modal: pump is the other option, not recommended', (await pg.locator('.venue button').nth(1).innerText()).includes('no trading fee'))
await pg.locator('.modal input:not([type=checkbox])').nth(0).fill('Ours'); await pg.locator('.modal input:not([type=checkbox])').nth(1).fill('OURS')
const png = join(SC, 'logo.png'); writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
await pg.locator('.modal input[type=file]').setInputFiles(png); await pg.waitForTimeout(200)
const noteTxt = await pg.locator('.modal .note').first().innerText()
chk('launch modal: default is Buy at launch (the vault buys its supply in block zero) ' + JSON.stringify(noteTxt.slice(0, 40)), /Coins the chest holds\s+20% · [67]\.\d+ SOL/.test(noteTxt) && (await pg.locator('.modal .seg button.on', { hasText: 'Buy at launch' }).count()) === 1)
await pg.locator('.modal .seg button', { hasText: 'Buy at launch' }).click(); await pg.waitForTimeout(100)
const noteTxt2 = await pg.locator('.modal .note').first().innerText()
chk('buy at launch: 20% priced off the real curve ≈ 7 SOL ' + JSON.stringify(noteTxt2.slice(0, 40)), /20% · [67]\.\d+ SOL/.test(noteTxt2))
await pg.locator('.modal input[type=range]').nth(0).fill('50'); await pg.waitForTimeout(100)
chk('slider to 50%: ≈ 27 SOL', /50% · 2[6-9]\.\d+ SOL/.test(await pg.locator('.modal .note').first().innerText()))
await pg.locator('.modal input[type=range]').nth(0).fill('20'); await pg.waitForTimeout(100)
const seenToasts = new Set(); const seenSteps = new Set(); await pg.locator('.modal .btn.pri', { hasText: 'Create coin' }).click()
for (let i = 0; i < 40; i++) { await pg.waitForTimeout(200); for (const t of await pg.locator('.toast').allInnerTexts().catch(() => [])) seenToasts.add(t); const on = await pg.locator('.lp-steps .on').allInnerTexts().catch(() => []); on.forEach((x) => seenSteps.add(x.trim())); if (on.length && !existsSync(join(SC, 'launch-progress.png'))) await pg.locator('.modal .box').screenshot({ path: join(SC, 'launch-progress.png') }).catch(() => {}) }
chk('launch progress row shows the live step ' + JSON.stringify([...seenSteps]), seenSteps.has('Build'))
chk('vault created on the launchlab venue with the explicit block-zero buy (20% ≈ 7 SOL) + 0.5 SOL chest', calls['/vault/create']?.[0]?.venue === 'launchlab' && calls['/vault/create'][0].dev === addr && calls['/vault/create'][0].vaultBuySol > 6.5 && calls['/vault/create'][0].targetPct === 20 && Math.abs(calls['/vault/create'][0].stakeSol - calls['/vault/create'][0].vaultBuySol - 0.5) < 0.01)
const lb = calls['/ll/launch/build']?.[0]
chk('one signature: no stake transfer sent ahead — the build is asked to put the stake inside the create (fundInBundle)', sent.length === 0 && lb?.fundInBundle === true && !calls['/vault/fund'])
chk('server asked to build the launch for the dev', !!lb && lb.dev === addr && lb.symbol === 'OURS' && lb.vaultId === 'v1' && lb.vaultBuySol > 6.5 && lb.vaultBuySol < 7.8 && lb.devBuySol === 0.5)
chk('transfer tax off by default (one fee: the curve tax)', lb?.permTax === false)
chk('launch build carries a dev signature (unnamed:launch:<vault>:<dev>:<minute>)', !!lb?.auth && lb.auth.msg.startsWith('unnamed:launch:v1:' + addr + ':') && lb.auth.sig.length > 60)
chk('arm carries a dev signature', !!calls['/vault/arm']?.[0]?.auth && calls['/vault/arm'][0].auth.msg.startsWith('unnamed:arm:v1:' + MINT))
const bundle = calls['/bundle']?.[0]?.txs || []
chk('bundle = [create signed by dev, keeper-signed vault buy]', bundle.length === 2 && VersionedTransaction.deserialize(Buffer.from(bundle[0], 'base64')).signatures[0].some((x) => x) && VersionedTransaction.deserialize(Buffer.from(bundle[0], 'base64')).message.staticAccountKeys[0].toBase58() === addr && VersionedTransaction.deserialize(Buffer.from(bundle[1], 'base64')).message.staticAccountKeys[0].toBase58() === vaultKp.publicKey.toBase58())
chk('vault armed after launch', calls['/vault/arm']?.[0]?.id === 'v1' && calls['/vault/arm'][0].mint === MINT)
chk('arm books the stake from the create tx (fundSig = the create signature the wallet made)', calls['/vault/arm']?.[0]?.fundSig === (bundle[0] ? (await import('bs58')).default.encode(VersionedTransaction.deserialize(Buffer.from(bundle[0], 'base64')).signatures[0]) : 'x'))
chk('the create the wallet signed carries the stake transfer to the vault (one prompt)', bundle[0] && VersionedTransaction.deserialize(Buffer.from(bundle[0], 'base64')).message.staticAccountKeys.some((k) => k.equals(vaultKp.publicKey)))
chk('metadata uploaded once, before the build', (calls['/ipfs'] || []).length === 1)
const toasts = [...seenToasts]; console.log('TOASTS', toasts.map((t) => t.replace(/\n/g, ' / ').slice(0, 90)).join(' || '))
chk('success toast says live on UNNAMED · vault in block zero', toasts.some((t) => t.includes('live on BANKER') && t.includes('vault in block zero')))
chk('success toast shows the stake went with the same signature', toasts.some((t) => /same signature/.test(t)))
chk('navigated to the coin page', pg.url().includes('#/coin/' + MINT))
await pg.waitForTimeout(2500); console.log('COINPAGE', (await pg.locator('.main').innerText().catch(() => '')).replace(/\n/g, ' / ').slice(0, 400))
chk('chest card: launch buy paid back + what the chest did', (await pg.locator('.prog-back').innerText().catch(() => '')).includes('3.10 / 7.29') && (await pg.locator('.prog-fi').count()) === 3)
await pg.locator('.prog').first().screenshot({ path: join(SC, 'chest-card.png') }).catch(() => {})
chk('coin page reads the pool as the exact source (price from /ll/pool, not the indexer)', (await pg.locator('.tile', { hasText: 'Price' }).innerText({ timeout: 3000 }).catch(() => '')).includes('$0.00000600'))
// ---- buy on our launchpad coin ----
await pg.locator('.btn.pri.big', { hasText: 'Buy' }).first().click().catch(() => {}); await pg.waitForTimeout(3000)
const tr = calls['/ll/trade']?.[0]
chk('buy routed through /ll/trade (sdk-built, no pumpportal)', !!tr && tr.action === 'buy' && tr.mint === MINT && tr.owner === addr && tr.amount === 0.1)
chk('buy tx signed by the burner and sent', sent.length >= 2 && VersionedTransaction.deserialize(Buffer.from(sent[sent.length - 1], 'base64')).signatures[0].some((x) => x))
// ---- retry after a launch that landed late: the server names the live coin, the app opens it instead of launching a second one ----
alreadyLive = true; const armsBefore = (calls['/vault/arm'] || []).length
await pg.goto('http://localhost:4197/#/'); await pg.waitForTimeout(800)
await pg.locator('.top .btn', { hasText: 'Launch' }).click(); await pg.waitForTimeout(400)
await pg.locator('.modal input:not([type=checkbox])').nth(0).fill('Ours'); await pg.locator('.modal input:not([type=checkbox])').nth(1).fill('OURS'); await pg.locator('.modal input[type=file]').setInputFiles(png); await pg.waitForTimeout(200)
const seen2 = new Set(); await pg.locator('.modal .btn.pri', { hasText: 'Create coin' }).click(); for (let i = 0; i < 10; i++) { await pg.waitForTimeout(500); for (const t of await pg.locator('.toast').allInnerTexts().catch(() => [])) seen2.add(t) }
chk('already-live retry: opens the live coin, no second launch', pg.url().includes('#/coin/' + MINT2) && [...seen2].some((t) => /already live/i.test(t)))
chk('already-live retry: arms onto the live coin (no fundSig: the server finds the create tx)', (calls['/vault/arm'] || []).length === armsBefore + 1 && calls['/vault/arm'].at(-1).mint === MINT2 && !calls['/vault/arm'].at(-1).fundSig)
// ---- pump.fun launch: server-built too (…BANK mint, stake inside the create, one signature) ----
alreadyLive = false; const bundlesBefore = (calls['/bundle'] || []).length; const sentBefore = sent.length
await pg.goto('http://localhost:4197/#/'); await pg.waitForTimeout(800)
await pg.locator('.top .btn', { hasText: 'Launch' }).click(); await pg.waitForTimeout(400)
await pg.locator('.venue button').nth(1).click(); await pg.waitForTimeout(200)
await pg.locator('.modal input:not([type=checkbox])').nth(0).fill('Pumpy'); await pg.locator('.modal input:not([type=checkbox])').nth(1).fill('PMPY'); await pg.locator('.modal input[type=file]').setInputFiles(png); await pg.waitForTimeout(200)
const seen3 = new Set(); await pg.locator('.modal .btn.pri', { hasText: 'Create coin' }).click(); for (let i = 0; i < 12; i++) { await pg.waitForTimeout(500); for (const t of await pg.locator('.toast').allInnerTexts().catch(() => [])) seen3.add(t) }
const pb = calls['/pump/launch/build']?.[0]
console.log('PUMP TOASTS', [...seen3].map((t) => t.replace(/\n/g, ' / ').slice(0, 100)).join(' || '))
chk('pump: the server builds the launch (fundInBundle, vault, dev signature)', !!pb && pb.fundInBundle === true && pb.vaultId === 'v1' && pb.symbol === 'PMPY' && !!pb.auth)
chk('pump: no stake transfer sent ahead, one bundle [create+stake, vault buy]', sent.length === sentBefore && (calls['/bundle'] || []).length === bundlesBefore + 1 && calls['/bundle'].at(-1).txs.length === 2)
chk('pump: armed onto the new coin with the create signature as the stake proof', calls['/vault/arm'].at(-1).mint === MINT3 && !!calls['/vault/arm'].at(-1).fundSig)
chk('pump: success toast + coin page', [...seen3].some((t) => t.includes('live on pump') && t.includes('vault in block zero')) && pg.url().includes('#/coin/' + MINT3))
// ---- a coin launched here without a chest: its creator switches the chest on from the coin page (free) ----
creatorAddr = addr
await pg.goto('http://localhost:4197/#/coin/' + MINT4); await pg.waitForTimeout(2500)
await pg.locator('button', { hasText: /^Vault/ }).first().click().catch(() => {}); await pg.waitForTimeout(800)
const sw = pg.locator('button', { hasText: 'Switch on the chest' }); chk('creator sees "Switch on the chest · free" on their chest-less launchpad coin', (await sw.count()) === 1)
await sw.first().click().catch(() => {}); await pg.waitForTimeout(1500)
const at = calls['/vault/attach']?.[0]; chk('attach sent for this coin by its creator, with a dev signature', !!at && at.mint === MINT4 && at.dev === addr && !!at.auth?.msg?.startsWith('unnamed:attach:attach:' + MINT4))
chk('no page errors', errs.filter((e) => !e.startsWith('FAIL') && !/net::|WebSocket|ERR_|Failed to fetch|localStorage/.test(e)).length === 0)
await pg.screenshot({ path: join(SC, 'launch-coinpage.png') })
await b.close(); const fails = errs.filter((e) => e.startsWith('FAIL')); if (fails.length) { console.log('ERRORS:', fails.join('; ')); process.exit(1) } process.exit(0)
