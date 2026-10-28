import { fileURLToPath as __f } from 'url'; import { dirname as __d, resolve as __r } from 'path'; import { mkdirSync as __mk, rmSync as __rm } from 'fs'
const HERE = __d(__f(import.meta.url)); const SC = process.env.E2E_TMP || __r(HERE, '../.e2e-tmp'); __rm(SC, { recursive: true, force: true }); __mk(SC, { recursive: true })
import { chromium } from 'playwright'
import { createServer } from 'http'; import { readFileSync, existsSync } from 'fs'; import { join, extname } from 'path'; import { spawn } from 'child_process'
import { Transaction } from '@solana/web3.js'
const DIST = __r(HERE, '../dist'); const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', TREASURY = '7UX2i7SucgLMQcfZ75s3VXmZZY4YRUyJN9X1RgfMoDUi'
const pair = { chainId: 'solana', dexId: 'raydium', url: 'x', pairAddress: 'P1', baseToken: { address: MINT, name: 'Bonk', symbol: 'BONK' }, quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' }, priceUsd: '0.0016', priceNative: '0.00001', marketCap: 1500000, liquidity: { usd: 32000, quote: 100 }, volume: { h24: 500000, h1: 20000 }, priceChange: { m5: 1, h1: 3.5, h24: -2 }, txns: { h24: { buys: 100, sells: 80 } }, pairCreatedAt: Date.now() - 86400000 }
const solPair = { ...pair, pairAddress: 'SOLP', baseToken: { address: 'So11111111111111111111111111111111111111112', name: 'SOL', symbol: 'SOL' }, priceUsd: '160' }
const dexReply = (u) => u.includes('token-pairs') ? JSON.stringify([pair]) : u.includes('tokens/v1') ? JSON.stringify([u.includes('So1111') ? solPair : pair]) : u.includes('token-boosts') ? JSON.stringify([{ chainId: 'solana', tokenAddress: MINT }]) : u.includes('/search') ? '{"pairs":[]}' : '[]'
const sent = []; let vaultPub = null, tokDeposited = false
const mock = createServer(async (req, res) => {
  const u = req.url; if (/token-pairs|tokens\/v1|token-boosts|token-profiles|\/search/.test(u)) { res.setHeader('content-type', 'application/json'); return res.end(dexReply(u)) }
  let body = ''; req.on('data', (c) => (body += c)); await new Promise((r) => req.on('end', r)); res.setHeader('content-type', 'application/json'); res.setHeader('access-control-allow-origin', '*'); res.setHeader('access-control-allow-headers', '*'); if (req.method === 'OPTIONS') return res.end()
  let q; try { q = JSON.parse(body) } catch { return res.end('{}') }; const reply = (result) => res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id, result })); const owner = q.params?.[0]
  if (q.method === 'getAccountInfo') return reply({ context: { slot: 1 }, value: { data: ['', 'base64'], executable: false, lamports: 1461600, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', rentEpoch: 0, space: 82 } })
  if (q.method === 'getBalance') return reply({ context: { slot: 1 }, value: owner === vaultPub ? (sent.length >= 1 ? 5e9 : 0) : 50e9 })
  if (q.method === 'getTokenSupply') return reply({ context: { slot: 1 }, value: { amount: '1000000000000000', decimals: 6, uiAmount: 1e9 } })
  if (q.method === 'getTokenAccountsByOwner') { const amt = owner === vaultPub ? (tokDeposited ? '100000000000' : '0') : '500000000000'; return reply({ context: { slot: 1 }, value: amt === '0' ? [] : [{ pubkey: '7UX2i7SucgLMQcfZ75s3VXmZZY4YRUyJN9X1RgfMoDUi', account: { executable: false, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280, rentEpoch: 0, space: 165, data: { program: 'spl-token', space: 165, parsed: { type: 'account', info: { mint: MINT, owner, isNative: false, state: 'initialized', tokenAmount: { amount: amt, decimals: 6, uiAmount: +amt / 1e6, uiAmountString: String(+amt / 1e6) } } } } } }] }) }
  if (q.method === 'getLatestBlockhash') return reply({ context: { slot: 1 }, value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999999 } })
  if (q.method === 'sendTransaction') { sent.push(q.params[0]); if (sent.length === 2) tokDeposited = true; return reply('5'.repeat(87)) }
  if (q.method === 'getSignatureStatuses') return reply({ context: { slot: 1 }, value: [{ slot: 1, confirmations: 10, err: null, confirmationStatus: 'confirmed' }] })
  if (q.method === 'getTransaction') { // reconstruct the fee tx: decode last sent tx, compute balance deltas
    const tx = Transaction.from(Buffer.from(sent[sent.length - 1], 'base64')); const keys = [...new Set([tx.feePayer.toBase58(), ...tx.instructions.flatMap((i) => i.keys.map((k) => k.pubkey.toBase58()))])]; const pre = keys.map(() => 50e9); const post = [...pre]
    for (const ix of tx.instructions) { const l = Number(ix.data.readBigUInt64LE(4)); post[keys.indexOf(ix.keys[0].pubkey.toBase58())] -= l; post[keys.indexOf(ix.keys[1].pubkey.toBase58())] += l }
    return reply({ slot: 1, blockTime: 1, meta: { err: null, preBalances: pre, postBalances: post, fee: 5000, innerInstructions: [], logMessages: [], postTokenBalances: [], preTokenBalances: [] }, transaction: { message: { accountKeys: keys.map((k) => ({ pubkey: k, signer: false, writable: true })), instructions: [], recentBlockhash: '11111111111111111111111111111111' }, signatures: ['5'.repeat(87)] }, version: 'legacy' }) }
  reply(null)
}).listen(4390)
const srv = createServer((req, res) => { let p = join(DIST, req.url.split('?')[0]); if (!existsSync(p) || p.endsWith('/')) p = join(DIST, 'index.html'); res.setHeader('content-type', MIME[extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)) }).listen(4191)
const proc = spawn('node', ['--experimental-strip-types', 'src/index.ts'], { cwd: process.env.E2E_SERVER || __r(HERE, '../../server'), env: { ...process.env, DEV_AUTH: '0', PORT: '4192', RPC_URL: 'http://localhost:4390', DEX_URL: 'http://localhost:4390', TREASURY, DATA_DIR: SC + '/vdata4' }, stdio: ['ignore', 'pipe', 'pipe'] })
proc.stderr.on('data', (d) => { const s = String(d); if (!s.includes('bigint')) process.stdout.write('[srv!] ' + s) })
await new Promise((r) => setTimeout(r, 2500))
const errs = []; const chk = (n, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + n); if (!ok) errs.push(n) }
const b = await chromium.launch(); const pg = await b.newPage({ viewport: { width: 1400, height: 900 } }); pg.on('pageerror', (e) => errs.push(String(e)))
await pg.addInitScript(() => { localStorage.setItem('unnamed_server', 'http://localhost:4192'); localStorage.setItem('unnamed_settings_v2', JSON.stringify({ rpc: 'http://localhost:4390' })) })
await pg.route(/api\.dexscreener\.com/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: dexReply(r.request().url()) })); await pg.route(/dexscreener\.com\/solana/, (r) => r.fulfill({ body: '<html></html>', contentType: 'text/html' }))
await pg.goto('http://localhost:4191/#/coin/' + MINT); await pg.waitForTimeout(1500)
await pg.locator('.top .btn', { hasText: 'Connect wallet' }).click(); await pg.locator('.modal .seg button', { hasText: 'In-app' }).click()
await pg.locator('.modal input[type=password]').nth(0).fill('hunter2hunter2'); await pg.locator('.modal input[type=password]').nth(1).fill('hunter2hunter2'); await pg.locator('.modal .btn.pri', { hasText: 'Create wallet' }).click(); await pg.waitForTimeout(3500)
const addr = await pg.locator('.modal .tile .v').nth(1).innerText(); await pg.locator('.modal').click({ position: { x: 5, y: 5 } }); await pg.waitForTimeout(2500)
chk('coin page shows Add vault button', (await pg.locator('.coinhd').innerText()).includes('Add vault'))
await pg.locator('.coinhd button', { hasText: 'Add vault' }).first().click({ force: true }); await pg.waitForTimeout(2000)
chk('import page quotes the coin', (await pg.locator('.card').first().innerText()).includes('BONK') && (await pg.locator('.card').first().innerText()).includes('15 SOL'))
// capture vault pub by intercepting /import/create response
pg.on('response', async (r) => { if (r.url().includes('/import/create')) { try { const j = await r.json(); vaultPub = j.pub } catch {} } })
await pg.locator('.btn.pri.big', { hasText: 'activate vault' }).click(); let seenToast = false; for (let i = 0; i < 12; i++) { await pg.waitForTimeout(600); if ((await pg.locator('.toast').allInnerTexts()).join(' ').includes('VAULTED')) seenToast = true }
chk('fee tx sent', sent.length >= 1)
if (sent.length) { const tx = Transaction.from(Buffer.from(sent[sent.length - 1], 'base64')); chk('fee tx: 10 SOL → treasury + 5 SOL → vault', tx.instructions.length === 2 && Number(tx.instructions[0].data.readBigUInt64LE(4)) === 10e9 && tx.instructions[0].keys[1].pubkey.toBase58() === TREASURY && Number(tx.instructions[1].data.readBigUInt64LE(4)) === 5e9 && tx.instructions[1].keys[1].pubkey.toBase58() === vaultPub) }
const vs = await (await fetch('http://localhost:4192/vaults')).json()
chk('vault armed via on-chain tx verification', vs.length === 1 && vs[0].armed && vs[0].imported && vs[0].chest === 5 && vs[0].dev === addr)
chk('toast VAULTED', seenToast)
await pg.waitForTimeout(1500); chk('coin header shows VAULTED badge', (await pg.locator('.coinhd').innerText()).includes('VAULTED'))
await pg.locator('.seg button', { hasText: 'Vault' }).click(); await pg.waitForTimeout(2000)
chk('deposit controls visible', (await pg.locator('.panel').nth(1).innerText()).includes('Deposit'))
await pg.locator('.btn.sm', { hasText: 'all my BONK' }).click(); await pg.locator('.btn.pri', { hasText: 'Deposit' }).click(); await pg.waitForTimeout(6000)
chk('deposit tx sent', sent.length === 2)
if (sent.length === 2) { const tx = Transaction.from(Buffer.from(sent[1], 'base64')); chk('deposit tx: ata + spl transfer of 500000 BONK', tx.instructions.length === 2 && Number(tx.instructions[1].data.readBigUInt64LE(1)) === 500000e6) }
const v2 = await (await fetch('http://localhost:4192/vault/mint/' + MINT)).json()
chk('server recorded dev bag (100000 tokens via mock) + pct', v2.tokens === 100000 && v2.depositedTokens === 100000 && v2.pct === 0.01)
chk('activity shows vaulted %', JSON.stringify(v2.activity).includes('vaulted'))
await pg.evaluate(() => { location.hash = '#/' }); await pg.waitForTimeout(2500)
chk('home Vaulted table lists the coin with MM tag', (await pg.locator('tbody').first().innerText()).includes('BONK') && (await pg.locator('tbody').first().innerText()).includes('MM'))
await pg.screenshot({ path: SC + '/import-board.png' })
// ---- community takeover on a second mint: start, chip in 15 SOL, auto-arm with cut 0
const MINT2 = 'HMzfNUuWz7aXxQJz8tJqmJ5NwQ2Gp1zH4kCqY3n9pump'
await pg.evaluate(() => { location.hash = '#/import' }); await pg.waitForTimeout(1200)
await pg.locator('.fld input').first().fill(MINT2); await pg.waitForTimeout(1500)
await pg.locator('.seg button', { hasText: 'Community takeover' }).click(); await pg.waitForTimeout(300)
await pg.locator('.btn.pri.big', { hasText: 'Start the takeover' }).click(); await pg.waitForTimeout(3000)
let openC = await (await fetch('http://localhost:4192/import/open')).json()
chk('takeover opened (escrow = vault wallet, goal 15)', openC.length === 1 && openC[0].crowd.goalSol === 15 && openC[0].crowd.raised === 0)
await pg.locator('.card .inp input').last().fill('15'); await pg.waitForTimeout(200)
await pg.locator('.btn.sm.pri', { hasText: 'Chip in' }).click(); await pg.waitForTimeout(9000)
const vs2 = await (await fetch('http://localhost:4192/vaults')).json(); const cv = vs2.find((v) => v.mint === MINT2)
chk('takeover funded → vault armed, cut 0, renounced', !!cv && cv.armed && cv.cut === 0 && cv.renounced && cv.crowd && cv.crowd.raised >= 15)
chk('treasury paid from escrow (vault-signed tx)', sent.length >= 4)
console.log('ERRORS:', errs.join('\n') || 'none'); await b.close(); proc.kill(); mock.close(); srv.close(); process.exit(0)
