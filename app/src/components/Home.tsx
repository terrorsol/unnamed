import React, { useEffect, useMemo, useState } from 'react'
import { deskEligible } from '../lib/dex'
import type { Coin } from '../lib/dex'
import * as K from '../lib/desk'
import { Pfp, Ch, Mc, Addr, Live, DeskState } from './ui'
import { F, S, ago, short, px } from '../lib/fmt'
import { classify, featsFromCoin, labelTone, labelText } from '../lib/signal'
import { solscan } from '../lib/rpc'

type Props = { coins: Coin[]; byMint: Record<string, Coin>; vaults: K.VaultPub[]; solPrice: number; go: (p: string) => void; quick: (c: Coin) => void; quickSol: number; deskUp: boolean; onLaunch: () => void; fresh: any[]; freshCoins: Record<string, Coin>; trades: any[]; live: boolean; err: string; watch: string[]; simple?: boolean }

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
    ...fills.slice(0, 20).map((f) => ({ k: f.sig, t: f.t, mint: f.mint, symbol: f.symbol, sol: f.sol, px: (f.discBps < 0 ? '+' : '−') + (Math.abs(f.discBps) / 100).toFixed(1) + '%', what: f.vault ? 'chest bought a big sell' : 'big trade off-chart', tone: f.discBps < 0 ? 'up' : 'dn' })),
    ...tape.filter((a: any) => a.kind === 'buy' || a.kind === 'capture' || a.kind === 'redeem' || a.kind === 'tax').slice(0, 20).map((a: any) => ({ k: a.sig || a.t, t: a.t, mint: a.mint, symbol: a.symbol, sol: a.sol || 0, px: a.kind === 'capture' ? 'profit' : a.kind === 'buy' ? 'dip' : a.kind === 'tax' ? 'fees' : 'cash-out', what: a.kind === 'capture' ? 'took profit on a pump' : a.kind === 'buy' ? 'bought the dip' : a.kind === 'tax' ? 'trading fees → chest' : 'holder cashed out at the floor', tone: a.kind === 'capture' ? 'dn' : 'up' })),
  ].sort((a, b) => b.t - a.t).slice(0, 16), [fills, tape])
  return <>
    {(() => {
      const desksLive = desks.filter((c) => books[c.mint]).length
      const offChartToday = fills24.reduce((a, f) => a + f.sol, 0) + tape.filter((a: any) => Date.now() - a.t < 86400000 && (a.kind === 'buy' || a.kind === 'bid')).reduce((a: number, x: any) => a + (x.sol || 0), 0)
      const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
      const vaultedCh = avg(ours.filter((x) => x.c).map((x) => x.c!.ch24)); const marketCh = avg(p.coins.map((c) => c.ch24))
      void vaultedCh; void marketCh
      return <div className={'tiles compact ' + (p.simple ? '' : 'four')} style={{ marginBottom: 10, ...(p.simple ? { gridTemplateColumns: 'repeat(2,1fr)' } : {}) }}>
        {!p.simple && <div className="tile" title="Coins where you can buy or sell a big chunk off the chart, without moving the price"><div className="l">Big-trade desks</div><div className="v num"><Live v={desks.length}>{desks.length}</Live></div></div>}
        <div className="tile" title="Coins with a vault: a chest of SOL that defends the price and grows from every trade"><div className="l">Protected coins</div><div className="v num"><Live v={p.vaults.filter((v) => v.armed).length}>{p.vaults.filter((v) => v.armed).length}</Live></div></div>
        <div className="tile" title="Total SOL sitting in chests under these coins"><div className="l">In chests</div><div className="v num"><Live v={chest}>{S(chest, 1)} SOL</Live></div></div>
        {!p.simple && <div className="tile" title="Big trades done privately today, so they never crashed a chart"><div className="l">Big trades today</div><div className="v num"><Live v={offChartToday}>{S(offChartToday, 1)} SOL</Live></div></div>}
      </div> })()}
    <div className="row" style={{ marginBottom: 10 }}>
      <div className="seg"><button className={tab === 'ours' ? 'on' : ''} onClick={() => setTab('ours')}>Our coins</button><button className={tab === 'market' ? 'on' : ''} onClick={() => setTab('market')}>Market</button>{!p.simple && <button className={tab === 'stream' ? 'on' : ''} onClick={() => setTab('stream')}>Brand new</button>}</div>
    </div>
    {tab === 'ours' && <div className="lay keep">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {ours.length > 0 && <div className="card"><h3>Coins with a chest <span className="nm">every trade pays into the chest · the chest buys dips and takes profit on pumps</span></h3><table><thead><tr><th>Coin</th><th className="r" title="what the whole coin is worth">Value</th><th className="r">1h</th><th className="r" title="SOL in this coin's chest">Chest</th><th className="r" title="what each coin is worth if you cash out against the chest">Floor price</th><th className="r" title="SOL the chest made selling into pumps">Profit taken</th><th className="r" title="our read on the chart right now">Health</th><th className="r"></th></tr></thead><tbody>
          {ours.map(({ v, c, sg }) => <tr key={v.id} onClick={() => p.go('coin/' + v.mint)}>
            <td><div className="row"><Pfp c={c || ({ mint: v.mint, image: v.image } as any)} mint={v.mint} /><div><div className="tk">{v.symbol} <span className={'tag ' + (v.mode === 'mm' ? 'live' : '')} style={{ marginLeft: 4 }}>{v.mode === 'mm' ? 'PROTECTED' : 'FLOOR ONLY'}</span></div></div></div></td>
            <td className="r">{c ? <Mc v={c.mcap} /> : (v as any).live?.price ? <Mc v={(v as any).live.price * (v.supply || 1e9) * p.solPrice} /> : '—'}</td><td className="r">{c ? <Ch v={c.ch1h} /> : (v as any).live?.vwap30 && (v as any).live?.price ? <Ch v={((v as any).live.price / (v as any).live.vwap30 - 1) * 100} /> : '—'}</td>
            <td className="r num"><Live v={v.chest}>{S(v.chest, 2)} SOL</Live></td><td className="r num">{px(v.floor * p.solPrice)}</td><td className="r num">{S(v.score?.captured || 0, 2)}</td>
            <td className="r">{sg ? <span className={'tag ' + labelTone(sg.label)} title={sg.reasons.join(' · ')}>{labelText(sg.label)}</span> : <span className="dim">—</span>}</td>
            <td className="r">{c && <button className="btn sm qbuy" onClick={(e) => { e.stopPropagation(); p.quick(c) }}>⚡ {p.quickSol}</button>}</td></tr>)}
        </tbody></table></div>}
        <div className="card"><h3>Moving now <span className="nm">the most active coins on Solana</span></h3><table><thead><tr><th>Coin</th><th className="r" title="what the whole coin is worth">Value</th><th className="r">5m</th><th className="r">1h</th><th className="r" title="traded in the last hour">Traded 1h</th><th className="r" title="our read on the chart right now">Health</th><th className="r"></th></tr></thead><tbody>
          {!movers.length && <tr><td colSpan={7} className="empty">{p.err || 'Loading coins…'}</td></tr>}
          {movers.map(({ c, s }) => <tr key={c.mint} onClick={() => p.go('coin/' + c.mint)} title={s.reasons.join(' · ')}>
            <td><div className="row"><Pfp c={c} /><div><div className="tk">{c.symbol} {p.vaults.some((v) => v.mint === c.mint) && <span className="tag live" style={{ marginLeft: 4 }} title="has a chest defending it">CHEST</span>}{books[c.mint] && <span className="tag" style={{ marginLeft: 4 }} title="big trades can happen off the chart">DESK</span>}{vampMap[c.mint] && <span className="tag pre" style={{ marginLeft: 4 }} title={vampMap[c.mint].reasons.join(' · ')}>COPYCAT of {vampMap[c.mint].originalSymbol}</span>}</div><div className="nm">{vampMap[c.mint] ? vampMap[c.mint].reasons[0] : s.reasons[0]}</div></div></div></td>
            <td className="r"><Mc v={c.mcap} /></td><td className="r"><Ch v={c.ch5m} /></td><td className="r"><Ch v={c.ch1h} /></td><td className="r num"><Mc v={c.vol1h} /></td>
            <td className="r"><span className={'tag ' + (s.label === 'RUNNER' ? 'hot' : labelTone(s.label))}>{labelText(s.label)}</span></td>
            <td className="r"><button className="btn sm qbuy" onClick={(e) => { e.stopPropagation(); p.quick(c) }}>⚡ {p.quickSol}</button></td></tr>)}
        </tbody></table></div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
{!p.simple && <div className="card"><h3>Big-trade desks <span className="nm">buy or sell a large amount without moving the price</span></h3>
          <div className="feed" style={{ maxHeight: 300 }}>{desks.map((c) => <div className="it" key={c.mint} style={{ cursor: 'pointer' }} onClick={() => p.go('coin/' + c.mint + '/desk')}><span className="tk">{c.symbol}</span><span className="dim num"><Mc v={c.mcap} /></span><DeskState b={books[c.mint]} /></div>)}
            {!desks.length && <div className="empty" style={{ padding: 16 }}>{p.deskUp ? 'No desks open right now' : 'Desk is reconnecting…'}</div>}</div></div>}
        <div className="card"><h3>What the chests are doing</h3>
          <div className="feed tape" style={{ maxHeight: 320 }}>
            {tapeRows.map((x, i) => <div className={'it' + (x.t > mountedAt ? ' new' : '')} key={x.k || i} style={{ cursor: 'pointer' }} onClick={() => p.go('coin/' + x.mint)}><span className={'dot ' + x.tone} /><span className="tk">{x.symbol}</span><span className="num">{S(x.sol, 2)} SOL</span><span className={'num ' + x.tone}>{x.px}</span><span className="dim what">{x.what}</span><span className="dim num">{ago(x.t)}</span></div>)}
            {!tapeRows.length && <div className="empty" style={{ padding: 16 }}>Dip buys, profit-taking and fees show up here as they happen</div>}</div></div>
      </div>
    </div>}
    {tab === 'market' && <MarketTable coins={p.coins} go={p.go} quick={p.quick} quickSol={p.quickSol} vaults={p.vaults} err={p.err} />}
    {tab === 'stream' && <div className="lay"><div className="card"><h3>Just launched on pump.fun</h3><div className="feed" style={{ maxHeight: 600 }}>{p.fresh.slice(0, 40).map((t) => <div className="it" key={t.mint} style={{ cursor: 'pointer' }} onClick={() => p.go('coin/' + t.mint)}><Pfp mint={t.mint} c={p.freshCoins[t.mint]} /><div style={{ flex: 1, minWidth: 0 }}><div className="tk">{t.symbol}</div><div className="nm">{t.name.slice(0, 20)} · dev {short(t.creator || '', 3)}</div></div><div style={{ textAlign: 'right' }}><div className="num">{((t.mcapSol || 0) * p.solPrice) ? F((t.mcapSol || 0) * p.solPrice) : '—'}</div><div className="nm">{ago(t.ts)}</div></div></div>)}{!p.fresh.length && <div className="empty">Waiting for new coins…</div>}</div></div>
      <div className="card"><h3>Live trades</h3><div className="feed" style={{ maxHeight: 600 }}>{p.trades.slice(0, 40).map((t, i) => <div className={'it' + (t.ts > mountedAt ? ' new' : '')} key={t.ts + ':' + t.trader + ':' + i}><span className={t.txType === 'buy' ? 'up' : 'dn'} style={{ width: 34, fontWeight: 600 }}>{t.txType.toUpperCase()}</span><span className="num" style={{ width: 70 }}>{S(t.sol, 2)} SOL</span><span className="dim num" style={{ flex: 1 }}>{short(t.trader, 3)}</span><span className="nm">{ago(t.ts)}</span></div>)}{!p.trades.length && <div className="empty">Trades show up here live</div>}</div></div></div>}
  </>
}

