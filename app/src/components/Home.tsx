import React, { useEffect, useMemo, useState } from 'react'
import type { Coin } from '../lib/dex'
import * as K from '../lib/desk'
import { Pfp, Ch, Mc, Addr } from './ui'
import { F, S, ago, short } from '../lib/fmt'
import { classify, featsFromCoin, labelTone } from '../lib/signal'
import { solscan } from '../lib/rpc'

type Props = { coins: Coin[]; byMint: Record<string, Coin>; vaults: K.VaultPub[]; solPrice: number; go: (p: string) => void; quick: (c: Coin) => void; quickSol: number; deskUp: boolean; onLaunch: () => void; fresh: any[]; freshCoins: Record<string, Coin>; trades: any[]; live: boolean; err: string; watch: string[] }

/** Home = our coins. Vaulted launches ranked by runner score, the vault tape, and the market behind a tab. */
export default function Home(p: Props) {
  const [tab, setTab] = useState<'ours' | 'market' | 'stream'>('ours')
  const ours = useMemo(() => p.vaults.filter((v) => v.mint).map((v) => { const c = p.byMint[v.mint!]; const sg = c ? classify(featsFromCoin(c, null, true)) : null; return { v, c, sg } }).sort((a, b) => (b.sg?.score || 0) - (a.sg?.score || 0)), [p.vaults, p.byMint])
  const runners = useMemo(() => p.coins.map((c) => ({ c, s: classify(featsFromCoin(c, null, p.vaults.some((v) => v.mint === c.mint))) })).filter((x) => x.s.label === 'RUNNER').sort((a, b) => b.s.score - a.s.score).slice(0, 6), [p.coins, p.vaults])
  const tape = useMemo(() => p.vaults.flatMap((v) => v.activity.filter((a) => ['capture', 'buy', 'redeem', 'bid', 'stream'].includes(a.kind)).map((a) => ({ ...a, symbol: v.symbol, mint: v.mint }))).sort((a, b) => b.t - a.t).slice(0, 30), [p.vaults])
  const chest = p.vaults.reduce((a, v) => a + v.chest, 0), captured = p.vaults.reduce((a, v) => a + (v.score?.captured || 0), 0), offChart = p.vaults.reduce((a, v) => a + (v.score?.deskBought || 0), 0)
  return <>
    <div className="tiles" style={{ marginBottom: 14 }}>
      <div className="tile"><div className="l">Vaulted coins</div><div className="v num">{p.vaults.length}</div><div className="s">{ours.filter((x) => x.sg?.label === 'RUNNER').length} running</div></div>
      <div className="tile"><div className="l">Chests</div><div className="v num">{S(chest, 1)} SOL</div><div className="s num">${S(chest * p.solPrice, 0)} holder-owned</div></div>
      <div className="tile"><div className="l">Captured → floors</div><div className="v num">{S(captured, 2)} SOL</div><div className="s">from stretched buys</div></div>
      <div className="tile"><div className="l">Absorbed off-chart</div><div className="v num">{S(offChart, 2)} SOL</div><div className="s">desk fills</div></div>
      <div className="tile"><div className="l">SOL</div><div className="v num">${S(p.solPrice, 2)}</div><div className="s status"><i className={p.deskUp ? '' : 'off'} />{p.deskUp ? 'vault + desk live' : 'vault server offline'}</div></div>
    </div>
    <div className="row" style={{ marginBottom: 10 }}>
      <div className="seg"><button className={tab === 'ours' ? 'on' : ''} onClick={() => setTab('ours')}>Vaulted</button><button className={tab === 'market' ? 'on' : ''} onClick={() => setTab('market')}>Market</button><button className={tab === 'stream' ? 'on' : ''} onClick={() => setTab('stream')}>Stream</button></div>
      <span className="sp" /><button className="btn pri" onClick={p.onLaunch}>Launch with a vault</button>
    </div>
    {tab === 'ours' && <div className="lay">
      <div className="card"><table><thead><tr><th>Coin</th><th className="r">MC</th><th className="r">1h</th><th className="r">Chest</th><th className="r">Floor</th><th className="r">Captured</th><th className="r">Signal</th><th className="r"></th></tr></thead><tbody>
        {!ours.length && <tr><td colSpan={8} className="empty">{p.deskUp ? <>Nothing vaulted yet. <a href="#/dev/import-a-coin" style={{ textDecoration: 'underline' }}>Import a coin</a> or launch one — the vault, desk and floor come with it.</> : 'Vault server offline — vaulted coins appear here when it\'s up.'}</td></tr>}
        {ours.map(({ v, c, sg }) => <tr key={v.id} onClick={() => p.go('coin/' + v.mint)}>
          <td><div className="row"><Pfp c={c} mint={v.mint} /><div><div className="tk">{v.symbol} <span className={'tag ' + (v.mode === 'mm' ? 'live' : '')} style={{ marginLeft: 4 }}>{v.mode === 'mm' ? 'MM' : 'FLOOR'}</span> {p.watch.includes(v.mint!) && <span className="gold">★</span>}</div><div className="nm">{v.name || c?.name || ''} · <Addr a={v.mint!} /></div></div></div></td>
          <td className="r">{c ? <Mc v={c.mcap} /> : '—'}</td><td className="r">{c ? <Ch v={c.ch1h} /> : '—'}</td>
          <td className="r num">{S(v.chest, 2)} SOL</td><td className="r num">${(v.floor * p.solPrice) ? (v.floor * p.solPrice).toPrecision(2) : '—'}</td><td className="r num">{S(v.score?.captured || 0, 2)}</td>
          <td className="r">{sg ? <span className={'tag ' + labelTone(sg.label)} title={sg.reasons.join(' · ')}>{sg.label}</span> : <span className="dim">—</span>}</td>
          <td className="r">{c && <button className="btn sm pri" onClick={(e) => { e.stopPropagation(); p.quick(c) }}>⚡ {p.quickSol}</button>}</td></tr>)}
      </tbody></table></div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="card"><h3>Runners <span className="dim" style={{ fontWeight: 500 }}>· structure, not candles</span></h3>
          <div className="feed" style={{ maxHeight: 260 }}>{runners.map(({ c, s }, i) => <div className="it" key={c.mint} style={{ cursor: 'pointer' }} onClick={() => p.go('coin/' + c.mint)} title={s.reasons.join(' · ')}><span className="dim num" style={{ width: 16 }}>{i + 1}</span><Pfp c={c} /><div style={{ flex: 1, minWidth: 0 }}><div className="tk">{c.symbol} {p.vaults.some((v) => v.mint === c.mint) && <span className="tag live">VAULTED</span>}</div><div className="nm">{F(c.mcap)} · run {s.score}</div></div><div style={{ textAlign: 'right' }}><div className="num up">+{c.ch1h.toFixed(0)}%</div><div className="nm">{F(c.vol1h)} 1h</div></div></div>)}
            {!runners.length && <div className="empty" style={{ padding: 16 }}>No runners right now</div>}</div></div>
        <div className="card"><h3>Vault tape</h3>
          <div className="feed" style={{ maxHeight: 300 }}>{tape.map((a, i) => <div className="it" key={i} style={{ cursor: 'pointer' }} onClick={() => p.go('coin/' + a.mint)}><span className={a.kind === 'capture' ? 'dn' : a.kind === 'buy' ? 'up' : a.kind === 'redeem' ? 'gold' : 'dim'} style={{ width: 54, fontWeight: 600 }}>{a.kind === 'capture' ? 'CAPTURE' : a.kind === 'buy' ? (a.msg?.includes('desk') ? 'OTC' : 'DIP') : a.kind.toUpperCase()}</span><span className="tk" style={{ width: 64 }}>{a.symbol}</span><span className="num" style={{ width: 80 }}>{a.sol != null ? S(a.sol, 3) + ' SOL' : ''}</span><span className="dim" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.msg}</span>{a.sig && <a className="dim" href={solscan(a.sig)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>↗</a>}<span className="nm">{ago(a.t)}</span></div>)}
            {!tape.length && <div className="empty" style={{ padding: 16 }}>Every capture, dip buy, desk fill and redeem shows here as it happens</div>}</div></div>
      </div>
    </div>}
    {tab === 'market' && <MarketTable coins={p.coins} go={p.go} quick={p.quick} quickSol={p.quickSol} vaults={p.vaults} err={p.err} />}
    {tab === 'stream' && <div className="lay"><div className="card"><h3><span className="status"><i className={p.live ? '' : 'off'} /></span>New pump.fun launches</h3><div className="feed" style={{ maxHeight: 600 }}>{p.fresh.slice(0, 40).map((t) => <div className="it" key={t.mint} style={{ cursor: 'pointer' }} onClick={() => p.go('coin/' + t.mint)}><Pfp mint={t.mint} c={p.freshCoins[t.mint]} /><div style={{ flex: 1, minWidth: 0 }}><div className="tk">{t.symbol}</div><div className="nm">{t.name.slice(0, 20)} · dev {short(t.creator || '', 3)}</div></div><div style={{ textAlign: 'right' }}><div className="num">{((t.mcapSol || 0) * p.solPrice) ? F((t.mcapSol || 0) * p.solPrice) : '—'}</div><div className="nm">{ago(t.ts)}</div></div></div>)}{!p.fresh.length && <div className="empty">Listening…</div>}</div></div>
      <div className="card"><h3>Live trades</h3><div className="feed" style={{ maxHeight: 600 }}>{p.trades.slice(0, 40).map((t, i) => <div className="it" key={i}><span className={t.txType === 'buy' ? 'up' : 'dn'} style={{ width: 34, fontWeight: 600 }}>{t.txType.toUpperCase()}</span><span className="num" style={{ width: 70 }}>{S(t.sol, 2)} SOL</span><span className="dim num" style={{ flex: 1 }}>{short(t.trader, 3)}</span><span className="nm">{ago(t.ts)}</span></div>)}{!p.trades.length && <div className="empty">Trades on tracked launches appear here</div>}</div></div></div>}
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
