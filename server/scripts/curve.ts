// one coin's LaunchLab pool, read straight from chain: how far up the curve it is
const LL = await import('../src/launchlab.ts')
const mint = process.env.MINT!
const p: any = await LL.pool(mint, 0)
if (!p) { console.log('no pool'); process.exit(0) }
const f = (x: bigint, d = 9) => Number(x) / 10 ** d
const raised = f(p.realB), target = f(p.totalFundRaisingB), sold = f(p.realA, 6), toSell = f(p.totalSellA, 6)
const vB = f(p.virtualB), vA = f(p.virtualA, 6)
const price = (vB + raised) / (vA - sold)
console.log(JSON.stringify({ t: new Date().toISOString(), status: p.status, raisedSol: +raised.toFixed(4), targetSol: target, bondedPct: +(100 * raised / target).toFixed(2), soldTokensM: +(sold / 1e6).toFixed(3), totalSellM: +(toSell / 1e6).toFixed(3), soldPct: +(100 * sold / toSell).toFixed(2), virtualSol: vB, virtualTokM: +(vA / 1e6).toFixed(3), priceSol: price, mcapSol: +(price * 1e9).toFixed(2), gradPriceSol: (vB + target) / (vA - toSell), gradMcapSol: +((vB + target) / (vA - toSell) * 1e9).toFixed(1) }, null, 1))
process.exit(0)
