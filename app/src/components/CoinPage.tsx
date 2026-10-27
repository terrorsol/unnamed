import React, { useEffect, useState } from 'react'
import * as D from '../lib/dex'
import { Pfp, Ch, Mc, Status, Addr } from './ui'
import { F, S, ago, pct } from '../lib/fmt'
import { flipFee, FLIP_WINDOW_MIN, vaultPct, deskOpen, deskMinBlock } from '../lib/protocol'
import type { Holding } from '../lib/rpc'
import type { Lot } from '../lib/positions'
import type { TradeEvt } from '../lib/pumpportal'
import { CoinDesk, CoinVault, VaultExtras, VaultDeposit, SellBlock, type DeskCtx } from './Desk'
import { loadOrders, addOrder, removeOrder } from '../lib/orders'
import * as K from '../lib/desk'

type Props = { mint: string; coin?: D.Coin; solPrice: number; holding?: Holding; lot?: Lot; sol: number | null; connected: boolean; busy: string
  onBuy: (c: D.Coin, sol: number) => void; onSell: (c: D.Coin, frac: number) => Promise<void>; quickSol: number; watch: string[]; toggleWatch: (m: string) => void; needWallet: () => void; trades: TradeEvt[]; subscribe: (m: string[]) => void; desk: DeskCtx; deskTick: number; vaultV: number; onRenounce: (v: K.VaultPub) => void; onRedeem: (c: D.Coin, tokens: number, decimals: number) => void; onDeposit: (v: K.VaultPub, sol: number, tokens: number, decimals: number) => void; go: (p: string) => void; ordersV: number; bumpOrders: () => void }

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
  const [tab, setTab] = useState<'trades' | 'desk' | 'vault' | 'protocol'>('trades'); const [sb, setSb] = useState(false)
  const [vault, setVault] = useState<K.VaultPub | null | undefined>(undefined)
  useEffect(() => { const f = () => K.vaultByMint(p.mint).then(setVault).catch(() => setVault(null)); f(); const i = setInterval(f, 8000); return () => clearInterval(i) }, [p.mint, p.vaultV])
  useEffect(() => { setCoin(p.coin) }, [p.coin])
  useEffect(() => {
    let on = true; p.subscribe([p.mint])
    const f = () => D.tokenPairs(p.mint).then((c) => on && c && setCoin(c)).catch(() => {})
    f(); const i = setInterval(f, 8000); return () => { on = false; clearInterval(i) }
  }, [p.mint])
  const c = coin
  if (!c) return <div className="empty">Loading {p.mint.slice(0, 8)}… <div className="nm" style={{ marginTop: 8 }}>Brand-new launches can take ~1 min to be indexed. You can still trade below once the pair appears.</div></div>
  const held = p.holding ? p.holding.amount : 0
  const valUsd = held * c.priceUsd; const valSol = p.solPrice ? valUsd / p.solPrice : 0
  const cost = p.lot?.costSol || 0; const pnl = cost ? valSol - cost : 0
  const heldMin = p.lot ? (Date.now() - p.lot.t) / 60000 : 999
  const sellSol = valSol * frac; const sellProfit = cost ? (valSol - cost) * frac : 0
  const fee = flipFee(sellProfit, heldMin)
  const n = parseFloat(amt) || 0
  const myTrades = p.trades.filter((t) => t.mint === p.mint)
  const stake = c.onCurve ? 0 : 0
  return <>
    {sb && <SellBlock mint={p.mint} symbol={c.symbol} holdingUi={held} priceSol={c.raw?.priceNative ? +c.raw.priceNative : (p.solPrice ? c.priceUsd / p.solPrice : 0)} liqSol={(c.raw?.liquidity as any)?.quote || (p.solPrice ? c.liq / 2 / p.solPrice : 0)} owner={p.desk.owner} connected={p.connected} busy={p.busy} onClose={() => setSb(false)} takeBid={p.desk.takeBid} onPoolSell={(f) => p.onSell(c, f)} needWallet={p.needWallet} />}
    <div className="coinhd"><Pfp c={c} lg /><div><h1>{c.symbol} <span className="nm" style={{ fontSize: 13 }}>{c.name}</span> <Status c={c} /></h1>
      <div className="meta"><Addr a={c.mint} /><span>pair {c.pair ? c.pair.slice(0, 6) : '—'}</span><span>{c.createdAt ? ago(c.createdAt) + ' old' : ''}</span>{c.url && <a href={c.url} target="_blank" rel="noreferrer">dexscreener ↗</a>}<a href={`https://pump.fun/coin/${c.mint}`} target="_blank" rel="noreferrer">pump.fun ↗</a></div></div>
      <span className="sp" />{vault ? <span className="tag live" style={{ marginRight: 8 }}>VAULTED</span> : vault === null && !c.onCurve ? <button className="btn sm pri" style={{ marginRight: 8 }} onClick={() => p.go('import/' + c.mint)}>+ Add vault · 15 SOL</button> : null}<button className="btn sm" onClick={() => p.toggleWatch(c.mint)}>{p.watch.includes(c.mint) ? '★ Watching' : '☆ Watch'}</button></div>
    <div className="tiles" style={{ marginBottom: 12 }}>
      <div className="tile"><div className="l">Market cap</div><div className="v"><Mc v={c.mcap} /></div><div className="s"><Ch v={c.ch24} /> 24h</div></div>
      <div className="tile"><div className="l">Price</div><div className="v num">${c.priceUsd < 0.01 ? c.priceUsd.toPrecision(3) : c.priceUsd.toFixed(4)}</div><div className="s"><Ch v={c.ch1h} /> 1h · <Ch v={c.ch5m} /> 5m</div></div>
      <div className="tile"><div className="l">Liquidity</div><div className="v"><Mc v={c.liq} /></div><div className="s">{c.onCurve ? 'bonding curve' : c.dex}</div></div>
      <div className="tile"><div className="l">Volume 24h</div><div className="v"><Mc v={c.vol24} /></div><div className="s num"><span className="up">{c.buys24}</span> / <span className="dn">{c.sells24}</span> txns</div></div>
      <div className="tile"><div className="l">Your position</div><div className="v num">{held ? S(valSol) + ' SOL' : '—'}</div><div className="s num">{held ? `${held.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${c.symbol}` : 'not holding'}{cost ? <> · <span className={pnl >= 0 ? 'up' : 'dn'}>{pnl >= 0 ? '+' : ''}{S(pnl)} SOL</span></> : null}</div></div>
    </div>
    <div className="lay">
      <div>
        <div className="chart">{c.pair ? <iframe src={D.chartUrl(c.pair)} title="chart" allow="clipboard-write" /> : <div className="empty">No chart yet</div>}</div>
        <div className="card" style={{ marginTop: 12 }}>
          <h3><span className="seg" style={{ marginLeft: -4 }}><button className={tab === 'trades' ? 'on' : ''} onClick={() => setTab('trades')}>Trades</button><button className={tab === 'desk' ? 'on' : ''} onClick={() => setTab('desk')}>Desk</button><button className={tab === 'vault' ? 'on' : ''} onClick={() => setTab('vault')}>Vault {vault && <span className="tag live" style={{ marginLeft: 4 }}>ON</span>}</button><button className={tab === 'protocol' ? 'on' : ''} onClick={() => setTab('protocol')}>Rules</button></span></h3>
          {tab === 'trades' ? <div className="feed">{myTrades.map((t, i) => <div className="it" key={i}><span className={t.txType === 'buy' ? 'up' : 'dn'} style={{ width: 40, fontWeight: 600 }}>{t.txType.toUpperCase()}</span><span className="num" style={{ width: 90 }}>{S(t.sol, 3)} SOL</span><span className="num dim" style={{ width: 110 }}>{F(t.mcapSol * p.solPrice)} mc</span><span className="dim num" style={{ flex: 1 }}>{t.trader.slice(0, 4)}…{t.trader.slice(-4)}</span><span className="nm">{ago(t.ts)}</span></div>)}
            {!myTrades.length && <div className="empty" style={{ padding: 24 }}>{c.onCurve ? 'Streaming curve trades… (pump.fun live feed)' : 'Live trade stream covers bonding-curve coins. Graduated: see dexscreener ↗'}</div>}</div>
            : tab === 'desk' ? <CoinDesk mint={p.mint} symbol={c.symbol} d={p.desk} key={p.deskTick} />
            : tab === 'vault' ? <><CoinVault mint={p.mint} v={vault} isDev={!!vault && vault.dev === p.desk.owner} onRenounce={() => vault && p.onRenounce(vault)} solPrice={p.solPrice} />{vault && <div className="panel" style={{ paddingTop: 0 }}><VaultDeposit v={vault} owner={p.desk.owner} holdingUi={held} busy={p.busy} connected={p.connected} needWallet={p.needWallet} onDeposit={(s, t) => p.onDeposit(vault, s, t, p.holding?.decimals ?? 6)} /><VaultExtras mint={p.mint} v={vault} holdingUi={held} decimals={p.holding?.decimals ?? 6} connected={p.connected} busy={p.busy} onRedeem={(t) => p.onRedeem(c, t, p.holding?.decimals ?? 6)} go={p.go} solPrice={p.solPrice} needWallet={p.needWallet} /></div>}</>
            : <div className="panel" style={{ gap: 8 }}>
              <div className="nm">Green = enforced now. Amber = on-chain program, next.</div>
              <div className="kv"><span><span className="tag live">LIVE</span> Desk</span><b>{deskOpen(!c.onCurve, c.mcap) ? `open · min block ${S(deskMinBlock(c.liq / 2 / (p.solPrice || 1)), 2)} SOL · bids −3–5% · 60s rest · all-or-none` : 'closed until graduated + $100K mc'}</b></div>
              <div className="kv"><span><span className={vault ? 'tag live' : 'tag'}>{vault ? 'LIVE' : 'NONE'}</span> Vault</span><b>{vault ? `${S(vault.chest)} SOL chest · ${vault.pct}% supply target · dip buys ≤40%/crash · trims above cost+VWAP` : 'not launched with a stake'}</b></div>
              <div className="kv"><span><span className={vault ? 'tag live' : 'tag'}>{vault ? 'LIVE' : 'NONE'}</span> Burn-to-redeem</span><b>{vault ? 'pro-rata on chest · 7% haircut · max 25%/redeem' : '—'}</b></div>
              <div className="kv"><span><span className={vault ? 'tag live' : 'tag'}>{vault ? 'LIVE' : 'NONE'}</span> Copies</span><b>{vault ? (vault.copyOf ? 'copy · half of cut streams to original' : `original · ${vault.copies?.length || 0} copies`) : '—'}</b></div>
              <div className="kv"><span><span className="tag pre">PREVIEW</span> Early-flip fee</span><b className="num">{p.lot ? `${pct((8 * Math.max(0, 1 - heldMin / FLIP_WINDOW_MIN)))} of profit · ${Math.max(0, FLIP_WINDOW_MIN - heldMin).toFixed(0)} min left` : '8% → 0 over 30 min, losses free'}</b></div>
              <div className="kv"><span><span className="tag pre">PREVIEW</span> Wallet cap</span><b>2.5% of supply during curve (own curve, v1)</b></div>
              <div className="kv"><span><span className="tag pre">PREVIEW</span> Stake pricing</span><b className="num">1 SOL → {S(vaultPct(1), 1)}% · 3.1 SOL → 10% cap</b></div>
            </div>}
        </div>
      </div>
      <div className="card"><div className="panel">
        <div className="seg" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}><button className={side === 'buy' ? 'on' : ''} onClick={() => setSide('buy')}>Buy</button><button className={side === 'sell' ? 'on' : ''} onClick={() => setSide('sell')}>Sell</button></div>
        {side === 'buy' ? <>
          <div className="presets">{[0.1, 0.25, 0.5, 1].map((v) => <button key={v} className={n === v ? 'on' : ''} onClick={() => setAmt(String(v))}>{v} SOL</button>)}</div>
          <div className="inp"><input value={amt} onChange={(e) => setAmt(e.target.value)} inputMode="decimal" placeholder="0.0" /><span>SOL</span></div>
          <div className="kv"><span>Balance</span><b className="num">{p.sol == null ? '—' : S(p.sol) + ' SOL'}</b></div>
          <div className="kv"><span>≈ USD</span><b className="num">${S(n * p.solPrice, 2)}</b></div>
          <div className="kv"><span>Route</span><b>{c.onCurve ? 'pump.fun curve · PumpPortal' : 'Jupiter aggregator'}</b></div>
          <div className="kv"><span>Est. tokens</span><b className="num">{c.priceUsd ? ((n * p.solPrice) / c.priceUsd).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'}</b></div>
          <button className="btn pri big" disabled={!!p.busy || (p.connected && (n <= 0 || (p.sol != null && n > p.sol - 0.005)))} onClick={() => p.connected ? p.onBuy(c, n) : p.needWallet()}>{p.busy || (!p.connected ? 'Connect wallet' : `Buy ${c.symbol}`)}</button>
        </> : <>
          <div className="presets">{[0.25, 0.5, 0.75, 1].map((v) => <button key={v} className={frac === v ? 'on' : ''} onClick={() => setFrac(v)}>{v * 100}%</button>)}</div>
          <input type="range" className="slider" min={1} max={100} value={Math.round(frac * 100)} onChange={(e) => setFrac(+e.target.value / 100)} />
          <div className="kv"><span>Holding</span><b className="num">{held ? held.toLocaleString(undefined, { maximumFractionDigits: 0 }) : 0} {c.symbol}</b></div>
          <div className="kv"><span>Selling</span><b className="num">≈ {S(sellSol)} SOL (${S(sellSol * p.solPrice, 2)})</b></div>
          {cost > 0 && <div className="kv"><span>P&amp;L on this sell</span><b className={'num ' + (sellProfit >= 0 ? 'up' : 'dn')}>{sellProfit >= 0 ? '+' : ''}{S(sellProfit)} SOL</b></div>}
                    <div className="kv"><span>Route</span><b>{c.onCurve ? 'pump.fun curve · PumpPortal' : 'Jupiter aggregator'}</b></div>
          <button className="btn big sell" disabled={!!p.busy || (p.connected && !held)} onClick={() => p.connected ? p.onSell(c, frac) : p.needWallet()}>{p.busy || (!p.connected ? 'Connect wallet' : !held ? 'Nothing to sell' : `Sell ${Math.round(frac * 100)}%`)}</button>
          {held > 0 && !c.onCurve && <button className="btn" style={{ width: '100%', fontSize: 12, fontWeight: 500 }} onClick={() => setSb(true)}>Sell a block on the desk → set max loss, shop for buyers</button>}
          <Orders c={c} owner={p.desk.owner} held={held} ordersV={p.ordersV} bump={p.bumpOrders} />
        </>}
        <div className="nm">Non-custodial · slippage &amp; priority in Settings · curve trades carry PumpPortal's 0.5%.</div>
      </div></div>
    </div>
  </>
}
