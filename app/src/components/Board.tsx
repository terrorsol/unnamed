import React, { useMemo, useState } from 'react'
import type { Coin } from '../lib/dex'
import type { NewToken, TradeEvt } from '../lib/pumpportal'
import { Pfp, Ch, Mc, Status, Addr } from './ui'
import { F, S, ago, short } from '../lib/fmt'

type Props = { coins: Coin[]; fresh: NewToken[]; freshCoins: Record<string, Coin>; trades: TradeEvt[]; live: boolean; solPrice: number; watch: string[]; go: (p: string) => void; quick: (c: Coin) => void; quickSol: number; err: string; vaulted: Set<string> }
type Seg = 'all' | 'new' | 'graduating' | 'runners' | 'watch'
const cols: [string, string, keyof Coin | 'none'][] = [['Token', '', 'none'], ['MC', 'r', 'mcap'], ['Liq', 'r', 'liq'], ['Vol 24h', 'r', 'vol24'], ['1h', 'r', 'ch1h'], ['24h', 'r', 'ch24'], ['Txns', 'r', 'buys24'], ['Age', 'r', 'createdAt'], ['', 'r', 'none']]

export default function Board(p: Props) {
  const [seg, setSeg] = useState<Seg>('all'); const [sort, setSort] = useState<{ k: keyof Coin; d: number }>({ k: 'vol24', d: -1 })
  const fresh = useMemo(() => p.fresh.map((t) => p.freshCoins[t.mint] || ({ mint: t.mint, symbol: t.symbol, name: t.name, dex: 'pumpfun', onCurve: true, priceUsd: 0, mcap: (t.mcapSol || 0) * p.solPrice, liq: 0, vol24: 0, vol1h: 0, ch1h: 0, ch24: 0, ch5m: 0, buys24: 0, sells24: 0, createdAt: t.ts } as Coin)), [p.fresh, p.freshCoins, p.solPrice])
  const rows = useMemo(() => {
    let r: Coin[] = seg === 'new' ? fresh : p.coins
    if (seg === 'graduating') r = p.coins.filter((c) => c.onCurve)
    if (seg === 'runners') r = p.coins.filter((c) => c.ch1h > 20)
    if (seg === 'watch') r = p.coins.filter((c) => p.watch.includes(c.mint))
    if (seg !== 'new') r = [...r].sort((a, b) => ((a[sort.k] as number) - (b[sort.k] as number)) * sort.d)
    return r
  }, [seg, p.coins, fresh, sort, p.watch])
  const tot = p.coins.reduce((a, c) => ({ v: a.v + c.vol24, l: a.l + c.liq, t: a.t + c.buys24 + c.sells24 }), { v: 0, l: 0, t: 0 })
  return <>
    <div className="tiles" style={{ marginBottom: 14 }}>
      <div className="tile"><div className="l">SOL</div><div className="v num">${S(p.solPrice, 2)}</div><div className="s">live · DexScreener</div></div>
      <div className="tile"><div className="l">Board volume 24h</div><div className="v num">{F(tot.v)}</div><div className="s">{p.coins.length} tracked markets</div></div>
      <div className="tile"><div className="l">Board liquidity</div><div className="v num">{F(tot.l)}</div><div className="s">pooled</div></div>
      <div className="tile"><div className="l">Txns 24h</div><div className="v num">{tot.t.toLocaleString()}</div><div className="s">buys + sells</div></div>
      <div className="tile"><div className="l">New launches</div><div className="v num">{p.fresh.length}</div><div className="s status"><i className={p.live ? '' : 'off'} />{p.live ? 'pump.fun stream live' : 'connecting…'}</div></div>
    </div>
    <div className="lay">
      <div>
        <div className="row" style={{ marginBottom: 10 }}>
          <div className="seg">{(['all', 'new', 'graduating', 'runners', 'watch'] as Seg[]).map((s) => <button key={s} className={seg === s ? 'on' : ''} onClick={() => setSeg(s)}>{s === 'watch' ? '★' : s[0].toUpperCase() + s.slice(1)}</button>)}</div>
          <span className="sp" />{p.err && <span className="dim" style={{ fontSize: 11 }}>data: {p.err}</span>}
        </div>
        <div className="card"><div style={{ overflowX: 'auto' }}><table>
          <thead><tr>{cols.map(([l, cls, k]) => <th key={l} className={cls} onClick={() => k !== 'none' && setSort((s) => ({ k: k as keyof Coin, d: s.k === k ? -s.d : -1 }))}>{l}{sort.k === k ? (sort.d < 0 ? ' ↓' : ' ↑') : ''}</th>)}</tr></thead>
          <tbody>{rows.length === 0 && <tr><td colSpan={9} className="empty">{seg === 'new' ? 'Waiting for new launches…' : seg === 'watch' ? 'Star a coin to track it here' : 'Loading markets…'}</td></tr>}
            {rows.map((c) => <tr key={c.mint} onClick={() => p.go('coin/' + c.mint)}>
              <td><div className="row"><Pfp c={c} /><div><div className="tk">{c.symbol} {p.vaulted.has(c.mint) && <span className="tag live" style={{ marginLeft: 4 }}>VAULTED</span>} {p.watch.includes(c.mint) && <span className="gold">★</span>}</div><div className="nm">{c.name.slice(0, 22)} · <Addr a={c.mint} /></div></div></div></td>
              <td className="r"><Mc v={c.mcap} /></td><td className="r"><Mc v={c.liq} /></td><td className="r"><Mc v={c.vol24} /></td>
              <td className="r"><Ch v={c.ch1h} /></td><td className="r"><Ch v={c.ch24} /></td>
              <td className="r num"><span className="up">{c.buys24}</span><span className="dim">/</span><span className="dn">{c.sells24}</span></td>
              <td className="r dim num">{c.createdAt ? ago(c.createdAt) : '—'}</td>
              <td className="r"><div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}><Status c={c} /><button className="btn sm pri" onClick={(e) => { e.stopPropagation(); p.quick(c) }}>⚡ {p.quickSol}</button></div></td>
            </tr>)}</tbody></table></div></div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="card"><h3><span className="status"><i className={p.live ? '' : 'off'} /></span>Live pump.fun launches</h3>
          <div className="feed">{p.fresh.slice(0, 25).map((t) => <div className="it" key={t.mint} style={{ cursor: 'pointer' }} onClick={() => p.go('coin/' + t.mint)}><Pfp mint={t.mint} c={p.freshCoins[t.mint]} /><div style={{ flex: 1, minWidth: 0 }}><div className="tk">{t.symbol}</div><div className="nm">{t.name.slice(0, 20)} · dev {short(t.creator || '', 3)}</div></div><div style={{ textAlign: 'right' }}><div className="num">{((t.mcapSol || 0) * p.solPrice) ? F((t.mcapSol || 0) * p.solPrice) : '—'}</div><div className="nm">{ago(t.ts)}</div></div></div>)}
            {!p.fresh.length && <div className="empty">Listening…</div>}</div></div>
        <div className="card"><h3>Runners <span className="dim" style={{ fontWeight: 500 }}>· 1h</span></h3>
          <div className="feed" style={{ maxHeight: 220 }}>{[...p.coins].filter((c) => c.ch1h > 0).sort((a, b) => b.ch1h - a.ch1h).slice(0, 8).map((c, i) => <div className="it" key={c.mint} style={{ cursor: 'pointer' }} onClick={() => p.go('coin/' + c.mint)}><span className="dim num" style={{ width: 16 }}>{i + 1}</span><Pfp c={c} /><div style={{ flex: 1, minWidth: 0 }}><div className="tk">{c.symbol}</div><div className="nm">{F(c.mcap)} mc</div></div><div style={{ textAlign: 'right' }}><div className="num up">+{c.ch1h.toFixed(0)}%</div><div className="nm">{F(c.vol1h)} vol</div></div></div>)}
            {!p.coins.length && <div className="empty" style={{ padding: 16 }}>Loading…</div>}</div></div>
        <div className="card"><h3>Live trades</h3>
          <div className="feed" style={{ maxHeight: 260 }}>{p.trades.slice(0, 30).map((t, i) => <div className="it" key={i}><span className={t.txType === 'buy' ? 'up' : 'dn'} style={{ width: 34, fontWeight: 600 }}>{t.txType.toUpperCase()}</span><span className="num" style={{ width: 70 }}>{S(t.sol, 2)} SOL</span><span className="dim num" style={{ flex: 1 }}>{short(t.trader, 3)}</span><span className="nm">{ago(t.ts)}</span></div>)}
            {!p.trades.length && <div className="empty" style={{ padding: 20 }}>Trades on tracked launches appear here</div>}</div></div>
      </div>
    </div>
  </>
}
