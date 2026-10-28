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
const ctx: { curveMint?: string; mayhemMint?: string; ammMint?: string; ammPool?: string; sol?: number } = {}

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
  const cands = pools.filter((p: any) => +p.attributes.volume_usd.h1 > 500).sort((a: any, b: any) => +b.attributes.volume_usd.h1 - +a.attributes.volume_usd.h1)
  const { curveSpot } = await import('../src/pool.ts'); const skipped: string[] = []; let live: any = null, mayhem: any = null
  for (const p of cands.slice(0, 10)) {
    const m = p.relationships.base_token.data.id.replace('solana_', '')
    try { const info = await conn.getAccountInfo(new PublicKey(m)); const sp = await curveSpot(m); const dec = (await conn.getTokenSupply(new PublicKey(m))).value.decimals
      if (!sp || sp.complete) { skipped.push(`${p.attributes.name}: ${sp ? 'graduated' : 'no curve'}`); continue }
      if (dec !== 6) { skipped.push(`${p.attributes.name}: ${dec} decimals`); continue }
      const t22 = !info || info.owner.toBase58() !== 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
      if (t22) { if (!mayhem) mayhem = p; continue }
      live = p; break } catch (e: any) { skipped.push(`${p.attributes.name}: ${String(e.message).slice(0, 40)}`) }
    if (live && mayhem) break
  }
  // most live curve coins are now Token-2022 ("mayhem mode"). Prefer a plain one for the classic checks, but keep a mayhem one to test the routes against.
  const pick = live || mayhem; if (!pick) throw new Error('no live curve coin among ' + cands.length + ' · ' + skipped.join('; '))
  ctx.curveMint = pick.relationships.base_token.data.id.replace('solana_', ''); if (mayhem) ctx.mayhemMint = mayhem.relationships.base_token.data.id.replace('solana_', '')
  return `${pools.length} pools · picked ${pick.attributes.name} (${live ? 'plain' : 'mayhem/token-2022'}) mint ${ctx.curveMint.slice(0, 8)}… h24 $${(+pick.attributes.volume_usd.h24).toFixed(0)}` + (mayhem ? ` · mayhem sample ${mayhem.attributes.name}` : ' · no mayhem coin in top 10') + (skipped.length ? ` · skipped ${skipped.join('; ')}` : '')
})
await sleep(2500)
await step('geckoterminal: active pumpswap pool (trending) + ohlcv + trades', async () => {
  // dexes/pumpswap/pools sorted by h24 volume returns stale pools; trending_pools filtered to pumpswap gives coins that trade right now
  const tr1: any = await (await timeout(fetch(`${GT}/networks/solana/trending_pools?page=1`), 10000)).json(); await sleep(2500)
  const tr2: any = await (await timeout(fetch(`${GT}/networks/solana/trending_pools?page=2`), 10000)).json()
  const cands = [...(tr1.data || []), ...(tr2.data || [])].filter((p: any) => p.relationships?.dex?.data?.id === 'pumpswap' && +p.attributes.volume_usd.h1 > 5000 && +(p.attributes.transactions?.m5?.buys || 0) > 0)
    .sort((a: any, b: any) => +b.attributes.volume_usd.h1 - +a.attributes.volume_usd.h1)
  const p = cands[0]; if (!p) throw new Error('no active pumpswap pool in trending')
  ctx.ammPool = p.attributes.address; ctx.ammMint = p.relationships.base_token.data.id.replace('solana_', '')
  await sleep(2500)
  const o = await (await fetch(`${GT}/networks/solana/pools/${ctx.ammPool}/ohlcv/minute?aggregate=1&limit=5&currency=usd`)).json() as any
  const l = o.data?.attributes?.ohlcv_list; if (!Array.isArray(l) || l[0]?.length !== 6) throw new Error('ohlcv shape ' + JSON.stringify(o).slice(0, 120))
  await sleep(2500)
  const tr = await (await fetch(`${GT}/networks/solana/pools/${ctx.ammPool}/trades`)).json() as any
  const a = tr.data?.[0]?.attributes; if (!a || !('kind' in a) || !('volume_in_usd' in a) || !('block_timestamp' in a)) throw new Error('trades shape')
  return `${p.attributes.name} h1 $${(+p.attributes.volume_usd.h1).toFixed(0)} m5 buys ${p.attributes.transactions.m5.buys} · ${l.length} candles (newest first: ${l[0][0] > l[1][0]}) · ${tr.data.length} trades · last ${a.kind} $${(+a.volume_in_usd).toFixed(0)}`
})
await step('dexscreener: curve + amm coin fields we use', async () => {
  const r = await fetch(`${DEX}/tokens/v1/solana/${ctx.curveMint},${ctx.ammMint}`); const p: any[] = await r.json()
  const c = p.find((x) => x.baseToken.address === ctx.curveMint), a = p.find((x) => x.baseToken.address === ctx.ammMint)
  return `curve dexId=${c?.dexId} liq.quote=${c?.liquidity?.quote} mcap=${c?.marketCap} · amm dexId=${a?.dexId} pair=${a?.pairAddress?.slice(0, 6)} vol.h1=${a?.volume?.h1}`
})

