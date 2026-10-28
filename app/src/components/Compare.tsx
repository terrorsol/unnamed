import React, { useMemo } from 'react'
import type { Coin } from '../lib/dex'
import * as K from '../lib/desk'
import { Pfp, Ch, Mc } from './ui'
import { S, ago } from '../lib/fmt'
import { classify, featsFromCoin, labelTone } from '../lib/signal'
import real from '../backtest-real.json'

type Row = { c: Coin; v?: K.VaultPub; s: ReturnType<typeof classify> }
const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
const pct = (v: number | null) => v == null ? <span className="dim">—</span> : <span className={v >= 0 ? 'up' : 'dn'}>{v >= 0 ? '+' : ''}{v.toFixed(1)}%</span>

/** Vaulted launches vs the rest of the market, same columns, same window. Live numbers only — no claims we can't show. */
export default function Compare({ coins, vaults, solPrice, go }: { coins: Coin[]; vaults: K.VaultPub[]; solPrice: number; go: (p: string) => void }) {
  const byMint = useMemo(() => Object.fromEntries(coins.map((c) => [c.mint, c])), [coins])
  const ours: Row[] = useMemo(() => vaults.filter((v) => v.mint && byMint[v.mint]).map((v) => { const c = byMint[v.mint!]; return { c, v, s: classify(featsFromCoin(c, (v as any).holders || null, true)) } }), [vaults, byMint])
  const others: Row[] = useMemo(() => coins.filter((c) => !vaults.some((v) => v.mint === c.mint) && c.mcap > 0).map((c) => ({ c, s: classify(featsFromCoin(c, null, false)) })).sort((a, b) => b.c.vol24 - a.c.vol24).slice(0, 40), [coins, vaults])
  const agg = (rows: Row[]) => ({ n: rows.length, ch1h: avg(rows.map((r) => r.c.ch1h)), ch24: avg(rows.map((r) => r.c.ch24)), vol: rows.reduce((a, r) => a + r.c.vol24, 0), buyRatio: avg(rows.map((r) => r.c.buys24 + r.c.sells24 ? r.c.buys24 / (r.c.buys24 + r.c.sells24) : 0.5)), runners: rows.filter((r) => r.s.label === 'RUNNER').length, risk: rows.filter((r) => r.s.label === 'RUG RISK' || r.s.label === 'DEAD' || r.s.label === 'CRASHING').length })
  const A = agg(ours), B = agg(others)
  const bt: any = real
  const Table = ({ rows, title }: { rows: Row[]; title: React.ReactNode }) => <div className="card"><h3>{title}</h3><table><thead><tr><th>Coin</th><th className="r">Age</th><th className="r">MC</th><th className="r">1h</th><th className="r">24h</th><th className="r">Vol 24h</th><th className="r">Buys</th><th className="r">Chest</th><th className="r">Signal</th></tr></thead><tbody>
    {!rows.length && <tr><td colSpan={9} className="empty">Nothing here yet</td></tr>}
    {rows.map(({ c, v, s }) => <tr key={c.mint} onClick={() => go('coin/' + c.mint)} title={s.reasons.join(' · ')}>
      <td><div className="row"><Pfp c={c} /><div className="tk">{c.symbol}{v && <span className="tag live" style={{ marginLeft: 4 }}>{v.mode === 'mm' ? 'MM' : 'FLOOR'}</span>}</div></div></td>
      <td className="r dim num">{c.createdAt ? ago(c.createdAt) : '—'}</td><td className="r"><Mc v={c.mcap} /></td><td className="r"><Ch v={c.ch1h} /></td><td className="r"><Ch v={c.ch24} /></td><td className="r num"><Mc v={c.vol24} /></td>
      <td className="r num">{c.buys24 + c.sells24 ? Math.round((c.buys24 / (c.buys24 + c.sells24)) * 100) + '%' : '—'}</td><td className="r num">{v ? S(v.chest, 1) + ' SOL' : <span className="dim">—</span>}</td>
      <td className="r"><span className={'tag ' + labelTone(s.label)}>{s.label}</span></td></tr>)}
  </tbody></table></div>
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
    <div><h2 style={{ margin: '0 0 4px', fontSize: 18 }}>Vaulted vs not</h2><div className="dim" style={{ fontSize: 12 }}>Same columns, same window, live from the market. Left column is every coin running one of our vaults; right is the most-traded coins on the board without one.</div></div>
    <div className="tiles" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
      <div className="tile"><div className="l">Coins</div><div className="v num">{A.n}<span className="dim" style={{ fontSize: 13 }}> vaulted · {B.n} not</span></div></div>
      <div className="tile"><div className="l">Avg 24h</div><div className="v num">{pct(A.ch24)}<span className="dim" style={{ fontSize: 13 }}> vs </span>{pct(B.ch24)}</div><div className="s">1h: {pct(A.ch1h)} vs {pct(B.ch1h)}</div></div>
      <div className="tile"><div className="l">Buy share of txns</div><div className="v num">{A.buyRatio == null ? '—' : Math.round(A.buyRatio * 100) + '%'}<span className="dim" style={{ fontSize: 13 }}> vs {B.buyRatio == null ? '—' : Math.round(B.buyRatio * 100) + '%'}</span></div><div className="s">more buys than sells = held, not flipped</div></div>
      <div className="tile"><div className="l">Runners / at-risk</div><div className="v num">{A.runners}/{A.risk}<span className="dim" style={{ fontSize: 13 }}> vs {B.runners}/{B.risk}</span></div><div className="s">signal labels, same rules both sides</div></div>
    </div>
    {bt?.agg && <div className="card"><h3>Backtest on real flow <span className="nm">{bt.coins} live coins replayed through the vault rules · same buyers and sellers, with and without a vault</span></h3>
      <div className="tiles" style={{ gridTemplateColumns: 'repeat(3,1fr)', padding: 12 }}>
        <div className="tile"><div className="l">Worst drop</div><div className="v num">{(bt.agg.mm.maxDDAvg * 100).toFixed(0)}%<span className="dim" style={{ fontSize: 13 }}> vs {(bt.agg.none.maxDDAvg * 100).toFixed(0)}% without</span></div><div className="s">drawdown shallower on {bt.agg.mm.ddBeatsNone}/{bt.coins} coins</div></div>
        <div className="tile"><div className="l">Where it ends</div><div className="v num">{bt.agg.mm.finalMed.toFixed(2)}x<span className="dim" style={{ fontSize: 13 }}> vs {bt.agg.none.finalMed.toFixed(2)}x</span></div><div className="s">median · part of this is the chest's own capital</div></div>
        <div className="tile"><div className="l">Coins where the vault helped</div><div className="v num">{bt.agg.mm.finalBeatsNone}/{bt.coins}</div><div className="s">final price higher than the no-vault replay</div></div>
      </div></div>}
    <div className="lay" style={{ gridTemplateColumns: '1fr 1fr' }}><Table rows={ours} title={<>Vaulted <span className="nm">our mechanism</span></>} /><Table rows={others} title={<>Not vaulted <span className="nm">most traded on the board</span></>} /></div>
    <div className="nm">Live columns come from DexScreener for both sides. The backtest block is the replay in <code>app/backtest-real.md</code>; it is the only number here that compares the <em>same</em> coin with and without a vault.</div>
  </div>
}
