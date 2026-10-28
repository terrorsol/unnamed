// Runner / rug / bundle / crash classifier. Pure function of live market fields (DexScreener) + optional on-chain holder data.
// Every label comes with the reasons that produced it so nobody is blindsided by a badge.
export type Feat = {
  m5: number; h1: number; h6: number; h24: number            // % price change
  vol5m: number; vol1h: number; vol24: number; mcap: number; liq: number; ageMin: number
  buys1h: number; sells1h: number; buys5m: number; sells5m: number
  top1?: number; top10?: number; mintAuth?: boolean; freezeAuth?: boolean; vault?: boolean
}
export type Label = 'RUNNER' | 'HEALTHY' | 'COOLING' | 'CRASHING' | 'BUNDLED' | 'RUG RISK' | 'DEAD'
export type Signal = { label: Label; score: number; reasons: string[]; risk: number }

const r2 = (n: number) => Math.round(n * 10) / 10
export function classify(f: Feat): Signal {
  const reasons: string[] = []; let run = 50, risk = 0
  const bs1 = f.sells1h ? f.buys1h / f.sells1h : f.buys1h ? 3 : 1; const bs5 = f.sells5m ? f.buys5m / f.sells5m : f.buys5m ? 3 : 1
  const volMc = f.mcap ? f.vol1h / f.mcap : 0; const liqMc = f.mcap ? f.liq / f.mcap : 0
  // ---- structure ----
  if (f.h1 > 15 && f.h6 >= f.h1 * 0.5 && f.m5 > -12) { run += 15; reasons.push(`higher lows: +${r2(f.h1)}% 1h on +${r2(f.h6)}% 6h`) }
  if (f.h1 > 40 && f.m5 > 0) { run += 10; reasons.push('still bidding 5m into a 1h move') }
  if (bs1 > 1.3) { run += 10; reasons.push(`buys outpace sells ${bs1.toFixed(1)}:1 (1h)`) } else if (bs1 < 0.7) { run -= 15; reasons.push(`sellers in control ${bs1.toFixed(1)}:1 (1h)`) }
  if (bs5 < 0.5 && f.sells5m >= 5) { run -= 15; reasons.push('5m sell cascade') }
  if (volMc > 0.05 && volMc < 1.5) { run += 10; reasons.push(`real turnover ${(volMc * 100).toFixed(0)}% of mcap/h`) }
  if (volMc >= 3) { risk += 25; run -= 10; reasons.push(`churn ${(volMc * 100).toFixed(0)}% of mcap/h — wash or bundle rotation`) }
  if (f.vol1h < 500 && f.ageMin > 60) { run -= 25; reasons.push('no volume') }
  // ---- post-pump / crash ----
  if (f.h6 > 150 && f.h1 < -35) { risk += 20; run -= 25; reasons.push(`post-pump: +${r2(f.h6)}% 6h, −${r2(-f.h1)}% last hour`) }
  if (f.m5 < -40) { risk += 30; run -= 30; reasons.push(`−${r2(-f.m5)}% in 5 minutes`) }
  if (f.h1 < -60) { risk += 25; run -= 20; reasons.push(`−${r2(-f.h1)}% in 1h`) }
  // ---- thin / rug mechanics ----
  if (liqMc > 0 && liqMc < 0.02 && f.mcap > 100_000) { risk += 25; reasons.push(`thin pool: liquidity ${(liqMc * 100).toFixed(1)}% of mcap`) }
  if (f.mintAuth) { risk += 30; reasons.push('mint authority not revoked') }
  if (f.freezeAuth) { risk += 20; reasons.push('freeze authority not revoked') }
  // ---- concentration / bundles ----
  if (f.top1 != null && f.top1 > 15) { risk += 25; reasons.push(`one wallet holds ${f.top1.toFixed(0)}%`) }
  if (f.top10 != null && f.top10 > 55) { risk += 20; reasons.push(`top 10 hold ${f.top10.toFixed(0)}%`) }
  if (f.ageMin < 15 && f.mcap > 400_000) { risk += 20; reasons.push(`$${(f.mcap / 1000).toFixed(0)}K in ${f.ageMin.toFixed(0)} min — launch bundle likely`) }
  if (f.ageMin < 30 && f.top10 != null && f.top10 > 40 && volMc > 1) { risk += 20; reasons.push('bundle rotation pattern: fresh, concentrated, churning') }
  if (f.vault) { risk -= 15; run += 5; reasons.push('vault: floor + desk under it') }
  run = Math.max(0, Math.min(100, run)); risk = Math.max(0, Math.min(100, risk))
  let label: Label
  if (f.ageMin > 60 && f.vol1h < 500 && (f.h24 < -50 || f.vol1h < f.vol24 * 0.02)) label = 'DEAD'
  else if (f.m5 < -40 || (f.h1 < -60 && bs1 < 0.7)) label = 'CRASHING'
  else if (risk >= 60 && (f.top10 ?? 0) > 40) label = 'BUNDLED'
  else if (risk >= 55) label = 'RUG RISK'
  else if (run >= 75 && risk < 40) label = 'RUNNER'
  else if (f.h6 > 100 && f.h1 < 0 && f.h1 > -35) label = 'COOLING'
  else label = 'HEALTHY'
  if (!reasons.length) reasons.push('nothing notable either way')
  return { label, score: run, reasons, risk }
}
export const labelTone = (l: Label) => (l === 'RUNNER' ? 'live' : l === 'HEALTHY' ? '' : l === 'COOLING' ? '' : 'pre')
/** Build features from a DexScreener Coin (+ optional rug check) */
export function featsFromCoin(c: any, rug?: { top1Pct: number; top10Pct: number; mintAuthority: boolean; freezeAuthority: boolean } | null, vault = false): Feat {
  const p = c.raw || {}
  return { m5: c.ch5m || 0, h1: c.ch1h || 0, h6: p.priceChange?.h6 ?? 0, h24: c.ch24 || 0, vol5m: p.volume?.m5 || 0, vol1h: c.vol1h || 0, vol24: c.vol24 || 0, mcap: c.mcap || 0, liq: c.liq || 0, ageMin: c.createdAt ? (Date.now() - c.createdAt) / 60000 : 9999,
    buys1h: p.txns?.h1?.buys || 0, sells1h: p.txns?.h1?.sells || 0, buys5m: p.txns?.m5?.buys || 0, sells5m: p.txns?.m5?.sells || 0,
    top1: rug?.top1Pct, top10: rug?.top10Pct, mintAuth: rug?.mintAuthority, freezeAuth: rug?.freezeAuthority, vault }
}
