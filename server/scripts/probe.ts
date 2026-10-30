// Read-only probe (runs in CI on a push to the `probe` branch): what the live server holds vs what the chain says. No keys, no sends.
const SERVER = process.env.SERVER || 'https://unnamed-server.onrender.com'
const LL = await import('../src/launchlab.ts'); const { conn } = await import('../src/chain.ts'); const { decode } = await import('../src/stream.ts')
const j = async (p: string) => { try { const r = await fetch(SERVER + p); return await r.json() } catch (e: any) { return { error: String(e.message || e) } } }
const h: any = await j('/health'); console.log('health', JSON.stringify({ commit: h.commit, vaults: h.vaults, mints: h.mints, stream: h.stream }).slice(0, 600))
// sniper report on real launches (the same read the server does ~75 s after arm): first minute of each pool, decoded from the chain
for (const mint of ['m9GEVhxuvexHAzEdr9uh3DcbTyaAKmjZmPsUJAHBANK', 'J4RRpzuCK3TuVdVM6jCQ1jDQQkj1LSBFYJcUsZ6BANK']) {
  const pool = LL.poolIdOf(mint); const t = Date.now()
  let sigs: any[] = []; let before: string | undefined
  for (let i = 0; i < 6; i++) { const pg = await conn.getSignaturesForAddress(pool, { limit: 1000, before }); if (!pg.length) break; sigs = sigs.concat(pg); before = pg.at(-1)!.signature; if (pg.length < 1000) break }
  sigs = sigs.filter((x) => !x.err).reverse(); if (!sigs.length) { console.log(mint, 'no txs'); continue }
  const t0 = sigs[0].blockTime || 0, slot0 = sigs[0].slot; const first = sigs.filter((x) => (x.blockTime || 0) <= t0 + 60).slice(0, 150)
  let buys = 0, buySol = 0, sells = 0, sellSol = 0, bz = 0; const w = new Set<string>(); const rows: string[] = []
  for (const x of first) { const sw = await decode(conn, pool.toBase58(), x.signature, x.slot).catch(() => null); if (!sw) { rows.push(`  ${x.slot - slot0} ? ${x.signature.slice(0, 8)}`); continue }
    rows.push(`  +${x.slot - slot0} slots ${sw.side} ${sw.sol.toFixed(3)} ${sw.trader.slice(0, 4)}`); if (sw.side === 'buy') { buys++; buySol += sw.sol; w.add(sw.trader); if (x.slot <= slot0 + 1) bz += sw.sol } else { sells++; sellSol += sw.sol } }
  console.log(`\n${mint}: ${sigs.length} pool txs total · launch ${new Date(t0 * 1000).toISOString()} · first minute: ${first.length} txs → ${buys} buys ${buySol.toFixed(3)} SOL from ${w.size} wallets (launch block ${bz.toFixed(3)}), ${sells} sells ${sellSol.toFixed(3)} · ${Date.now() - t} ms`)
  console.log(rows.slice(0, 40).join('\n'))
}
process.exit(0)
