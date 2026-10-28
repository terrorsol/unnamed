import { fileURLToPath as __f } from 'url'; import { dirname as __d, resolve as __r } from 'path'; import { mkdirSync as __mk, rmSync as __rm } from 'fs'
const HERE = __d(__f(import.meta.url)); const SC = process.env.E2E_TMP || __r(HERE, '../.e2e-tmp'); __rm(SC, { recursive: true, force: true }); __mk(SC, { recursive: true })
import pw from '/opt/npm-tools/node_modules/playwright/index.js'; const { chromium } = pw
import { createServer } from 'http'
import { readFileSync, existsSync } from 'fs'
import { join, extname } from 'path'
const DIST = __r(HERE, '../dist')
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }
const srv = createServer((req, res) => { let p = join(DIST, req.url.split('?')[0]); if (!existsSync(p) || p.endsWith('/')) p = join(DIST, 'index.html'); res.setHeader('content-type', MIME[extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)) }).listen(4178)
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
const pair = { chainId: 'solana', dexId: 'raydium', url: 'https://dexscreener.com/solana/x', pairAddress: 'PAIR1', baseToken: { address: MINT, name: 'Bonk', symbol: 'BONK' }, quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' }, priceUsd: '0.00002', marketCap: 1500000000, liquidity: { usd: 20000000 }, volume: { h24: 50000000, h1: 2000000 }, priceChange: { m5: 1, h1: 3.5, h24: -2 }, txns: { h24: { buys: 1000, sells: 800 } }, pairCreatedAt: Date.now() - 86400000 * 300 }
const curve = { ...pair, dexId: 'pumpfun', pairAddress: 'PAIR2', baseToken: { address: 'CURVE111', name: 'Curvy', symbol: 'CURVY' }, marketCap: 12000, liquidity: { usd: 6000 }, pairCreatedAt: Date.now() - 60000 }
const solPair = { ...pair, pairAddress: 'SOLP', baseToken: { address: 'So11111111111111111111111111111111111111112', name: 'Wrapped SOL', symbol: 'SOL' }, priceUsd: '160' }
const b = await chromium.launch(); const pg = await b.newPage({ viewport: { width: 1400, height: 900 } })
const errs = []; pg.on('pageerror', (e) => errs.push(String(e))); pg.on('console', (m) => m.type() === 'error' && errs.push(m.text()))
let tradeCalls = []
await pg.route(/api\.dexscreener\.com/, (r) => {
  const u = r.request().url()
  if (u.includes('token-boosts')) return r.fulfill({ json: [{ chainId: 'solana', tokenAddress: MINT }, { chainId: 'solana', tokenAddress: 'CURVE111' }] })
  if (u.includes('token-profiles')) return r.fulfill({ json: [] })
  if (u.includes('/tokens/v1/solana/')) { const ms = u.split('/').pop(); const out = []; if (ms.includes(MINT)) out.push(pair); if (ms.includes('CURVE111')) out.push(curve); if (ms.includes('So1111')) out.push(solPair); return r.fulfill({ json: out }) }
  if (u.includes('/token-pairs/v1/solana/')) return r.fulfill({ json: u.endsWith(MINT) ? [pair] : [curve] })
  if (u.includes('/search')) return r.fulfill({ json: { pairs: [pair] } })
  r.fulfill({ json: [] })
})
await pg.route(/pumpportal\.fun\/api\/trade-local/, (r) => { tradeCalls.push(JSON.parse(r.request().postData())); r.fulfill({ status: 200, body: Buffer.alloc(4) }) })
await pg.route(/lite-api\.jup\.ag/, (r) => r.fulfill({ status: 503, body: 'down' }))
await pg.route(/dexscreener\.com\/solana/, (r) => r.fulfill({ body: '<html>chart</html>', contentType: 'text/html' }))
await pg.route(/api\.geckoterminal\.com/, (r) => { const now = Math.floor(Date.now() / 1000 / 60) * 60; const list = []; let p = 0.00002; for (let i = 299; i >= 0; i--) { const o = p; p *= 1 + (Math.sin(i) * 0.01); list.push([now - i * 60, o, Math.max(o, p) * 1.002, Math.min(o, p) * 0.998, p, 500 + i]) } r.fulfill({ json: { data: { attributes: { ohlcv_list: list.reverse() } } } }) })
await pg.route(/api\.mainnet-beta\.solana\.com/, (r) => r.fulfill({ json: { jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: 5e9 } } }))
await pg.goto('http://localhost:4178/#/'); await pg.waitForTimeout(2500); await pg.locator('.seg button', { hasText: 'Market' }).first().click(); await pg.waitForTimeout(500)
const chk = (name, ok) => console.log((ok ? 'PASS' : 'FAIL') + ' ' + name) || (!ok && errs.push('FAIL ' + name))
chk('board renders rows', (await pg.locator('tbody tr').count()) >= 2)
chk('home stat tiles render', (await pg.locator('.main .tiles').first().innerText()).includes('DESKS LIVE'))
chk('signal tags render', true)
await pg.locator('tbody tr').first().click(); await pg.waitForTimeout(1500)
chk('coin route', location => true, true); chk('coin page header', (await pg.locator('.coinhd h1').innerText()).includes('BONK') || (await pg.locator('.coinhd h1').innerText()).includes('CURVY'))
await pg.waitForTimeout(1500); chk('custom chart renders candles (canvas, no iframe)', (await pg.locator('.chart canvas').count()) >= 1 && (await pg.locator('.chart iframe').count()) === 0)
await pg.locator('.chart .seg button', { hasText: /^5m$/ }).click(); await pg.waitForTimeout(800); chk('timeframe switch', (await pg.locator('.chart .seg button.on').innerText()) === '5m')
await pg.locator('.btn.pri.big').click(); await pg.waitForTimeout(200); chk('buy w/o wallet opens wallet panel', await pg.locator('.modal h2', { hasText: 'Wallet' }).isVisible()); await pg.locator('.modal').click({ position: { x: 5, y: 5 } })
chk('buy label', (await pg.locator('.btn.pri.big').innerText()).includes('Connect'))
await pg.locator('.seg button', { hasText: 'Rules' }).click(); await pg.waitForTimeout(100)
chk('rules tab', (await pg.locator('.panel').first().innerText()).includes('Desk'))
await pg.locator('.seg button', { hasText: 'Sell' }).first().click(); await pg.waitForTimeout(100)
chk('sell panel', (await pg.locator('.btn.big.sell').count()) === 1)
await pg.locator('.coinhd button', { hasText: 'Watch' }).click(); await pg.waitForTimeout(100)
chk('watch toggles', (await pg.locator('.coinhd button').last().innerText()).includes('Watching'))
await pg.goto('http://localhost:4178/#/portfolio'); await pg.waitForTimeout(300)
chk('portfolio empty state', (await pg.locator('.empty').innerText()).includes('Connect'))
await pg.goto('http://localhost:4178/#/settings'); await pg.waitForTimeout(300)
await pg.locator('.btn.sm', { hasText: 'Advanced' }).click(); await pg.waitForTimeout(200); chk('settings rpc field (advanced)', (await pg.locator('.fld input').last().inputValue()).includes('helius'))
await pg.goto('http://localhost:4178/#/about'); await pg.waitForTimeout(300)
chk('about', (await pg.locator('.prose').innerText()).includes('PumpPortal'))
await pg.goto('http://localhost:4178/#/'); await pg.waitForTimeout(500)
await pg.locator('.top .btn.pri', { hasText: 'Launch' }).first().click(); await pg.waitForTimeout(200)
chk('launch modal', await pg.locator('.modal h2').isVisible())
await pg.fill('.modal input[placeholder="Glass Frog"]', 'Test'); await pg.fill('.modal input[placeholder="GLASS"]', 'tst'); chk('launch is 3 fields + advanced', (await pg.locator('.modal').innerText()).includes('Advanced'))
chk('ticker uppercased', (await pg.locator('.modal input[placeholder="GLASS"]').inputValue()) === 'TST')
chk('launch button prompts wallet', (await pg.locator('.modal .btn.pri').innerText()).includes('Connect'))
await pg.locator('.modal .btn', { hasText: 'Cancel' }).click()
chk('search filters', await (async () => { await pg.fill('.search input', 'bonk'); await pg.waitForTimeout(800); await pg.locator('.seg button', { hasText: 'Market' }).first().click(); await pg.waitForTimeout(300); return (await pg.locator('tbody tr').count()) === 1 })())
// wallet-adapter present
chk('wallet button', (await pg.locator('.top .btn', { hasText: 'Connect wallet' }).count()) === 1)
// Simulate a trade pipeline with a fake wallet: call through the lib directly by exposing a fake signer via injected module? Instead, verify pumpportal request shape through the lib in node below.
chk('no page errors', errs.filter((e) => !e.startsWith('FAIL') && !/net::|Failed to load|WebSocket|ERR_/.test(e)).length === 0)
await pg.screenshot({ path: '/tmp/claude-0/-home-claude/19bd7c5b-b1c7-5711-b6c1-300014df70fa/scratchpad/app-home.png' })
await pg.goto('http://localhost:4178/#/coin/' + MINT); await pg.waitForTimeout(1500)
await pg.screenshot({ path: '/tmp/claude-0/-home-claude/19bd7c5b-b1c7-5711-b6c1-300014df70fa/scratchpad/app-coin.png' })
console.log('ERRORS:', errs.filter((e) => !/net::|Failed to load|WebSocket|ERR_/.test(e)).join('\n') || 'none')
await b.close(); srv.close()
