// Preflight: prove every live integration's SHAPE against mainnet without spending anything.
// Builds the real transactions (PumpPortal single + bundle mode + create, Jupiter swap, our Sender tip, desk fill) for a
// well-funded public wallet and runs them through simulateTransaction (sigVerify off) — the chain tells us whether the
// instructions are valid before any key or SOL is involved. Runs in CI (.github/workflows/preflight.yml) and locally:
//   RPC_URL=https://mainnet.helius-rpc.com/?api-key=… node --experimental-strip-types scripts/preflight.ts
import { Connection, PublicKey, VersionedTransaction, Transaction, SystemProgram, TransactionMessage } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import bs58 from 'bs58'
import { decode } from '../src/stream.ts'
import { addTip, senderUrl, TIP_ACCOUNTS, MIN_TIP_LAMPORTS } from '../src/fast.ts'
import { verifyFill } from '../src/verify.ts'
import * as R from '../src/rules.ts'

const RPC = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com'
const conn = new Connection(RPC, 'confirmed')
const PAYER = new PublicKey(process.env.PREFLIGHT_PAYER || '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9') // any well-funded wallet; we only simulate
const PP = (process.env.PUMPPORTAL_URL || 'https://pumpportal.fun/api') + '/trade-local'
const DEX = process.env.DEX_URL || 'https://api.dexscreener.com'
const GT = 'https://api.geckoterminal.com/api/v2'
const t = () => performance.now(); const ms = (a: number) => `${(t() - a).toFixed(0)}ms`
const out: { name: string; ok: boolean; info: string }[] = []
const row = (name: string, ok: boolean, info: string) => { out.push({ name, ok, info }); console.log(`${ok ? 'OK  ' : 'FAIL'} ${name.padEnd(34)} ${info}`) }
const timeout = <T,>(p: Promise<T>, n: number) => Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error('timeout ' + n + 'ms')), n))])
async function step(name: string, f: () => Promise<string>) { const a = t(); try { row(name, true, (await f()) + ' · ' + ms(a)) } catch (e: any) { row(name, false, String(e?.message || e).slice(0, 300) + ' · ' + ms(a)) } }
const sleep = (n: number) => new Promise((r) => setTimeout(r, n))
/** simulate with signatures ignored; returns logs tail or throws with the on-chain error */
async function sim(tx: VersionedTransaction, label: string) {
  const r = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' })
  const v = r.value; const logs = (v.logs || []).slice(-3).join(' | ')
  if (v.err) throw new Error(`${label} simulate err ${JSON.stringify(v.err)} · ${logs}`)
  return `${label} ok · ${v.unitsConsumed} CU · ${logs.slice(0, 160)}`
}
const ctx: { curveMint?: string; ammMint?: string; ammPool?: string; sol?: number } = {}

// ---------- market data shapes ----------
await step('dexscreener: SOL pairs shape', async () => {
  const r = await timeout(fetch(`${DEX}/token-pairs/v1/solana/So11111111111111111111111111111111111111112`), 10000); const p: any[] = await r.json()
  if (!Array.isArray(p) || !p.length) throw new Error('not a bare array'); const x = p[0]
  for (const k of ['chainId', 'dexId', 'pairAddress', 'baseToken', 'quoteToken', 'priceNative', 'priceUsd', 'liquidity', 'volume', 'txns']) if (!(k in x)) throw new Error('missing ' + k)
  ctx.sol = +x.priceUsd; return `${p.length} pairs · SOL $${ctx.sol} · dexIds ${[...new Set(p.map((q) => q.dexId))].slice(0, 6).join(',')}`
})
await step('geckoterminal: pump-fun curve pools (dex id)', async () => {
  const r = await timeout(fetch(`${GT}/networks/solana/dexes/pump-fun/pools?page=1&sort=h24_volume_usd_desc`), 10000); if (!r.ok) throw new Error('HTTP ' + r.status)
  const d: any = await r.json(); const pools = d.data || []; if (!pools.length) throw new Error('no pools')
  const live = pools.find((p: any) => +p.attributes.volume_usd.h1 > 500) || pools[0]
  ctx.curveMint = live.relationships.base_token.data.id.replace('solana_', '')
  return `${pools.length} pools · picked ${live.attributes.name} mint ${ctx.curveMint.slice(0, 8)}… h24 $${(+live.attributes.volume_usd.h24).toFixed(0)}`
})
await sleep(2500)
await step('geckoterminal: pumpswap pools + ohlcv + trades', async () => {
  const r = await timeout(fetch(`${GT}/networks/solana/dexes/pumpswap/pools?page=1&sort=h24_volume_usd_desc`), 10000); if (!r.ok) throw new Error('HTTP ' + r.status)
  const d: any = await r.json(); const p = d.data?.[0]; if (!p) throw new Error('no pools')
  ctx.ammPool = p.attributes.address; ctx.ammMint = p.relationships.base_token.data.id.replace('solana_', '')
  await sleep(2500)
  const o = await (await fetch(`${GT}/networks/solana/pools/${ctx.ammPool}/ohlcv/minute?aggregate=1&limit=5&currency=usd`)).json() as any
  const l = o.data?.attributes?.ohlcv_list; if (!Array.isArray(l) || l[0]?.length !== 6) throw new Error('ohlcv shape ' + JSON.stringify(o).slice(0, 120))
  await sleep(2500)
  const tr = await (await fetch(`${GT}/networks/solana/pools/${ctx.ammPool}/trades`)).json() as any
  const a = tr.data?.[0]?.attributes; if (!a || !('kind' in a) || !('volume_in_usd' in a) || !('block_timestamp' in a)) throw new Error('trades shape')
  return `${p.attributes.name} · ${l.length} candles (newest first: ${l[0][0] > l[1][0]}) · ${tr.data.length} trades · kind=${a.kind} vol=$${(+a.volume_in_usd).toFixed(0)}`
})
await step('dexscreener: curve + amm coin fields we use', async () => {
  const r = await fetch(`${DEX}/tokens/v1/solana/${ctx.curveMint},${ctx.ammMint}`); const p: any[] = await r.json()
  const c = p.find((x) => x.baseToken.address === ctx.curveMint), a = p.find((x) => x.baseToken.address === ctx.ammMint)
  return `curve dexId=${c?.dexId} liq.quote=${c?.liquidity?.quote} mcap=${c?.marketCap} · amm dexId=${a?.dexId} pair=${a?.pairAddress?.slice(0, 6)} vol.h1=${a?.volume?.h1}`
})

