import React, { useEffect, useMemo, useState } from 'react'
import { deskEligible } from '../lib/dex'
import type { Coin } from '../lib/dex'
import * as K from '../lib/desk'
import { Pfp, Ch, Mc, Addr, Live } from './ui'
import { F, S, ago, short } from '../lib/fmt'
import { classify, featsFromCoin, labelTone } from '../lib/signal'
import { solscan } from '../lib/rpc'

type Props = { coins: Coin[]; byMint: Record<string, Coin>; vaults: K.VaultPub[]; solPrice: number; go: (p: string) => void; quick: (c: Coin) => void; quickSol: number; deskUp: boolean; onLaunch: () => void; fresh: any[]; freshCoins: Record<string, Coin>; trades: any[]; live: boolean; err: string; watch: string[] }

/** Home = our coins. Vaulted launches ranked by runner score, the vault tape, and the market behind a tab. */
export default function Home(p: Props) {
  const [tab, setTab] = useState<'ours' | 'market' | 'stream'>('ours')
  const ours = useMemo(() => p.vaults.filter((v) => v.mint).map((v) => { const c = p.byMint[v.mint!]; const sg = c ? classify(featsFromCoin(c, (v as any).holders || null, true)) : null; return { v, c, sg } }).sort((a, b) => (b.sg?.score || 0) - (a.sg?.score || 0)), [p.vaults, p.byMint])
  const runners = useMemo(() => p.coins.map((c) => ({ c, s: classify(featsFromCoin(c, null, p.vaults.some((v) => v.mint === c.mint))) })).filter((x) => x.s.label === 'RUNNER').sort((a, b) => b.s.score - a.s.score).slice(0, 6), [p.coins, p.vaults])
  const tape = useMemo(() => p.vaults.flatMap((v) => v.activity.filter((a) => ['capture', 'buy', 'redeem', 'bid', 'stream'].includes(a.kind)).map((a) => ({ ...a, symbol: v.symbol, mint: v.mint }))).sort((a, b) => b.t - a.t).slice(0, 30), [p.vaults])
  const chest = p.vaults.reduce((a, v) => a + v.chest, 0), captured = p.vaults.reduce((a, v) => a + (v.score?.captured || 0), 0), offChart = p.vaults.reduce((a, v) => a + (v.score?.deskBought || 0), 0)
  const [vampMap, setVampMap] = useState<Record<string, K.VampHit>>({})
  useEffect(() => { if (!p.deskUp) return; const f = () => K.vamps().then((d) => setVampMap(Object.fromEntries(d.vamps.map((v) => [v.mint, v])))).catch(() => {}); f(); const i = setInterval(f, 60000); return () => clearInterval(i) }, [p.deskUp])
  const [fills, setFills] = useState<K.FillRec[]>([]); const [books, setBooks] = useState<Record<string, { bids: number; sol: number; bestDisc: number }>>({})
  useEffect(() => { if (!p.deskUp) return; const f = () => { K.fills().then(setFills).catch(() => {}); K.getBooks().then((l) => setBooks(Object.fromEntries(l.map((b) => [b.mint, b])))).catch(() => {}) }; f(); const i = setInterval(f, 10000); K.bookBus.addEventListener('book', f); return () => { clearInterval(i); K.bookBus.removeEventListener('book', f) } }, [p.deskUp])
  const desks = useMemo(() => p.coins.filter(deskEligible).sort((a, b) => (books[b.mint]?.sol || 0) - (books[a.mint]?.sol || 0) || b.vol1h - a.vol1h).slice(0, 12), [p.coins, books])
  const movers = useMemo(() => p.coins.map((c) => ({ c, s: classify(featsFromCoin(c, null, p.vaults.some((v) => v.mint === c.mint))) })).filter((x) => x.s.label !== 'DEAD' && x.s.label !== 'RUG RISK').sort((a, b) => b.s.score - a.s.score).slice(0, 14), [p.coins, p.vaults])
  const fills24 = fills.filter((f) => Date.now() - f.t < 86400000)
  // one compact row per event; fills and vault moves merged, newest first, capped
  const mountedAt = useMemo(() => Date.now(), [])
  const tapeRows = useMemo(() => [
    ...fills.slice(0, 20).map((f) => ({ k: f.sig, t: f.t, mint: f.mint, symbol: f.symbol, sol: f.sol, px: (f.discBps < 0 ? '+' : '−') + (Math.abs(f.discBps) / 100).toFixed(1) + '%', what: f.vault ? 'vault bought' : 'desk fill', tone: f.discBps < 0 ? 'up' : 'dn' })),
    ...tape.filter((a: any) => a.kind === 'buy' || a.kind === 'capture' || a.kind === 'redeem' || a.kind === 'tax').slice(0, 20).map((a: any) => ({ k: a.sig || a.t, t: a.t, mint: a.mint, symbol: a.symbol, sol: a.sol || 0, px: a.kind === 'capture' ? 'sold' : a.kind === 'buy' ? 'dip' : a.kind === 'tax' ? 'tax' : 'redeem', what: a.kind === 'capture' ? 'into a pump' : a.kind === 'buy' ? 'bought the dip' : a.kind === 'tax' ? 'tax → chest' : 'holder redeemed', tone: a.kind === 'capture' ? 'dn' : 'up' })),
  ].sort((a, b) => b.t - a.t).slice(0, 16), [fills, tape])
  return <>
    {(() => {
      const desksLive = desks.filter((c) => books[c.mint]).length
      const offChartToday = fills24.reduce((a, f) => a + f.sol, 0) + tape.filter((a: any) => Date.now() - a.t < 86400000 && (a.kind === 'buy' || a.kind === 'bid')).reduce((a: number, x: any) => a + (x.sol || 0), 0)
      const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
      const vaultedCh = avg(ours.filter((x) => x.c).map((x) => x.c!.ch24)); const marketCh = avg(p.coins.map((c) => c.ch24))
      return <div className="tiles four" style={{ marginBottom: 12 }}>
        <div className="tile"><div className="l">Desks live</div><div className="v num"><Live v={desksLive}>{desksLive}</Live><span className="dim" style={{ fontSize: 13 }}> / {desks.length} open</span></div><div className="s status"><i className={p.deskUp ? '' : 'off'} />{p.deskUp ? 'desk online' : 'desk offline'}</div></div>
        <div className="tile"><div className="l">Vaults live</div><div className="v num"><Live v={p.vaults.filter((v) => v.armed).length}>{p.vaults.filter((v) => v.armed).length}</Live></div><div className="s num">{chest > 0 ? `${S(chest, 1)} SOL in chests · ${ours.filter((x) => x.sg?.label === 'RUNNER').length} running` : 'holder-owned market makers'}</div></div>
        <div className="tile"><div className="l">Off-chart volume today</div><div className="v num"><Live v={offChartToday}>{S(offChartToday, 1)} SOL</Live></div><div className="s num">{fills24.length} desk fills · ${S(offChartToday * p.solPrice, 0)}</div></div>
        <div className="tile"><div className="l">24h · vaulted vs market</div><div className="v num">{vaultedCh == null ? <span className="dim">—</span> : <span className={vaultedCh >= 0 ? 'up' : 'dn'}>{vaultedCh >= 0 ? '+' : ''}{vaultedCh.toFixed(1)}%</span>}<span className="dim" style={{ fontSize: 13 }}> vs {marketCh == null ? '—' : (marketCh >= 0 ? '+' : '') + marketCh.toFixed(1) + '%'}</span></div><div className="s"><a href="#/docs/vaulted-vs-not" style={{ textDecoration: 'underline' }}>vaulted vs not →</a></div></div>
      </div> })()}
    <div className="row" style={{ marginBottom: 10 }}>
      <span className="sp" /><button className="btn pri sm" onClick={p.onLaunch}>Launch with a vault</button>
    </div>
    <div className="row" style={{ marginBottom: 10 }}>
      <div className="seg"><button className={tab === 'ours' ? 'on' : ''} onClick={() => setTab('ours')}>Now</button><button className={tab === 'market' ? 'on' : ''} onClick={() => setTab('market')}>Market</button><button className={tab === 'stream' ? 'on' : ''} onClick={() => setTab('stream')}>Stream</button></div>
    </div>
    {tab === 'ours' && <div className="lay">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {ours.length > 0 && <div className="card"><h3>Vaulted <span className="nm">holder-owned market maker on every one</span></h3><table><thead><tr><th>Coin</th><th className="r">MC</th><th className="r">1h</th><th className="r">Chest</th><th className="r">Floor</th><th className="r">Captured</th><th className="r">Signal</th><th className="r"></th></tr></thead><tbody>
          {ours.map(({ v, c, sg }) => <tr key={v.id} onClick={() => p.go('coin/' + v.mint)}>
            <td><div className="row"><Pfp c={c} mint={v.mint} /><div><div className="tk">{v.symbol} <span className={'tag ' + (v.mode === 'mm' ? 'live' : '')} style={{ marginLeft: 4 }}>{v.mode === 'mm' ? 'MM' : 'FLOOR'}</span></div></div></div></td>
            <td className="r">{c ? <Mc v={c.mcap} /> : '—'}</td><td className="r">{c ? <Ch v={c.ch1h} /> : '—'}</td>
            <td className="r num"><Live v={v.chest}>{S(v.chest, 2)} SOL</Live></td><td className="r num">${(v.floor * p.solPrice) ? (v.floor * p.solPrice).toPrecision(2) : '—'}</td><td className="r num">{S(v.score?.captured || 0, 2)}</td>
            <td className="r">{sg ? <span className={'tag ' + labelTone(sg.label)} title={sg.reasons.join(' · ')}>{sg.label}</span> : <span className="dim">—</span>}</td>
            <td className="r">{c && <button className="btn sm pri" onClick={(e) => { e.stopPropagation(); p.quick(c) }}>⚡ {p.quickSol}</button>}</td></tr>)}
        </tbody></table></div>}
        <div className="card"><h3>Runners <span className="nm">ranked by structure, not candles · tap a row for the why</span></h3><table><thead><tr><th>Coin</th><th className="r">MC</th><th className="r">5m</th><th className="r">1h</th><th className="r">Vol 1h</th><th className="r">Signal</th><th className="r"></th></tr></thead><tbody>
          {!movers.length && <tr><td colSpan={7} className="empty">{p.err || 'Loading the market…'}</td></tr>}
          {movers.map(({ c, s }) => <tr key={c.mint} onClick={() => p.go('coin/' + c.mint)} title={s.reasons.join(' · ')}>
            <td><div className="row"><Pfp c={c} /><div><div className="tk">{c.symbol} {p.vaults.some((v) => v.mint === c.mint) && <span className="tag live" style={{ marginLeft: 4 }}>VAULTED</span>}{books[c.mint] && <span className="tag" style={{ marginLeft: 4 }}>DESK</span>}{vampMap[c.mint] && <span className="tag pre" style={{ marginLeft: 4 }} title={vampMap[c.mint].reasons.join(' · ')}>VAMP of {vampMap[c.mint].originalSymbol}</span>}</div><div className="nm">{vampMap[c.mint] ? vampMap[c.mint].reasons[0] : s.reasons[0]}</div></div></div></td>
            <td className="r"><Mc v={c.mcap} /></td><td className="r"><Ch v={c.ch5m} /></td><td className="r"><Ch v={c.ch1h} /></td><td className="r num"><Mc v={c.vol1h} /></td>
            <td className="r"><span className={'tag ' + (s.label === 'RUNNER' ? 'hot' : labelTone(s.label))}>{s.label === 'RUNNER' ? '🔥 runner' : s.label}</span></td>
            <td className="r"><button className="btn sm pri" onClick={(e) => { e.stopPropagation(); p.quick(c) }}>⚡ {p.quickSol}</button></td></tr>)}
        </tbody></table></div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="card"><h3>Desks open <span className="nm">trade a block off-chart</span></h3>
          <div className="feed" style={{ maxHeight: 300 }}>{desks.map((c) => <div className="it" key={c.mint} style={{ cursor: 'pointer' }} onClick={() => p.go('coin/' + c.mint + '/desk')}><span className="tk">{c.symbol}</span><span className="dim num"><Mc v={c.mcap} /></span><span className="num">{books[c.mint] ? `${books[c.mint].bids} bid${books[c.mint].bids === 1 ? '' : 's'} · ${S(books[c.mint].sol, 1)} SOL` : <span className="dim">no bids yet</span>}</span></div>)}
            {!desks.length && <div className="empty" style={{ padding: 16 }}>{p.deskUp ? 'No eligible coins loaded yet' : 'Desk offline'}</div>}</div></div>
        <div className="card"><h3>Off-chart <span className="nm">live</span></h3>
          <div className="feed tape" style={{ maxHeight: 320 }}>
            {tapeRows.map((x, i) => <div className={'it' + (x.t > mountedAt ? ' new' : '')} key={x.k || i} style={{ cursor: 'pointer' }} onClick={() => p.go('coin/' + x.mint)}><span className={'dot ' + x.tone} /><span className="tk">{x.symbol}</span><span className="num">{S(x.sol, 2)} SOL</span><span className={'num ' + x.tone}>{x.px}</span><span className="dim what">{x.what}</span><span className="dim num">{ago(x.t)}</span></div>)}
            {!tapeRows.length && <div className="empty" style={{ padding: 16 }}>Every desk fill, capture and dip buy shows here</div>}</div></div>
      </div>
    </div>}
    {tab === 'market' && <MarketTable coins={p.coins} go={p.go} quick={p.quick} quickSol={p.quickSol} vaults={p.vaults} err={p.err} />}
    {tab === 'stream' && <div className="lay"><div className="card"><h3><span className="status"><i className={p.live ? '' : 'off'} /></span>New pump.fun launches</h3><div className="feed" style={{ maxHeight: 600 }}>{p.fresh.slice(0, 40).map((t) => <div className="it" key={t.mint} style={{ cursor: 'pointer' }} onClick={() => p.go('coin/' + t.mint)}><Pfp mint={t.mint} c={p.freshCoins[t.mint]} /><div style={{ flex: 1, minWidth: 0 }}><div className="tk">{t.symbol}</div><div className="nm">{t.name.slice(0, 20)} · dev {short(t.creator || '', 3)}</div></div><div style={{ textAlign: 'right' }}><div className="num">{((t.mcapSol || 0) * p.solPrice) ? F((t.mcapSol || 0) * p.solPrice) : '—'}</div><div className="nm">{ago(t.ts)}</div></div></div>)}{!p.fresh.length && <div className="empty">Listening…</div>}</div></div>
      <div className="card"><h3>Live trades</h3><div className="feed" style={{ maxHeight: 600 }}>{p.trades.slice(0, 40).map((t, i) => <div className={'it' + (t.ts > mountedAt ? ' new' : '')} key={t.ts + ':' + t.trader + ':' + i}><span className={t.txType === 'buy' ? 'up' : 'dn'} style={{ width: 34, fontWeight: 600 }}>{t.txType.toUpperCase()}</span><span className="num" style={{ width: 70 }}>{S(t.sol, 2)} SOL</span><span className="dim num" style={{ flex: 1 }}>{short(t.trader, 3)}</span><span className="nm">{ago(t.ts)}</span></div>)}{!p.trades.length && <div className="empty">Trades on tracked launches appear here</div>}</div></div></div>}
  </>
}