function MarketTable({ coins, go, quick, quickSol, vaults, err }: { coins: Coin[]; go: (p: string) => void; quick: (c: Coin) => void; quickSol: number; vaults: K.VaultPub[]; err: string }) {
  const [sort, setSort] = useState<{ k: keyof Coin; d: number }>({ k: 'vol24', d: -1 })
  const rows = useMemo(() => [...coins].sort((a, b) => ((a[sort.k] as number) - (b[sort.k] as number)) * sort.d), [coins, sort])
  const cols: [string, string, keyof Coin | 'none'][] = [['Token', '', 'none'], ['Value', 'r', 'mcap'], ['Pool', 'r', 'liq'], ['Traded 24h', 'r', 'vol24'], ['1h', 'r', 'ch1h'], ['24h', 'r', 'ch24'], ['Age', 'r', 'createdAt'], ['', 'r', 'none']]
  return <div className="card"><div style={{ overflowX: 'auto' }}><table><thead><tr>{cols.map(([l, cls, k]) => <th key={l} className={cls} onClick={() => k !== 'none' && setSort((s) => ({ k: k as keyof Coin, d: s.k === k ? -s.d : -1 }))}>{l}{sort.k === k ? (sort.d < 0 ? ' ↓' : ' ↑') : ''}</th>)}</tr></thead><tbody>
    {!rows.length && <tr><td colSpan={8} className="empty">{err ? 'data: ' + err : 'Loading coins…'}</td></tr>}
    {rows.map((c) => { const sg = classify(featsFromCoin(c, null, vaults.some((v) => v.mint === c.mint))); return <tr key={c.mint} onClick={() => go('coin/' + c.mint)}>
      <td><div className="row"><Pfp c={c} /><div><div className="tk">{c.symbol} {sg.label !== 'HEALTHY' && <span className={'tag ' + labelTone(sg.label)} title={sg.reasons.join(' · ')}>{labelText(sg.label)}</span>}</div><div className="nm">{c.name.slice(0, 22)} · <Addr a={c.mint} /></div></div></div></td>
      <td className="r"><Mc v={c.mcap} /></td><td className="r"><Mc v={c.liq} /></td><td className="r"><Mc v={c.vol24} /></td><td className="r"><Ch v={c.ch1h} /></td><td className="r"><Ch v={c.ch24} /></td><td className="r dim num">{c.createdAt ? ago(c.createdAt) : '—'}</td>
      <td className="r"><button className="btn sm qbuy" onClick={(e) => { e.stopPropagation(); quick(c) }}>⚡ {quickSol}</button></td></tr> })}
  </tbody></table></div></div>
}
