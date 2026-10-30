// Private beta gate, end to end against the REAL server with GATE=1: writes are refused without a session, the app shows the gate,
// a key is redeemed in the UI with the in-app wallet (signature), the terminal unlocks, writes work with the session header,
// and the same key is refused for a second wallet.
import { fileURLToPath as __f } from 'url'; import { dirname as __d, resolve as __r } from 'path'; import { mkdirSync as __mk, rmSync as __rm } from 'fs'
const HERE = __d(__f(import.meta.url)); const SC = process.env.E2E_TMP || __r(HERE, '../.e2e-tmp-gate'); __rm(SC, { recursive: true, force: true }); __mk(SC, { recursive: true })
import { chromium } from 'playwright'
import { createServer } from 'http'; import { readFileSync, existsSync } from 'fs'; import { join, extname } from 'path'
import { spawn, execFileSync } from 'child_process'
import { Keypair } from '@solana/web3.js'
import nacl from 'tweetnacl'; import bs58 from 'bs58'
const DIST = __r(HERE, '../dist'); const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }
const stat = createServer((req, res) => { let p = join(DIST, req.url.split('?')[0]); if (!existsSync(p) || p.endsWith('/')) p = join(DIST, 'index.html'); res.setHeader('content-type', MIME[extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)) }).listen(4297)
// mock rpc + dex for the server (it only needs /health-level reads here)
const mock = createServer(async (req, res) => { let body = ''; for await (const c of req) body += c; res.setHeader('content-type', 'application/json'); let q = {}; try { q = JSON.parse(body) } catch {}
  if (req.url.startsWith('/tokens/v1/') || req.url.startsWith('/token-pairs/')) return res.end('[]')
  const id = q.id ?? 1; if (q.method === 'getBalance') return res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { context: { slot: 1 }, value: 5e9 } }))
  res.end(JSON.stringify({ jsonrpc: '2.0', id, result: null })) }).listen(4390)
const SRV = process.env.E2E_SERVER || __r(HERE, '../../server'); const DATA = SC + '/gate-data'
const keys = execFileSync('node', ['--experimental-strip-types', 'scripts/invites.ts', '2', 'e2e'], { cwd: SRV, env: { ...process.env, DATA_DIR: DATA }, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n')
const proc = spawn('node', ['--experimental-strip-types', 'src/index.ts'], { cwd: SRV, env: { ...process.env, MM_WARMUP_MS: '0', DEV_AUTH: '0', GATE: '1', PORT: '4292', RPC_URL: 'http://localhost:4390', DEX_URL: 'http://localhost:4390', DATA_DIR: DATA, VAMPS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
proc.stderr.on('data', (d) => { const s = String(d); if (!s.includes('bigint')) process.stdout.write('[srv!] ' + s) })
await new Promise((r) => setTimeout(r, 3000))
const chk = (n, ok) => console.log((ok ? 'PASS ' : 'FAIL ') + n)
const S = 'http://localhost:4292'
const post = (p, b, h = {}) => fetch(S + p, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(b) })

chk('two keys minted in BANK-XXXX-XXXX form', keys.length === 2 && keys.every((k) => /^BANK-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(k)))
const h = await (await fetch(S + '/health')).json(); chk('health says gated, 2 keys, 0 redeemed', h.gate === true && h.invites.keys === 2 && h.invites.redeemed === 0)
const r0 = await post('/vault/create', { dev: 'x', stakeSol: 1 }); chk('write without a session → 401 gate', r0.status === 401 && (await r0.json()).gate === true)
chk('reads stay open', (await fetch(S + '/vaults')).status === 200)

// ---- the app: gate screen → in-app wallet → key → unlocked ----
const b = await chromium.launch(); const pg = await b.newPage({ viewport: { width: 1200, height: 900 } })
await pg.addInitScript(() => { localStorage.setItem('unnamed_server', 'http://localhost:4292') })
const errs = []; pg.on('pageerror', (e) => { errs.push(String(e)); console.log('PAGEERR', String(e).slice(0, 200)) })
await pg.route(/api\.dexscreener\.com|geckoterminal\.com/, (r) => r.fulfill({ json: [] }))
await pg.route(/raw\.githubusercontent\.com/, (r) => r.fulfill({ status: 404, body: '' }))
await pg.route(/mainnet-beta\.solana\.com|helius-rpc\.com/, (r) => { const q = JSON.parse(r.request().postData()); const id = q.id; if (q.method === 'getBalance') return r.fulfill({ json: { jsonrpc: '2.0', id, result: { context: { slot: 1 }, value: 2e9 } } }); if (q.method === 'getTokenAccountsByOwner') return r.fulfill({ json: { jsonrpc: '2.0', id, result: { context: { slot: 1 }, value: [] } } }); r.fulfill({ json: { jsonrpc: '2.0', id, result: null } }) })
await pg.goto('http://localhost:4297/#/?key=' + keys[0]); await pg.waitForTimeout(2500)
chk('gate screen shown with the key prefilled from the url', (await pg.locator('.gate').count()) === 1 && (await pg.locator('.gate input').inputValue()) === keys[0])
chk('nothing else of the terminal renders behind the gate', (await pg.locator('.tiles').count()) === 0)
await pg.locator('.gate .btn.pri').click(); await pg.waitForTimeout(400)
chk('enter without a wallet opens the wallet panel', (await pg.locator('.modal').count()) >= 1)
await pg.locator('.modal .seg button', { hasText: 'In-app' }).click()
await pg.locator('.modal input[type=password]').nth(0).fill('hunter2hunter2'); await pg.locator('.modal input[type=password]').nth(1).fill('hunter2hunter2')
await pg.locator('.modal .btn.pri', { hasText: 'Create wallet' }).click(); await pg.waitForTimeout(2000)
const addr = await pg.locator('.modal .tile .v').nth(1).innerText()
await pg.keyboard.press('Escape'); await pg.locator('.modal').click({ position: { x: 5, y: 5 } }).catch(() => {}); await pg.waitForTimeout(300)
await pg.locator('.gate .btn.pri', { hasText: 'Enter' }).click(); await pg.waitForTimeout(2500)
chk('gate gone after redeeming', (await pg.locator('.gate').count()) === 0 && (await pg.locator('.tiles').count()) >= 1)
const token = await pg.evaluate(() => localStorage.getItem('banker_session')); chk('session stored', !!token && token.length > 30)
const h2 = await (await fetch(S + '/health')).json(); chk('key now redeemed and bound', h2.invites.redeemed === 1)
const r1 = await post('/vault/create', { dev: addr, stakeSol: 1 }, { 'x-banker-session': token }); chk('write with the session → 200', r1.status === 200 && (await r1.json()).pub)
// same key, different wallet → that wallet is added to the key; wrong key → refused; reload keeps the session
const w2 = Keypair.generate(); const msg = `banker:invite:${w2.publicKey.toBase58()}:${Math.floor(Date.now() / 60000)}`; const sig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(msg), w2.secretKey))
const r2 = await post('/invite/redeem', { code: keys[0], wallet: w2.publicKey.toBase58(), msg, sig }); chk('same key from another of the holder\'s wallets → works (one key, any wallet)', r2.status === 200 && !!(await r2.json()).token)
const r3 = await post('/invite/redeem', { code: 'BANK-AAAA-AAAA', wallet: w2.publicKey.toBase58(), msg, sig }); chk('unknown key → refused', r3.status >= 400)
await pg.reload(); await pg.waitForTimeout(2500); chk('reload: still unlocked', (await pg.locator('.gate').count()) === 0)
chk('no page errors', errs.length === 0)
await b.close(); proc.kill(); stat.close(); mock.close()
