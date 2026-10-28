import React, { useEffect, useMemo, useRef, useState } from 'react'
import { compare, type Result } from '../lib/sim'
import { S } from '../lib/fmt'

export default function Simulate() {
  const [pool, setPool] = useState(100); const [chest, setChest] = useState(0.15); const [ceiling, setCeiling] = useState(0.3); const [pump, setPump] = useState(1.0); const [desk, setDesk] = useState(0.5); const [seeds, setSeeds] = useState(12)
  const [res, setRes] = useState<{ none: Result; floor: Result; mm: Result; one: { none: Result; mm: Result } } | null>(null); const [busy, setBusy] = useState(false); const [adv, setAdv] = useState(false); const [showTable, setShowTable] = useState(false)
  const cv = useRef<HTMLCanvasElement>(null)
  const run = () => {
    setBusy(true)
    setTimeout(() => {
      const acc: any = { none: [], floor: [], mm: [] }
      for (let seed = 1; seed <= seeds; seed++) { const c = compare({ poolSol: pool, chestPct: chest, ceiling, hours: 6, seed, swapFee: 0.015, deskUse: desk, pumpStrength: pump }); (['none', 'floor', 'mm'] as const).forEach((k) => acc[k].push(c[k])) }
      const avg = (arr: Result[]): Result => { const o: any = {}; for (const k of Object.keys(arr[0]) as (keyof Result)[]) { if (k === 'path') continue; o[k] = arr.reduce((a, x) => a + (x[k] as number), 0) / arr.length } o.path = arr[0].path; return o }
      const one = compare({ poolSol: pool, chestPct: chest, ceiling, hours: 6, seed: 1, swapFee: 0.015, deskUse: desk, pumpStrength: pump })
      setRes({ none: avg(acc.none), floor: avg(acc.floor), mm: avg(acc.mm), one: { none: one.none, mm: one.mm } }); setBusy(false)
    }, 20)
  }
  useEffect(run, [])
  useEffect(() => {
    const c = cv.current; if (!c || !res) return; const ctx = c.getContext('2d')!; const W = c.width = c.clientWidth * 2, H = c.height = 220 * 2
    ctx.fillStyle = '#0d0d0c'; ctx.fillRect(0, 0, W, H)
    const paths = [[res.one.none.path, 'rgba(243,242,236,.35)'], [res.one.mm.path, '#3ecf8e']] as const
    const all = paths.flatMap(([p]) => p); const mx = Math.max(...all), mn = Math.min(...all)
    for (const [p, col] of paths) { ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.beginPath(); p.forEach((v, i) => { const x = (i / (p.length - 1)) * W, y = H - ((Math.log(v) - Math.log(mn)) / (Math.log(mx) - Math.log(mn))) * (H - 20) - 10; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y) }); ctx.stroke() }
    ctx.fillStyle = 'rgba(243,242,236,.5)'; ctx.font = '22px Geist'; ctx.fillText('no vault', 16, 34); ctx.fillStyle = '#3ecf8e'; ctx.fillText('market maker', 16, 64)
  }, [res])
  const d = (a: number, b: number, pct = true) => { const v = pct ? (a / b - 1) * 100 : a - b; return <span className={v >= 0 ? 'up' : 'dn'}>{v >= 0 ? '+' : ''}{pct ? v.toFixed(0) + '%' : v.toFixed(2)}</span> }
  return <div style={{ maxWidth: 980 }}>
    <h2 style={{ margin: '0 0 4px', fontSize: 18 }}>What a vault does to a chart</h2>
    <div className="dim" style={{ fontSize: 12, marginBottom: 12 }}>Same buyers and sellers, same 6 hours — once with no vault, once with one. The exact rules the live bot runs.</div>
    <div className="card"><div className="panel" style={{ gap: 8 }}>
      <div className="lay" style={{ gridTemplateColumns: adv ? '1fr 1fr 1fr' : '1fr 1fr', gap: 12 }}>
        {adv && <div><div className="lbl">Pool reserve · {pool} SOL (≈ ${(pool * 160 * 2 / 1000).toFixed(0)}K liq)</div><input type="range" className="slider" min={20} max={500} step={10} value={pool} onChange={(e) => setPool(+e.target.value)} /></div>}
        <div><div className="lbl">Chest size · {Math.round(chest * 100)}% of the pool ({S(pool * chest, 1)} SOL)</div><input type="range" className="slider" min={0.05} max={0.5} step={0.05} value={chest} onChange={(e) => setChest(+e.target.value)} /></div>
        {adv && <div><div className="lbl">Capture ceiling · {Math.round(ceiling * 100)}%</div><input type="range" className="slider" min={0.05} max={0.3} step={0.05} value={ceiling} onChange={(e) => setCeiling(+e.target.value)} /></div>}
        <div><div className="lbl">How wild the coin is · {pump < 0.8 ? 'calm' : pump < 1.2 ? 'normal' : 'degen'} ({pump.toFixed(1)}×)</div><input type="range" className="slider" min={0.4} max={1.6} step={0.1} value={pump} onChange={(e) => setPump(+e.target.value)} /></div>
        {adv && <div><div className="lbl">Sellers who use the desk · {Math.round(desk * 100)}%</div><input type="range" className="slider" min={0} max={1} step={0.1} value={desk} onChange={(e) => setDesk(+e.target.value)} /></div>}
        {adv && <div><div className="lbl">Seeds · {seeds}</div><input type="range" className="slider" min={4} max={40} step={4} value={seeds} onChange={(e) => setSeeds(+e.target.value)} /></div>}
      </div>
      <div className="row"><button className="btn sm" onClick={() => setAdv(!adv)}>{adv ? 'Fewer knobs' : 'More knobs'}</button><span className="sp" /><button className="btn pri" disabled={busy} onClick={run}>{busy ? 'Running…' : 'Run'}</button></div>
    </div></div>
    {res && <>
      <div className="tiles" style={{ marginTop: 12, gridTemplateColumns: 'repeat(3,1fr)' }}>
        <div className="tile"><div className="l">Worst drop</div><div className="v num">{(res.mm.maxDrawdown * 100).toFixed(0)}% <span className="dim" style={{ fontSize: 12 }}>vs {(res.none.maxDrawdown * 100).toFixed(0)}%</span></div><div className="s">{d(res.none.maxDrawdown, res.mm.maxDrawdown)} shallower with a vault</div></div>
        <div className="tile"><div className="l">Where it ends</div><div className="v num">{res.mm.final.toFixed(2)}x <span className="dim" style={{ fontSize: 12 }}>vs {res.none.final.toFixed(2)}x</span></div><div className="s">{d(res.mm.final, res.none.final)} higher with a vault</div></div>
        <div className="tile"><div className="l">Sells kept off the chart</div><div className="v num">{S(res.mm.deskBought + res.mm.dipBought, 1)} SOL</div><div className="s">{S(res.mm.deskBought, 1)} desk · {S(res.mm.dipBought, 1)} dips bought</div></div>
      </div>
      <canvas ref={cv} style={{ width: '100%', height: 220, marginTop: 12, borderRadius: 10, border: '1px solid var(--line)' }} />
      <div className="row" style={{ marginTop: 10 }}><button className="btn sm" onClick={() => setShowTable(!showTable)}>{showTable ? 'Hide the numbers' : 'All the numbers'}</button></div>
      {showTable && <div className="card" style={{ marginTop: 8 }}><table><thead><tr><th></th><th className="r">No vault</th><th className="r">Floor</th><th className="r">Market maker</th><th className="r">MM vs none</th></tr></thead><tbody>
        {([['Peak', 'peak', 'x'], ['Max drawdown', 'maxDrawdown', '%'], ['Final price', 'final', 'x']] as const).map(([l, k, u]) => <tr key={k}><td className="dim">{l}</td>{(['none', 'floor', 'mm'] as const).map((m) => <td key={m} className="r num">{u === '%' ? (res[m][k] * 100).toFixed(0) + '%' : res[m][k].toFixed(2) + 'x'}</td>)}<td className="r num">{k === 'maxDrawdown' ? d(1 - res.mm[k], 1 - res.none[k]) : d(res.mm[k], res.none[k])}</td></tr>)}
        <tr><td className="dim">Vault P&amp;L (chest + supply at final)</td><td className="r dim">—</td><td className="r num">{d(res.floor.vaultValue, res.floor.vaultStart, false)} SOL</td><td className="r num">{d(res.mm.vaultValue, res.mm.vaultStart, false)} SOL</td><td className="r dim">on {S(res.mm.vaultStart, 1)} start</td></tr>
        <tr><td className="dim">Captured from stretched buys</td><td className="r dim">—</td><td className="r dim">—</td><td className="r num">{S(res.mm.captured, 2)} SOL · {res.mm.captures.toFixed(0)}×</td><td className="r dim">{(res.mm.captured / Math.max(1e-9, res.mm.volumeSol) * 100).toFixed(1)}% of volume</td></tr>
        <tr><td className="dim">Sellers absorbed off-chart (desk)</td><td className="r dim">—</td><td className="r num">{S(res.floor.deskBought, 2)} SOL</td><td className="r num">{S(res.mm.deskBought, 2)} SOL</td><td className="r dim">{res.mm.deskFills.toFixed(0)} fills · ~{(res.mm.impactAvoided * 100).toFixed(0)}% chart damage avoided</td></tr>
        <tr><td className="dim">Dip tranches bought</td><td className="r dim">—</td><td className="r num">{S(res.floor.dipBought, 2)} SOL · {res.floor.dips.toFixed(0)}×</td><td className="r num">{S(res.mm.dipBought, 2)} SOL · {res.mm.dips.toFixed(0)}×</td><td className="r dim"></td></tr>
        <tr><td className="dim">Chest at end</td><td className="r dim">—</td><td className="r num">{S(res.floor.chest, 2)} SOL</td><td className="r num">{S(res.mm.chest, 2)} SOL</td><td className="r dim">redeem floor ${(res.mm.chest / 1e9 * 160).toExponential(1)}/token</td></tr>
        <tr><td className="dim">On-chain: txs · swap fees</td><td className="r dim">—</td><td className="r num">{res.floor.txs.toFixed(0)} · {S(res.floor.feesPaid, 2)} SOL</td><td className="r num">{res.mm.txs.toFixed(0)} · {S(res.mm.feesPaid, 2)} SOL</td><td className="r dim">{(res.mm.txs / 6).toFixed(1)} tx/hr</td></tr>
        <tr><td className="dim">Dev cut paid</td><td className="r dim">—</td><td className="r num">{S(res.floor.devPaid, 3)}</td><td className="r num">{S(res.mm.devPaid, 3)}</td><td className="r dim">only from profit</td></tr>
      </tbody></table></div>}
      <div className="nm" style={{ marginTop: 10 }}>Scripted regimes flatter a mean-reversion strategy; real flow is uglier. Read the deltas, not the absolute P&amp;L. Under 15% chest the vault is cosmetic.</div>
    </>}
  </div>
}