// ---------- token program on real mints ----------
await step('token program: curve + amm mints', async () => {
  const [c, a] = await Promise.all([conn.getAccountInfo(new PublicKey(ctx.curveMint!)), conn.getAccountInfo(new PublicKey(ctx.ammMint!))])
  const lbl = (o?: PublicKey) => o?.equals(TOKEN_PROGRAM_ID) ? 'spl-token' : o?.equals(TOKEN_2022_PROGRAM_ID) ? 'token-2022' : 'unknown'
  return `curve=${lbl(c?.owner)} amm=${lbl(a?.owner)}`
})
await step('token-2022 share of top 50 pumpswap mints', async () => {
  await sleep(2500)
  const d: any = await (await fetch(`${GT}/networks/solana/dexes/pumpswap/pools?page=1&sort=h24_volume_usd_desc`)).json(); await sleep(2500)
  const d2: any = await (await fetch(`${GT}/networks/solana/dexes/pumpswap/pools?page=2&sort=h24_volume_usd_desc`)).json()
  const mints = [...(d.data || []), ...(d2.data || [])].map((p: any) => new PublicKey(p.relationships.base_token.data.id.replace('solana_', ''))).slice(0, 50)
  const infos = await conn.getMultipleAccountsInfo(mints); const n22 = infos.filter((i) => i?.owner.equals(TOKEN_2022_PROGRAM_ID)).length
  return `${n22}/${mints.length} are Token-2022`
})

// ---------- landing stack ----------
await step('helius: priority estimate', async () => {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getPriorityFeeEstimate', params: [{ accountKeys: [PAYER.toBase58()], options: { recommended: true } }] }) })
  const d: any = await r.json(); if (d.error) throw new Error(d.error.message); return `${d.result.priorityFeeEstimate} µlamports/CU`
})
await step('helius: sender ping', async () => `${(await timeout(fetch('https://sender.helius-rpc.com/ping'), 8000)).status} · ${senderUrl(RPC).replace(/api-key=[^&]+/, 'api-key=…')}`)
await step('jito: getTipAccounts', async () => {
  const r = await timeout(fetch('https://mainnet.block-engine.jito.wtf/api/v1/getTipAccounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTipAccounts', params: [] }) }), 8000)
  const d: any = await r.json(); if (d.error) throw new Error(JSON.stringify(d.error)); return `${d.result.length} accounts (${d.result[0].slice(0, 6)}…)`
})
await step('jito: tip floor', async () => { const d: any = await (await timeout(fetch('https://bundles.jito.wtf/api/v1/bundles/tip_floor'), 8000)).json(); const x = d[0]; return `p50 ${x.landed_tips_50th_percentile} p75 ${x.landed_tips_75th_percentile} SOL` })

