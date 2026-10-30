// Read-only probe (runs in CI on a push to the `probe` branch). This run: the full on-chain swap tape of the two real launches, decoded the
// same way the vault does it, paced so the shared RPC never rate-limits. Writes probe-out/<mint>.jsonl ({ t, slot, side, sol, trader }).
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
const LL = await import('../src/launchlab.ts'); const { conn } = await import('../src/chain.ts'); const { decode } = await import('../src/stream.ts')
mkdirSync('probe-out', { recursive: true })
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
for (const mint of ['J4RRpzuCK3TuVdVM6jCQ1jDQQkj1LSBFYJcUsZ6BANK', 'm9GEVhxuvexHAzEdr9uh3DcbTyaAKmjZmPsUJAHBANK']) {
  const pool = LL.poolIdOf(mint); let sigs: any[] = []; let before: string | undefined
  for (let i = 0; i < 6; i++) { const pg = await conn.getSignaturesForAddress(pool, { limit: 1000, before }); if (!pg.length) break; sigs = sigs.concat(pg); before = pg.at(-1)!.signature; if (pg.length < 1000) break }
  sigs = sigs.filter((x) => !x.err).reverse(); const f = `probe-out/${mint}.jsonl`; writeFileSync(f, '')
  let n = 0, miss = 0
  for (const x of sigs) { await wait(170); let sw = await decode(conn, pool.toBase58(), x.signature, x.slot).catch(() => null)
    if (!sw) { await wait(600); sw = await decode(conn, pool.toBase58(), x.signature, x.slot).catch(() => null) }   // one retry (rate limit)
    if (!sw) { miss++; continue } n++; appendFileSync(f, JSON.stringify({ t: (x.blockTime || 0) * 1000, slot: x.slot, side: sw.side, sol: +sw.sol.toFixed(6), trader: sw.trader, sig: x.signature }) + '\n') }
  console.log(`${mint}: ${sigs.length} pool txs → ${n} swaps decoded, ${miss} not swaps/unreadable`)
}
process.exit(0)
