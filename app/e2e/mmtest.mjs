import { fileURLToPath as __f } from 'url'; import { dirname as __d, resolve as __r } from 'path'; import { mkdirSync as __mk, rmSync as __rm } from 'fs'
const HERE = __d(__f(import.meta.url)); const SC = process.env.E2E_TMP || __r(HERE, '../.e2e-tmp'); __rm(SC, { recursive: true, force: true }); __mk(SC, { recursive: true })
import { createServer } from 'http'; import { spawn } from 'child_process'
import { VersionedTransaction, TransactionMessage, SystemProgram, Keypair, PublicKey } from '@solana/web3.js'
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', TREASURY = '7UX2i7SucgLMQcfZ75s3VXmZZY4YRUyJN9X1RgfMoDUi'
let price = 0.00001, liq = 100, vaultPub = null, vaultTokens = 50_000_000, trades = []
const pair = () => ({ chainId: 'solana', dexId: 'raydium', url: 'x', pairAddress: 'P1', baseToken: { address: MINT, name: 'Bonk', symbol: 'BONK' }, quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' }, priceUsd: String(price * 160), priceNative: String(price), marketCap: price * 160 * 1e9, liquidity: { usd: liq * 160 * 2, quote: liq }, volume: { h24: 50000, h1: 20000 }, priceChange: {}, txns: { h24: { buys: 100, sells: 80 } }, pairCreatedAt: Date.now() - 86400000 })
const mock = createServer(async (req, res) => {
  const u = req.url
  if (u.includes('trade-local')) { let b = ''; req.on('data', (c) => (b += c)); await new Promise((r) => req.on('end', r)); const q = JSON.parse(b); trades.push(q); if (q.action === 'sell') { const pct = parseFloat(q.amount) / 100; vaultTokens *= 1 - pct } if (q.action === 'buy') vaultTokens += q.amount / price; const pk = new PublicKey(q.publicKey); const msg = new TransactionMessage({ payerKey: pk, recentBlockhash: '11111111111111111111111111111111', instructions: [SystemProgram.transfer({ fromPubkey: pk, toPubkey: pk, lamports: 1 })] }).compileToV0Message(); res.statusCode = 200; return res.end(Buffer.from(new VersionedTransaction(msg).serialize())) }
  if (/token-pairs|tokens\/v1/.test(u)) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify([u.includes('So1111') ? { ...pair(), baseToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL', name: 'SOL' }, priceUsd: '160' } : pair()])) }
  let body = ''; req.on('data', (c) => (body += c)); await new Promise((r) => req.on('end', r)); res.setHeader('content-type', 'application/json')
  let q; try { q = JSON.parse(body) } catch { return res.end('[]') }; const reply = (result) => res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id, result })); const owner = q.params?.[0]
  if (q.method === 'getAccountInfo') return reply({ context: { slot: 1 }, value: { data: ['', 'base64'], executable: false, lamports: 1461600, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', rentEpoch: 0, space: 82 } })
  if (q.method === 'getBalance') return reply({ context: { slot: 1 }, value: 10e9 })
  if (q.method === 'getTokenSupply') return reply({ context: { slot: 1 }, value: { amount: '1000000000000000', decimals: 6, uiAmount: 1e9 } })
  if (q.method === 'getTokenAccountsByOwner') { const amt = Math.floor(vaultTokens * 1e6); return reply({ context: { slot: 1 }, value: [{ pubkey: TREASURY, account: { executable: false, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280, rentEpoch: 0, space: 165, data: { program: 'spl-token', space: 165, parsed: { type: 'account', info: { mint: MINT, owner, isNative: false, state: 'initialized', tokenAmount: { amount: String(amt), decimals: 6, uiAmount: amt / 1e6, uiAmountString: String(amt / 1e6) } } } } } }] }) }
  if (q.method === 'getLatestBlockhash') return reply({ context: { slot: 1 }, value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999999 } })
  if (q.method === 'sendTransaction') return reply('5'.repeat(87))
  if (q.method === 'getSignatureStatuses') return reply({ context: { slot: 1 }, value: [{ slot: 1, confirmations: 10, err: null, confirmationStatus: 'confirmed' }] })
  reply(null)
}).listen(4390)
const proc = spawn('node', ['--experimental-strip-types', 'src/index.ts'], { cwd: process.env.E2E_SERVER || __r(HERE, '../../server'), env: { ...process.env, PORT: '4192', RPC_URL: 'http://localhost:4390', DEX_URL: 'http://localhost:4390', TREASURY, DATA_DIR: SC + '/vdata6', PUMPPORTAL_URL: 'http://localhost:4390' }, stdio: ['ignore', 'pipe', 'pipe'] })
proc.stderr.on('data', (d) => { const s = String(d); if (!s.includes('bigint')) process.stdout.write('[srv!] ' + s) })
await new Promise((r) => setTimeout(r, 2500))
const chk = (n, ok) => console.log((ok ? 'PASS ' : 'FAIL ') + n)
const post = (p, b) => fetch('http://localhost:4192' + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json())
const v = await post('/vault/create', { dev: TREASURY, stakeSol: 5, mode: 'mm', ceiling: 0.3 }); vaultPub = v.pub
const armed = await post('/vault/arm', { id: v.id, mint: MINT, symbol: 'BONK' }); chk('armed in mm mode', armed.armed && armed.mode === 'mm')
// let it sample for ~12s at flat price → vwap = price, no capture
await new Promise((r) => setTimeout(r, 12000)); let g = await (await fetch('http://localhost:4192/vault/mint/' + MINT)).json()
chk('flat market: capture now 0% (not stretched)', g.live.captureNow === 0 && g.score.captures === 0)
// pump: price +30% and reserve +8 SOL (a buy) — repeatedly over a few ticks
price *= 1.3; liq += 8; await new Promise((r) => setTimeout(r, 6000)); price *= 1.05; liq += 6; await new Promise((r) => setTimeout(r, 6000)); price *= 1.03; liq += 5; await new Promise((r) => setTimeout(r, 6000)); price *= 1.03; liq += 5; await new Promise((r) => setTimeout(r, 6000)); price *= 1.05; liq += 6; await new Promise((r) => setTimeout(r, 6000)); liq += 6; await new Promise((r) => setTimeout(r, 6000))
g = await (await fetch('http://localhost:4192/vault/mint/' + MINT)).json()
console.log('LIVE', JSON.stringify(g.live), 'avgCost', g.avgCost, 'tokens', g.tokens, 'chest', g.chest, 'acts', g.activity.slice(0,4).map(a=>a.kind+':'+a.msg).join(' | ')); chk('stretched: capture now > 0', g.live.captureNow > 0.05)
chk('mm countered inflow (vault sold)', g.score.captures >= 1 && trades.some((t) => t.action === 'sell'))
chk('capture is bounded (≤5% of position per capture)', trades.filter((t) => t.action === 'sell').every((t) => parseFloat(t.amount) <= 5))
// dump: price −25% from high → tranche 1 fires
const sellsBefore = trades.filter((t) => t.action === 'buy').length
price *= 0.72; liq -= 20; await new Promise((r) => setTimeout(r, 22000)) // two ticks below trigger (wick filter, 3.5–6.5s each) + up to 4s random delay
g = await (await fetch('http://localhost:4192/vault/mint/' + MINT)).json()
chk('tranche 1 fired on −25%', g.live.tranchesFired.length >= 1 && trades.filter((t) => t.action === 'buy').length > sellsBefore)
console.log('BUYS', trades.filter((t) => t.action === 'buy').map((t) => t.amount)); const chestBefore = g.chest + trades.filter((t) => t.action === 'buy').slice(1).reduce((a, t) => a + t.amount, 0); chk('defense tranche ≤ chest×0.4×skew(≤1.5)/3', trades.filter((t) => t.action === 'buy').slice(1).every((t) => t.amount <= chestBefore * 0.4 * 1.5 / 3 + 0.001))
// switch to floor: no more captures even if stretched
const sw = await post('/vault/mode', { id: v.id, dev: TREASURY, mode: 'floor' }); chk('mode switched to floor', sw.mode === 'floor')
const capBefore = g.score.captures; price *= 1.5; liq += 10; await new Promise((r) => setTimeout(r, 7000)); liq += 10; await new Promise((r) => setTimeout(r, 7000))
g = await (await fetch('http://localhost:4192/vault/mint/' + MINT)).json()
chk('floor mode: no new captures', g.score.captures === capBefore && g.live.captureNow === 0)
chk('scorecard present', typeof g.score.redeployed === 'number' && typeof g.floor === 'number')
proc.kill(); mock.close(); process.exit(0)