// ---------- pumpportal: real tx builds, simulated ----------
let curveBuy: VersionedTransaction | null = null
await step('pumpportal: curve buy (single) → simulate', async () => {
  const r = await timeout(fetch(PP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicKey: PAYER.toBase58(), action: 'buy', mint: ctx.curveMint, amount: 0.01, denominatedInSol: 'true', slippage: 15, priorityFee: 0.0005, pool: 'auto' }) }), 15000)
  if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`); const ct = r.headers.get('content-type')
  curveBuy = VersionedTransaction.deserialize(new Uint8Array(await r.arrayBuffer()))
  return `content-type=${ct} · version=${curveBuy.message.version} · ${curveBuy.message.compiledInstructions.length} ix · ` + (await sim(curveBuy, 'buy'))
})
await step('pumpportal: amm buy (single) → simulate', async () => {
  const r = await timeout(fetch(PP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicKey: PAYER.toBase58(), action: 'buy', mint: ctx.ammMint, amount: 0.01, denominatedInSol: 'true', slippage: 15, priorityFee: 0.0005, pool: 'auto' }) }), 15000)
  if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`)
  return await sim(VersionedTransaction.deserialize(new Uint8Array(await r.arrayBuffer())), 'amm buy')
})
await step('our sender tip appended to pumpportal tx → simulate', async () => {
  if (!curveBuy) throw new Error('no curve buy tx'); const tipped = await addTip(conn, curveBuy, PAYER, MIN_TIP_LAMPORTS)
  const keys = tipped.message.staticAccountKeys.map((k) => k.toBase58()); if (!TIP_ACCOUNTS.some((a) => keys.includes(a))) throw new Error('tip account not in keys')
  return `${tipped.message.compiledInstructions.length} ix · ` + (await sim(tipped, 'tipped buy'))
})
await step('pumpportal: bundle mode (array) → base58 txs → simulate', async () => {
  const body = [{ publicKey: PAYER.toBase58(), action: 'buy', mint: ctx.curveMint, amount: 0.01, denominatedInSol: 'true', slippage: 15, priorityFee: 0.0005, pool: 'pump' }]
  const r = await timeout(fetch(PP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), 15000)
  if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`); const txt = await r.text(); let enc: string[]
  try { enc = JSON.parse(txt) } catch { throw new Error('bundle response not JSON: ' + txt.slice(0, 80)) }
  if (!Array.isArray(enc) || typeof enc[0] !== 'string') throw new Error('not an array of strings: ' + txt.slice(0, 80))
  const tx = VersionedTransaction.deserialize(bs58.decode(enc[0]))
  const jitoTips = ['96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5', 'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe', 'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY', 'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49', 'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh', 'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt', 'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL', '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT']
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58()); const hasTip = jitoTips.some((a) => keys.includes(a))
  return `${enc.length} tx · jito tip account present=${hasTip} · ` + (await sim(tx, 'bundle buy'))
})
await step('pumpportal: create + dev buy (random mint) → shape only', async () => {
  const { Keypair } = await import('@solana/web3.js'); const mintKp = Keypair.generate()
  const r = await timeout(fetch(PP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicKey: PAYER.toBase58(), action: 'create', tokenMetadata: { name: 'preflight', symbol: 'PRE', uri: 'https://ipfs.io/ipfs/bafkreigh2akiscaildc' }, mint: mintKp.publicKey.toBase58(), denominatedInSol: 'true', amount: 0.01, slippage: 15, priorityFee: 0.0005, pool: 'pump' }) }), 15000)
  if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`)
  const tx = VersionedTransaction.deserialize(new Uint8Array(await r.arrayBuffer())); tx.sign([mintKp])
  const signers = tx.message.header.numRequiredSignatures
  return `${tx.message.compiledInstructions.length} ix · ${signers} signers (dev + mint) · mint signature applied=${tx.signatures.some((s) => s.some((b) => b))} · ` + (await sim(tx, 'create').catch((e) => 'simulate: ' + String(e.message).slice(0, 120)))
})
await step('pumpportal: collectCreatorFee → shape', async () => {
  const r = await timeout(fetch(PP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicKey: PAYER.toBase58(), action: 'collectCreatorFee', priorityFee: 0.000001 }) }), 15000)
  const txt = r.ok ? '' : await r.text(); if (!r.ok) return `HTTP ${r.status} ${txt.slice(0, 120)} (expected for a wallet with no creator fees)`
  const tx = VersionedTransaction.deserialize(new Uint8Array(await r.arrayBuffer())); return `${tx.message.compiledInstructions.length} ix`
})

