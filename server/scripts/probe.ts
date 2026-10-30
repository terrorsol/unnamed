// Read-only probe (runs in CI on a push to the `probe` branch): what the live server holds vs what the chain says. No keys, no sends.
import { LaunchpadPool } from '@raydium-io/raydium-sdk-v2'
const SERVER = process.env.SERVER || 'https://unnamed-server.onrender.com'
const LL = await import('../src/launchlab.ts'); const { conn } = await import('../src/chain.ts')
const j = async (p: string) => { try { const r = await fetch(SERVER + p); return await r.json() } catch (e: any) { return { error: String(e.message || e) } } }
const h: any = await j('/health'); console.log('health', JSON.stringify({ commit: h.commit, vaults: h.vaults, mints: h.mints, stream: h.stream, mm: h.mm, profitOnly: h.profitOnly }).slice(0, 600))
const vs: any[] = await j('/vaults'); console.log('vaults listed', Array.isArray(vs) ? vs.length : JSON.stringify(vs).slice(0, 200))
console.log('platform fee vault', (await LL.platformVaultSol()).toFixed(6), 'SOL')
for (const v of (Array.isArray(vs) ? vs : [])) {
  console.log(`\n== ${v.symbol} ${v.id} venue=${v.venue} armed=${v.armed} chest=${(+v.chest).toFixed(4)} tokens=${(+v.tokens / 1e6).toFixed(2)}M taxClaimed=${(+v.taxClaimed).toFixed(4)} mint=${v.mint}`)
  console.log('   mm', JSON.stringify(v.mm), 'score', JSON.stringify(v.score).slice(0, 160))
  for (const a of (v.activity || []).slice(0, 6)) console.log('   ', new Date(a.t).toISOString().slice(11, 19), a.kind, (a.sol != null ? (+a.sol).toFixed(4) : ''), String(a.msg || '').slice(0, 120))
  if (v.mint && v.venue === 'launchlab') {
    const p = await LL.pool(v.mint, 0); if (!p) { console.log('   pool: none'); continue }
    const raw: any = LaunchpadPool.decode((await conn.getAccountInfo(LL.poolIdOf(v.mint)))!.data)
    console.log(`   pool status=${p.status} realB=${(Number(p.realB) / 1e9).toFixed(4)} price=${p.priceSol?.toExponential?.(3)} platformFee(raw)=${raw.platformFee?.toString()} protocolFee=${raw.protocolFee?.toString?.()} creator=${p.creator}`)
    const sigs = await conn.getSignaturesForAddress(LL.poolIdOf(v.mint), { limit: 20 }).catch(() => [])
    console.log(`   last ${sigs.length} pool txs: newest ${sigs[0] ? new Date((sigs[0].blockTime || 0) * 1000).toISOString().slice(11, 19) : '-'} oldest ${sigs.at(-1) ? new Date((sigs.at(-1)!.blockTime || 0) * 1000).toISOString().slice(11, 19) : '-'}`)
  }
}
// which coins on our platform are paying the fee right now (the platform fee vault's recent deposits → the mint each trade was on)
{ const pv = LL.platformVault(); const sigs = await conn.getSignaturesForAddress(pv, { limit: 60 }).catch(() => [])
  console.log(`\nplatform vault ${pv.toBase58()} · ${sigs.length} recent txs · newest ${sigs[0] ? new Date((sigs[0].blockTime || 0) * 1000).toISOString() : '-'}`)
  const count = new Map<string, { n: number; last: number }>()
  for (const x of sigs.slice(0, 25)) { const tx = await conn.getParsedTransaction(x.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null); if (!tx) continue
    const mints = new Set((tx.meta?.postTokenBalances || []).map((b) => b.mint).filter((m) => m !== 'So11111111111111111111111111111111111111112'))
    for (const m of mints) { const c = count.get(m) || { n: 0, last: 0 }; c.n++; c.last = Math.max(c.last, x.blockTime || 0); count.set(m, c) } }
  for (const [m, c] of count) { const p = await LL.pool(m, 0).catch(() => null); console.log(`  ${m} · ${c.n} of the last 25 fee txs · last ${new Date(c.last * 1000).toISOString().slice(11, 19)} · pool ${p ? `status ${p.status} realB ${(Number(p.realB) / 1e9).toFixed(2)} creator ${p.creator}` : 'none'}`) } }
console.log('rpc', h.rpc, 'ws', JSON.stringify(h.stream))
process.exit(0)
