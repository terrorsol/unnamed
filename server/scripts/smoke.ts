// Mainnet smoke test for everything the server touches. Run where the server runs (Render/Railway shell) or locally:
//   RPC_URL=https://mainnet.helius-rpc.com/?api-key=… node --experimental-strip-types scripts/smoke.ts
//   …add  --trade <mint> <sol> --key <base58 secret>   to do a real tiny buy + 100% sell through the vault path (pumpTrade) and time the landing.
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import { decode } from '../src/stream.ts'
import { senderUrl, TIP_ACCOUNTS } from '../src/fast.ts'

const RPC = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com'
const conn = new Connection(RPC, 'confirmed')
const args = process.argv.slice(2); const flag = (k: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined }
const t = () => performance.now(); const ms = (a: number) => `${(t() - a).toFixed(0)}ms`
const row = (name: string, ok: boolean, info: string) => console.log(`${ok ? 'OK  ' : 'FAIL'} ${name.padEnd(28)} ${info}`)
const timeout = <T,>(p: Promise<T>, msN: number) => Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error('timeout ' + msN + 'ms')), msN))])
let fails = 0; const step = async (name: string, f: () => Promise<string>) => { const a = t(); try { row(name, true, (await f()) + ' · ' + ms(a)) } catch (e: any) { fails++; row(name, false, (e?.message || e) + ' · ' + ms(a)) } }

await step('rpc getSlot', async () => 'slot ' + (await timeout(conn.getSlot(), 8000)))
await step('rpc priority estimate', async () => {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getPriorityFeeEstimate', params: [{ options: { recommended: true } }] }) })
  const d: any = await r.json(); if (d.error) throw new Error(d.error.message); return `recommended ${d.result.priorityFeeEstimate} µlamports/CU`
})
await step('helius sender ping', async () => { const r = await timeout(fetch('https://sender.helius-rpc.com/ping'), 8000); return `${r.status} via ${senderUrl(RPC).replace(/api-key=[^&]+/, 'api-key=…')}` })
await step('jito tip accounts', async () => {
  const r = await timeout(fetch(process.env.JITO_URL || 'https://mainnet.block-engine.jito.wtf/api/v1/bundles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTipAccounts', params: [] }) }), 8000)
  const d: any = await r.json(); if (d.error) throw new Error(JSON.stringify(d.error)); return `${d.result.length} accounts`
})
await step('pumpportal trade-local', async () => {
  const r = await timeout(fetch((process.env.PUMPPORTAL_URL || 'https://pumpportal.fun/api') + '/trade-local', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), 8000)
  return `reachable (HTTP ${r.status} on empty body)`
})
await step('dexscreener', async () => {
  const r = await timeout(fetch(`${process.env.DEX_URL || 'https://api.dexscreener.com'}/token-pairs/v1/solana/So11111111111111111111111111111111111111112`), 8000)
  const p: any[] = await r.json(); return `${p.length} SOL pairs, top ${p[0]?.dexId} ${p[0]?.pairAddress?.slice(0, 6)}…`
})
await step('geckoterminal ohlcv', async () => {
  const pool = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2' // SOL/USDC raydium
  const r = await timeout(fetch(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/minute?aggregate=1&limit=3&currency=usd`, { headers: { accept: 'application/json;version=20230302' } }), 8000)
  const d: any = await r.json(); const l = d.data.attributes.ohlcv_list; return `${l.length} candles, last close ${l[0][4]}`
})
await step('pool websocket (logsSubscribe)', async () => {
  const pool = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2'
  return await timeout(new Promise<string>((res, rej) => {
    const ws = new (globalThis as any).WebSocket(RPC.replace(/^http/, 'ws')); const a = t()
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [pool] }, { commitment: 'confirmed' }] }))
    ws.onerror = (e: any) => rej(new Error('ws error ' + (e?.message || '')))
    ws.onmessage = async (ev: any) => {
      const m = JSON.parse(ev.data); if (m.method !== 'logsNotification') return
      const sig = m.params.result.value.signature; ws.close()
      const sw = await decode(conn, pool, sig, m.params.result.context.slot).catch((e) => { throw new Error('decode: ' + e.message) })
      res(sw ? `first swap in ${ms(a)}: ${sw.side} ${sw.sol.toFixed(3)} SOL ${sig.slice(0, 8)}…` : `log seen, not a swap (${sig.slice(0, 8)}…)`)
    }
  }), 30000)
})

const mint = flag('trade'), sol = +(args[args.indexOf('--trade') + 2] || 0), key = flag('key')
if (mint && key) {
  const { pumpTrade, FAST } = await import('../src/chain.ts')
  const kp = Keypair.fromSecretKey(bs58.decode(key))
  console.log(`\ntrading as ${kp.publicKey.toBase58()} · balance ${(await conn.getBalance(kp.publicKey)) / 1e9} SOL · path ${process.env.JITO === '1' ? 'jito bundle' : FAST ? 'helius sender' : 'rpc'}`)
  await step(`buy ${sol} SOL of ${mint.slice(0, 6)}…`, async () => 'sig ' + (await pumpTrade(kp, 'buy', mint, sol, true, 15)))
  await new Promise((r) => setTimeout(r, 3000))
  await step('sell 100%', async () => 'sig ' + (await pumpTrade(kp, 'sell', mint, '100%', false, 15)))
  console.log(`balance after ${(await conn.getBalance(kp.publicKey)) / 1e9} SOL`)
} else if (mint || key) console.log('\n(--trade needs both --trade <mint> <sol> and --key <base58 secret>)')

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed'); process.exit(fails ? 1 : 0)