// ---------- jupiter ----------
await step('jupiter: api.jup.ag quote + swap → simulate', async () => {
  const h: Record<string, string> = process.env.JUP_KEY ? { 'x-api-key': process.env.JUP_KEY } : {}
  const q = await (await timeout(fetch(`https://api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${ctx.ammMint}&amount=10000000&slippageBps=1000&restrictIntermediateTokens=true`, { headers: h }), 15000)).json() as any
  if (q.error) throw new Error('quote: ' + q.error)
  await sleep(2100)
  const s = await (await fetch('https://api.jup.ag/swap/v1/swap', { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify({ quoteResponse: q, userPublicKey: PAYER.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, dynamicSlippage: false, prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 1000000, priorityLevel: 'high' } } }) })).json() as any
  if (s.error) throw new Error('swap: ' + s.error)
  const tx = VersionedTransaction.deserialize(Buffer.from(s.swapTransaction, 'base64'))
  const tipped = await addTip(conn, tx, PAYER, MIN_TIP_LAMPORTS)
  return `out ${q.outAmount} · impact ${q.priceImpactPct}% · v${tx.message.version} alts=${tx.message.version === 'legacy' ? 0 : tx.message.addressTableLookups.length} · ` + (await sim(tipped, 'tipped swap'))
})

// ---------- desk fill structure on the real amm mint ----------
await step('desk fill tx: build + verify on real mint', async () => {
  const mint = new PublicKey(ctx.ammMint!); const info = await conn.getAccountInfo(mint); const prog = info!.owner
  const dec = (await conn.getTokenSupply(mint)).value.decimals; const px = 0.00001
  const { Keypair } = await import('@solana/web3.js'); const seller = Keypair.generate().publicKey, bidder = Keypair.generate().publicKey, treasury = Keypair.generate().publicKey
  const q = R.fillQuote(1, 400, px, dec)
  const bAta = getAssociatedTokenAddressSync(mint, bidder, true, prog), sAta = getAssociatedTokenAddressSync(mint, seller, true, prog)
  const tx = new Transaction(); tx.feePayer = seller; tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash
  tx.add(createAssociatedTokenAccountIdempotentInstruction(seller, bAta, bidder, mint, prog), createTransferCheckedInstruction(sAta, mint, bAta, seller, BigInt(q.base), dec, [], prog), SystemProgram.transfer({ fromPubkey: bidder, toPubkey: seller, lamports: BigInt(q.sellerLamports) }), SystemProgram.transfer({ fromPubkey: bidder, toPubkey: treasury, lamports: BigInt(q.fee) }))
  const why = verifyFill(tx, { mint: mint.toBase58(), seller: seller.toBase58(), bidder: bidder.toBase58(), treasury: treasury.toBase58(), base: BigInt(q.base), sellerLamports: BigInt(q.sellerLamports), fee: BigInt(q.fee), tokenProgram: prog.toBase58(), decimals: dec })
  if (why) throw new Error('verify: ' + why)
  return `program=${prog.equals(TOKEN_2022_PROGRAM_ID) ? 'token-2022' : 'spl'} decimals=${dec} · ${tx.serialize({ requireAllSignatures: false }).length} bytes · verify ok`
})

// ---------- pool websocket ----------
await step('helius ws: logsSubscribe on amm pool → decode one swap', async () => {
  const pool = ctx.ammPool!
  return await timeout(new Promise<string>((res, rej) => {
    const ws = new (globalThis as any).WebSocket(RPC.replace(/^http/, 'ws')); const a = t()
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [pool] }, { commitment: 'confirmed' }] }))
    ws.onerror = (e: any) => rej(new Error('ws error ' + (e?.message || '')))
    ws.onmessage = async (ev: any) => {
      const m = JSON.parse(ev.data); if (m.method !== 'logsNotification') return
      const sig = m.params.result.value.signature; if (m.params.result.value.err) return
      ws.close(); try { const sw = await decode(conn, pool, sig, m.params.result.context.slot); res(sw ? `swap in ${ms(a)}: ${sw.side} ${sw.sol.toFixed(4)} SOL by ${sw.trader.slice(0, 6)}…` : `log seen but not decoded as swap (${sig.slice(0, 8)}…)`) } catch (e: any) { rej(e) }
    }
  }), 45000)
})

const fails = out.filter((o) => !o.ok).length
console.log(`\n${out.length - fails}/${out.length} checks passed`)
{ const { writeFileSync, mkdirSync } = await import('node:fs'); mkdirSync('reports', { recursive: true }); writeFileSync('reports/preflight.md', `# Preflight · ${new Date().toISOString()} · ${out.length - fails}/${out.length} passed\n\n` + out.map((o) => `- ${o.ok ? 'OK  ' : 'FAIL'} **${o.name}** — ${o.info}`).join('\n') + '\n'); writeFileSync('reports/preflight.json', JSON.stringify({ at: Date.now(), out }, null, 1)) }
if (process.env.GITHUB_STEP_SUMMARY) { const { appendFileSync } = await import('node:fs'); appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Preflight · ${out.length - fails}/${out.length} passed\n\n| check | ok | detail |\n|---|---|---|\n` + out.map((o) => `| ${o.name} | ${o.ok ? '✅' : '❌'} | ${o.info.replace(/\|/g, '/')} |`).join('\n') + '\n') }
process.exit(fails ? 1 : 0)