// ---------- exact pool price vs indexer ----------
await step('pool price: curve reserves vs dexscreener', async () => {
  const { curveSpot } = await import('../src/pool.ts'); const sp = await curveSpot(ctx.curveMint!)
  if (!sp) throw new Error('curve account not decoded'); const r = await fetch(`${DEX}/tokens/v1/solana/${ctx.curveMint}`); const p: any = (await r.json())[0]; const ipx = +p.priceNative
  const dev = Math.abs(sp.priceSol / ipx - 1)
  const sup = await conn.getTokenSupply(new PublicKey(ctx.curveMint!)); const info = await conn.getAccountInfo(new PublicKey(ctx.curveMint!)); const t22 = info?.owner.toBase58() !== 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
  const d = (await conn.getAccountInfo((await import('../src/pool.ts')).curvePda(ctx.curveMint!)))!.data
  const raw = `vTok=${d.readBigUInt64LE(8)} vSol=${d.readBigUInt64LE(16)} rTok=${d.readBigUInt64LE(24)} rSol=${d.readBigUInt64LE(32)} supply=${d.readBigUInt64LE(40)} complete=${d[48]} len=${d.length}`
  const diag = `supply ${sup.value.uiAmountString} (${sup.value.decimals} dec, ${t22 ? 'token-2022' : 'spl'}) · indexer mcap $${p.marketCap} fdv $${p.fdv} px $${p.priceUsd} · ours×supply = ${(sp.priceSol * +(sup.value.uiAmount || 0)).toFixed(1)} SOL mcap · ${raw}`
  if (dev > 0.05 && !t22) throw new Error(`curve ${sp.priceSol.toPrecision(4)} vs indexer ${ipx.toPrecision(4)} (${(dev * 100).toFixed(1)}% off) · ${diag}`)
  return `curve ${sp.priceSol.toPrecision(4)} SOL · indexer ${ipx.toPrecision(4)} · ${(dev * 100).toFixed(2)}% apart · vSOL ${sp.liqSol.toFixed(1)} · ${diag}`
})
await step('pool price: pumpswap vaults vs dexscreener', async () => {
  const { pumpswapSpot } = await import('../src/pool.ts'); const sp = await pumpswapSpot(ctx.ammPool!, ctx.ammMint!)
  if (!sp) throw new Error('pool vaults not found'); const r = await fetch(`${DEX}/tokens/v1/solana/${ctx.ammMint}`); const p: any = (await r.json())[0]; const ipx = +p.priceNative
  const dev = Math.abs(sp.priceSol / ipx - 1); if (dev > 0.10) throw new Error(`pool ${sp.priceSol.toPrecision(4)} vs indexer ${ipx.toPrecision(4)} (${(dev * 100).toFixed(1)}% off)`) // the indexer lags a busy pool by seconds; >10% means we decoded the wrong vaults
  return `pool ${sp.priceSol.toPrecision(4)} SOL · indexer ${ipx.toPrecision(4)} · ${(dev * 100).toFixed(2)}% apart · ${sp.liqSol.toFixed(1)} SOL in pool`
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
await step('mayhem coin: pumpportal buy vs jupiter fallback → simulate', async () => {
  if (!ctx.mayhemMint) return 'no Token-2022 curve coin in the top 10 right now — skipped'
  const notes: string[] = []
  try {
    const r = await timeout(fetch(PP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicKey: PAYER.toBase58(), action: 'buy', mint: ctx.mayhemMint, amount: 0.01, denominatedInSol: 'true', slippage: 15, priorityFee: 0.0005, pool: 'pump' }) }), 15000)
    if (!r.ok) notes.push(`pumpportal HTTP ${r.status}`); else notes.push('pumpportal: ' + (await sim(VersionedTransaction.deserialize(new Uint8Array(await r.arrayBuffer())), 'buy').catch((e) => 'FAILS ' + String(e.message).slice(0, 90))))
  } catch (e: any) { notes.push('pumpportal: ' + String(e.message).slice(0, 80)) }
  await sleep(1500)
  try { const { jupBuild } = await import('../src/chain.ts'); const tx = await jupBuild(PAYER, 'buy', ctx.mayhemMint, 0.01, true, 1500); notes.push('jupiter: ' + (await sim(tx, 'buy').catch((e) => 'FAILS ' + String(e.message).slice(0, 90)))) }
  catch (e: any) { notes.push('jupiter: ' + String(e.message).slice(0, 80)) }
  // this step reports; it fails only when NEITHER route can buy the coin
  if (!notes.some((n) => / ok /.test(n))) throw new Error(notes.join(' · '))
  return notes.join(' · ')
})
await step('market(): geckoterminal fallback fields for a curve coin', async () => {
  await sleep(6000); const { fromGecko } = await import('../src/market.ts'); const g: any = await fromGecko(ctx.mayhemMint || ctx.curveMint!).catch((e) => { if (/429/.test(String(e.message))) return '429'; throw e })
  if (g === '429') return 'geckoterminal rate-limits this runner IP on /tokens/{mint}/pools (trending/ohlcv calls above went through) — fallback is exercised on the server, not here'
  if (!g) throw new Error('no SOL-quoted pool for ' + (ctx.mayhemMint || ctx.curveMint)); for (const k of ['priceSol', 'mcapUsd', 'vol1h', 'pair', 'dexId']) if (g[k] == null) throw new Error('missing ' + k)
  const { curveSpot } = await import('../src/pool.ts'); const sp = await curveSpot(ctx.mayhemMint || ctx.curveMint!)
  return `${g.symbol} ${g.dexId} onCurve=${g.onCurve} px ${g.priceSol.toPrecision(4)} (curve ${sp?.priceSol.toPrecision(4)}, ${sp ? (Math.abs(sp.priceSol / g.priceSol - 1) * 100).toFixed(1) : '?'}% apart) · mcap $${g.mcapUsd.toFixed(0)} · vol1h $${g.vol1h.toFixed(0)} · liq ${g.liqSol.toFixed(1)} SOL`
})
await step('pumpportal: amm buy (single) → simulate', async () => {
  const notes: string[] = []
  for (const pool of ['auto', 'pump-amm']) {
    const r = await timeout(fetch(PP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicKey: PAYER.toBase58(), action: 'buy', mint: ctx.ammMint, amount: 0.01, denominatedInSol: 'true', slippage: 15, priorityFee: 0.0005, pool }) }), 15000)
    if (!r.ok) { notes.push(`pool=${pool} HTTP ${r.status} ${(await r.text()).slice(0, 120)}`); continue }
    return `pool=${pool} · ` + (await sim(VersionedTransaction.deserialize(new Uint8Array(await r.arrayBuffer())), 'amm buy')) + (notes.length ? ' · ' + notes.join('; ') : '')
  }
  throw new Error(notes.join('; '))
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
await step('launch bundle: [create+dev buy, vault buy] → decode + math check', async () => {
  // the exact 2-tx bundle the app sends at launch, built by PumpPortal for a random mint. Dev and vault are both PAYER here (same wallet twice is allowed).
  const { Keypair } = await import('@solana/web3.js'); const L = await import('../src/launch.ts')
  const mintKp = Keypair.generate(); const mint = mintKp.publicKey.toBase58(); const devSol = 0.05, vaultSol = 0.1
  const body = [
    { publicKey: PAYER.toBase58(), action: 'create', tokenMetadata: { name: 'preflight', symbol: 'PRE', uri: 'https://ipfs.io/ipfs/bafkreigh2akiscaildc' }, mint, denominatedInSol: 'true', amount: devSol, slippage: 10, priorityFee: 0.0005, pool: 'pump' },
    { publicKey: PAYER.toBase58(), action: 'buy', mint, denominatedInSol: 'true', amount: vaultSol, slippage: 10, priorityFee: 0.00005, pool: 'pump' },
  ]
  const r = await timeout(fetch(PP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), 20000)
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 160)}`)
  const enc: string[] = await r.json(); if (enc.length !== 2) throw new Error('expected 2 txs, got ' + enc.length)
  const [t0, t1] = enc.map((e) => VersionedTransaction.deserialize(bs58.decode(e)))
  { const { writeFileSync, mkdirSync } = await import('node:fs'); mkdirSync('reports', { recursive: true }); writeFileSync('reports/launch-bundle.json', JSON.stringify({ mint, devSol, vaultSol, payer: PAYER.toBase58(), txs: enc }, null, 1)) }
  const k0 = await L.resolveKeys(t0, conn), k1 = await L.resolveKeys(t1, conn)
  const c = L.inspectCreate(t0, mint, 6, k0); const b = L.inspectBuy(t1, PAYER.toBase58(), mint, 6, k1)
  const z = L.blockZero(devSol, vaultSol)
  const devDev = c.buy ? (c.buy.tokens - z.devTokens) / z.devTokens * 100 : NaN, vaultDev = (b.tokens - z.vaultTokens) / z.vaultTokens * 100
  if (Math.abs(devDev) > 0.5 || Math.abs(vaultDev) > 0.5) throw new Error(`our block-zero math is off: dev ${devDev.toFixed(3)}% vault ${vaultDev.toFixed(3)}%`)
  // the real cost of the vault buy is fixed by the create tx's dev buy + our token amount; PumpPortal's max_sol_cost is only a ceiling
  const real = L.bundleCost(c.buy?.tokens || 0, b.tokens)
  if (!(b.maxSolCost >= real.cost)) throw new Error(`max_sol_cost ${b.maxSolCost} below the real cost ${real.cost}`)
  if (Math.abs(real.sol - vaultSol) / vaultSol > 0.005) throw new Error(`real cost ${real.sol.toFixed(5)} ≠ requested ${vaultSol}`)
  if (!c.tipSol && !b.tipSol) throw new Error('no Jito tip in either tx')
  const simNote = await sim(t0, 'create').catch((e) => 'create simulate: ' + String(e.message).slice(0, 100))
  return `${c.created} · tip on ${c.tipSol ? 'tx0' : 'tx1'} ${(c.tipSol || b.tipSol).toFixed(4)} SOL · dev ${(c.buy!.tokens / 1e6).toFixed(3)}M tok (ours ${(z.devTokens / 1e6).toFixed(3)}M, ${devDev >= 0 ? '+' : ''}${devDev.toFixed(3)}%) · vault ${(b.tokens / 1e6).toFixed(3)}M (ours ${(z.vaultTokens / 1e6).toFixed(3)}M, ${vaultDev >= 0 ? '+' : ''}${vaultDev.toFixed(3)}%) via ${b.via} · real cost ${real.cost.toFixed(4)} SOL vs max_sol_cost ${b.maxSolCost.toFixed(4)} (${(b.maxSolCost / real.cost).toFixed(2)}× pad) · ixs ${b.ixs.join(',')} · ${simNote}`
})
await step('pumpportal: collectCreatorFee → shape', async () => {
  const r = await timeout(fetch(PP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicKey: PAYER.toBase58(), action: 'collectCreatorFee', priorityFee: 0.000001 }) }), 15000)
  const txt = r.ok ? '' : await r.text(); if (!r.ok) return `HTTP ${r.status} ${txt.slice(0, 120)} (expected for a wallet with no creator fees)`
  const tx = VersionedTransaction.deserialize(new Uint8Array(await r.arrayBuffer())); return `${tx.message.compiledInstructions.length} ix`
})

// ---------- launchlab: our launchpad ----------
const LLX: { mint?: string; platformId?: string } = {}
await step('launchlab: reference platform + default config decode', async () => {
  const LL = await import('../src/launchlab.ts'); const { LAUNCHPAD_PLATFORM, PlatformConfig, LaunchpadConfig } = await import('@raydium-io/raydium-sdk-v2')
  const [pi, ci] = await Promise.all([conn.getAccountInfo(LAUNCHPAD_PLATFORM), conn.getAccountInfo(LL.CONFIG_ID)])
  if (!pi || !ci) throw new Error('platform/config account missing')
  const pd: any = PlatformConfig.decode(pi.data), cd: any = LaunchpadConfig.decode(ci.data)
  return `raydium platform fee ${+pd.feeRate / 1e4}% creator ${+pd.creatorFeeRate / 1e4}% · config#${cd.index} curve ${cd.curveType} protocol fee ${+cd.tradeFeeRate / 1e4}% · ours: tax ${LL.TAX_BPS} bps creator ${LL.CREATOR_FEE_BPS} bps · platform ${LL.PLATFORM_ID?.toBase58() || 'unset (PLATFORM_ADMIN)'}`
})
await step('launchlab: live pool decode vs geckoterminal price', async () => {
  const LL = await import('../src/launchlab.ts')
  // raydium's own launchpad api lists live pools; shapes tried in order
  let list: any[] = []; const tried: string[] = []
  for (const url of ['https://launch-mint-v1.raydium.io/get/list?sort=lastTrade&size=10&mintType=default&includeNsfw=false', 'https://launch-mint-v1.raydium.io/get/list?sort=marketCap&size=10&mintType=default&includeNsfw=false', 'https://launch-mint-v1.raydium.io/get/list?size=10']) {
    try { const d: any = await (await timeout(fetch(url), 10000)).json(); const rows = d?.data?.rows || d?.data?.data || d?.data || []; if (Array.isArray(rows) && rows.length) { list = rows; break } tried.push(url.slice(36, 60) + ':' + JSON.stringify(d).slice(0, 60)) } catch (e: any) { tried.push(String(e.message).slice(0, 40)) }
  }
  if (!list.length) throw new Error('raydium launch api gave no rows · ' + tried.join(' | '))
  const sample = list[0]; const keys = Object.keys(sample).slice(0, 40).join(','); const mintKey = ['mint', 'mintA', 'address', 'tokenMint', 'baseMint'].find((k) => typeof sample[k] === 'string' && sample[k].length > 30) || 'mint'
  list = list.map((x: any) => ({ ...x, mint: x[mintKey] }))
  const d = { data: list.map((x: any) => ({ relationships: { base_token: { data: { id: 'solana_' + x.mint } } }, attributes: { name: x.symbol || x.name || '?', base_token_price_native_currency: String(x.priceSol ?? x.price ?? 0) } })) }
  const notes: string[] = []
  for (const p of (d.data || []).slice(0, 8)) {
    const mint = p.relationships.base_token.data.id.replace('solana_', ''); const pl = await LL.pool(mint, 0)
    if (!pl) { notes.push(`${p.attributes.name}: no pool pda`); continue }
    if (pl.migrated) { notes.push(`${p.attributes.name}: migrated`); continue }
    const gpx = +p.attributes.base_token_price_native_currency; const dev = gpx ? Math.abs(pl.priceSol / gpx - 1) * 100 : NaN
    LLX.mint = mint; LLX.platformId = pl.platformId
    return `${p.attributes.name} · pool ${pl.poolId.slice(0, 8)}… status ${pl.status} sold ${pl.soldPct}% · ours ${pl.priceSol.toPrecision(4)} vs gecko ${gpx.toPrecision(4)} (${dev.toFixed(1)}% apart) · liq ${pl.liqSol.toFixed(1)} SOL · platform ${pl.platformId.slice(0, 8)}… fee pending ${(Number(pl.platformFee) / 1e9).toFixed(4)} SOL` + (notes.length ? ' · skipped ' + notes.join('; ') : '')
  }
  throw new Error('no live (unmigrated) launchlab pool in top 8 · ' + notes.join('; ') + ` · row keys ${keys} · sample ${JSON.stringify(sample).slice(0, 300)}`)
})
await step('launchlab: buy tx via sdk → simulate', async () => {
  if (!LLX.mint) throw new Error('no pool'); const LL = await import('../src/launchlab.ts')
  const tx = await LL.buildTrade(PAYER, 'buy', LLX.mint, 0.01, { slippageBps: 1500 })
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58()); if (!keys.includes(LL.PROGRAM.toBase58())) throw new Error('launchlab program not in tx')
  return `${tx.message.compiledInstructions.length} ix · ` + (await sim(tx, 'll buy'))
})
await step('launchlab: platform fee claim tx shape → simulate as that platform', async () => {
  if (!LLX.mint || !LLX.platformId) throw new Error('no pool'); const LL = await import('../src/launchlab.ts'); const { PlatformConfig } = await import('@raydium-io/raydium-sdk-v2')
  const pi = await conn.getAccountInfo(new PublicKey(LLX.platformId)); const pd: any = PlatformConfig.decode(pi!.data)
  // build as the pool's real platform (its fee wallet is the signer); simulate with sigVerify off
  const { Raydium, TxVersion, LAUNCHPAD_PROGRAM } = await import('@raydium-io/raydium-sdk-v2')
  const r = await Raydium.load({ connection: conn, owner: pd.platformClaimFeeWallet, disableLoadToken: true, disableFeatureCheck: true, cluster: 'mainnet' })
  const b: any = await r.launchpad.claimPlatformFee({ programId: LAUNCHPAD_PROGRAM, platformId: new PublicKey(LLX.platformId), platformClaimFeeWallet: pd.platformClaimFeeWallet, poolId: LL.poolIdOf(LLX.mint), mintB: LL.WSOL, txVersion: TxVersion.V0 })
  return `${b.transaction.message.compiledInstructions.length} ix · fee wallet ${pd.platformClaimFeeWallet.toBase58().slice(0, 8)}… · ` + (await sim(b.transaction, 'claim').catch((e) => 'simulate: ' + String(e.message).slice(0, 140)))
})
await step('launchlab: create platform config tx → simulate', async () => {
  const LL = await import('../src/launchlab.ts'); const { tx, platformId } = await LL.buildPlatformTx(PAYER)
  const t = VersionedTransaction.deserialize(Buffer.from(tx, 'base64'))
  return `platform pda ${platformId.slice(0, 8)}… · ${t.message.compiledInstructions.length} ix · ` + (await sim(t, 'create platform').catch((e) => 'simulate: ' + String(e.message).slice(0, 140)))
})
await step('launchlab: launch bundle [create+dev buy, vault buy] → decode + simulate create', async () => {
  const LL = await import('../src/launchlab.ts'); const { LAUNCHPAD_PLATFORM } = await import('@raydium-io/raydium-sdk-v2')
  const built = await LL.buildLaunch(PAYER, { name: 'preflight', symbol: 'PRE', uri: 'https://ipfs.io/ipfs/bafkreigh2akiscaildc' }, 0.05, LAUNCHPAD_PLATFORM)
  const txs = built.txs.map((b) => VersionedTransaction.deserialize(Buffer.from(b, 'base64')))
  const vt = await LL.buildTrade(PAYER, 'buy', built.mint, 0.1, { poolState: built.afterDev, fromCreate: true, slippageBps: 3000, platformId: LAUNCHPAD_PLATFORM, tipLamports: 1_000_000 })
  const progs = vt.message.compiledInstructions.map((ix) => vt.message.staticAccountKeys[ix.programIdIndex]?.toBase58().slice(0, 6)).join(',')
  const z = LL.blockZero(0.05, 0.1)
  const sims: string[] = []; for (const [i, t] of txs.entries()) sims.push(await sim(t, `create#${i}`).catch((e) => `create#${i} simulate: ` + String(e.message).slice(0, 120)))
  return `${txs.length} create tx · signers ${txs.map((t) => t.message.header.numRequiredSignatures).join('/')} · dev ${(built.devTokens / 1e6).toFixed(3)}M tok (${z.devPct.toFixed(2)}%) · vault buy ${(z.vaultTokens / 1e6).toFixed(3)}M (${z.vaultPct.toFixed(2)}%) programs ${progs} · mcap after ${z.mcapSol.toFixed(1)} SOL · ` + sims.join(' · ')
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
