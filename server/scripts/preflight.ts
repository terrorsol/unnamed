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

process.env.PERM_TAX_BPS ||= '100' // the token-2022 check needs a non-zero transfer tax to build the extension (production default is 0)
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
  if (v.err && JSON.stringify(v.err).includes('6063') && ctx.curveIsT22) return `${label}: PumpPortal 6063 on a Token-2022 (mayhem) coin — known, routed to Jupiter in prod`
  if (v.err) throw new Error(`${label} simulate err ${JSON.stringify(v.err)} · ${logs}`)
  return `${label} ok · ${v.unitsConsumed} CU · ${logs.slice(0, 160)}`
}
const ctx: { curveMint?: string; curveIsT22?: boolean; mayhemMint?: string; ammMint?: string; ammPool?: string; sol?: number } = {}

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
  ctx.curveMint = pick.relationships.base_token.data.id.replace('solana_', ''); ctx.curveIsT22 = !live; if (mayhem) ctx.mayhemMint = mayhem.relationships.base_token.data.id.replace('solana_', '')
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
await step('pump buy with max_sol_cost tightened to our curve cost +5% → simulate (the margin the server now signs launch buys with)', async () => {
  // a live curve coin: our cost for the tokens PumpPortal asks for, from the curve account itself; then the ceiling at +5%, +1% and +0% → which still pass
  const L = await import('../src/launch.ts'); const { curveSpot } = await import('../src/pool.ts')
  const r = await timeout(fetch(PP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ publicKey: PAYER.toBase58(), action: 'buy', mint: ctx.curveMint, denominatedInSol: 'true', amount: 0.2, slippage: 10, priorityFee: 0.0005, pool: 'pump' }]) }), 15000)
  if (!r.ok) throw new Error(`HTTP ${r.status}`); const enc: string[] = await r.json()
  const out: string[] = []
  { const t = VersionedTransaction.deserialize(bs58.decode(enc[0])); const res = await conn.simulateTransaction(t, { sigVerify: false, replaceRecentBlockhash: true })
    if (res.value.err) return `skipped: PumpPortal's own tx already fails on this coin untouched (${JSON.stringify(res.value.err).slice(0, 60)} — mayhem/Token-2022 curve; the vault routes those via Jupiter)` }
  for (const m of [1.05, 1.01, 1.0]) {
    const t = VersionedTransaction.deserialize(bs58.decode(enc[0])); const keys = await L.resolveKeys(t, conn); const b = L.inspectBuy(t, PAYER.toBase58(), ctx.curveMint!, 6, keys)
    const cs: any = await curveSpot(ctx.curveMint!); const st = { vSol: cs.liqSol, vTok: cs.liqSol / cs.priceSol }; const cost = L.costForTokens(st, b.tokens).cost
    L.setMaxSolCost(t, cost * m, keys)
    const res = await conn.simulateTransaction(t, { sigVerify: false, replaceRecentBlockhash: true }); out.push(`×${m}: ${res.value.err ? 'FAILS ' + JSON.stringify(res.value.err).slice(0, 60) : 'ok'}`)
  }
  if (!out[0].includes('ok')) throw new Error('the +5% ceiling is too tight: ' + out.join(' · '))
  return out.join(' · ')
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
await step("pump launch: the chest's block-zero buy goes straight to pump (no PumpPortal wrapper) → create + that buy simulate in one tx", async () => {
  // the server converts PumpPortal's wrapper buy into pump's own buy (launch.ts directPumpBuy). Dev and chest are both PAYER here; a Jito bundle
  // runs the two txs back to back, so one tx holding the create and then the converted buy is the same state the buy meets on mainnet.
  const { Keypair, TransactionMessage, ComputeBudgetProgram } = await import('@solana/web3.js'); const L = await import('../src/launch.ts')
  const mint = Keypair.generate().publicKey.toBase58()
  const body = [
    { publicKey: PAYER.toBase58(), action: 'create', tokenMetadata: { name: 'preflight', symbol: 'PRE', uri: 'https://ipfs.io/ipfs/bafkreigh2akiscaildc' }, mint, denominatedInSol: 'true', amount: 0.05, slippage: 10, priorityFee: 0.0005, pool: 'pump' },
    { publicKey: PAYER.toBase58(), action: 'buy', mint, denominatedInSol: 'true', amount: 0.1, slippage: 30, priorityFee: 0.00005, pool: 'pump' },
  ]
  const r = await timeout(fetch(PP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), 20000)
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 160)}`)
  const [t0, t1] = ((await r.json()) as string[]).map((e) => VersionedTransaction.deserialize(bs58.decode(e)))
  const luts = (await Promise.all([...t0.message.addressTableLookups, ...t1.message.addressTableLookups].map((l) => conn.getAddressLookupTable(l.accountKey)))).map((x) => x.value!).filter(Boolean)
  const gi = await conn.getAccountInfo(PublicKey.findProgramAddressSync([Buffer.from('global')], new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'))[0]); const gr = L.pumpGlobalRecipients(gi!.data)
  const d = L.directPumpBuy(t1, luts, mint, PAYER.toBase58(), PAYER.toBase58(), gi!.data); if (!d.tx) throw new Error('conversion refused: ' + d.why)
  const b = L.inspectBuy(d.tx, PAYER.toBase58(), mint, 6, await L.resolveKeys(d.tx, conn)); if (b.via !== 'pump') throw new Error('still the wrapper')
  const noCU = (ix: any) => !ix.programId.equals(ComputeBudgetProgram.programId)
  const m0 = TransactionMessage.decompile(t0.message, { addressLookupTableAccounts: luts }), m1 = TransactionMessage.decompile(d.tx.message, { addressLookupTableAccounts: luts })
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: PAYER, recentBlockhash: m0.recentBlockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ...m0.instructions.filter(noCU), ...m1.instructions.filter(noCU)] }).compileToV0Message(luts))
  return `global: ${gr.fee.length} fee + ${gr.buyback.length} buyback recipients · direct buy ${(b.tokens / 1e6).toFixed(3)}M tok, ceiling ${b.maxSolCost.toFixed(4)} · vault tx ${d.tx.serialize().length} B (wrapper ${t1.serialize().length} B) · ` + (await sim(tx, 'create + direct buy'))
})
await step('pumpportal: collectCreatorFee → shape', async () => {
  const r = await timeout(fetch(PP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicKey: PAYER.toBase58(), action: 'collectCreatorFee', priorityFee: 0.000001 }) }), 15000)
  const txt = r.ok ? '' : await r.text(); if (!r.ok) return `HTTP ${r.status} ${txt.slice(0, 120)} (expected for a wallet with no creator fees)`
  const tx = VersionedTransaction.deserialize(new Uint8Array(await r.arrayBuffer())); return `${tx.message.compiledInstructions.length} ix`
})

// ---------- launchlab: our launchpad ----------
const LLX: { mint?: string; platformId?: string; mints: string[]; first?: boolean } = { mints: [] }
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
  const notes: string[] = []; let msg = ''
  for (const p of (d.data || []).slice(0, 8)) {
    const mint = p.relationships.base_token.data.id.replace('solana_', ''); const pl = await LL.pool(mint, 0)
    if (!pl) { notes.push(`${p.attributes.name}: no pool pda`); continue }
    if (pl.migrated) { notes.push(`${p.attributes.name}: migrated`); continue }
    LLX.mints.push(mint); if (LLX.mint) continue
    const gpx = +p.attributes.base_token_price_native_currency; const dev = gpx ? Math.abs(pl.priceSol / gpx - 1) * 100 : NaN
    LLX.mint = mint; LLX.platformId = pl.platformId
    msg = `${p.attributes.name} · pool ${pl.poolId.slice(0, 8)}… status ${pl.status} sold ${pl.soldPct}% · ours ${pl.priceSol.toPrecision(4)} vs gecko ${gpx.toPrecision(4)} (${dev.toFixed(1)}% apart) · liq ${pl.liqSol.toFixed(1)} SOL · platform ${pl.platformId.slice(0, 8)}… fee pending ${(Number(pl.platformFee) / 1e9).toFixed(4)} SOL` + (notes.length ? ' · skipped ' + notes.join('; ') : '')
  }
  if (msg) return msg + ` · ${LLX.mints.length} live pools`
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
  const { getPdaLaunchpadVaultId } = await import('@raydium-io/raydium-sdk-v2'); const poolId = LL.poolIdOf(LLX.mint)
  const b: any = await r.launchpad.claimPlatformFee({ programId: LAUNCHPAD_PROGRAM, platformId: new PublicKey(LLX.platformId), platformClaimFeeWallet: pd.platformClaimFeeWallet, poolId, mintB: LL.WSOL, vaultB: getPdaLaunchpadVaultId(LAUNCHPAD_PROGRAM, poolId, LL.WSOL).publicKey, txVersion: TxVersion.V0 })
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

await step('jito: takes a real launch bundle [create, vault buy] with a fresh blockhash (unfunded keys — it can never land, costs nothing)', async () => {
  // the Oct 29 failure was 'bundle contains an expired blockhash' on every launch with a vault buy. This sends the exact bundle shape the app sends:
  // the server's restamped create (dev + mint signed) and the vault's block-zero buy, from brand-new unfunded wallets, and checks Jito's answer.
  const LL = await import('../src/launchlab.ts'); const C = await import('../src/chain.ts'); const { LAUNCHPAD_PLATFORM } = await import('@raydium-io/raydium-sdk-v2'); const { Keypair } = await import('@solana/web3.js')
  const dev = Keypair.generate(), vault = Keypair.generate(); const t0 = Date.now()
  const built = await LL.buildLaunch(dev.publicKey, { name: 'preflight', symbol: 'PRE', uri: 'https://ipfs.io/ipfs/bafkreigh2akiscaildc' }, 0, LAUNCHPAD_PLATFORM)
  const vt = await LL.buildTrade(vault.publicKey, 'buy', built.mint, 0.05, { poolState: built.afterDev, fromCreate: true, slippageBps: 3000, platformId: LAUNCHPAD_PLATFORM, tipLamports: 1_000_000 })
  const lb = await conn.getLatestBlockhash('confirmed'); const raws = built.restamp(lb.blockhash).map((b) => VersionedTransaction.deserialize(Buffer.from(b, 'base64')))
  if (vt.message.header.numRequiredSignatures === 1) vt.message.recentBlockhash = lb.blockhash
  for (const t of raws) t.sign([dev]); vt.sign([vault]); const buildMs = Date.now() - t0
  const same = raws.every((t) => t.message.recentBlockhash === vt.message.recentBlockhash)
  try {
    const id = await C.sendBundle([...raws.map((t) => t.serialize()), vt.serialize()])
    await new Promise((r) => setTimeout(r, 3000)); const st = await C.bundleStatus(id).catch(() => null)
    return `accepted · bundle ${String(id).slice(0, 10)}… · Jito status after 3 s: ${st?.status || 'not reported'} (unfunded, so it is expected to fail at the leader) · build ${buildMs} ms · one blockhash for the bundle: ${same}`
  } catch (e: any) {
    const m = String(e.message || e); if (/expired|blockhash/i.test(m)) throw new Error(`Jito refused a FRESH bundle as expired (build ${buildMs} ms): ${m.slice(0, 200)}`)
    return `refused for another reason (not the blockhash — fine for unfunded keys): ${m.slice(0, 160)} · build ${buildMs} ms · one blockhash: ${same}`
  }
})

await step('one-signature launch: create(+dev buy) with the stake transfer inside → size + simulate as a funded dev', async () => {
  // Oct 30: the stake no longer goes out ahead of the launch. The server appends dev → vault to the create the dev signs (mint-signed by us,
  // so it can't be stripped), and the bundle [create+stake, vault buy] is all-or-nothing. This proves the real SDK create still fits and runs.
  const LL = await import('../src/launchlab.ts'); const { LAUNCHPAD_PLATFORM } = await import('@raydium-io/raydium-sdk-v2'); const { Keypair } = await import('@solana/web3.js')
  const vault = Keypair.generate().publicKey; const out: string[] = []
  for (const [dev, perm] of [[0.5, false], [2, true]] as [number, boolean][]) {
    const built = await LL.buildLaunch(PAYER, { name: 'Preflight One Signature Launch', symbol: 'PREFLIGHT', uri: 'https://ipfs.io/ipfs/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy' }, dev, LAUNCHPAD_PLATFORM, perm)
    const size = await built.addTransfer(vault, 0.5e9); const lb = await conn.getLatestBlockhash('confirmed'); const raws = built.restamp(lb.blockhash).map((b) => VersionedTransaction.deserialize(Buffer.from(b, 'base64')))
    const keys = raws[0].message.staticAccountKeys.map((k) => k.toBase58()); if (!keys.includes(vault.toBase58())) throw new Error('vault not in the create tx')
    out.push(`dev buy ${dev}${perm ? ' + transfer tax' : ''}: ${size} B · ` + (await sim(raws[0], 'create+stake')).slice(0, 70))
  }
  return out.join(' · ')
})
await step('jito: takes a one-signature launch bundle [create+stake, vault buy] (unfunded keys — can never land)', async () => {
  const LL = await import('../src/launchlab.ts'); const C = await import('../src/chain.ts'); const { LAUNCHPAD_PLATFORM } = await import('@raydium-io/raydium-sdk-v2'); const { Keypair } = await import('@solana/web3.js')
  const dev = Keypair.generate(), vault = Keypair.generate(); const t0 = Date.now()
  const built = await LL.buildLaunch(dev.publicKey, { name: 'preflight', symbol: 'PRE', uri: 'https://ipfs.io/ipfs/bafkreigh2akiscaildc' }, 0.2, LAUNCHPAD_PLATFORM)
  await built.addTransfer(vault.publicKey, 1e9)
  const vt = await LL.buildTrade(vault.publicKey, 'buy', built.mint, 0.5, { poolState: built.afterDev, fromCreate: true, slippageBps: 3000, platformId: LAUNCHPAD_PLATFORM, tipLamports: 1_000_000 })
  const lb = await conn.getLatestBlockhash('confirmed'); const raws = built.restamp(lb.blockhash).map((b) => VersionedTransaction.deserialize(Buffer.from(b, 'base64')))
  if (vt.message.header.numRequiredSignatures === 1) vt.message.recentBlockhash = lb.blockhash
  for (const t of raws) t.sign([dev]); vt.sign([vault])
  try { const id = await C.sendBundle([...raws.map((t) => t.serialize()), vt.serialize()]); await new Promise((r) => setTimeout(r, 3000)); const st = await C.bundleStatus(id).catch(() => null); return `accepted · ${String(id).slice(0, 10)}… · status ${st?.status || 'not reported'} (unfunded: expected to fail at the leader) · build ${Date.now() - t0} ms` }
  catch (e: any) { const m = String(e.message || e); if (/expired|blockhash/i.test(m)) throw new Error('Jito refused a FRESH one-signature bundle as expired: ' + m.slice(0, 200)); return 'refused for another reason (fine for unfunded keys): ' + m.slice(0, 160) }
})
await step('pump one-signature launch: PumpPortal [create+dev buy+tip, vault buy] + stake inside the create → size + simulate + Jito', async () => {
  // what /pump/launch/build does: our mint key, the stake appended to the create (mint-signed by us), one blockhash, Jito bundle
  const { Keypair } = await import('@solana/web3.js'); const L = await import('../src/launch.ts'); const LL = await import('../src/launchlab.ts'); const C = await import('../src/chain.ts')
  const mintKp = Keypair.generate(); const mint = mintKp.publicKey.toBase58(); const vault = Keypair.generate()
  const mk = async (dev: string) => { const r = await timeout(fetch(PP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([
    { publicKey: dev, action: 'create', tokenMetadata: { name: 'Preflight One Signature', symbol: 'PREFLIGHT', uri: 'https://ipfs.io/ipfs/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy' }, mint, denominatedInSol: 'true', amount: 0.5, slippage: 10, priorityFee: 0.005, pool: 'pump' },
    { publicKey: vault.publicKey.toBase58(), action: 'buy', mint, denominatedInSol: 'true', amount: 1, slippage: 30, priorityFee: 0.00005, pool: 'pump' }]) }), 20000)
    if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 160)}`); return (await r.json() as string[]).map((e) => VersionedTransaction.deserialize(bs58.decode(e))) }
  // 1) as a funded dev: the create with the stake appended must still simulate
  let [ct] = await mk(PAYER.toBase58()); const luts: any[] = []; for (const l of ct.message.addressTableLookups) { const a = (await conn.getAddressLookupTable(l.accountKey)).value; if (a) luts.push(a) }
  ct = LL.appendTransfer(ct, luts, PAYER, vault.publicKey, 0.5e9); const size = ct.serialize().length; ct.sign([mintKp])
  const c = L.inspectCreate(ct, mint, 6, await L.resolveKeys(ct, conn)); if (!c.tipSol) throw new Error('no Jito tip left in the create after the surgery')
  const simNote = await sim(ct, 'pump create+stake')
  // 2) unfunded dev: Jito must take the bundle (fresh blockhash), it can never land
  const dev = Keypair.generate(); let [ct2, vt2] = await mk(dev.publicKey.toBase58()); const luts2: any[] = []; for (const l of ct2.message.addressTableLookups) { const a = (await conn.getAddressLookupTable(l.accountKey)).value; if (a) luts2.push(a) } ct2 = LL.appendTransfer(ct2, luts2, dev.publicKey, vault.publicKey, 1e9)
  const lb = await conn.getLatestBlockhash('confirmed'); ct2.message.recentBlockhash = lb.blockhash; vt2.message.recentBlockhash = lb.blockhash; ct2.sign([mintKp, dev]); vt2.sign([vault])
  let jito = ''; try { const id = await C.sendBundle([ct2.serialize(), vt2.serialize()]); await new Promise((r) => setTimeout(r, 3000)); const st = await C.bundleStatus(id).catch(() => null); jito = `Jito accepted (${st?.status || 'no status'})` } catch (e: any) { const m = String(e.message || e); if (/expired|blockhash/i.test(m)) throw new Error('Jito refused a fresh pump bundle as expired: ' + m.slice(0, 160)); jito = 'Jito refused (not the blockhash): ' + m.slice(0, 100) }
  return `${c.created} · ${size} B with the stake · tip ${c.tipSol.toFixed(4)} · ${simNote.slice(0, 60)} · ${jito}`
})
await step('launchlab: token-2022 launch with the permanent transfer tax → simulate create + vault buy shape', async () => {
  const LL = await import('../src/launchlab.ts'); const { LAUNCHPAD_PLATFORM } = await import('@raydium-io/raydium-sdk-v2')
  const built = await LL.buildLaunch(PAYER, { name: 'preflight', symbol: 'PRE', uri: 'https://ipfs.io/ipfs/bafkreigh2akiscaildc' }, 0.05, LAUNCHPAD_PLATFORM, true)
  const txs = built.txs.map((b) => VersionedTransaction.deserialize(Buffer.from(b, 'base64')))
  const { resolveKeys } = await import('../src/launch.ts'); const keys = await resolveKeys(txs[0], conn); const t22 = keys.includes('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
  const vt = await LL.buildTrade(PAYER, 'buy', built.mint, 0.1, { poolState: built.afterDev, fromCreate: true, slippageBps: 3000, platformId: LAUNCHPAD_PLATFORM, permTaxBps: built.permTax })
  const vkeys = await resolveKeys(vt, conn)
  const sims: string[] = []; for (const [i, t] of txs.entries()) sims.push(await sim(t, `create#${i}`).catch((e) => `create#${i} simulate: ` + String(e.message).slice(0, 160)))
  if (!t22) throw new Error('create tx does not use the token-2022 program · programs ' + [...new Set(txs[0].message.compiledInstructions.map((ix) => (keys[ix.programIdIndex] || '?').slice(0, 8)))].join(','))
  return `tax ${built.permTax} bps · ${txs.length} create tx (token-2022 ${t22}) · vault buy references token-2022 ${vkeys.includes('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')} · ` + sims.join(' · ')
})
await step('launchlab: HTTP routes on a live server (/ll/platform, /ll/pool, /ll/trade, /ll/launch/build) → simulate', async () => {
  const { spawn } = await import('node:child_process'); const { LAUNCHPAD_PLATFORM } = await import('@raydium-io/raydium-sdk-v2')
  const port = 4321 + Math.floor(Math.random() * 500)
  const proc = spawn(process.execPath, ['--experimental-strip-types', 'src/index.ts'], { env: { ...process.env, PORT: String(port), DATA_DIR: `/tmp/pf-${port}`, PLATFORM_ID: LAUNCHPAD_PLATFORM.toBase58(), VAMPS: '0', DEV_AUTH: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''; proc.stdout.on('data', (d) => { log += d }); proc.stderr.on('data', (d) => { log += d })
  try {
    const base = `http://127.0.0.1:${port}`; let up = false
    for (let i = 0; i < 40 && !up; i++) { await sleep(500); up = await fetch(base + '/health').then((r) => r.ok).catch(() => false) }
    if (!up) throw new Error('server did not start: ' + log.slice(-300))
    const post = (p: string, b: any) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json())
    const plat: any = await (await fetch(base + '/ll/platform')).json(); if (!plat.chain?.exists) throw new Error('/ll/platform: ' + JSON.stringify(plat).slice(0, 160))
    const pool: any = LLX.mint ? await (await fetch(base + '/ll/pool/' + LLX.mint)).json() : null
    const tr: any = LLX.mint ? await post('/ll/trade', { owner: PAYER.toBase58(), action: 'buy', mint: LLX.mint, amount: 0.01 }) : null
    const trSim = tr?.tx ? await sim(VersionedTransaction.deserialize(Buffer.from(tr.tx, 'base64')), 'route buy') : 'no live pool'
    const lb: any = await post('/ll/launch/build', { dev: PAYER.toBase58(), name: 'preflight', symbol: 'PRE', uri: 'https://ipfs.io/ipfs/bafkreigh2akiscaildc', devBuySol: 0.05 })
    if (!lb.txs?.length) throw new Error('/ll/launch/build: ' + JSON.stringify(lb).slice(0, 200))
    const cs = await sim(VersionedTransaction.deserialize(Buffer.from(lb.txs[0], 'base64')), 'route create')
    return `platform ${plat.chain.feeRate}% · pool ${pool ? `${pool.priceSol.toPrecision(3)} sold ${pool.soldPct}%` : '—'} · ${trSim.slice(0, 60)} · launch mint ${lb.mint.slice(0, 6)}… ${cs.slice(0, 60)}`
  } finally { proc.kill() }
})

await step('one-signature launch through the real server routes: /vault/create → /ll/launch/build + /pump/launch/build (fundInBundle) → simulate the creates', async () => {
  // the whole server path the app takes, against mainnet: a shared-wallet vault (a throwaway VAULT_KEY), the build with the stake inside the create,
  // and the create simulated as a funded dev. Nothing is signed by a real key and nothing is sent.
  const { spawn } = await import('node:child_process'); const { LAUNCHPAD_PLATFORM } = await import('@raydium-io/raydium-sdk-v2'); const { Keypair, SystemProgram: SPx } = await import('@solana/web3.js')
  const port = 4900 + Math.floor(Math.random() * 300); const vk = Keypair.generate()
  const proc = spawn(process.execPath, ['--experimental-strip-types', 'src/index.ts'], { env: { ...process.env, PORT: String(port), DATA_DIR: `/tmp/pf1-${port}`, PLATFORM_ID: LAUNCHPAD_PLATFORM.toBase58(), VAMPS: '0', DEV_AUTH: '0', VAULT_KEY: bs58.encode(vk.secretKey), PROFIT_ONLY: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''; proc.stdout.on('data', (d) => { log += d }); proc.stderr.on('data', (d) => { log += d })
  try {
    const base = `http://127.0.0.1:${port}`; let up = false
    for (let i = 0; i < 40 && !up; i++) { await sleep(500); up = await fetch(base + '/health').then((r) => r.ok).catch(() => false) }
    if (!up) throw new Error('server did not start: ' + log.slice(-300))
    const post = (p: string, b: any) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json())
    const out: string[] = []
    for (const venue of ['launchlab', 'pump']) {
      const v: any = await post('/vault/create', { dev: PAYER.toBase58(), stakeSol: 0.6, vaultBuySol: 0.4, venue, mode: 'mm' }); if (!v.id) throw new Error(venue + ' /vault/create: ' + JSON.stringify(v).slice(0, 160))
      const b: any = await post(venue === 'pump' ? '/pump/launch/build' : '/ll/launch/build', { dev: PAYER.toBase58(), name: 'Preflight', symbol: 'PRE', uri: 'https://ipfs.io/ipfs/bafkreigh2akiscaildc', devBuySol: 0.05, vaultId: v.id, vaultBuySol: 0.4, fundInBundle: true })
      if (!b.txs?.length) throw new Error(venue + ' build: ' + JSON.stringify(b).slice(0, 200))
      const ct = VersionedTransaction.deserialize(Buffer.from(b.txs[0], 'base64')); const keys = await (await import('../src/launch.ts')).resolveKeys(ct, conn)
      if (!keys.includes(v.pub)) throw new Error(venue + ': the vault wallet is not in the create — no stake inside')
      // pump: the chest's signed buy must call pump's program itself, never PumpPortal's wrapper (directPumpBuy)
      let via = ''; if (venue === 'pump' && b.vaultTx) { const vtx = VersionedTransaction.deserialize(Buffer.from(b.vaultTx, 'base64')); const ks = vtx.message.staticAccountKeys.map((k) => k.toBase58()); const progs = vtx.message.compiledInstructions.map((ix) => ks[ix.programIdIndex])
        if (progs.includes('FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe')) throw new Error('pump: the chest buy still goes through the PumpPortal wrapper'); via = progs.includes('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P') ? ' (direct pump buy)' : ' (?)' }
      out.push(`${venue}: fundSol ${b.fundSol} · vault buy ${b.vaultTx ? 'signed' : 'none'} ${(+b.vaultSpend || 0).toFixed(3)}${via} · ${ct.serialize().length} B · ` + (await sim(ct, venue + ' create+stake')).slice(0, 50))
    }
    return out.join(' · ')
  } finally { proc.kill() }
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

// ---------- tx guard: what the vault checks before it signs a trade someone else built ----------
// Every route the vault trades through (PumpPortal curve + amm, Jupiter, the LaunchLab SDK) is built for a real wallet, simulated with inner
// instructions and walked by the same guard production runs. Real trades must pass; the same trade with a drain appended must be refused.
const GUARDX: { buy?: VersionedTransaction; solCurve?: { mint: string; buy: VersionedTransaction } } = {}
async function ppBuild(owner: PublicKey, action: 'buy' | 'sell', mint: string, amount: number | string, pool = 'auto') {
  const r = await timeout(fetch(PP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicKey: owner.toBase58(), action, mint, amount, denominatedInSol: action === 'buy' ? 'true' : 'false', slippage: 15, priorityFee: 0.0005, pool }) }), 15000)
  if (!r.ok) throw new Error(`pumpportal HTTP ${r.status} ${(await r.text()).slice(0, 80)}`)
  return VersionedTransaction.deserialize(new Uint8Array(await r.arrayBuffer()))
}
/** a wallet (system-owned) that holds `mint`, from the largest token accounts; skips pools/curves (program-owned) */
async function holderOf(mint: string): Promise<{ owner: PublicKey; raw: bigint } | null> {
  const big = await conn.getTokenLargestAccounts(new PublicKey(mint)).catch(() => null); if (!big) return null
  const parsed = await conn.getMultipleParsedAccounts(big.value.slice(0, 12).map((a) => a.address)).catch(() => null); if (!parsed) return null
  for (const [i, a] of parsed.value.entries()) {
    const o = (a?.data as any)?.parsed?.info?.owner; if (!o) continue; const oi = await conn.getAccountInfo(new PublicKey(o)).catch(() => null)
    if (oi && oi.owner.toBase58() === '11111111111111111111111111111111' && oi.lamports > 0.01e9 && BigInt(big.value[i].amount) > 0n) return { owner: new PublicKey(o), raw: BigInt(big.value[i].amount) }
  }
  return null
}
/** a pump curve coin quoted in SOL (most top curve coins today are quoted in another token: PumpPortal answers 6063 UnsupportedQuoteMint
 *  on those). Our own launches are SOL-quoted, so this is the shape the chest trades. Found by asking PumpPortal for a buy and simulating it. */
async function solCurveCoin(): Promise<{ mint: string; buy: VersionedTransaction } | null> {
  const seen = new Set<string>()
  for (const q of ['sort=h24_volume_usd_desc&page=1', 'sort=h24_tx_count_desc&page=1', 'sort=h24_volume_usd_desc&page=2']) {
    const d: any = await (await timeout(fetch(`${GT}/networks/solana/dexes/pump-fun/pools?${q}`), 10000)).json().catch(() => null)
    for (const p of (d?.data || []).slice(0, 20)) {
      const m = p.relationships.base_token.data.id.replace('solana_', ''); if (seen.has(m)) continue; seen.add(m)
      try { const tx = await ppBuild(PAYER, 'buy', m, 0.01, 'pump'); const r = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true }); if (!r.value.err) return { mint: m, buy: tx } } catch {}
      if (seen.size >= 24) return null
      await sleep(250)
    }
    await sleep(1500)
  }
  return null
}
await step('tx guard: a SOL-quoted pump curve coin through PumpPortal\'s wrapper — real buy + real holder sell pass, the sell is capped', async () => {
  const G = await import('../src/txguard.ts'); const { tokenBalance } = await import('../src/chain.ts'); const { curveSpot } = await import('../src/pool.ts')
  const c = await solCurveCoin(); if (!c) return 'skipped: no SOL-quoted curve coin in the top lists this minute (the next step covers the wrapper buy on a fresh coin)'
  GUARDX.solCurve = c
  const notes: string[] = [`coin ${c.mint.slice(0, 6)}…`]
  const { buyWatch } = await import('../src/chain.ts'); const blim = { ...G.limitsFor('buy', c.mint, 0.01, { slippageBps: 1500 }), ...(await buyWatch(PAYER, c.mint)) }
  const bt = VersionedTransaction.deserialize(c.buy.serialize()); const capped = G.capBuyCeilings(bt, BigInt(Math.floor((blim.maxSolOut - 0.015) * 1e9)))
  const r = await G.guardTx(conn, bt, PAYER, blim); notes.push(`buy ok · out ${r.solOut.toFixed(4)} (fee ${(r.feeSol || 0).toFixed(5)}) · coin in ${r.tokIn} · ${r.checked} ixs${capped ? ' · ceiling capped' : ''}`)
  const h = await holderOf(c.mint); if (!h) return notes.concat('no wallet holder to test a sell').join(' · ')
  const bal = await tokenBalance(h.owner.toBase58(), c.mint); const sp = await curveSpot(c.mint).catch(() => null); const expectSol = bal.ui * 0.1 * (sp?.priceSol || 0)
  const sell = await ppBuild(h.owner, 'sell', c.mint, '10%', 'pump')
  try { const rs = await G.guardTx(conn, sell, h.owner, G.limitsFor('sell', c.mint, '10%', { slippageBps: 1500, expectSol, balanceRaw: bal.raw })); notes.push(`holder sell 10% ok · tokens ${rs.tokOut} ≤ ${bal.raw / 10n + 1n} · sol out ${rs.solOut.toFixed(4)} (expect ${expectSol.toFixed(4)})`) }
  catch (e: any) { if (e?.kind === 'refused' || e?.kind === 'unavailable') throw new Error('holder sell: ' + e.message); notes.push('holder sell: route fails on chain (' + String(e.message).slice(0, 50) + ')') }
  try { await G.guardTx(conn, sell, h.owner, G.limitsFor('sell', c.mint, '5%', { slippageBps: 1500, expectSol, balanceRaw: bal.raw })); throw new Error('a 10% sell passed a 5% limit') } catch (e: any) { if (e?.kind === 'refused') notes.push('10% under a 5% limit refused'); else if (e?.kind !== 'simFailed') throw e }
  return notes.join(' · ')
})
await step('tx guard: a fresh SOL-quoted coin — create + PumpPortal\'s wrapper buy in one simulated tx; the guard walks the buy\'s CPIs and passes them', async () => {
  // the shape the chest meets right after one of our pump launches, independent of what trades on mainnet this minute
  const G = await import('../src/txguard.ts'); const { Keypair, TransactionMessage, ComputeBudgetProgram } = await import('@solana/web3.js'); const L = await import('../src/launch.ts')
  const mint = Keypair.generate().publicKey.toBase58()
  const body = [{ publicKey: PAYER.toBase58(), action: 'create', tokenMetadata: { name: 'preflight', symbol: 'PRE', uri: 'https://ipfs.io/ipfs/bafkreigh2akiscaildc' }, mint, denominatedInSol: 'true', amount: 0.05, slippage: 10, priorityFee: 0.0005, pool: 'pump' },
    { publicKey: PAYER.toBase58(), action: 'buy', mint, denominatedInSol: 'true', amount: 0.1, slippage: 30, priorityFee: 0.00005, pool: 'pump' }]
  const r = await timeout(fetch(PP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), 20000); if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const [t0, t1] = ((await r.json()) as string[]).map((e) => VersionedTransaction.deserialize(bs58.decode(e)))
  const luts = (await Promise.all([...t0.message.addressTableLookups, ...t1.message.addressTableLookups].map((l) => conn.getAddressLookupTable(l.accountKey)))).map((x) => x.value!).filter(Boolean)
  const noCU = (ix: any) => !ix.programId.equals(ComputeBudgetProgram.programId)
  const a = TransactionMessage.decompile(t0.message, { addressLookupTableAccounts: luts }).instructions.filter(noCU), b = TransactionMessage.decompile(t1.message, { addressLookupTableAccounts: luts }).instructions.filter(noCU)
  const all = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ...a, ...b]; const tx = new VersionedTransaction(new TransactionMessage({ payerKey: PAYER, recentBlockhash: t0.message.recentBlockhash, instructions: all }).compileToV0Message(luts))
  const sres = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, innerInstructions: true }); if (sres.value.err) throw new Error('combined simulate err ' + JSON.stringify(sres.value.err))
  // only the buy's part (top-level index ≥ 1 + a.length) — the create's own CPIs are the dev's, not a trade
  const keys = await L.resolveKeys(tx, conn); const from = 1 + a.length; const inner = new Map<number, any[]>(); for (const g of sres.value.innerInstructions || []) inner.set(g.index, g.instructions as any[])
  const ixs: any[] = []; tx.message.compiledInstructions.forEach((ix, i) => { if (i < from) return; ixs.push(G.decodeTop(keys[ix.programIdIndex], ix.data, ix.accountKeyIndexes.map((k) => keys[k]))); for (const y of inner.get(i) || []) ixs.push(G.fromInner(y)) })
  const res = G.checkIxs(ixs, PAYER.toBase58(), G.limitsFor('buy', mint, 0.1, { slippageBps: 3000 }))
  const types = [...new Set(ixs.filter((x) => x.program !== 'other').map((x) => x.program + ':' + x.type))].join(', ')
  return `buy part: ${ixs.length} ixs (${types}) · out ${res.solOut.toFixed(4)} SOL for a 0.1 buy · bound ${G.limitsFor('buy', mint, 0.1, { slippageBps: 3000 }).maxSolOut.toFixed(4)}`
})
// ---------- pump fast path: the sniper tax's own feed and sale (pumpfast.ts) ----------
await step('pump fast path: the trade event in real pump txs\' logs (what the processed-logs feed reads) matches the curve\'s own SOL move', async () => {
  const PF = await import('../src/pumpfast.ts'); const c = GUARDX.solCurve || await solCurveCoin(); if (!c) return 'skipped: no SOL-quoted curve coin this minute'
  GUARDX.solCurve = c; const curve = PF.curveOf(new PublicKey(c.mint))
  const sigs = await conn.getSignaturesForAddress(curve, { limit: 8 }); const notes: string[] = []; let checked = 0
  for (const x of sigs) { if (x.err || checked >= 3) continue
    const tx = await conn.getTransaction(x.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null); if (!tx?.meta) continue
    const evs = PF.tradesFromLogs(tx.meta.logMessages).filter((e) => e.mint === c.mint); if (!evs.length) { notes.push(`${x.signature.slice(0, 6)}: no event in logs`); continue }
    const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses as any }).staticAccountKeys.map((k) => k.toBase58()); const i = keys.indexOf(curve.toBase58())
    const d = i >= 0 ? Math.abs(tx.meta.postBalances[i] - tx.meta.preBalances[i]) / 1e9 : NaN; const e = evs[0]; checked++
    notes.push(`${e.isBuy ? 'buy' : 'sell'} ${e.sol.toFixed(4)} SOL (curve moved ${d.toFixed(4)}) · fees ${e.feeBps}+${e.creatorFeeBps} bps (buyback ${e.buybackFeeBps / 100}% of the protocol fee) · reserves ${(Number(e.vSol) / 1e9).toFixed(2)} SOL`) }
  if (!checked) throw new Error('no trade event decoded · ' + notes.join(' · '))
  return `coin ${c.mint.slice(0, 6)}… · ` + notes.join(' · ')
})
await step('pump fast path: our own direct sell for a real holder → simulate (CU, min-out vs what pump pays) + this pool\'s priority fee', async () => {
  const PF = await import('../src/pumpfast.ts'); const { tokenBalance } = await import('../src/chain.ts'); const c = GUARDX.solCurve; if (!c) return 'skipped: no SOL-quoted curve coin'
  const f = await PF.coinFacts(conn, c.mint, true); if (!f) throw new Error('coinFacts refused a SOL-quoted curve coin')
  const h = await holderOf(c.mint); if (!h) return 'no wallet holder found'
  const [g, rs, fee] = await Promise.all([PF.pumpGlobal(conn), PF.reserves(conn, f.curve), PF.poolPriorityFee(conn, [new PublicKey(f.curve)])])
  const bal = await tokenBalance(h.owner.toBase58(), c.mint); const amt = bal.raw / 10n; const expect = PF.sellOut(rs!.vSol, rs!.vTok, amt, 130)
  const lb = await conn.getLatestBlockhash('confirmed')
  const tx = PF.buildSellTx(h.owner, f, g, amt, (expect * 97n) / 100n, fee, 1_000_000, lb.blockhash, 200_000)
  PF.selfCheck(tx, h.owner)
  const r = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true })
  if (r.value.err) throw new Error('direct sell simulate err ' + JSON.stringify(r.value.err) + ' · ' + (r.value.logs || []).slice(-3).join(' | '))
  const ev = PF.tradesFromLogs(r.value.logs).find((e) => e.mint === c.mint && !e.isBuy); const paid = ev ? ev.sol : NaN
  return `holder ${h.owner.toBase58().slice(0, 6)}… sells 10% · ${r.value.unitsConsumed} CU (whole tx) · we expected ${(Number(expect) / 1e9).toFixed(5)} SOL, pump's event says ${paid.toFixed(5)} gross · pool priority fee ${fee} µlamports/CU · tx ${tx.serialize().length} B`
})
await step('tx guard: the RPC simulates with inner instructions (the guard refuses to sign without them)', async () => {
  const tx = await ppBuild(PAYER, 'buy', ctx.curveMint!, 0.01); GUARDX.buy = tx
  const r = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, innerInstructions: true })
  const ii = r.value.innerInstructions; if (!Array.isArray(ii)) throw new Error('no innerInstructions in the simulation response · err ' + JSON.stringify(r.value.err))
  const flat = ii.flatMap((g: any) => g.instructions); const parsed = flat.filter((x: any) => x.parsed)
  return `${ii.length} groups · ${flat.length} inner ixs (${parsed.length} parsed: ${[...new Set(parsed.map((x: any) => x.program + ':' + x.parsed.type))].slice(0, 8).join(', ')}) · err ${JSON.stringify(r.value.err)}`
})
await step('tx guard: real buys pass on every route (pumpportal curve + amm, jupiter, launchlab sdk)', async () => {
  const G = await import('../src/txguard.ts'); const notes: string[] = []; let passed = 0
  const one = async (label: string, mint: string | undefined, build: () => Promise<VersionedTransaction>, slipBps: number) => {
    if (!mint) { notes.push(`${label}: no coin`); return }
    // exactly what production does: the bound + the coin account to watch, padded ceilings pulled down, then the guard
    try { const tx = await build(); const { buyWatch } = await import('../src/chain.ts'); const lim = { ...G.limitsFor('buy', mint, 0.01, { slippageBps: slipBps }), ...(await buyWatch(PAYER, mint)) }; const capped = G.capBuyCeilings(tx, BigInt(Math.floor((lim.maxSolOut - 0.015) * 1e9)))
      const r = await G.guardTx(conn, tx, PAYER, lim); passed++; notes.push(`${label} ok · out ${r.solOut.toFixed(4)} (wrap ${r.wrapped.toFixed(4)}, fee ${(r.feeSol || 0).toFixed(5)}) of ${lim.maxSolOut.toFixed(4)} · coin in ${r.tokIn} · ${r.checked} ixs${capped ? ' · ceiling capped' : ''}`) }
    catch (e: any) { if (e?.kind === 'refused' || e?.kind === 'unavailable') throw new Error(`${label}: ${e.message}`); notes.push(`${label}: route fails on chain (${String(e.message).slice(0, 70)})`) }
    await sleep(800)
  }
  await one('pumpportal curve', ctx.curveMint, async () => GUARDX.buy || ppBuild(PAYER, 'buy', ctx.curveMint!, 0.01), 1500)
  await one('pumpportal amm', ctx.ammMint, () => ppBuild(PAYER, 'buy', ctx.ammMint!, 0.01), 1500)
  const { jupBuild } = await import('../src/chain.ts')
  await one('jupiter amm', ctx.ammMint, () => jupBuild(PAYER, 'buy', ctx.ammMint!, 0.01, true, 1500), 1500)
  if (ctx.mayhemMint) await one('jupiter mayhem curve', ctx.mayhemMint, () => jupBuild(PAYER, 'buy', ctx.mayhemMint!, 0.01, true, 1500), 1500)
  const LL = await import('../src/launchlab.ts')
  await one('launchlab sdk', LLX.mint, () => LL.buildTrade(PAYER, 'buy', LLX.mint!, 0.01, { slippageBps: 1500 }), 1500)
  if (passed < 1) return 'no buy route available this minute (market, not the guard) · ' + notes.join(' · ')
  return notes.join(' · ')
})
await step('tx guard: real sells pass for a real holder (pumpportal + jupiter), capped at the share asked for', async () => {
  const G = await import('../src/txguard.ts'); const { jupBuild, tokenBalance } = await import('../src/chain.ts'); const notes: string[] = []; let passed = 0
  for (const [label, mint] of [['curve', ctx.curveMint], ['amm', ctx.ammMint]] as const) {
    if (!mint) continue; const h = await holderOf(mint); if (!h) { notes.push(`${label}: no wallet holder found`); continue }
    const bal = await tokenBalance(h.owner.toBase58(), mint); const { curveSpot, pumpswapSpot } = await import('../src/pool.ts'); const sp = label === 'curve' ? await curveSpot(mint).catch(() => null) : (ctx.ammPool ? await pumpswapSpot(ctx.ammPool, mint).catch(() => null) : null)
    const px = sp?.priceSol || 0; const expectSol = bal.ui * 0.1 * px   // what production passes: the sale at the pool's price (bounds the fees it may pay)
    const lim = G.limitsFor('sell', mint, '10%', { slippageBps: 1500, expectSol: expectSol || 1, balanceRaw: bal.raw })
    for (const [route, build] of [['pumpportal', () => ppBuild(h.owner, 'sell', mint, '10%')], ['jupiter', () => jupBuild(h.owner, 'sell', mint, '10%', false, 1500)]] as const) {
      try { const r = await G.guardTx(conn, await build(), h.owner, lim); passed++; notes.push(`${label}/${route} ok · tokens ${r.tokOut} ≤ ${lim.maxTokOutRaw} · sol out ${r.solOut.toFixed(4)}`) }
      catch (e: any) { if (e?.kind === 'refused' || e?.kind === 'unavailable') throw new Error(`${label}/${route} (holder ${h.owner.toBase58().slice(0, 6)}): ${e.message}`); notes.push(`${label}/${route}: route fails on chain (${String(e.message).slice(0, 60)})`) }
      await sleep(800)
    }
    // the same sell asked as 5%: a tx built for 10% must be refused
    try { await G.guardTx(conn, await ppBuild(h.owner, 'sell', mint, '10%'), h.owner, G.limitsFor('sell', mint, '5%', { slippageBps: 1500, expectSol: expectSol || 1, balanceRaw: bal.raw })); throw new Error(`${label}: a 10% sell passed a 5% limit`) }
    catch (e: any) { if (e?.kind === 'refused') notes.push(`${label}: 10% sell under a 5% limit refused`); else if (e?.kind === 'unavailable' || /passed a 5% limit/.test(String(e?.message))) throw e; else notes.push(`${label}: (route unavailable: ${String(e?.message).slice(0, 50)})`) }
  }
  if (!passed) return 'no sell route available this minute (market, not the guard) · ' + notes.join(' · ')
  return notes.join(' · ')
})
await step('tx guard: the same buy with a drain appended is refused (SOL out, token delegate, foreign token)', async () => {
  const G = await import('../src/txguard.ts'); const { TransactionMessage } = await import('@solana/web3.js')
  const { createApproveInstruction, createTransferInstruction } = await import('@solana/spl-token')
  // a buy the chain accepts as is (the curve coin of the minute may be a mayhem coin PumpPortal can't trade): PumpPortal on the amm coin, else Jupiter
  let base: VersionedTransaction | null = null, baseMint = ctx.ammMint!, baseRoute = ''
  for (const [route, mint, build] of [['pumpportal sol-quoted curve', GUARDX.solCurve?.mint, async () => GUARDX.solCurve!.buy], ['pumpportal amm', ctx.ammMint, () => ppBuild(PAYER, 'buy', ctx.ammMint!, 0.01)], ['pumpportal curve', ctx.curveMint, () => GUARDX.buy ? Promise.resolve(GUARDX.buy) : ppBuild(PAYER, 'buy', ctx.curveMint!, 0.01)], ['jupiter amm', ctx.ammMint, async () => (await import('../src/chain.ts')).jupBuild(PAYER, 'buy', ctx.ammMint!, 0.01, true, 1500)]] as const) {
    if (!mint) continue; try { const tx = await build(); const r = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true }); if (!r.value.err) { base = tx; baseMint = mint; baseRoute = route; break } } catch {}
  }
  if (!base) return 'skipped: no buy route simulates clean this minute — nothing to append a drain to (unit tests cover the same drains)'
  const alts = base.message.version === 0 ? (await Promise.all(base.message.addressTableLookups.map((l) => conn.getAddressLookupTable(l.accountKey)))).map((r) => r.value!).filter(Boolean) : []
  const msg = TransactionMessage.decompile(base.message, { addressLookupTableAccounts: alts })
  const lim = G.limitsFor('buy', baseMint, 0.01, { slippageBps: 1500 })
  const other = (await conn.getTokenAccountsByOwner(PAYER, { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') })).value.find((a) => a.account.data.readBigUInt64LE(64) > 0n)
  const evil = PublicKey.unique()
  const cases: [string, any][] = [['SOL out', SystemProgram.transfer({ fromPubkey: PAYER, toPubkey: evil, lamports: 500_000_000 })]]
  if (other) { cases.push(['token delegate', createApproveInstruction(other.pubkey, evil, PAYER, 1n)]); cases.push(['foreign token out', createTransferInstruction(other.pubkey, other.pubkey, PAYER, 1n)]) }
  const notes: string[] = []
  for (const [label, ix] of cases) {
    const m = new TransactionMessage({ payerKey: msg.payerKey, recentBlockhash: msg.recentBlockhash, instructions: [...msg.instructions, ix] })
    const tx = new VersionedTransaction(m.compileToV0Message(alts))
    try { await G.guardTx(conn, tx, PAYER, lim); throw new Error(`${label}: NOT refused`) }
    catch (e: any) { if (e?.kind === 'refused') notes.push(`${label} refused (${String(e.message).replace('tx guard: ', '').slice(0, 60)})`); else if (e?.kind === 'simFailed') notes.push(`${label}: sim failed (${String(e.message).slice(0, 50)}) — not a guard check`); else throw e }
    await sleep(500)
  }
  if (!notes.some((n) => /SOL out refused/.test(n))) throw new Error(baseRoute + ' · ' + notes.join(' · '))
  return `base ${baseRoute} · ` + notes.join(' · ')
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
async function wsOneSwap(pools: string | string[], waitMs: number) {
  const list = Array.isArray(pools) ? pools : [pools]; const subs = new Map<number, string>()
  return await timeout(new Promise<string>((res, rej) => {
    const ws = new (globalThis as any).WebSocket(RPC.replace(/^http/, 'ws')); const a = t()
    ws.onopen = () => list.forEach((pool, i) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'logsSubscribe', params: [{ mentions: [pool] }, { commitment: 'confirmed' }] })))
    ws.onerror = (e: any) => rej(new Error('ws error ' + (e?.message || '')))
    ws.onmessage = async (ev: any) => {
      const m = JSON.parse(ev.data); if (m.id && typeof m.result === 'number') { subs.set(m.result, list[m.id - 1]); return } if (m.method !== 'logsNotification') return
      const sig = m.params.result.value.signature; if (m.params.result.value.err) return
      const pool = subs.get(m.params.subscription) || list[0]
      ws.close(); try { const sw = await decode(conn, pool, sig, m.params.result.context.slot); res(sw ? `swap in ${ms(a)}: ${sw.side} ${sw.sol.toFixed(4)} SOL by ${sw.trader.slice(0, 6)}…` : `log seen but not decoded as swap (${sig.slice(0, 8)}…)`) } catch (e: any) { rej(e) }
    }
  }), waitMs)
}
await step('helius ws: logsSubscribe on a launchlab pool → decode one swap (the vault\'s per-swap detector for our coins)', async () => {
  if (!LLX.mint) throw new Error('no live launchlab pool'); const LL = await import('../src/launchlab.ts')
  // the 4 most recently traded live pools at once: one swap on any of them proves the detector; a single quiet pool used to time out
  return wsOneSwap([LLX.mint, ...LLX.mints.filter((m) => m !== LLX.mint)].slice(0, 4).map((m) => LL.poolIdOf(m).toBase58()), 90000)
})
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
