import React, { useEffect, useMemo, useState } from 'react'
import { useFlash } from '../hooks'
import * as D from '../lib/dex'
import { Pfp, Ch, Mc, Status, Addr } from './ui'
import { F, S, ago, pct } from '../lib/fmt'
import { deskOpen, deskMinBlock } from '../lib/protocol'
import type { Holding } from '../lib/rpc'
import type { Lot, Fill } from '../lib/positions'
import type { TradeEvt } from '../lib/pumpportal'
import { CoinDesk, CoinVault, VaultExtras, VaultDeposit, SellBlock, type DeskCtx } from './Desk'
import { loadOrders, addOrder, removeOrder } from '../lib/orders'
import Chart from './Chart'
import { rugCheck, type RugCheck } from '../lib/rpc'
import { classify, featsFromCoin, labelTone } from '../lib/signal'
import { useConnection } from '@solana/wallet-adapter-react'
import * as K from '../lib/desk'

type Props = { mint: string; coin?: D.Coin; solPrice: number; holding?: Holding; lot?: Lot; sol: number | null; connected: boolean; busy: string
  onBuy: (c: D.Coin, sol: number) => void; onSell: (c: D.Coin, frac: number) => Promise<void>; quickSol: number; watch: string[]; toggleWatch: (m: string) => void; needWallet: () => void; trades: TradeEvt[]; subscribe: (m: string[]) => void; desk: DeskCtx; deskTick: number; vaultV: number; onRenounce: (v: K.VaultPub) => void; onRedeem: (c: D.Coin, tokens: number, decimals: number) => void; onDeposit: (v: K.VaultPub, sol: number, tokens: number, decimals: number) => void; onMode: (v: K.VaultPub, m: 'floor' | 'mm', c: number) => void; onSwitch: (from: D.Coin, toMint: string, toSymbol: string) => void; go: (p: string) => void; ordersV: number; bumpOrders: () => void; fills: Fill[] }

