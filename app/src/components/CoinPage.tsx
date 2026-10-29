import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useFlash } from '../hooks'
import * as D from '../lib/dex'
import { Pfp, Ch, Mc, Status, Addr } from './ui'
import { F, S, ago, pct, px } from '../lib/fmt'
import { deskOpen, deskMinBlock, LLCURVE } from '../lib/protocol'
import type { Holding } from '../lib/rpc'
import type { Lot, Fill } from '../lib/positions'
import type { TradeEvt } from '../lib/pumpportal'
import { CoinDesk, CoinVault, VaultExtras, VaultDeposit, SellBlock, type DeskCtx } from './Desk'
import { loadOrders, addOrder, removeOrder } from '../lib/orders'
import Chart from './Chart'
import { ProgressCard } from './Progress'
import { Safety, safetyChecks, USD_PRESETS } from './Simple'
import { AreaChart } from './AreaChart'
import { SimpleCoinView } from './SimpleCoin'
import { ActionBar, TradeSheet, haptic } from './Flow'
import { onToast } from '../lib/store'
import { confetti } from '../hooks'
import { coinBurst } from '../lib/fx'
import { rugCheck, type RugCheck } from '../lib/rpc'
import { classify, featsFromCoin, labelTone, labelText } from '../lib/signal'
import { useConnection } from '@solana/wallet-adapter-react'
import * as K from '../lib/desk'

type Props = { mint: string; coin?: D.Coin; solPrice: number; holding?: Holding; lot?: Lot; sol: number | null; connected: boolean; busy: string
  onBuy: (c: D.Coin, sol: number) => void; onSell: (c: D.Coin, frac: number) => Promise<void>; quickSol: number; watch: string[]; toggleWatch: (m: string) => void; needWallet: () => void; trades: TradeEvt[]; subscribe: (m: string[]) => void; desk: DeskCtx; deskTick: number; vaultV: number; onRenounce: (v: K.VaultPub) => void; onRedeem: (c: D.Coin, tokens: number, decimals: number) => void; onDeposit: (v: K.VaultPub, sol: number, tokens: number, decimals: number) => void; onMode: (v: K.VaultPub, m: 'floor' | 'mm', c: number) => void; onSwitch: (from: D.Coin, toMint: string, toSymbol: string) => void; go: (p: string) => void; ordersV: number; bumpOrders: () => void; fills: Fill[]; simple?: boolean }

