// Simple-mode coin screen. Same data and the same buy/sell calls as the pro page, arranged to fit one phone screen:
// what it's worth → the chart → what you own → the chest → is it safe → Buy. Details open in sheets instead of tabs.
import React, { useState } from 'react'
import type { Coin } from '../lib/dex'
import type * as K from '../lib/desk'
import type { RugCheck } from '../lib/rpc'
import { Pfp, Addr } from './ui'
import { F, S, px, ago } from '../lib/fmt'
import { AreaChart, RANGES } from './AreaChart'
import { ProgressCard, ladder } from './Progress'
import { safetyChecks, Ic, Ring } from './Simple'
import { ActionBar, TradeSheet, haptic } from './Flow'

/** a bottom sheet for details */
export function InfoSheet({ title, onClose, children }: { title: React.ReactNode; onClose: () => void; children: React.ReactNode }) {
  return <div className="modal s-sheet-bg" onClick={onClose}><div className="s-sheet info" onClick={(e) => e.stopPropagation()}>
    <div className="s-grab" />
    <div className="is-hd"><b>{title}</b><span className="sp" /><button className="is-x" onClick={onClose} aria-label="Close">{Ic.x(18)}</button></div>
    {children}
  </div></div>
}

export function SimpleCoinView({ c, vault, rug, held, valSol, cost, p, range, setRange, sheet, setSheet, quickBuy }: {
  c: Coin; vault: K.VaultPub | null | undefined; rug: RugCheck | null | undefined; held: number; valSol: number; cost: number; p: any
  range: string; setRange: (r: string) => void; tab?: string; setTab?: (t: any) => void
  sheet: null | 'buy' | 'sell'; setSheet: (s: null | 'buy' | 'sell') => void; quickBuy: () => void
}) {
  const [chg, setChg] = useState<number | null>(null); const [scrub, setScrub] = useState<{ t: number; v: number } | null>(null)
  const [info, setInfo] = useState<null | 'chest' | 'safety' | 'about'>(null)
  const open = (k: 'chest' | 'safety' | 'about') => { haptic(6); setInfo(k) }
  const L = ladder(c.mcap); const checks = safetyChecks(c, vault, rug); const warn = checks.filter((x) => !x.ok).length
  const shownV = scrub ? scrub.v : c.mcap; const ch = chg ?? c.ch24 ?? 0
  const diff = shownV - shownV / (1 + ch / 100)
  const sp = p.solPrice || 0
  const mine = held > 0 ? valSol * sp : 0; const pnl = held > 0 && cost > 0 ? (valSol / cost - 1) * 100 : null; const pnlUsd = held > 0 && cost > 0 ? (valSol - cost) * sp : null
  const floorUsd = vault && held > 0 ? (held / (vault.supply || 1e9)) * vault.chest * 0.93 * sp : 0
  const up = ch >= 0
  return <div className="sc">
    <div className="sc-top">
      <button className="s-back" onClick={() => (history.length > 1 ? history.back() : p.go(''))} aria-label="Back">{Ic.back(20)}</button>
      <div className="sc-id"><Pfp c={c} /><b>{c.symbol}</b>{vault && <span className="sc-shield">{Ic.shield(13)}</span>}</div>
      <button className={'s-star' + (p.watch.includes(c.mint) ? ' on' : '')} onClick={() => { haptic(8); p.toggleWatch(c.mint) }} aria-label="Watch">{Ic.star(20, p.watch.includes(c.mint))}</button>
    </div>
    <div className="sc-head">
      <div className="sc-k">{scrub ? new Date(scrub.t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : <>{c.name} · market value</>}</div>
      <div className="sc-v num">{F(shownV)}</div>
      <div className={'sc-sub num ' + (up ? 'up' : 'dn')}>{up ? '▲' : '▼'} {F(Math.abs(diff))} ({Math.abs(ch).toFixed(1)}%) <span className="dim">{RANGES[range]?.label || ''}</span></div>
    </div>
    <AreaChart coin={c} solPrice={sp} range={range} onRange={setRange} height={176} onChange={(x, s) => { setChg(x); setScrub(s) }} />
    {held > 0 && <div className="sc-pos">
      <div><div className="sc-k">Your position</div><b className="num">${S(mine, 2)}</b></div>
      {pnl != null && <div className={'sc-pnl num ' + (pnl >= 0 ? 'up' : 'dn')}><b>{pnl >= 0 ? '+' : '−'}${S(Math.abs(pnlUsd || 0), 2)}</b><span>{pnl >= 0 ? '+' : '−'}{Math.abs(pnl).toFixed(1)}%</span></div>}
      {vault && <div className="sc-floor"><div className="sc-k">Your chest share</div><b className="num">${S(floorUsd, 2)}</b></div>}
    </div>}
    <section className="grp sc-grp">
      {vault ? <button className="cr sc-chest" onClick={() => open('chest')}>
        <Ring frac={L.frac} size={48} stroke={4}>{Ic.chest(20)}</Ring>
        <span className="cr-mid"><span className="cr-name">Safety chest</span><span className="cr-sub num"><b className="gold">{S(vault.chest, 2)} SOL</b> <span className="cr-dim">· ${S(vault.chest * sp, 0)}</span></span></span>
        <span className="cr-right"><b className="num">{L.next ? F(L.next) : 'Done'}</b><span className="dim num">{L.next ? `${Math.round(L.frac * 100)}% to goal` : 'all goals hit'}</span></span>
        <span className="cr-chev">{Ic.chev(16)}</span>
      </button> : c.venue === 'launchlab' && (c.raw as any)?.ours && (c.raw as any)?.creator && (c.raw as any).creator === p.desk?.owner && p.onAttach
        ? <button className="cr sc-chest" onClick={() => { haptic(8); p.onAttach(c) }}><span className="sc-ic ok">{Ic.chest(18)}</span><span className="cr-mid"><span className="cr-name">Switch on your chest · free</span><span className="cr-sub">You launched it here: the 2% fee fills it from the next trade</span></span><span className="cr-chev">{Ic.chev(16)}</span></button>
        : <div className="cr sc-nochest"><span className="sc-warn-ic">{Ic.alert(18)}</span><span className="cr-mid"><span className="cr-name">No chest on this coin</span><span className="cr-sub">Nothing defends the price. Trade with care.</span></span></div>}
      <button className="cr" onClick={() => open('safety')}>
        <span className={'sc-ic ' + (warn ? 'warn' : 'ok')}>{warn ? Ic.alert(18) : Ic.check(18)}</span>
        <span className="cr-mid"><span className="cr-name">{warn ? `${warn} thing${warn > 1 ? 's' : ''} to know` : 'Safety checks passed'}</span><span className="cr-sub">{checks.length - warn} of {checks.length} checks look good</span></span>
        <span className="cr-chev">{Ic.chev(16)}</span>
      </button>
      <button className="cr" onClick={() => open('about')}>
        <span className="sc-ic">{Ic.info(18)}</span>
        <span className="cr-mid"><span className="cr-name">About {c.symbol}</span><span className="cr-sub num">{F(c.vol24)} traded today · {c.createdAt ? ago(c.createdAt) + ' old' : 'new'}</span></span>
        <span className="cr-chev">{Ic.chev(16)}</span>
      </button>
    </section>
    {info === 'chest' && <InfoSheet title="Safety chest" onClose={() => setInfo(null)}><ProgressCard coin={c} vault={vault} solPrice={sp} held={held} simple /></InfoSheet>}
    {info === 'safety' && <InfoSheet title="Safety check" onClose={() => setInfo(null)}>
      <div className="is-list">{checks.map((x, i) => <div key={i} className={'is-row ' + (x.ok ? 'ok' : 'warn')}><span className="sc-ic">{x.ok ? Ic.check(16) : Ic.alert(16)}</span><span>{x.text}</span></div>)}</div>
      <div className="dim is-note">Checked live from the chain. A chest can't stop every drop, but it buys the dips and nobody can withdraw it.</div>
    </InfoSheet>}
    {info === 'about' && <InfoSheet title={<>About {c.symbol}</>} onClose={() => setInfo(null)}>
      <div className="is-list kvs">
        <div className="kv"><span>Price</span><b className="num">{px(c.priceUsd)}</b></div>
        <div className="kv"><span>Pool</span><b className="num">{F(c.liq)}</b></div>
        <div className="kv"><span>Traded today</span><b className="num">{F(c.vol24)}</b></div>
        <div className="kv"><span>Buys / sells today</span><b className="num">{c.buys24} / {c.sells24}</b></div>
        <div className="kv"><span>Age</span><b>{c.createdAt ? ago(c.createdAt) : '—'}</b></div>
        <div className="kv"><span>Contract</span><b><Addr a={c.mint} /></b></div>
      </div>
      <div className="dim is-note">Want the full chart, the desk and auto-sell? Switch to Pro mode in More.</div>
    </InfoSheet>}
    {!sheet && !info && <ActionBar held={held} onBuy={() => setSheet('buy')} onSell={() => setSheet('sell')} onQuick={quickBuy} />}
    {sheet && <TradeSheet coin={c} side={sheet} solPrice={sp} held={held} balSol={p.sol} connected={p.connected} busy={p.busy} onClose={() => setSheet(null)} needWallet={p.needWallet} buy={(sol) => p.onBuy(c, sol)} sell={(f) => p.onSell(c, f)} vault={vault} />}
  </div>
}