function Orders({ c, owner, held, ordersV, bump }: { c: D.Coin; owner: string; held: number; ordersV: number; bump: () => void }) {
  const [type, setType] = useState<'tp' | 'sl'>('tp'); const [mult, setMult] = useState(2); const [frac, setFrac] = useState(0.5)
  const mine = loadOrders(owner).filter((o) => o.mint === c.mint)
  const trig = type === 'tp' ? c.priceUsd * mult : c.priceUsd * (1 - (mult - 1 > 0.9 ? 0.5 : Math.min(0.9, (mult - 1) / 2)))
  return <div style={{ borderTop: '1px solid var(--line)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
    <div className="row"><div className="lbl" style={{ margin: 0 }}>Auto-sell orders</div><span className="sp" /><div className="seg"><button className={type === 'tp' ? 'on' : ''} onClick={() => setType('tp')}>Take profit</button><button className={type === 'sl' ? 'on' : ''} onClick={() => setType('sl')}>Stop loss</button></div></div>
    <div className="presets">{(type === 'tp' ? [1.5, 2, 3, 5] : [1.2, 1.4, 1.6, 2.8]).map((m) => <button key={m} className={mult === m ? 'on' : ''} onClick={() => setMult(m)}>{type === 'tp' ? m + '×' : '−' + Math.round(Math.min(90, (m - 1) * 50)) + '%'}</button>)}</div>
    <div className="kv"><span>Trigger</span><b className="num">${trig < 0.01 ? trig.toPrecision(3) : trig.toFixed(4)} · sell {Math.round(frac * 100)}%</b></div>
    <input type="range" className="slider" min={10} max={100} value={frac * 100} onChange={(e) => setFrac(+e.target.value / 100)} />
    <button className="btn" disabled={!owner || !held || !c.priceUsd} onClick={() => { addOrder(owner, { mint: c.mint, symbol: c.symbol, type, trigUsd: trig, frac }); bump() }}>Arm {type === 'tp' ? 'take profit' : 'stop loss'}</button>
    {mine.map((o) => <div className="kv" key={o.id}><span><span className={o.type === 'tp' ? 'up' : 'dn'}>{o.type.toUpperCase()}</span> @ ${o.trigUsd < 0.01 ? o.trigUsd.toPrecision(3) : o.trigUsd.toFixed(4)} · {Math.round(o.frac * 100)}%</span><button className="btn sm ghost" onClick={() => { removeOrder(owner, o.id); bump() }}>cancel</button></div>)}
    <div className="nm">Fires from this browser while a tab is open.</div>
  </div>
}
export default function CoinPage(p: Props) {
  const [coin, setCoin] = useState<D.Coin | undefined>(p.coin)
  const [side, setSide] = useState<'buy' | 'sell'>('buy'); const [amt, setAmt] = useState(String(p.quickSol)); const [frac, setFrac] = useState(1)
  const flash = useFlash(coin?.priceUsd); const mountedAt = useMemo(() => Date.now(), [])
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
        if (best) { const take = Math.min(best.sol, sizeSol); setRoute(`Routing ${S(take, 2)} SOL via desk at −${(best.discBps / 100).toFixed(1)}% (chart would cost −${(impact / 100).toFixed(1)}%)`); await p.desk.takeBid(best.id, take < best.sol - 1e-9 ? +take.toFixed(4) : undefined); const rest = sizeSol - take; if (rest > 0.05) { setRoute(`Desk filled · ${S(rest, 2)} SOL left → pool`); await p.onSell(cc, Math.min(1, rest / Math.max(1e-9, pxSol * held0))) } else setRoute('Filled entirely on the desk · zero chart impact'); return }
        if (impact > 300) setRoute(`No desk bid beats −${(impact / 100).toFixed(1)}% chart impact — use "Sell a block" to shop one`)
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
    f(); const i = setInterval(f, 4000); return () => { on = false; clearInterval(i) }
  }, [p.mint])
  const c = coin
  if (!c) return <div className="empty">Loading {p.mint.slice(0, 8)}… <div className="nm" style={{ marginTop: 8 }}>Brand-new launches can take ~1 min to be indexed. You can still trade below once the pair appears.</div></div>
  const held = p.holding ? p.holding.amount : 0
  const valUsd = held * c.priceUsd; const valSol = p.solPrice ? valUsd / p.solPrice : 0
  const cost = p.lot?.costSol || 0; const pnl = cost ? valSol - cost : 0
  const heldMin = p.lot ? (Date.now() - p.lot.t) / 60000 : 999
  const sellSol = valSol * frac; const sellProfit = cost ? (valSol - cost) * frac : 0
  const n = parseFloat(amt) || 0
  const myTrades = p.trades.filter((t) => t.mint === p.mint)
  const stake = c.onCurve ? 0 : 0
  return <>
    {sb && <SellBlock mint={p.mint} symbol={c.symbol} holdingUi={held} priceSol={c.raw?.priceNative ? +c.raw.priceNative : (p.solPrice ? c.priceUsd / p.solPrice : 0)} liqSol={c.depthSol || (p.solPrice ? c.liq / 2 / p.solPrice : 0)} owner={p.desk.owner} connected={p.connected} busy={p.busy} onClose={() => setSb(false)} takeBid={p.desk.takeBid} onPoolSell={(f) => p.onSell(c, f)} needWallet={p.needWallet} />}
    <div className="coinhd"><Pfp c={c} lg /><div><h1>{c.symbol} <span className="nm" style={{ fontSize: 13 }}>{c.name}</span> <Status c={c} /></h1>
      <div className="meta"><Addr a={c.mint} /><span>{c.createdAt ? ago(c.createdAt) + ' old' : ''}</span>{c.url && <a href={c.url} target="_blank" rel="noreferrer">dexscreener ↗</a>}{c.venue === 'launchlab' ? <a href={`https://raydium.io/launchpad/token/?mint=${c.mint}`} target="_blank" rel="noreferrer">raydium ↗</a> : <a href={`https://pump.fun/coin/${c.mint}`} target="_blank" rel="noreferrer">pump.fun ↗</a>}</div></div>
      <span className="sp" />{vault ? <span className="tag live" style={{ marginRight: 8 }}>VAULTED</span> : vault === null && !c.onCurve ? <button className="btn sm pri" style={{ marginRight: 8 }} onClick={() => p.go('vault/import/' + c.mint)}>+ Add vault</button> : null}<button className="btn sm" onClick={() => p.toggleWatch(c.mint)}>{p.watch.includes(c.mint) ? '★ Watching' : '☆ Watch'}</button></div>
    <div className="tiles compact" style={{ marginBottom: 10 }}>
      <div className="tile"><div className="l">Mcap</div><div className="v"><Mc v={c.mcap} /></div><div className="s"><Ch v={c.ch24} /> 24h</div></div>
      <div className={'tile ' + flash}><div className="l">Price</div><div className="v num">${c.priceUsd < 0.01 ? c.priceUsd.toPrecision(3) : c.priceUsd.toFixed(4)}</div><div className="s"><Ch v={c.ch1h} /> 1h · <Ch v={c.ch5m} /> 5m</div></div>
      <div className="tile"><div className="l">You</div><div className="v num">{held ? S(valSol) + ' SOL' : '—'}{cost ? <span className={'num ' + (pnl >= 0 ? 'up' : 'dn')} style={{ fontSize: 12, marginLeft: 8 }}>{pnl >= 0 ? '+' : ''}{((pnl / cost) * 100).toFixed(0)}%</span> : null}</div><div className="s num">{held ? `${held.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${c.symbol}` : 'not holding'}{cost ? <> · <span className={pnl >= 0 ? 'up' : 'dn'}>{pnl >= 0 ? '+' : ''}{S(pnl)} SOL (${S(Math.abs(pnl) * p.solPrice, 0)})</span></> : null}</div></div>
      <div className="tile"><div className="l">Liq</div><div className="v"><Mc v={c.liq} /></div><div className="s">{c.venue === 'launchlab' ? `our curve · ${((c.raw as any)?.soldPct ?? 0).toFixed(1)}% sold · graduates at 85 SOL` : c.onCurve ? 'bonding curve' : c.dex}</div></div>
      <div className="tile"><div className="l">Volume 24h</div><div className="v"><Mc v={c.vol24} /></div><div className="s num"><span className="up">{c.buys24}</span> / <span className="dn">{c.sells24}</span> txns</div></div>
    </div>
    {(() => { const sg = classify(featsFromCoin(c, rug || (vault as any)?.holders || null, !!vault)); return <div className="card" style={{ marginBottom: 10, padding: '8px 12px' }}><div className="row" style={{ gap: 8, flexWrap: 'wrap', fontSize: 12 }}><span className={'tag ' + labelTone(sg.label)}>{sg.label}</span><span className="dim" style={{ flex: 1, minWidth: 120, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sg.reasons.slice(0, 2).join(' · ')}</span>{vi?.vamp && <span className="tag pre" title={vi.vamp.reasons.join(' · ')}>VAMP of {vi.vamp.originalSymbol} · {vi.vamp.reasons[0]}</span>}{vi?.vamp && <button className="btn sm pri" disabled={!!p.busy || !held} onClick={() => p.onSwitch(c, vi.vamp!.original, vi.vamp!.originalSymbol)}>Switch → {vi.vamp.originalSymbol} (original)</button>}{!vi?.vamp && vi?.copies?.length ? <span className="tag live" title={vi.copies.map((x) => x.symbol).join(', ')}>original · {vi.copies.length} cop{vi.copies.length === 1 ? 'y' : 'ies'} detected</span> : null}{rug && <>{rug.mintAuthority && <span className="tag pre">MINT AUTHORITY ON</span>}{rug.freezeAuthority && <span className="tag pre">FREEZE ON</span>}{rug.top1Pct > 20 && <span className="tag pre">top holder {rug.top1Pct.toFixed(0)}%</span>}{rug.top10Pct > 60 && <span className="tag pre">top 10 {rug.top10Pct.toFixed(0)}%</span>}{vault && <span className="tag live">vault {(rug.holders.find((h) => h.address === vault.pub)?.pct || 0).toFixed(1)}%</span>}</>}{fam?.members && fam.members.length > 1 && (() => { const leader = fam.members.find((m) => m.leader); return leader && leader.mint !== p.mint ? <button className="btn sm pri" disabled={!!p.busy || !held} onClick={() => p.onSwitch(c, leader.mint, leader.symbol)}>Switch → {leader.symbol} (leader)</button> : <span className="tag live">LEADER</span> })()}</div></div> })()}
    <div className="lay">
      <div>
        <div className="row" style={{ marginBottom: 10 }}><span className="seg"><button className={tab === 'trades' ? 'on' : ''} onClick={() => setTab('trades')}>Chart</button><button className={tab === 'desk' ? 'on' : ''} onClick={() => setTab('desk')}>Desk / OTC</button><button className={tab === 'vault' ? 'on' : ''} onClick={() => setTab('vault')}>Vault {vault && <span className="tag live" style={{ marginLeft: 4 }}>ON</span>}</button><button className={tab === 'protocol' ? 'on' : ''} onClick={() => setTab('protocol')}>Rules</button></span></div>
        {tab === 'trades' && <Chart coin={c} solPrice={p.solPrice} vault={vault} fills={p.fills} lot={p.lot} orders={loadOrders(p.desk.owner)} trades={p.trades} owner={p.desk.owner} />}
        <div className="card" style={{ marginTop: tab === 'trades' ? 12 : 0 }}>
          {tab === 'trades' ? <div className="feed">{myTrades.map((t, i) => <div className={'it' + (t.ts > mountedAt ? ' new' : '')} key={t.ts + ':' + t.trader + ':' + i}><span className={t.txType === 'buy' ? 'up' : 'dn'} style={{ width: 40, fontWeight: 600 }}>{t.txType.toUpperCase()}</span><span className="num" style={{ width: 90 }}>{S(t.sol, 3)} SOL</span><span className="num dim" style={{ width: 110 }}>{F(t.mcapSol * p.solPrice)} mc</span><span className="dim num" style={{ flex: 1 }}>{t.trader.slice(0, 4)}…{t.trader.slice(-4)}</span><span className="nm">{ago(t.ts)}</span></div>)}
            {!myTrades.length && <div className="empty" style={{ padding: 24 }}>{c.venue === 'launchlab' ? 'Trades on our launchpad show in the Vault tab tape' : c.onCurve ? 'Streaming curve trades… (pump.fun live feed)' : 'Live trade stream covers bonding-curve coins. Graduated: see dexscreener ↗'}</div>}</div>
            : tab === 'desk' ? <CoinDesk mint={p.mint} symbol={c.symbol} d={{ ...p.desk, onShop: () => setSb(true), needWallet: p.needWallet }} key={p.deskTick} />
            : tab === 'vault' ? <><CoinVault mint={p.mint} v={vault} isDev={!!vault && vault.dev === p.desk.owner} onRenounce={() => vault && p.onRenounce(vault)} solPrice={p.solPrice} onMode={(m, c) => vault && p.onMode(vault, m, c)} />{vault && <div className="panel" style={{ paddingTop: 0 }}><VaultDeposit v={vault} owner={p.desk.owner} holdingUi={held} busy={p.busy} connected={p.connected} needWallet={p.needWallet} onDeposit={(s, t) => p.onDeposit(vault, s, t, p.holding?.decimals ?? 6)} /><VaultExtras mint={p.mint} v={vault} holdingUi={held} decimals={p.holding?.decimals ?? 6} connected={p.connected} busy={p.busy} onRedeem={(t) => p.onRedeem(c, t, p.holding?.decimals ?? 6)} go={p.go} solPrice={p.solPrice} needWallet={p.needWallet} /></div>}</>
            : <div className="panel" style={{ gap: 8 }}>
              <div className="kv"><span>Desk</span><b>{deskOpen(!c.onCurve, c.mcap) ? `open · bids 1–15% under · sell offers ±15% · min block ${S(deskMinBlock(c.liq / 2 / (p.solPrice || 1)), 2)} SOL · partial fills` : 'closed until graduated + $100K mc'}</b></div>
              <div className="kv"><span>Vault</span><b>{vault ? `${S(vault.chest)} SOL chest · ${vault.pct}% supply target · dip buys ≤40%/crash · counters stretched buys · never withdraws` : 'no vault on this coin'}</b></div>
              <div className="kv"><span>Burn-to-redeem</span><b>{vault ? 'pro-rata on chest · 7% haircut · max 25%/redeem' : '—'}</b></div>
              <div className="kv"><span>Copies</span><b>{vault ? (vault.copyOf ? 'copy · half of cut streams to original' : `original · ${vault.copies?.length || 0} copies`) : '—'}</b></div>
              <div className="kv"><span>Holding</span><b className="num">{p.lot ? `${heldMin.toFixed(0)} min · cost ${S(p.lot.costSol)} SOL` : 'none'}</b></div>
            </div>}
        </div>
      </div>
      <div className="card"><div className="panel">
        <div className="seg" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}><button className={side === 'buy' ? 'on' : ''} onClick={() => setSide('buy')}>Buy</button><button className={side === 'sell' ? 'on' : ''} onClick={() => setSide('sell')}>Sell</button></div>
        {side === 'buy' ? <>
          <div className="presets lg">{[0.1, 0.25, 0.5, 1].map((v) => <button key={v} className={n === v ? 'on' : ''} onClick={() => setAmt(String(v))}>{v} SOL</button>)}</div>
          <div className="inp"><input value={amt} onChange={(e) => setAmt(e.target.value)} inputMode="decimal" placeholder="0.0" /><span>SOL</span></div>
          <div className="tradekv">
            <div className="kv"><span>You get</span><b className="num" style={{ fontSize: 16 }}>{c.priceUsd ? ((n * p.solPrice) / c.priceUsd).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'} {c.symbol}</b></div>
            <div className="kv"><span>For</span><b className="num">{S(n)} SOL · ${S(n * p.solPrice, 2)}</b></div>
            <div className="kv"><span>Balance</span><b className="num">{p.sol == null ? '—' : S(p.sol) + ' SOL'}</b></div>
          </div>
          <button className="btn pri big" disabled={!!p.busy || (p.connected && (n <= 0 || (p.sol != null && n > p.sol - 0.005)))} onClick={() => p.connected ? p.onBuy(c, n) : p.needWallet()}>{p.busy || (!p.connected ? 'Connect wallet' : `Buy ${c.symbol}`)}</button>
        </> : <>
          <div className="presets lg">{[0.25, 0.5, 0.75, 1].map((v) => <button key={v} className={frac === v ? 'on' : ''} onClick={() => setFrac(v)}>{v * 100}%</button>)}</div>
          <input type="range" className="slider" min={1} max={100} value={Math.round(frac * 100)} onChange={(e) => setFrac(+e.target.value / 100)} />
          <div className="tradekv">
            <div className="kv"><span>You get</span><b className="num" style={{ fontSize: 16 }}>≈ {S(sellSol)} SOL · ${S(sellSol * p.solPrice, 2)}</b></div>
            <div className="kv"><span>Selling</span><b className="num">{(held * frac).toLocaleString(undefined, { maximumFractionDigits: 0 })} of {held ? held.toLocaleString(undefined, { maximumFractionDigits: 0 }) : 0} {c.symbol}</b></div>
            {cost > 0 && <div className="kv"><span>P&amp;L</span><b className={'num ' + (sellProfit >= 0 ? 'up' : 'dn')}>{sellProfit >= 0 ? '+' : ''}{S(sellProfit)} SOL</b></div>}
          </div>
          <button className="btn big sell" disabled={!!p.busy || (p.connected && !held)} onClick={() => p.connected ? smartSell() : p.needWallet()}>{p.busy || (!p.connected ? 'Connect wallet' : !held ? 'Nothing to sell' : `Sell ${Math.round(frac * 100)}%`)}</button>
          {route && <div className="nm">{route}</div>}
          {held > 0 && !c.onCurve && <button className="btn" style={{ width: '100%', fontSize: 12, fontWeight: 500 }} onClick={() => setSb(true)}>OTC · sell a block off-chart</button>}
          <Orders c={c} owner={p.desk.owner} held={held} ordersV={p.ordersV} bump={p.bumpOrders} />
        </>}

      </div></div>
    </div>
  </>
}