function Orders({ c, owner, held, ordersV, bump }: { c: D.Coin; owner: string; held: number; ordersV: number; bump: () => void }) {
  const [type, setType] = useState<'tp' | 'sl'>('tp'); const [mult, setMult] = useState(2); const [frac, setFrac] = useState(0.5)
  const mine = loadOrders(owner).filter((o) => o.mint === c.mint)
  const trig = type === 'tp' ? c.priceUsd * mult : c.priceUsd * (1 - (mult - 1 > 0.9 ? 0.5 : Math.min(0.9, (mult - 1) / 2)))
  return <div style={{ borderTop: '1px solid var(--line)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
    <div className="row"><div className="lbl" style={{ margin: 0 }}>Sell automatically</div><span className="sp" /><div className="seg"><button className={type === 'tp' ? 'on' : ''} onClick={() => setType('tp')}>Take profit</button><button className={type === 'sl' ? 'on' : ''} onClick={() => setType('sl')}>Stop loss</button></div></div>
    <div className="presets">{(type === 'tp' ? [1.5, 2, 3, 5] : [1.2, 1.4, 1.6, 2.8]).map((m) => <button key={m} className={mult === m ? 'on' : ''} onClick={() => setMult(m)}>{type === 'tp' ? m + '×' : '−' + Math.round(Math.min(90, (m - 1) * 50)) + '%'}</button>)}</div>
    <div className="kv"><span>Trigger</span><b className="num">${trig < 0.01 ? trig.toPrecision(3) : trig.toFixed(4)} · sell {Math.round(frac * 100)}%</b></div>
    <input type="range" className="slider" min={10} max={100} value={frac * 100} onChange={(e) => setFrac(+e.target.value / 100)} />
    <button className="btn" disabled={!owner || !held || !c.priceUsd} onClick={() => { addOrder(owner, { mint: c.mint, symbol: c.symbol, type, trigUsd: trig, frac }); bump() }}>Arm {type === 'tp' ? 'take profit' : 'stop loss'}</button>
    {mine.map((o) => <div className="kv" key={o.id}><span><span className={o.type === 'tp' ? 'up' : 'dn'}>{o.type.toUpperCase()}</span> @ ${o.trigUsd < 0.01 ? o.trigUsd.toPrecision(3) : o.trigUsd.toFixed(4)} · {Math.round(o.frac * 100)}%</span><button className="btn sm ghost" onClick={() => { removeOrder(owner, o.id); bump() }}>cancel</button></div>)}
    <div className="nm">Only runs while this page is open in your browser.</div>
  </div>
}
export default function CoinPage(p: Props) {
  const [coin, setCoin] = useState<D.Coin | undefined>(p.coin)
  const [side, setSide] = useState<'buy' | 'sell'>('buy'); const [amt, setAmt] = useState(String(p.quickSol)); const [frac, setFrac] = useState(1)
  const flash = useFlash(coin?.priceUsd); const mountedAt = useMemo(() => Date.now(), [])
  // simple mode starts the buy box on $10 once the SOL price is known
  const usdInit = useRef(false); useEffect(() => { if (p.simple && p.solPrice && !usdInit.current) { usdInit.current = true; setAmt(String(+(10 / p.solPrice).toFixed(4))) } }, [p.simple, p.solPrice])
  const [tab, setTab] = useState<'trades' | 'desk' | 'vault' | 'protocol'>(location.hash.endsWith('/desk') ? 'desk' : location.hash.endsWith('/vault') ? 'vault' : 'trades');
  useEffect(() => { const f = () => { if (location.hash.endsWith('/desk')) setTab('desk'); else if (location.hash.endsWith('/vault')) setTab('vault') }; addEventListener('hashchange', f); return () => removeEventListener('hashchange', f) }, []); const [sb, setSb] = useState(false); const [route, setRoute] = useState('')
  // Smart sell: if a resting desk bid beats the chart impact and fits inside the size, take it first; the rest goes to the pool.
  const smartSell = async () => {
    const cc = coin!; const held0 = p.holding ? p.holding.amount : 0; const pxSol = cc.raw?.priceNative ? +cc.raw.priceNative : (p.solPrice ? cc.priceUsd / p.solPrice : 0); const liqSol = cc.depthSol || (p.solPrice ? cc.liq / 2 / p.solPrice : 0)
    const sizeSol = held0 * frac * pxSol; const impact = K.poolImpactBps(sizeSol, liqSol)
    try {
      if (!cc.onCurve && p.desk.deskUp && sizeSol > 0.2) {
        const book = await K.getBook(cc.mint, p.desk.owner)
        const minB = book.minBlock || 0
        const best = book.bids.filter((b) => !b.mine && b.restable && !b.away && b.discBps < impact && Math.min(b.sol, sizeSol) >= Math.min(b.sol, minB)).sort((a, b) => a.discBps - b.discBps)[0]
        if (best) { const take = Math.min(best.sol, sizeSol); setRoute(`Selling ${S(take, 2)} SOL to a buyer on the desk at −${(best.discBps / 100).toFixed(1)}% (selling on the chart would cost you −${(impact / 100).toFixed(1)}%)`); await p.desk.takeBid(best.id, take < best.sol - 1e-9 ? +take.toFixed(4) : undefined); const rest = sizeSol - take; if (rest > 0.05) { setRoute(`Desk took part of it · selling the last ${S(rest, 2)} SOL on the chart`); await p.onSell(cc, Math.min(1, rest / Math.max(1e-9, pxSol * held0))) } else setRoute('Sold to a desk buyer · the chart didn\'t move'); return }
        if (impact > 300) setRoute(`This sale moves the price −${(impact / 100).toFixed(1)}%. Try "Sell a big amount" below to find a buyer off the chart`)
      }
    } catch {}
    await p.onSell(cc, frac)
  }
  const [vault, setVault] = useState<K.VaultPub | null | undefined>(undefined)
  useEffect(() => { const f = () => K.vaultByMint(p.mint).then(setVault).catch(() => setVault(null)); f(); const i = setInterval(f, 8000); return () => clearInterval(i) }, [p.mint, p.vaultV])
  const { connection } = useConnection(); const [rug, setRug] = useState<RugCheck | null | undefined>(undefined); const [fam, setFam] = useState<K.Family | null>(null); const [vi, setVi] = useState<K.VampInfo | null>(null)
  useEffect(() => { K.family(p.mint).then(setFam).catch(() => setFam(null)); const f = () => K.vampFor(p.mint).then(setVi).catch(() => setVi(null)); f(); const i = setInterval(f, 30000); return () => clearInterval(i) }, [p.mint, p.vaultV])
  useEffect(() => { setRug(undefined); rugCheck(connection, p.mint, vault?.pub).then(setRug).catch(() => setRug(null)) }, [p.mint, vault?.pub])
  useEffect(() => { setCoin(p.coin) }, [p.coin])
  useEffect(() => {
    let on = true; p.subscribe([p.mint])
    // our launchpad first: the pool is the exact source and exists before any indexer has the coin
    const f = async () => {
      const [c, ll] = await Promise.all([D.tokenPairs(p.mint).catch(() => null), K.llPool(p.mint).catch(() => null)])
      if (!on) return
      if (ll && !ll.migrated) {
        const px = ll.priceSol * (p.solPrice || 0); const base: D.Coin = c || { mint: p.mint, symbol: vault?.symbol || p.mint.slice(0, 4), name: vault?.name || '', image: vault?.image, dex: 'launchlab', priceUsd: 0, mcap: 0, liq: 0, vol24: 0, vol1h: 0, ch1h: 0, ch24: 0, ch5m: 0, buys24: 0, sells24: 0, createdAt: 0, onCurve: true, depthSol: 0 }
        setCoin({ ...base, venue: 'launchlab', onCurve: true, dex: 'launchlab', priceUsd: px || base.priceUsd, mcap: px ? ll.priceSol * 1e9 * (p.solPrice || 0) : base.mcap, depthSol: ll.liqSol, liq: ll.liqSol * 2 * (p.solPrice || 0), pair: ll.poolId, raw: { ...(base.raw || ({} as any)), priceNative: String(ll.priceSol), soldPct: ll.soldPct } })
      } else if (c) setCoin(c)
    }
    // server pushes the exact pool price for vaulted coins on every tick — apply it the moment it lands, the 4s poll is the fallback
    const onPrice = (e: Event) => { const d = (e as CustomEvent).detail; if (!on || d.mint !== p.mint || !d.priceSol) return; setCoin((c) => c ? { ...c, priceUsd: d.priceSol * (p.solPrice || 0) || c.priceUsd, mcap: d.mcapUsd || c.mcap, depthSol: d.liqSol || c.depthSol, raw: { ...(c.raw || ({} as any)), priceNative: String(d.priceSol) } } : c) }
    K.bookBus.addEventListener('price', onPrice)
    f(); const i = setInterval(f, 4000); return () => { on = false; clearInterval(i); K.bookBus.removeEventListener('price', onPrice) }
  }, [p.mint])
  const [sheet, setSheet] = useState<null | 'buy' | 'sell'>(null); const [range, setRange] = useState('1D'); const [sTab, setSTab] = useState<'chest' | 'safety' | 'about'>('chest')
  const quickBuy = async () => {
    if (!coin || !p.solPrice) return; if (!p.connected) return p.needWallet()
    let ok = false; const off = onToast((t) => { if (t.kind === 'ok' && /^Bought\b/.test(t.title)) ok = true })
    try { await p.onBuy(coin, +(10 / p.solPrice).toFixed(4)) } finally { off() }
    if (ok) { haptic([20, 40, 60]); coinBurst(innerWidth / 2, innerHeight - 90, 12) }
  }
  const c = coin
  const tabNow = p.simple && (tab === 'desk' || tab === 'protocol') ? 'trades' : tab
  if (!c) return <div className="empty">Loading {p.mint.slice(0, 8)}… <div className="nm" style={{ marginTop: 8 }}>Brand-new coins can take about a minute to show up.</div></div>
  const held = p.holding ? p.holding.amount : 0
  const valUsd = held * c.priceUsd; const valSol = p.solPrice ? valUsd / p.solPrice : 0
  const cost = p.lot?.costSol || 0; const pnl = cost ? valSol - cost : 0
  const heldMin = p.lot ? (Date.now() - p.lot.t) / 60000 : 999
  const sellSol = valSol * frac; const sellProfit = cost ? (valSol - cost) * frac : 0
  const n = parseFloat(amt) || 0
  const myTrades = p.trades.filter((t) => t.mint === p.mint)
  const stake = c.onCurve ? 0 : 0
  // simple mode: one calm screen — who, how much it's worth, the chart, the chest at a glance, then the action bar. Details are one tap away.
  if (p.simple) return <SimpleCoinView c={c} vault={vault} rug={rug} held={held} valSol={valSol} cost={cost} p={p} range={range} setRange={setRange} tab={sTab} setTab={setSTab} sheet={sheet} setSheet={setSheet} quickBuy={quickBuy} />
  return <>
    {sb && <SellBlock mint={p.mint} symbol={c.symbol} holdingUi={held} priceSol={c.raw?.priceNative ? +c.raw.priceNative : (p.solPrice ? c.priceUsd / p.solPrice : 0)} liqSol={c.depthSol || (p.solPrice ? c.liq / 2 / p.solPrice : 0)} owner={p.desk.owner} connected={p.connected} busy={p.busy} onClose={() => setSb(false)} takeBid={p.desk.takeBid} onPoolSell={(f) => p.onSell(c, f)} needWallet={p.needWallet} />}
    <div className="coinhd">{p.simple && <button className="s-back" onClick={() => (history.length > 1 ? history.back() : p.go(''))} aria-label="Back"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg></button>}<Pfp c={c} lg /><div><h1>{c.symbol} <span className="nm" style={{ fontSize: 13 }}>{c.name}</span> {!p.simple && <Status c={c} />}</h1>
      <div className="meta"><Addr a={c.mint} /><span>{c.createdAt ? ago(c.createdAt) + ' old' : ''}</span>{!p.simple && c.url && <a href={c.url} target="_blank" rel="noreferrer">dexscreener ↗</a>}{!p.simple && (c.venue === 'launchlab' ? <a href={`https://raydium.io/launchpad/token/?mint=${c.mint}`} target="_blank" rel="noreferrer">raydium ↗</a> : <a href={`https://pump.fun/coin/${c.mint}`} target="_blank" rel="noreferrer">pump.fun ↗</a>)}</div></div>
      <span className="sp" />{vault ? null : vault === null && !c.onCurve ? <button className="btn sm pri" style={{ marginRight: 8 }} onClick={() => p.go('vault/import/' + c.mint)}>+ Add vault</button> : null}{p.simple ? <button className={'s-star' + (p.watch.includes(c.mint) ? ' on' : '')} onClick={() => p.toggleWatch(c.mint)} aria-label={p.watch.includes(c.mint) ? 'Watching' : 'Watch'}>{p.watch.includes(c.mint) ? '★' : '☆'}</button> : <button className="btn sm" onClick={() => p.toggleWatch(c.mint)}>{p.watch.includes(c.mint) ? '★ Watching' : '☆ Watch'}</button>}</div>
    {p.simple && <div className="s-price">
      <div><div className="s-price-v">{px(c.priceUsd)}</div><div className="s-price-s"><span className={'s-chg ' + ((c.ch1h || 0) >= 0 ? 'up' : 'dn')}>{(c.ch1h || 0) >= 0 ? '+' : '−'}{Math.abs(c.ch1h || 0).toFixed(1)}%</span> this hour · worth {F(c.mcap)}</div></div>
      <div className="s-price-own"><div className="nm">You own</div><b className="num">{held ? (p.solPrice ? '$' + S(valSol * p.solPrice, 2) : S(valSol) + ' SOL') : '—'}</b></div>
    </div>}
    {!p.simple && <div className="tiles compact" style={{ marginBottom: 10 }}>
      <div className="tile" title="what the whole coin is worth"><div className="l">Value</div><div className="v"><Mc v={c.mcap} /></div><div className="s"><Ch v={c.ch24} /> 24h</div></div>
      <div className={'tile ' + flash}><div className="l">Price</div><div className="v num">${c.priceUsd < 0.01 ? c.priceUsd.toPrecision(3) : c.priceUsd.toFixed(4)}</div><div className="s"><Ch v={c.ch1h} /> 1h · <Ch v={c.ch5m} /> 5m</div></div>
      <div className="tile"><div className="l">Your coins</div><div className="v num">{held ? (p.simple && p.solPrice ? '$' + S(valSol * p.solPrice, 2) : S(valSol) + ' SOL') : (p.simple ? <span style={{ fontSize: 14 }}>nothing yet</span> : '—')}{cost ? <span className={'num ' + (pnl >= 0 ? 'up' : 'dn')} style={{ fontSize: 12, marginLeft: 8 }}>{pnl >= 0 ? '+' : ''}{((pnl / cost) * 100).toFixed(0)}%</span> : null}</div><div className="s num">{held ? `${held.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${c.symbol}` : 'you don\'t own any yet'}{cost ? <> · <span className={pnl >= 0 ? 'up' : 'dn'}>{pnl >= 0 ? '+' : ''}{S(pnl)} SOL (${S(Math.abs(pnl) * p.solPrice, 0)})</span></> : null}</div></div>
      {!p.simple && <>      <div className="tile" title="SOL in the trading pool: the bigger it is, the less one trade moves the price"><div className="l">Pool</div><div className="v"><Mc v={c.liq} /></div><div className="s">{c.venue === 'launchlab' ? `launching · ${((c.raw as any)?.soldPct ?? 0).toFixed(1)}% sold · moves to Raydium at ${LLCURVE.raiseSol} SOL raised` : c.onCurve ? 'still launching' : c.dex}</div></div>
      <div className="tile"><div className="l">Traded 24h</div><div className="v"><Mc v={c.vol24} /></div><div className="s num"><span className="up">{c.buys24}</span> / <span className="dn">{c.sells24}</span> buys / sells</div></div></>}
    </div>}
    {!p.simple && (() => { const sg = classify(featsFromCoin(c, rug || (vault as any)?.holders || null, !!vault)); return <div className="card" style={{ marginBottom: 10, padding: '8px 12px' }}><div className="row" style={{ gap: 8, flexWrap: 'wrap', fontSize: 12 }}><span className={'tag ' + labelTone(sg.label)}>{labelText(sg.label)}</span><span className="dim" style={{ flex: 1, minWidth: 120, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sg.reasons.slice(0, 2).join(' · ')}</span>{vi?.vamp && <span className="tag pre" title={vi.vamp.reasons.join(' · ')}>COPYCAT of {vi.vamp.originalSymbol} · {vi.vamp.reasons[0]}</span>}{vi?.vamp && <button className="btn sm pri" disabled={!!p.busy || !held} onClick={() => p.onSwitch(c, vi.vamp!.original, vi.vamp!.originalSymbol)}>Swap into the original {vi.vamp.originalSymbol}</button>}{!vi?.vamp && vi?.copies?.length ? <span className="tag live" title={vi.copies.map((x) => x.symbol).join(', ')}>the original · {vi.copies.length} copycat{vi.copies.length === 1 ? '' : 's'} found</span> : null}{rug && <>{rug.mintAuthority && <span className="tag pre" title="the creator can still print more of this coin">DEV CAN PRINT MORE</span>}{rug.freezeAuthority && <span className="tag pre" title="the creator can still freeze your coins">DEV CAN FREEZE</span>}{rug.top1Pct > 20 && <span className="tag pre">one wallet holds {rug.top1Pct.toFixed(0)}%</span>}{rug.top10Pct > 60 && <span className="tag pre">top 10 wallets hold {rug.top10Pct.toFixed(0)}%</span>}{vault && <span className="tag live">chest holds {(rug.holders.find((h) => h.address === vault.pub)?.pct || 0).toFixed(1)}%</span>}</>}{fam?.members && fam.members.length > 1 && (() => { const leader = fam.members.find((m) => m.leader); return leader && leader.mint !== p.mint ? <button className="btn sm pri" disabled={!!p.busy || !held} onClick={() => p.onSwitch(c, leader.mint, leader.symbol)}>Swap into {leader.symbol} (the leader)</button> : <span className="tag live">THE LEADER</span> })()}</div></div> })()}
    <div className="lay">
      <div>
        <div className="row" style={{ marginBottom: 10 }}><span className="seg"><button className={tab === 'trades' ? 'on' : ''} onClick={() => setTab('trades')}>Chart</button>{!p.simple && <button className={tab === 'desk' ? 'on' : ''} onClick={() => setTab('desk')}>Desk · big trades</button>}<button className={tab === 'vault' ? 'on' : ''} onClick={() => setTab('vault')}>{p.simple ? 'Chest' : 'Vault'} {vault && <span className="tag live" style={{ marginLeft: 4 }}>ON</span>}</button>{!p.simple && <button className={tab === 'protocol' ? 'on' : ''} onClick={() => setTab('protocol')}>Rules</button>}</span></div>
        {tabNow === 'trades' && (p.simple ? <AreaChart coin={c} solPrice={p.solPrice} range={range} onRange={setRange} /> : <Chart coin={c} solPrice={p.solPrice} vault={vault} fills={p.fills} lot={p.lot} orders={loadOrders(p.desk.owner)} trades={p.trades} owner={p.desk.owner} />)}
        {(tabNow !== 'trades' || myTrades.length > 0) && <div className="card" style={{ marginTop: tabNow === 'trades' ? 12 : 0 }}>
          {tabNow === 'trades' ? <div className="feed">{myTrades.map((t, i) => <div className={'it' + (t.ts > mountedAt ? ' new' : '')} key={t.ts + ':' + t.trader + ':' + i}><span className={t.txType === 'buy' ? 'up' : 'dn'} style={{ width: 40, fontWeight: 600 }}>{t.txType.toUpperCase()}</span><span className="num" style={{ width: 90 }}>{S(t.sol, 3)} SOL</span><span className="num dim" style={{ width: 110 }}>{F(t.mcapSol * p.solPrice)} mc</span><span className="dim num" style={{ flex: 1 }}>{t.trader.slice(0, 4)}…{t.trader.slice(-4)}</span><span className="nm">{ago(t.ts)}</span></div>)}
            </div>
            : tabNow === 'desk' ? <CoinDesk mint={p.mint} symbol={c.symbol} d={{ ...p.desk, onShop: () => setSb(true), needWallet: p.needWallet }} key={p.deskTick} />
            : tabNow === 'vault' ? <><CoinVault mint={p.mint} v={vault} isDev={!!vault && vault.dev === p.desk.owner} onRenounce={() => vault && p.onRenounce(vault)} solPrice={p.solPrice} onMode={(m, c) => vault && p.onMode(vault, m, c)} />{vault && vault.armed && <div className="panel" style={{ paddingTop: 0 }}>{!p.simple && <VaultDeposit v={vault} owner={p.desk.owner} holdingUi={held} busy={p.busy} connected={p.connected} needWallet={p.needWallet} onDeposit={(s, t) => p.onDeposit(vault, s, t, p.holding?.decimals ?? 6)} />}<VaultExtras simple={p.simple} mint={p.mint} v={vault} holdingUi={held} decimals={p.holding?.decimals ?? 6} connected={p.connected} busy={p.busy} onRedeem={(t) => p.onRedeem(c, t, p.holding?.decimals ?? 6)} go={p.go} solPrice={p.solPrice} needWallet={p.needWallet} /></div>}</>
            : <div className="panel" style={{ gap: 8 }}>
              <div className="kv"><span>Desk (big trades)</span><b>{deskOpen(!c.onCurve, c.mcap) ? `open · buyers can bid up to 15% under the price · smallest trade ${S(deskMinBlock(c.liq / 2 / (p.solPrice || 1)), 2)} SOL · can be filled in parts` : 'opens once the coin leaves its launch and is worth $100K'}</b></div>
              <div className="kv"><span>Chest</span><b>{vault ? `${S(vault.chest)} SOL · aims to hold ${vault.pct}% of the coins · uses at most 40% of the chest per crash · takes profit when the price runs · nobody can withdraw it` : 'this coin has no chest'}</b></div>
              <div className="kv"><span>Cash out at the floor</span><b>{vault ? 'trade your coins in for your share of the chest · 7% fee · up to 25% of the chest at a time' : '—'}</b></div>
              <div className="kv"><span>Copycats</span><b>{vault ? (vault.copyOf ? 'this is a copy · half of what it earns goes to the original' : `this is the original · ${vault.copies?.length || 0} copycats`) : '—'}</b></div>
              <div className="kv"><span>You've held</span><b className="num">{p.lot ? `${heldMin.toFixed(0)} min · paid ${S(p.lot.costSol)} SOL` : 'nothing yet'}</b></div>
            </div>}
        </div>}
      </div>
      <div>{!p.simple && <div className="card"><div className="panel">
        <div className="seg" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}><button className={side === 'buy' ? 'on' : ''} onClick={() => setSide('buy')}>Buy</button><button className={side === 'sell' ? 'on' : ''} onClick={() => setSide('sell')}>Sell</button></div>
        {side === 'buy' ? <>
          {p.simple && p.solPrice ? <>
            <div className="presets lg">{USD_PRESETS.map((u) => { const sol = +(u / p.solPrice).toFixed(4); return <button key={u} className={Math.abs(n - sol) < 1e-6 ? 'on' : ''} onClick={() => setAmt(String(sol))}>${u}</button> })}</div>
            <div className="s-usd">≈ {S(n, 3)} SOL · you can type any amount <input aria-label="amount in dollars" className="s-usd-in" value={n && p.solPrice ? String(Math.round(n * p.solPrice)) : ''} onChange={(e) => { const u = parseFloat(e.target.value) || 0; setAmt(String(+(u / p.solPrice).toFixed(4))) }} inputMode="decimal" placeholder="$" /></div>
          </> : <>
          <div className="presets lg">{[0.1, 0.25, 0.5, 1].map((v) => <button key={v} className={n === v ? 'on' : ''} onClick={() => setAmt(String(v))}>{v} SOL</button>)}</div>
          <div className="inp"><input value={amt} onChange={(e) => setAmt(e.target.value)} inputMode="decimal" placeholder="0.0" /><span>SOL</span></div>
          </>}
          <div className="tradekv">
            <div className="kv"><span>You get</span><b className="num" style={{ fontSize: 16 }}>{c.priceUsd ? ((n * p.solPrice) / c.priceUsd).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'} {c.symbol}</b></div>
            <div className="kv"><span>For</span><b className="num">{S(n)} SOL · ${S(n * p.solPrice, 2)}</b></div>
            <div className="kv"><span>Balance</span><b className="num">{p.sol == null ? '—' : S(p.sol) + ' SOL'}</b></div>
          </div>
          <button className="btn pri big" disabled={!!p.busy || (p.connected && (n <= 0 || (p.sol != null && n > p.sol - 0.005)))} onClick={() => p.connected ? p.onBuy(c, n) : p.needWallet()}>{p.busy || (!p.connected ? 'Connect wallet' : p.simple && p.solPrice ? `Buy $${Math.round(n * p.solPrice)} of ${c.symbol}` : `Buy ${c.symbol}`)}</button>
        </> : <>
          <div className="presets lg">{[0.25, 0.5, 0.75, 1].map((v) => <button key={v} className={frac === v ? 'on' : ''} onClick={() => setFrac(v)}>{v * 100}%</button>)}</div>
          <input type="range" className="slider" min={1} max={100} value={Math.round(frac * 100)} onChange={(e) => setFrac(+e.target.value / 100)} />
          <div className="tradekv">
            <div className="kv"><span>You get</span><b className="num" style={{ fontSize: 16 }}>≈ {S(sellSol)} SOL · ${S(sellSol * p.solPrice, 2)}</b></div>
            <div className="kv"><span>Selling</span><b className="num">{(held * frac).toLocaleString(undefined, { maximumFractionDigits: 0 })} of {held ? held.toLocaleString(undefined, { maximumFractionDigits: 0 }) : 0} {c.symbol}</b></div>
            {cost > 0 && <div className="kv"><span>Profit</span><b className={'num ' + (sellProfit >= 0 ? 'up' : 'dn')}>{sellProfit >= 0 ? '+' : ''}{S(sellProfit)} SOL</b></div>}
          </div>
          <button className="btn big sell" disabled={!!p.busy || (p.connected && !held)} onClick={() => p.connected ? smartSell() : p.needWallet()}>{p.busy || (!p.connected ? 'Connect wallet' : !held ? 'Nothing to sell' : `Sell ${Math.round(frac * 100)}%`)}</button>
          {route && <div className="nm">{route}</div>}
          {!p.simple && held > 0 && !c.onCurve && <button className="btn" style={{ width: '100%', fontSize: 12, fontWeight: 500 }} onClick={() => setSb(true)}>Sell a big amount without crashing the price</button>}
          {!p.simple && <Orders c={c} owner={p.desk.owner} held={held} ordersV={p.ordersV} bump={p.bumpOrders} />}
        </>}

      </div></div>}
      <ProgressCard coin={c} vault={vault} solPrice={p.solPrice} held={held} simple={p.simple} />{p.simple && <Safety checks={safetyChecks(c, vault, rug)} />}</div>
    </div>
    {p.simple && !sheet && <ActionBar held={held} onBuy={() => setSheet('buy')} onSell={() => setSheet('sell')} onQuick={quickBuy} />}
    {p.simple && sheet && <TradeSheet coin={c} side={sheet} solPrice={p.solPrice} held={held} balSol={p.sol} connected={p.connected} busy={p.busy} onClose={() => setSheet(null)} needWallet={p.needWallet} buy={(sol) => p.onBuy(c, sol)} sell={(f) => p.onSell(c, f)} />}
  </>
}