function MarketTable({ coins, go, quick, quickSol, vaults, err }: { coins: Coin[]; go: (p: string) => void; quick: (c: Coin) => void; quickSol: number; vaults: K.VaultPub[]; err: string }) {
  const [sort, setSort] = useState<{ k: keyof Coin; d: number }>({ k: 'vol24', d: -1 })
  const rows = useMemo(() => [...coins].sort((a, b) => ((a[sort.k] as number) - (b[sort.k] as number)) * sort.d), [coins, sort])
  const cols: [string, string, keyof Coin | 'none'][] = [['Token', '', 'none'], ['MC', 'r', 'mcap'], ['Liq', 'r', 'liq'], ['Vol 24h', 'r', 'vol24'], ['1h', 'r', 'ch1h'], ['24h', 'r', 'ch24'], ['Age', 'r', 'createdAt'], ['', 'r', 'none']]
  return <div className="card"><div style={{ overflowX: 'auto' }}><table><thead><tr>{cols.map(([l, cls, k]) => <th key={l} className={cls} onClick={() => k !== 'none' && setSort((s) => ({ k: k as keyof Coin, d: s.k === k ? -s.d : -1 }))}>{l}{sort.k === k ? (sort.d < 0 ? ' ↓' : ' ↑') : ''}</th>)}</tr></thead><tbody>
    {!rows.length && <tr><td colSpan={8} className="empty">{err ? 'data: ' + err : 'Loading markets…'}</td></tr>}
    {rows.map((c) => { const sg = classify(featsFromCoin(c, null, vaults.some((v) => v.mint === c.mint))); return <tr key={c.mint} onClick={() => go('coin/' + c.mint)}>
      <td><div className="row"><Pfp c={c} /><div><div className="tk">{c.symbol} {sg.label !== 'HEALTHY' && <span className={'tag ' + labelTone(sg.label)} title={sg.reasons.join(' · ')}>{sg.label}</span>}</div><div className="nm">{c.name.slice(0, 22)} · <Addr a={c.mint} /></div></div></div></td>
      <td className="r"><Mc v={c.mcap} /></td><td className="r"><Mc v={c.liq} /></td><td className="r"><Mc v={c.vol24} /></td><td className="r"><Ch v={c.ch1h} /></td><td className="r"><Ch v={c.ch24} /></td><td className="r dim num">{c.createdAt ? ago(c.createdAt) : '—'}</td>
      <td className="r"><button className="btn sm pri" onClick={(e) => { e.stopPropagation(); quick(c) }}>⚡ {quickSol}</button></td></tr> })}
  </tbody></table></div></div>
}
