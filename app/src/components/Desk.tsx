import React, { useEffect, useMemo, useState } from 'react'
import * as K from '../lib/desk'
import { Live, DeskState } from './ui'
import { deskEligible } from '../lib/dex'
import { F, S, ago, short } from '../lib/fmt'
import { solscan } from '../lib/rpc'

export type DeskCtx = { owner: string; connected: boolean; bidder: K.BidderSession | null; deskUp: boolean; busy: string; takeBid: (id: string, sol?: number) => Promise<void>; takeAsk?: (id: string, sol?: number) => Promise<void>; holdingUi: number; solPrice: number; onShop?: () => void; needWallet?: () => void }

/** Simple desk: one question (sell or buy?), one best action, plain words. 'Pro' shows the full book and forms. */
export function CoinDesk({ mint, symbol, d }: { mint: string; symbol: string; d: DeskCtx }) {
  const [pro, setPro] = useState(() => { try { return localStorage.getItem('unnamed_desk_pro') === '1' } catch { return false } })
  const [side, setSide] = useState<'sell' | 'buy'>('sell')
  const [book, setBook] = useState<K.Book | null>(null); const [err, setErr] = useState('')
  const [sol, setSol] = useState('1'); const [disc, setDisc] = useState(400); const [msg, setMsg] = useState('')
  const [askSol, setAskSol] = useState('1'); const [askBps, setAskBps] = useState(0); const [sub, setSub] = useState('')
  const load = () => K.getBook(mint, d.owner || undefined).then((b) => { setBook(b); setErr('') }).catch((e) => setErr(String(e.message || e)))
  useEffect(() => { load(); const i = setInterval(load, 5000); const onBook = (e: Event) => { if ((e as CustomEvent).detail === mint) load() }; K.bookBus.addEventListener('book', onBook); return () => { clearInterval(i); K.bookBus.removeEventListener('book', onBook) } }, [mint, d.owner])
  const togglePro = () => { setPro(!pro); try { localStorage.setItem('unnamed_desk_pro', !pro ? '1' : '0') } catch {} }
  if (pro) return <><div className="row" style={{ marginBottom: 8 }}><span className="sp" /><button className="btn sm" onClick={togglePro}>Simple view</button></div><CoinDeskPro mint={mint} symbol={symbol} d={d} /></>
  if (err) return <div className="panel"><div className="note">Desk offline. Reconnecting.</div></div>
  if (!book) return <div className="empty">Loading…</div>
  const px = book.market?.priceSol || 0
  const offers = book.bids.filter((b) => !b.mine && b.restable && !b.away).sort((a, b) => a.discBps - b.discBps)
  const best = offers[0]; const myValSol = d.holdingUi * px
  const takeOf = (b: K.BookBid) => Math.min(b.sol, myValSol)
  const canSellTo = (b: K.BookBid) => book.open && d.connected && takeOf(b) >= Math.min(b.sol, book.minBlock || 0) - 1e-9 && takeOf(b) > 0
  const post = async () => { setMsg(''); try { if (side === 'buy') { await d.bidder!.place(mint, +sol, disc); setMsg(`Bid posted. Live in 60s.`) } load() } catch (e: any) { setMsg(e.message) } }
  const postAsk = async () => { setMsg(''); try { await d.bidder!.placeAsk(mint, +askSol, askBps); setMsg(`Offer live. Keep this tab open to sign the fill.`); load() } catch (e: any) { setMsg(e.message) } }
  const asksOpen = (book?.asks || []).filter((a) => !a.mine && !a.away).sort((a, b) => b.discBps - a.discBps)
  const myAsk = (book?.asks || []).find((a) => a.mine)
  const Wallet = () => <button className="btn pri big" onClick={() => d.needWallet?.()}>Connect wallet</button>
  const pct = (bps: number, over = 'over', under = 'under') => bps === 0 ? 'at price' : bps < 0 ? `${(Math.abs(bps) / 100).toFixed(1)}% ${over}` : `${(bps / 100).toFixed(1)}% ${under}`
  const bestAsk = asksOpen[0]
  const offerForm = myAsk ? <div className="card" style={{ padding: 14 }}><div className="row" style={{ gap: 8 }}><b className="num">{S(myAsk.sol, 2)} SOL {pct(myAsk.discBps)}</b><span className="tag live">LIVE</span><span className="sp" /><button className="btn sm" onClick={async () => { await d.bidder?.cancelAsk(myAsk.id); load() }}>Cancel</button></div></div>
    : <div className="card" style={{ padding: 14 }}>
      <div className="lbl">Your sell offer</div>
      <div className="presets lg" style={{ marginTop: 8 }}>{[0.5, 1, 2, 5].map((v) => <button key={v} className={+askSol === v ? 'on' : ''} onClick={() => setAskSol(String(v))}>{v} SOL</button>)}</div>
      <div className="row" style={{ marginTop: 8 }}><input type="range" className="slider" min={-1500} max={1500} step={25} value={-askBps} onChange={(e) => setAskBps(-+e.target.value)} /><b className={'num ' + (askBps <= 0 ? 'up' : 'dn')}>{askBps <= 0 ? '+' : '−'}{(Math.abs(askBps) / 100).toFixed(1)}%</b></div>
      <div className="row" style={{ marginTop: 10 }}>{!d.connected ? <Wallet /> : <button className="btn pri big" disabled={!book.open || !d.bidder?.connected() || d.holdingUi <= 0 || +askSol < (book.minBlock || 0) || myValSol < +askSol * 0.98} onClick={postAsk}>{!d.bidder?.connected() ? 'Linking…' : d.holdingUi <= 0 ? `No ${symbol} in wallet` : myValSol < +askSol * 0.98 ? `You hold ≈ ${S(myValSol, 2)} SOL` : +askSol < (book.minBlock || 0) ? `Min ${S(book.minBlock || 0, 2)} SOL` : `Offer ${askSol} SOL ${pct(askBps)}`}</button>}</div>
    </div>
  const bidForm = <div className="card" style={{ padding: 14 }}>
      <div className="lbl">Your bid</div>
      <div className="presets lg" style={{ marginTop: 8 }}>{[0.5, 1, 2, 5].map((v) => <button key={v} className={+sol === v ? 'on' : ''} onClick={() => setSol(String(v))}>{v} SOL</button>)}</div>
      <div className="row" style={{ marginTop: 8 }}><input type="range" className="slider" min={book.rules.discMin} max={book.rules.discMax} step={25} value={disc} onChange={(e) => setDisc(+e.target.value)} /><b className="num dn">−{(disc / 100).toFixed(1)}%</b></div>
      <div className="row" style={{ marginTop: 10 }}>{!d.connected ? <Wallet /> : <button className="btn pri big" disabled={!book.open || !d.bidder?.connected() || +sol < (book.minBlock || 0)} onClick={post}>{!d.bidder?.connected() ? 'Linking…' : +sol < (book.minBlock || 0) ? `Min ${S(book.minBlock || 0, 2)} SOL` : `Bid ${sol} SOL · ${(disc / 100).toFixed(1)}% under`}</button>}</div>
    </div>
  return <div className="panel" style={{ gap: 10 }}>
    <div className="row" style={{ gap: 8 }}>
      <span className="seg"><button className={side === 'sell' ? 'on' : ''} onClick={() => { setSide('sell'); setSub('') }}>Sell</button><button className={side === 'buy' ? 'on' : ''} onClick={() => { setSide('buy'); setSub('') }}>Buy</button></span>
      <span className="sp" /><span className="nm">{book.open ? `min ${S(book.minBlock || 0, 2)} SOL` : 'closed'}</span><button className="btn sm" onClick={togglePro}>Pro</button>
    </div>
    {!book.open && <div className="note">Closed: {book.why || 'not enough market'}.</div>}
    {side === 'sell' ? <>
      {best ? <div className="card" style={{ padding: 14 }}>
        <div className="lbl">Best bid{offers.length > 1 ? <span className="nm" style={{ marginLeft: 8 }}>+{offers.length - 1} more in Pro</span> : null}</div>
        <div style={{ fontSize: 19, fontWeight: 600 }} className="num"><Live v={best.sol}>{S(best.sol, 2)} SOL</Live> <span className="dim" style={{ fontSize: 14, fontWeight: 500 }}>{pct(best.discBps)}</span></div>
        <div className="nm" style={{ marginTop: 4 }}>{d.holdingUi <= 0 ? `No ${symbol} in wallet.` : myValSol >= best.sol ? `You get ≈ ${S(best.sol * (1 - book.rules.feeBps / 10000), 2)} SOL.` : canSellTo(best) ? `Whole bag → ≈ ${S(takeOf(best) * (1 - book.rules.feeBps / 10000), 2)} SOL.` : `Your bag (${S(myValSol, 2)} SOL) is under the ${S(book.minBlock || 0, 2)} SOL minimum.`}</div>
        <div className="row" style={{ marginTop: 10, gap: 8 }}>{!d.connected ? <Wallet /> : <button className="btn pri big" disabled={!canSellTo(best) || !!d.busy} onClick={() => d.takeBid(best.id, takeOf(best) < best.sol - 1e-9 ? +takeOf(best).toFixed(4) : undefined)}>{d.busy || 'Sell into it'}</button>}</div>
      </div> : offerForm}
      <div className="row" style={{ gap: 8 }}>{best && <button className={'btn' + (sub === 'offer' ? ' on' : '')} onClick={() => setSub(sub === 'offer' ? '' : 'offer')}>{myAsk ? 'Your offer' : 'Post a sell offer'}</button>}{d.connected && d.holdingUi > 0 && book.open && <button className="btn" onClick={() => d.onShop?.()}>Ask buyers</button>}</div>
      {best && sub === 'offer' && offerForm}
    </> : <>
      {bestAsk ? <div className="card" style={{ padding: 14 }}>
        <div className="lbl">{bestAsk.vault ? <>Vault sells at spot <span className="tag live" style={{ marginLeft: 6 }}>NO FEE</span></> : 'Best sell offer'}</div>
        <div style={{ fontSize: 19, fontWeight: 600 }} className="num"><Live v={bestAsk.sol}>{S(bestAsk.sol, 2)} SOL</Live> <span className="dim" style={{ fontSize: 14, fontWeight: 500 }}>{pct(bestAsk.discBps)}</span></div>
        <div className="nm" style={{ marginTop: 4 }}>≈ {px ? (bestAsk.sol / (px * (1 - bestAsk.discBps / 10000))).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'} {symbol} for {S(bestAsk.sol * (1 + (bestAsk.feeBps ?? book.rules.feeBps) / 10000), 2)} SOL.{asksOpen.length > 1 ? ` +${asksOpen.length - 1} more in Pro.` : ''}</div>
        <div className="row" style={{ marginTop: 10 }}>{!d.connected ? <Wallet /> : <button className="btn pri big" disabled={!book.open || !!d.busy} onClick={() => d.takeAsk?.(bestAsk.id)}>{d.busy || 'Buy this block'}</button>}</div>
      </div> : bidForm}
      {bestAsk && <div className="row"><button className={'btn' + (sub === 'bid' ? ' on' : '')} onClick={() => setSub(sub === 'bid' ? '' : 'bid')}>Post a bid</button></div>}
      {bestAsk && sub === 'bid' && bidForm}
    </>}
    {msg && <div className="note">{msg}</div>}
    <FillTape mint={mint} />
  </div>
}

/** Off-chart tape: desk fills, newest first. One coin or all. */
export function FillTape({ mint, go, limit = 12 }: { mint?: string; go?: (p: string) => void; limit?: number }) {
  const [fills, setFills] = useState<K.FillRec[]>([]); const mountedAt = useMemo(() => Date.now(), [])
  useEffect(() => { let on = true; const f = () => K.fills(mint).then((l) => on && setFills(l)).catch(() => {}); f(); const i = setInterval(f, 8000); const onBook = () => f(); K.bookBus.addEventListener('book', onBook); return () => { on = false; clearInterval(i); K.bookBus.removeEventListener('book', onBook) } }, [mint])
  const rows = fills.slice().sort((a, b) => b.t - a.t).slice(0, limit)
  return <div className="card"><h3>Off-chart tape <span className="nm">{mint ? 'this coin' : 'all desks'}</span></h3><div className="feed tape">
    {rows.map((f) => <div className={'it' + (f.t > mountedAt ? ' new' : '')} key={f.sig} style={{ cursor: go ? 'pointer' : 'default' }} onClick={() => go?.('coin/' + f.mint + '/desk')}>{!mint && <b className="tk" style={{ width: 64 }}>{f.symbol}</b>}<span className="num up" style={{ width: 80 }}>{S(f.sol, 2)} SOL</span><span className="num dn" style={{ width: 64 }}>{f.discBps < 0 ? '+' : '−'}{(Math.abs(f.discBps) / 100).toFixed(1)}%</span><span className="dim" style={{ width: 60 }}>{f.vault ? 'vault' : short(f.bidder, 4)}</span><span className="sp" /><span className="dim">{ago(f.t)}</span><a className="dim" href={solscan(f.sig)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={{ marginLeft: 8 }}>↗</a></div>)}
    {!rows.length && <div className="empty" style={{ padding: 14 }}>No fills yet</div>}
  </div></div>
}
/** Order book + bid/take controls for one coin */
export function CoinDeskPro({ mint, symbol, d }: { mint: string; symbol: string; d: DeskCtx }) {
  const [book, setBook] = useState<K.Book | null>(null); const [err, setErr] = useState(''); const [sol, setSol] = useState('1'); const [disc, setDisc] = useState(400); const [msg, setMsg] = useState('')
  const [mode, setMode] = useState<'rest' | 'block'>('rest'); const [prem, setPrem] = useState(200); const [ttl, setTtl] = useState(120)
  const load = () => K.getBook(mint, d.owner || undefined).then((b) => { setBook(b); setErr('') }).catch((e) => setErr(String(e.message || e)))
  useEffect(() => { load(); const i = setInterval(load, 5000); const onBook = (e: Event) => { if ((e as CustomEvent).detail === mint) load() }; K.bookBus.addEventListener('book', onBook); return () => { clearInterval(i); K.bookBus.removeEventListener('book', onBook) } }, [mint, d.owner])
  if (err) return <div className="panel"><div className="note">Desk offline — <span className="dim">{err}</span>. Resumes on its own.</div></div>
  if (!book) return <div className="empty">Loading book…</div>
  const place = async () => { setMsg(''); try { if (mode === 'block') { await d.bidder!.buyBlock(mint, +sol, prem, ttl); setMsg(`Block buy live for ${ttl}s · holders are being pinged`) } else { await d.bidder!.place(mint, +sol, disc); setMsg('Bid placed · rests 60s, then fillable') } load() } catch (e: any) { setMsg(e.message) } }
  const cancel = async (id: string) => { await d.bidder?.cancel(id); load() }
  return <div className="panel" style={{ gap: 12 }}>
    <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
      <span className={'tag ' + (book.open ? 'live' : '')}>{book.open ? 'DESK OPEN' : 'DESK CLOSED'}</span>
      <span className="dim" style={{ fontSize: 11 }}>{book.open ? `min block ${S(book.minBlock || 0, 2)} SOL${book.rules.feeBps ? ` · ${book.rules.feeBps / 100}% fee` : ' · no fee'}` : `closed: ${book.why || `opens at ${F(book.rules.gateUsd)} mc`}`}</span>
      <span className="sp" /><span className="dim">{d.bidder?.connected() ? 'bidder link live' : d.connected ? 'bidder link off' : 'no wallet'}</span>
    </div>
    <div className="lay" style={{ gridTemplateColumns: '1fr 1fr', gap: 12 }}>
      <div>
        <div className="lbl">Bids on {symbol}</div>
        <div className="card"><table className="desktbl"><thead><tr><th className="r">Bid</th><th className="r">Price</th><th className="r">Takes ≈</th><th className="r"></th><th className="r"></th></tr></thead><tbody>
          {book.bids.length === 0 && <tr><td colSpan={5} className="empty" style={{ padding: 18 }}>No bids resting</td></tr>}
          {book.bids.map((b) => { const px = book.market?.priceSol * (1 - b.discBps / 10000); const tokens = px ? b.sol / px : 0
            // partial fill: take what you hold if it is at least the min block
            const myValSol = d.holdingUi * (px || 0); const take = Math.min(b.sol, myValSol); const partial = take < b.sol - 1e-9; const canTake = book.open && d.connected && !b.mine && b.restable && !b.away && take >= Math.min(b.sol, book.minBlock || 0) - 1e-9 && take > 0
            return <tr key={b.id}><td className="r num big">{S(b.sol, 2)} SOL</td><td className="r num big">{b.vault && <span className="tag live" style={{ marginRight: 6 }}>vault</span>}{b.block && <span className="tag live" style={{ marginRight: 6 }}>buyer above spot</span>}<span className={b.discBps < 0 ? 'up' : 'dn'}>{b.discBps < 0 ? '+' : '−'}{(Math.abs(b.discBps) / 100).toFixed(1)}%</span></td><td className="r num dim">{tokens ? tokens.toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' ' + symbol : '—'}</td><td className="r num dim">{b.away ? <span className="gold">away</span> : b.block && b.expiresAt ? `${Math.max(0, Math.round((b.expiresAt - Date.now()) / 1000))}s left` : ago(b.placedAt)}{!b.restable && !b.away && <span className="gold"> · resting</span>}</td>
              <td className="r">{b.mine ? <button className="btn sm" onClick={() => cancel(b.id)}>Cancel</button> : <button className="btn pri" disabled={!canTake || !!d.busy} title={b.away ? 'bidder reconnecting' : !b.restable ? 'resting' : !canTake ? `you hold less than the min block (${S(book.minBlock || 0, 2)} SOL)` : `fills at ${px ? px.toPrecision(3) : '?'} SOL/token, spot at signing`} onClick={() => d.takeBid(b.id, partial ? +take.toFixed(4) : undefined)}>Sell {partial ? S(take, 2) + ' of ' : ''}→ {S((partial ? take : b.sol) * (1 - book.rules.feeBps / 10000), 2)} SOL</button>}</td></tr> })}
        </tbody></table></div>
        <div className="nm" style={{ marginTop: 6 }}>One tx, both sides sign.</div>
        <div className="lbl" style={{ marginTop: 12 }}>Sell offers on {symbol}</div>
        <div className="card"><table className="desktbl"><thead><tr><th className="r">Offer</th><th className="r">Price</th><th className="r">Gets you ≈</th><th className="r"></th><th className="r"></th></tr></thead><tbody>
          {(book.asks || []).length === 0 && <tr><td colSpan={5} className="empty" style={{ padding: 14 }}>No sell offers</td></tr>}
          {(book.asks || []).map((a) => { const apx = book.market?.priceSol * (1 - a.discBps / 10000); const tok = apx ? a.sol / apx : 0
            return <tr key={a.id}><td className="r num big">{S(a.sol, 2)} SOL</td><td className="r num big"><span className={a.discBps <= 0 ? 'up' : 'dn'}>{a.discBps <= 0 ? '+' : '−'}{(Math.abs(a.discBps) / 100).toFixed(1)}%</span></td><td className="r num dim">{tok ? tok.toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' ' + symbol : '—'}</td><td className="r num dim">{a.away ? <span className="gold">away</span> : ago(a.placedAt)}</td>
              <td className="r">{a.mine ? <button className="btn sm" onClick={async () => { await d.bidder?.cancelAsk(a.id); load() }}>Cancel</button> : <button className="btn pri" disabled={!book.open || a.away || !d.connected || !!d.busy} onClick={() => d.takeAsk?.(a.id)}>Buy → {S(a.sol * (1 + book.rules.feeBps / 10000), 2)} SOL</button>}</td></tr> })}
        </tbody></table></div>
      </div>
      <div>
        <div className="lbl" style={{ margin: 0 }}>Bid for {symbol} below market</div>
        <div className="presets lg">{[0.5, 1, 2, 5].map((v) => <button key={v} className={+sol === v ? 'on' : ''} onClick={() => setSol(String(v))}>{v} SOL</button>)}</div>
        <div className="inp" style={{ marginTop: 8 }}><input value={sol} onChange={(e) => setSol(e.target.value)} inputMode="decimal" /><span>SOL</span></div>
        {mode === 'rest' ? <div className="row" style={{ marginTop: 8 }}><span className="dim" style={{ fontSize: 12 }}>Below market by</span><input type="range" className="slider" min={book.rules.discMin} max={book.rules.discMax} step={25} value={disc} onChange={(e) => setDisc(+e.target.value)} /><b className="num dn">−{(disc / 100).toFixed(2)}%</b></div>
          : <><div className="row" style={{ marginTop: 8 }}><span className="dim" style={{ fontSize: 12 }}>Pay up to</span><input type="range" className="slider" min={0} max={500} step={25} value={prem} onChange={(e) => setPrem(+e.target.value)} /><b className="num up">+{(prem / 100).toFixed(2)}%</b></div>
            <div className="row" style={{ marginTop: 6 }}><span className="dim" style={{ fontSize: 12 }}>Open for</span><span className="presets" style={{ margin: 0 }}>{[60, 120, 300].map((v) => <button key={v} className={ttl === v ? 'on' : ''} onClick={() => setTtl(v)}>{v / 60} min</button>)}</span></div></>}
        {(() => { const eff = mode === 'rest' ? disc : -prem; return <div className="tradekv"><div className="kv" style={{ marginTop: 6 }}><span>Fills at</span><b className="num">{book.market?.priceSol ? (book.market.priceSol * (1 - eff / 10000) * d.solPrice).toPrecision(3) + ' USD' : '—'}</b></div>
        <div className="kv"><span>You receive ≈</span><b className="num">{book.market?.priceSol ? (+sol / (book.market.priceSol * (1 - eff / 10000))).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'} {symbol}</b></div></div> })()}
        <button className="btn pri big" style={{ marginTop: 10 }} disabled={!book.open || !d.connected || !d.bidder?.connected() || !(+sol >= (book.minBlock || 0))} onClick={place}>{!d.connected ? 'Connect wallet' : !d.bidder?.connected() ? 'Linking bidder…' : +sol < (book.minBlock || 0) ? `Min block ${S(book.minBlock || 0, 2)} SOL` : mode === 'block' ? `Buy ${sol} SOL now · up to +${(prem / 100).toFixed(1)}%` : `Bid ${sol} SOL · −${(disc / 100).toFixed(1)}%`}</button>
        {msg && <div className="nm" style={{ marginTop: 6 }}>{msg}</div>}
        <div className="nm" style={{ marginTop: 8 }}>{mode === 'block' ? 'Holders get pinged and fill you. No candle.' : 'A holder sells to you at that price, off-chart. Your SOL stays put until then. Live after 60s.'}</div>
      </div>
    </div>
  </div>
}

/** Standalone Desk page: every book with resting bids */
export function DeskPage({ go, coins = [], owner = '', bidder = null }: { go: (p: string) => void; coins?: import('../lib/dex').Coin[]; owner?: string; bidder?: K.BidderSession | null }) {
  const [mine, setMine] = useState<K.BookBid[]>([])
  useEffect(() => { if (!owner) { setMine([]); return } const f = () => K.myBids(owner).then(setMine).catch(() => {}); f(); const i = setInterval(f, 6000); K.bookBus.addEventListener('book', f); return () => { clearInterval(i); K.bookBus.removeEventListener('book', f) } }, [owner])
  const [list, setList] = useState<Awaited<ReturnType<typeof K.getBooks>> | null>(null); const [err, setErr] = useState('')
  useEffect(() => { const f = () => K.getBooks().then((l) => { setList(l); setErr('') }).catch((e) => setErr(String(e.message || e))); f(); const i = setInterval(f, 8000); K.bookBus.addEventListener('book', f); return () => { clearInterval(i); K.bookBus.removeEventListener('book', f) } }, [])
  const [open, setOpen] = useState('')
  const openMint = () => { const m = open.trim(); if (m.length >= 32) go('coin/' + m + '/desk') }
  // one list: every coin that qualifies, plus every coin that already has a book — bids first
  const bidsBy = Object.fromEntries((list || []).map((b) => [b.mint, b]))
  const rows = [...coins.filter((c) => deskEligible(c)).map((c) => ({ mint: c.mint, symbol: c.symbol, mcap: c.mcap, bids: bidsBy[c.mint]?.bids || 0, sol: bidsBy[c.mint]?.sol || 0, best: bidsBy[c.mint]?.bestDisc, asks: bidsBy[c.mint]?.asks || 0, askSol: bidsBy[c.mint]?.askSol || 0 })), ...(list || []).filter((b) => !coins.some((c) => c.mint === b.mint)).map((b) => ({ mint: b.mint, symbol: b.symbol, mcap: 0, bids: b.bids, sol: b.sol, best: b.bestDisc, asks: b.asks || 0, askSol: b.askSol || 0 }))].sort((x, y) => (y.bids - x.bids) || (y.mcap - x.mcap))
  return <>
    <div className="card" style={{ marginBottom: 12 }}><div className="panel" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 6 }}><input value={open} onChange={(e) => setOpen(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && openMint()} placeholder="paste any mint" /><button className="btn pri" onClick={openMint} disabled={open.trim().length < 32}>Open desk</button></div>
      <div className="nm">Off-chart. No candle, no names.{err ? <span className="dn"> · offline</span> : null}</div>
    </div></div>
    {mine.length > 0 && <div className="card" style={{ marginBottom: 12 }}><h3>Your bids <span className="nm">{mine.length} open · {S(mine.reduce((a, b) => a + b.sol, 0), 2)} SOL</span></h3><table><thead><tr><th>Coin</th><th className="r">Size</th><th className="r">Under</th><th className="r">Status</th><th className="r"></th></tr></thead><tbody>
      {mine.map((b) => <tr key={b.id}><td className="tk" style={{ cursor: 'pointer' }} onClick={() => go('coin/' + b.mint + '/desk')}>{b.symbol}</td><td className="r num">{S(b.sol, 2)} SOL</td><td className="r num dn">{(b.discBps / 100).toFixed(1)}%</td><td className="r"><span className={'tag ' + (b.away ? '' : b.restable ? 'live' : '')}>{b.away ? 'AWAY' : b.restable ? 'LIVE' : 'RESTING'}</span></td><td className="r"><button className="btn sm" onClick={() => bidder?.cancel(b.id)}>Cancel</button></td></tr>)}
    </tbody></table></div>}
    <div className="card"><h3>Desks <span className="nm">tap one</span></h3><table><thead><tr><th>Coin</th><th className="r">Mcap</th><th className="r">Bids</th><th className="r">Best bid</th></tr></thead><tbody>
      {!rows.length && <tr><td colSpan={4} className="empty">{err ? 'Offline. Reconnecting.' : 'No desks open right now. Paste a mint above.'}</td></tr>}
      {rows.map((r) => <tr key={r.mint} onClick={() => go('coin/' + r.mint + '/desk')}><td className="tk">{r.symbol}</td><td className="r num">{r.mcap ? F(r.mcap) : '—'}</td><td className="r"><DeskState b={{ bids: r.bids, sol: r.sol, asks: r.asks, askSol: r.askSol }} /></td><td className="r num">{r.best != null && r.bids ? <span className="dn">−{(r.best / 100).toFixed(1)}%</span> : <span className="dim">—</span>}</td></tr>)}
    </tbody></table></div>
    <div style={{ marginTop: 12 }}><FillTape go={go} limit={16} /></div>
  </>
}

/** Vault panel for one coin */
export function CoinVault({ mint, v, isDev, onRenounce, solPrice, onMode }: { mint: string; v: K.VaultPub | null | undefined; isDev: boolean; onRenounce: () => void; solPrice: number; onMode?: (m: 'floor' | 'mm', c: number) => void }) {
  const mountedAt = useMemo(() => Date.now(), []); const [more, setMore] = useState(false)
  if (v === undefined) return <div className="empty" style={{ padding: 18 }}>Loading vault…</div>
  if (!v) return <div className="panel"><div className="note">No vault yet. Launch here with a stake and it's free, or <a href={'#/import/' + mint} style={{ textDecoration: 'underline' }}>import this coin and activate a vault</a> for 15 SOL (5 seeds the chest). Then vault your bag.</div></div>
  const last = v.activity.find((a) => ['capture', 'buy', 'bid', 'redeem', 'trim'].includes(a.kind))
  const floorUsd = v.floor * solPrice
  return <div className="panel" style={{ gap: 10 }}>
    <div className="card" style={{ padding: 14 }}>
      <div style={{ fontSize: 15, fontWeight: 600 }}>This coin has a vault</div>
      <div className="nm" style={{ marginTop: 4, fontSize: 12.5, lineHeight: 1.5 }}>SOL and {v.symbol} owned by the holders. Buys dips, takes sellers off-chart, never cashes out.</div>
      <div className="tiles" style={{ marginTop: 10, gridTemplateColumns: v.venue === 'launchlab' ? 'repeat(4,1fr)' : 'repeat(3,1fr)' }}>
        <div className="tile"><div className="l">Floor</div><div className="v num"><Live v={floorUsd}>{floorUsd ? '$' + floorUsd.toPrecision(2) : '—'}</Live></div><div className="s">what every {v.symbol} is backed by right now</div></div>
        <div className="tile"><div className="l">In the chest</div><div className="v num"><Live v={v.chest}>{S(v.chest, 1)} SOL</Live></div><div className="s">${S(v.chest * solPrice, 0)} · never withdrawn</div></div>
        {v.venue === 'launchlab' && <div className="tile"><div className="l">Tax collected</div><div className="v num"><Live v={v.taxClaimed || 0}>{S(v.taxClaimed || 0, 3)} SOL</Live></div><div className="s">every trade pays the chest</div></div>}
        <div className="tile"><div className="l">Last move</div><div className="v" style={{ fontSize: 14 }}>{last ? (last.kind === 'buy' ? 'bought the dip' : last.kind === 'capture' ? 'sold into a pump' : last.kind === 'bid' ? 'bidding on the desk' : last.kind === 'redeem' ? 'paid a redeem' : 'trimmed') : 'watching'}</div><div className="s">{last ? ago(last.t) : v.mode === 'mm' ? 'market maker mode' : 'floor mode'}</div></div>
      </div>
      <div className="row" style={{ marginTop: 8 }}><span className="sp" /><button className="btn sm" onClick={() => setMore(!more)}>{more ? 'Less' : 'Details'}</button></div>
    </div>
    {more && <>
    <VaultScore v={v} solPrice={solPrice} />
    <div className="tiles" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
      <div className="tile"><div className="l">Chest</div><div className="v num"><Live v={v.chest}>{S(v.chest)} SOL</Live></div><div className="s">buys dips, never withdraws</div></div>
      <div className="tile"><div className="l">Vault supply</div><div className="v num"><Live v={v.tokens}>{v.tokens.toLocaleString(undefined, { maximumFractionDigits: 0 })}</Live></div><div className="s">{v.pct}% target · avg {v.avgCost ? (v.avgCost * solPrice).toPrecision(3) : '—'} USD</div></div>
      <div className="tile"><div className="l">Dev cut</div><div className="v num">{v.renounced ? '0% · renounced' : v.cut + '%'}</div><div className="s">paid {S(v.devPaid, 3)} SOL</div></div>
      <div className="tile"><div className="l">Stake</div><div className="v num">{S(v.stakeSol)} SOL</div><div className="s">{v.armed ? 'armed' : 'awaiting funds'} · <a href={`https://solscan.io/account/${v.pub}`} target="_blank" rel="noreferrer">vault ↗</a></div></div>
    </div>
    <div className="lbl">Activity</div>
    <div className="feed" style={{ maxHeight: 260 }}>{v.activity.map((a, i) => <div className={'it' + (a.t > mountedAt ? ' new' : '')} key={a.t + ':' + i}><span className={a.kind === 'buy' || a.kind === 'seed' || a.kind === 'tax' || a.kind === 'stream' ? 'up' : a.kind === 'trim' ? 'dn' : a.kind === 'cut' ? 'gold' : 'dim'} style={{ width: 46, fontWeight: 600 }}>{a.kind.toUpperCase()}</span><span className="num" style={{ width: 90 }}>{a.sol != null ? S(a.sol, 3) + ' SOL' : ''}</span><span className="dim" style={{ flex: 1 }}>{a.msg}</span>{a.sig && <a className="dim" href={solscan(a.sig)} target="_blank" rel="noreferrer">↗</a>}<span className="nm">{ago(a.t)}</span></div>)}
      {!v.activity.length && <div className="empty" style={{ padding: 16 }}>Nothing yet</div>}</div>
    {isDev && <div className="row" style={{ alignItems: 'flex-start' }}><div style={{ flex: 1 }}><div className="lbl">Mode (owner)</div><ModePicker mode={v.mode} ceiling={v.ceiling} onChange={(m, c) => onMode?.(m, c)} compact /></div>{!v.renounced && <button className="btn sm" style={{ marginTop: 18 }} onClick={onRenounce}>Renounce cut</button>}</div>}
    <div className="nm">Rules: dip buys ≤40% of chest per crash · sells only above cost + 30-min VWAP, ≤2% a time, 5% a day · never withdraws.</div>
    </>}
    <div className="nm" style={{ display: 'none' }}></div>
  </div>
}

export function VaultPage({ go, solPrice, onLaunch }: { go: (p: string) => void; solPrice: number; onLaunch?: () => void }) {
  const [list, setList] = useState<K.VaultPub[] | null>(null); const [err, setErr] = useState('')
  useEffect(() => { const f = () => K.vaults().then((l) => { setList(l); setErr('') }).catch((e) => setErr(String(e.message || e))); f(); const i = setInterval(f, 10000); return () => clearInterval(i) }, [])
  const chest = list?.reduce((a, v) => a + v.chest, 0) || 0
  return <>
    <div className="actions2">
      <button className="btn pri big" onClick={() => onLaunch ? onLaunch() : go('')}><b>Launch a coin</b><span>vault from block zero · 2% tax → chest</span></button>
      <button className="btn big" onClick={() => go('vault/import')}><b>Import a coin</b><span>give any pump coin a vault</span></button>
    </div>
    <div className="tiles" style={{ marginBottom: 14, gridTemplateColumns: 'repeat(2,1fr)' }}>
      <div className="tile"><div className="l">Vaults</div><div className="v num">{list ? list.length : '—'}</div>{err ? <div className="s dn">offline</div> : null}</div>
      <div className="tile"><div className="l">In chests</div><div className="v num"><Live v={chest}>{S(chest, 2)} SOL</Live></div><div className="s">${S(chest * solPrice, 0)}</div></div>
    </div>
    <div className="card"><table><thead><tr><th>Coin</th><th className="r">Mode</th><th className="r">Chest</th><th className="r">Captured</th><th className="r">Off-chart buys</th><th className="r">Floor</th><th className="r">Last</th></tr></thead><tbody>
      {(!list || !list.length) && <tr><td colSpan={7} className="empty">{err ? 'Offline. Reconnecting.' : 'No vaults yet.'}</td></tr>}
      {list?.map((v) => <tr key={v.id} onClick={() => v.mint && go('coin/' + v.mint)}><td className="tk">{v.symbol || '—'} <span className="nm">{v.mint ? short(v.mint, 4) : ''}</span></td><td className="r"><span className={'tag ' + (v.mode === 'mm' ? 'live' : '')}>{v.mode === 'mm' ? 'MM ' + Math.round(v.ceiling * 100) + '%' : 'FLOOR'}</span></td><td className="r num"><Live v={v.chest}>{S(v.chest, 2)} SOL</Live></td><td className="r num">{S(v.score?.captured || 0, 2)}</td><td className="r num">{S((v.score?.deskBought || 0) + (v.score?.dipBought || 0), 2)}</td><td className="r num">{v.floor && solPrice ? '$' + (v.floor * solPrice).toPrecision(2) : '—'}</td><td className="r dim">{v.activity?.[0] ? ago(v.activity[0].t) : '—'}</td></tr>)}
    </tbody></table></div>
  </>
}

/** Burn-to-redeem + family (copies) — rendered inside the Vault tab */
export function VaultExtras({ mint, v, holdingUi, decimals, connected, busy, onRedeem, go, solPrice, needWallet }: { mint: string; v: K.VaultPub; holdingUi: number; decimals: number; connected: boolean; busy: string; onRedeem: (tokens: number) => void; go: (p: string) => void; solPrice: number; needWallet: () => void }) {
  const [frac, setFrac] = useState(1); const [fam, setFam] = useState<K.Family | null>(null)
  useEffect(() => { K.family(mint).then(setFam).catch(() => setFam(null)) }, [mint])
  const tokens = holdingUi * frac; const share = tokens / (v.supply || 1e9); const sol = share * v.chest * 0.93
  return <>
    <div className="lbl" style={{ marginTop: 6 }}>Burn-to-redeem</div>
    <div className="lay" style={{ gridTemplateColumns: '1fr 1fr', gap: 12 }}>
      <div>
        <div className="presets">{[0.25, 0.5, 0.75, 1].map((f) => <button key={f} className={frac === f ? 'on' : ''} onClick={() => setFrac(f)}>{f * 100}%</button>)}</div>
        <div className="kv" style={{ marginTop: 8 }}><span>Redeem</span><b className="num">{tokens.toLocaleString(undefined, { maximumFractionDigits: 0 })} {v.symbol}</b></div>
        <div className="kv"><span>Share of supply</span><b className="num">{(share * 100).toFixed(4)}%</b></div>
        <div className="kv"><span>You receive</span><b className="num up">{S(sol, 4)} SOL <span className="dim">(${S(sol * solPrice, 2)})</span></b></div>
        <button className="btn big" style={{ marginTop: 8 }} disabled={!!busy || (connected && (!holdingUi || sol < 0.001 || sol > v.chest * 0.25))} onClick={() => (connected ? onRedeem(tokens) : needWallet())}>{busy || (!connected ? 'Connect wallet' : !holdingUi ? 'Nothing to redeem' : sol < 0.001 ? 'Below 0.001 SOL' : sol > v.chest * 0.25 ? 'Max 25% of chest per redeem' : 'Burn & redeem')}</button>
      </div>
      <div className="nm">Burn tokens, take your share of the chest minus 7%. One tx.</div>
    </div>
    <div className="lbl" style={{ marginTop: 10 }}>Family {v.copyOf ? <span className="tag">COPY</span> : <span className="tag live">ORIGINAL</span>}</div>
    {fam && Array.isArray(fam.members) && fam.members.length > 1 ? <div className="card"><table><thead><tr><th>Coin</th><th className="r">MC</th><th className="r">Vol 1h</th><th className="r">Score</th><th className="r"></th></tr></thead><tbody>
      {fam.members.map((m) => <tr key={m.mint} onClick={() => go('coin/' + m.mint)}><td className="tk">{m.symbol} {m.original && <span className="tag">ORIGINAL</span>} {m.leader && <span className="tag live">LEADER</span>}</td><td className="r num">{F(m.mcapUsd)}</td><td className="r num">{F(m.vol1h)}</td><td className="r num dim">{m.score ? m.score.toExponential(2) : '0'}</td><td className="r dim">{m.vault ? 'vault' : ''}</td></tr>)}
    </tbody></table></div> : <div className="nm">{v.copyOf ? `Copy of ${short(v.copyOf, 4)} — half of this vault's cut streams to the original's chest.` : 'No copies. Copies of this coin stream half their dev cut into this chest.'}</div>}
    {v.copyOf && <div className="kv" style={{ marginTop: 6 }}><span>Streamed to original</span><b className="num">{S(v.streamed || 0, 4)} SOL</b></div>}
  </>
}

export function MinePage({ owner, go, solPrice, onRenounce, onClaim, busy, onConnect, onLaunch }: { onConnect?: () => void; onLaunch?: () => void; owner: string; go: (p: string) => void; solPrice: number; onRenounce: (v: K.VaultPub) => void; onClaim: (mint: string, toVault?: K.VaultPub) => void; busy: string }) {
  const [list, setList] = useState<K.VaultPub[] | null>(null); const [err, setErr] = useState('')
  useEffect(() => { if (!owner) return; const f = () => K.devVaults(owner).then((l) => { setList(l); setErr('') }).catch((e) => setErr(String(e.message || e))); f(); const i = setInterval(f, 10000); return () => clearInterval(i) }, [owner])
  if (!owner) return <div className="empty" style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>Your launches, cuts and claims live here.<div className="row" style={{ gap: 8 }}><button className="btn pri big" onClick={onConnect}>Connect wallet</button><button className="btn big" onClick={onLaunch}>Launch a coin</button></div></div>
  const armed = list?.filter((v) => v.armed) || []
  return <>
    <div className="tiles" style={{ marginBottom: 14, gridTemplateColumns: 'repeat(4,1fr)' }}>
      <div className="tile"><div className="l">Launched with vault</div><div className="v num">{armed.length}</div></div>
      <div className="tile"><div className="l">Chests you seeded</div><div className="v num">{S(armed.reduce((a, v) => a + v.chest, 0), 2)} SOL</div></div>
      <div className="tile"><div className="l">Cut paid to you</div><div className="v num gold">{S(armed.reduce((a, v) => a + v.devPaid, 0), 4)} SOL</div><div className="s">${S(armed.reduce((a, v) => a + v.devPaid, 0) * solPrice, 2)}</div></div>
      <div className="tile"><div className="l">Received from copies</div><div className="v num">{S(armed.reduce((a, v) => a + v.activity.filter((x) => x.kind === 'stream' && (x.msg || '').startsWith('from')).reduce((s2, x) => s2 + (x.sol || 0), 0), 0), 4)} SOL</div></div>
    </div>
    <div className="card"><h3>Your coins</h3><table><thead><tr><th>Coin</th><th className="r">Chest</th><th className="r">Vault supply</th><th className="r">Your cut</th><th className="r">Paid</th><th className="r">Desk bid</th><th className="r"></th></tr></thead><tbody>
      {(!list || !list.length) && <tr><td colSpan={7} className="empty">{err ? 'Server unreachable: ' + err : 'No launches from this wallet yet. Hit Launch — set a stake and the vault is yours.'}</td></tr>}
      {list?.map((v) => <tr key={v.id}><td className="tk" style={{ cursor: v.mint ? 'pointer' : 'default' }} onClick={() => v.mint && go('coin/' + v.mint)}>{v.symbol || '(unfunded)'} {v.copyOf && <span className="tag">COPY</span>} {!v.armed && <span className="tag pre">AWAITING STAKE</span>}<div className="nm">{v.mint ? short(v.mint, 4) : 'send ' + v.stakeSol + ' SOL to ' + short(v.pub, 4)}</div></td>
        <td className="r num">{S(v.chest)} SOL</td><td className="r num">{v.tokens.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td><td className="r num">{v.renounced ? '0% · renounced' : v.cut + '%'}</td><td className="r num gold">{S(v.devPaid, 4)}</td><td className="r num">{v.deskBid ? S(v.deskBid, 2) + ' SOL' : '—'}</td>
        <td className="r"><div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>{v.mint && <button className="btn sm" disabled={!!busy} onClick={() => onClaim(v.mint!)}>Claim fees</button>}{v.mint && v.armed && <button className="btn sm pri" disabled={!!busy} onClick={() => onClaim(v.mint!, v)}>Claim → chest</button>}{v.armed && !v.renounced && <button className="btn sm" onClick={() => onRenounce(v)}>Renounce</button>}</div></td></tr>)}
    </tbody></table></div>
    <div className="nm" style={{ marginTop: 10 }}>Cut = vaulted %, paid only from trims above holder cost. Renounce is permanent.</div>
  </>
}

export function LeaderboardPage({ owner }: { owner: string }) {
  const [list, setList] = useState<Awaited<ReturnType<typeof K.leaderboard>> | null>(null); const [fl, setFl] = useState<K.FillRec[]>([]); const [err, setErr] = useState(''); const mountedAt = useMemo(() => Date.now(), [])
  useEffect(() => { const f = () => Promise.all([K.leaderboard(owner || undefined), K.fills()]).then(([l, f]) => { setList(l); setFl(f); setErr('') }).catch((e) => setErr(String(e.message || e))); f(); const i = setInterval(f, 15000); return () => clearInterval(i) }, [])
  return <div className="lay" style={{ gridTemplateColumns: '1fr 1fr' }}>
    <div className="card"><h3>Desk leaderboard <span className="dim" style={{ fontWeight: 500 }}>· volume crossed off-pool</span></h3><table><thead><tr><th>#</th><th>Wallet</th><th className="r">Sold blocks</th><th className="r">Bought blocks</th><th className="r">Fills</th><th className="r">Saved vs chart</th></tr></thead><tbody>
      {(!list || !list.length) && <tr><td colSpan={6} className="empty">{err ? 'Server unreachable' : 'No desk fills yet'}</td></tr>}
      {list?.map((r, i) => <tr key={r.wallet} className={r.mine ? 'on' : ''}><td className="dim num">{i + 1}</td><td className="num">{r.wallet}{r.mine && <span className="tag live" style={{ marginLeft: 6 }}>YOU</span>}</td><td className="r num">{S(r.soldSol, 2)} SOL</td><td className="r num">{S(r.boughtSol, 2)} SOL</td><td className="r num">{r.fills}</td><td className="r num up">≈{S(r.saved, 3)} SOL</td></tr>)}
    </tbody></table></div>
    <div className="card"><h3>Recent desk fills</h3><div className="feed">{fl.map((f) => <div className={'it' + (f.t > mountedAt ? ' new' : '')} key={f.sig}><span className="tk" style={{ width: 70 }}>{f.symbol}</span><span className="num" style={{ width: 80 }}>{S(f.sol, 2)} SOL</span><span className="num dn" style={{ width: 50 }}>−{(f.discBps / 100).toFixed(1)}%</span><span className="dim" style={{ flex: 1 }}>{f.vault ? 'vault bid' : short(f.bidder, 3)} ← {short(f.seller, 3)}</span><a className="dim" href={solscan(f.sig)} target="_blank" rel="noreferrer">↗</a><span className="nm">{ago(f.t)}</span></div>)}{!fl.length && <div className="empty">Nothing yet</div>}</div></div>
  </div>
}

/** Import an existing coin and activate a vault on it */
export function ImportPage({ owner, connected, busy, onPay, onCrowd, onContribute, go, initialMint, needWallet, sol }: { owner: string; connected: boolean; busy: string; onPay: (mint: string) => Promise<void>; onCrowd: (mint: string) => Promise<void>; onContribute: (v: K.VaultPub, sol: number) => Promise<void>; go: (p: string) => void; initialMint?: string; needWallet: () => void; sol: number | null }) {
  const [mint, setMint] = useState(initialMint || ''); const [q, setQ] = useState<K.ImportQuote | null>(null); const [err, setErr] = useState('')
  useEffect(() => { if (mint.trim().length < 32) { setQ(null); setErr(''); return } const t = setTimeout(() => K.importQuote(mint.trim()).then((x) => { setQ(x); setErr('') }).catch((e) => { setQ(null); setErr(String(e.message || e)) }), 400); return () => clearTimeout(t) }, [mint])
  const canPay = !!q && connected && !busy && (sol == null || sol >= (q.feeSol + 0.01))
  const [who, setWho] = useState<'dev' | 'crowd'>('dev'); const [open, setOpen] = useState<K.VaultPub[]>([]); const [amt, setAmt] = useState<Record<string, string>>({})
  useEffect(() => { const f = () => K.crowdOpen().then(setOpen).catch(() => {}); f(); const i = setInterval(f, 10000); return () => clearInterval(i) }, [busy])
  return <div style={{ maxWidth: 720 }}>
    <h2 style={{ margin: '0 0 6px', fontSize: 18 }}>Import a coin</h2>
    <div className="dim" style={{ marginBottom: 14, fontSize: 12 }}>Any pump coin. One payment, the vault runs.</div>
    <div className="fld"><div className="lbl">Mint address</div><input value={mint} onChange={(e) => setMint(e.target.value)} placeholder="paste the token's mint" /></div>
    {err && <div className="note" style={{ marginTop: 8, color: 'var(--dn)' }}>{err}</div>}
    {q && <div className="card" style={{ marginTop: 10 }}><div className="panel">
      <div className="tiles" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
        <div className="tile"><div className="l">Coin</div><div className="v">{q.symbol}</div></div>
        <div className="tile"><div className="l">Market cap</div><div className="v num">{F(q.mcapUsd)}</div></div>
        <div className="tile"><div className="l">Pool reserve</div><div className="v num">{S(q.liqSol, 1)} SOL</div></div>
        <div className="tile"><div className="l">Price</div><div className="v num" style={{ fontSize: 13 }}>{q.priceSol.toPrecision(3)} SOL</div></div>
      </div>
      <div className="kv"><span>Import fee</span><b className="num">{q.feeSol} SOL</b></div>
      <div className="kv"><span>→ seeds the chest</span><b className="num up">{q.seedSol} SOL</b></div>
      <div className="kv"><span>→ BANKER treasury</span><b className="num">{q.treasurySol} SOL</b></div>
      <div className="seg" style={{ marginTop: 4 }}><button className={who === 'dev' ? 'on' : ''} onClick={() => setWho('dev')}>I pay it</button><button className={who === 'crowd' ? 'on' : ''} onClick={() => setWho('crowd')}>Community takeover</button></div>
      {who === 'dev' ? <>
        <div className="kv"><span>Owner (gets the cut, can renounce)</span><b className="num">{owner ? short(owner, 6) : '—'}</b></div>
        <button className="btn pri big" disabled={!canPay && connected} onClick={() => (connected ? onPay(q.mint) : needWallet())}>{busy || (!connected ? 'Connect wallet' : sol != null && sol < q.feeSol + 0.01 ? `Need ${q.feeSol} SOL` : `Pay ${q.feeSol} SOL · activate vault`)}</button>
        <div className="nm">Then deposit your bag on the coin page. It only leaves through the rules. Cut 5%, renounceable.</div>
      </> : <>
        <div className="kv"><span>Goal</span><b className="num">{q.feeSol} SOL · anyone chips in ≥0.05</b></div>
        <div className="kv"><span>Escrow</span><b className="num">the vault's own wallet · refunds in 7 days if not funded</b></div>
        <button className="btn pri big" disabled={!!busy} onClick={() => (connected ? onCrowd(q.mint) : needWallet())}>{busy || (!connected ? 'Connect wallet' : 'Start the takeover')}</button>
        <div className="nm">No dev needed. Cut 0. Arms when the goal is hit.</div>
      </>}
    </div></div>}
    {open.length > 0 && <div style={{ marginTop: 16 }}><div className="lbl">Takeovers raising</div>
      {open.map((v) => { const c = v.crowd!; const pct = Math.min(100, (c.raised / c.goalSol) * 100); return <div className="card" key={v.id} style={{ marginBottom: 8 }}><div className="panel" style={{ gap: 6 }}>
        <div className="row"><b>{v.symbol}</b><span className="dim" style={{ fontSize: 11 }}>{c.backers} backers · {Math.max(0, Math.round((c.expiresAt - Date.now()) / 3.6e6))}h left</span><span className="sp" /><b className="num">{S(c.raised, 2)} / {c.goalSol} SOL</b></div>
        <div style={{ height: 6, background: 'var(--line)', borderRadius: 3 }}><div style={{ width: pct + '%', height: '100%', background: 'var(--up)', borderRadius: 3 }} /></div>
        <div className="row" style={{ gap: 6 }}><div className="inp" style={{ flex: 1 }}><input value={amt[v.id] || ''} onChange={(e) => setAmt({ ...amt, [v.id]: e.target.value })} placeholder="0.25" inputMode="decimal" /><span>SOL</span></div><button className="btn sm pri" disabled={!!busy || !(+(amt[v.id] || 0) >= 0.05)} onClick={() => (connected ? onContribute(v, +(amt[v.id] || 0)) : needWallet())}>Chip in</button><button className="btn sm" onClick={() => go('coin/' + v.mint)}>Coin</button></div>
      </div></div> })}</div>}
  </div>
}

/** Deposit controls shown on the vault tab */
export function VaultDeposit({ v, owner, holdingUi, busy, onDeposit, needWallet, connected }: { v: K.VaultPub; owner: string; holdingUi: number; busy: string; onDeposit: (sol: number, tokens: number) => void; needWallet: () => void; connected: boolean }) {
  const [sol, setSol] = useState(''); const [tok, setTok] = useState('')
  const isOwner = owner === v.dev
  return <>
    <div className="lbl" style={{ marginTop: 10 }}>Fund the vault</div>
    <div className="lay" style={{ gridTemplateColumns: '1fr 1fr', gap: 12 }}>
      <div>
        <div className="inp"><input value={sol} onChange={(e) => setSol(e.target.value)} inputMode="decimal" placeholder="0.0" /><span>SOL → chest</span></div>
        <div className="inp" style={{ marginTop: 6 }}><input value={tok} onChange={(e) => setTok(e.target.value)} inputMode="decimal" placeholder={holdingUi ? `up to ${holdingUi.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '0'} /><span>{v.symbol} → vault</span></div>
        <div className="row" style={{ marginTop: 6 }}><button className="btn sm" onClick={() => setTok(String(Math.floor(holdingUi)))} disabled={!holdingUi}>all my {v.symbol}</button><span className="sp" /><button className="btn pri" disabled={!!busy || (connected && !(+sol > 0 || +tok > 0))} onClick={() => (connected ? onDeposit(+sol || 0, +tok || 0) : needWallet())}>{busy || (!connected ? 'Connect wallet' : 'Deposit')}</button></div>
      </div>
      <div className="nm">{isOwner ? 'Deposited tokens only leave through the rules.' : 'More chest → bigger bid, bigger dip buys.'} Funders: {Object.keys(v.funders || {}).length || 0}</div>
    </div>
  </>
}

/** Seller: shop a block with a max loss and a clock */
export function SellBlock({ mint, symbol, holdingUi, priceSol, liqSol, owner, connected, busy, onClose, takeBid, onPoolSell, needWallet }: { mint: string; symbol: string; holdingUi: number; priceSol: number; liqSol: number; owner: string; connected: boolean; busy: string; onClose: () => void; takeBid: (id: string) => Promise<void>; onPoolSell: (frac: number) => Promise<void>; needWallet: () => void }) {
  const [frac, setFrac] = useState(0.5); const [maxBps, setMaxBps] = useState(300); const [ttl, setTtl] = useState(60); const [rfq, setRfq] = useState<K.Rfq | null>(null); const [log, setLog] = useState<string[]>([]); const [err, setErr] = useState(''); const filling = React.useRef(false); const done = React.useRef(false)
  const sizeSol = holdingUi * frac * priceSol; const impact = K.poolImpactBps(sizeSol, liqSol)
  const add = (m: string) => setLog((l) => [m, ...l].slice(0, 8))
  useEffect(() => {
    if (!rfq || rfq.status !== 'open') return
    const i = setInterval(async () => {
      try {
        const r = await K.rfqGet(rfq.id); setRfq(r)
        if (r.matches.length && !filling.current) { filling.current = true; const id = r.matches[0]; try { add(`filling ${id.startsWith('v') ? 'vault' : 'bidder'} …`); await takeBid(id); add('filled ✓') } catch (e: any) { add('fill failed: ' + e.message) } finally { filling.current = false } }
        if ((r.status !== 'open') && !done.current) { done.current = true
          if (r.remainingSol > 0.01) { const imp = K.poolImpactBps(r.remainingSol, liqSol); if (imp <= r.maxBps) { add(`timer up · ${r.remainingSol.toFixed(2)} SOL left → pool (impact −${(imp / 100).toFixed(1)}% ≤ your max)`); const remFrac = Math.min(1, r.remainingSol / Math.max(1e-9, priceSol * holdingUi)); await onPoolSell(remFrac) } else add(`timer up · ${r.remainingSol.toFixed(2)} SOL unfilled — pool impact −${(imp / 100).toFixed(1)}% exceeds your max, cancelled`) }
          else add('block fully sold ✓') }
      } catch {}
    }, 1200); return () => clearInterval(i)
  }, [rfq?.id, rfq?.status])
  const post = async () => { setErr(''); try { const r = await K.rfqCreate(mint, owner, +sizeSol.toFixed(3), maxBps, ttl * 1000); setRfq(r); add(r.matches.length ? `${r.matches.length} resting bid${r.matches.length > 1 ? 's' : ''} inside your max — filling now` : 'no resting bids inside your max · pinging bidders + vault'); if (r.counters.length) add(`${r.counters.length} counter${r.counters.length > 1 ? 's' : ''} received`) } catch (e: any) { setErr(e.message) } }
  return <div className="modal" onClick={onClose}><div className="box" onClick={(e) => e.stopPropagation()}>
    <div className="row"><h2>Sell a block · {symbol}</h2><span className="sp" /><span className="tag live">DESK</span></div>
    {!rfq ? <>
      <div className="presets">{[0.25, 0.5, 0.75, 1].map((f) => <button key={f} className={frac === f ? 'on' : ''} onClick={() => setFrac(f)}>{f * 100}%</button>)}</div>
      <div className="kv"><span>Block</span><b className="num">{(holdingUi * frac).toLocaleString(undefined, { maximumFractionDigits: 0 })} {symbol} ≈ {S(sizeSol, 2)} SOL</b></div>
      <div className="kv"><span>Dumping this into the pool would cost</span><b className="num dn">−{(impact / 100).toFixed(1)}%</b></div>
      <div className="row"><span className="dim" style={{ fontSize: 12 }}>Max loss</span><input type="range" className="slider" min={50} max={1000} step={25} value={maxBps} onChange={(e) => setMaxBps(+e.target.value)} /><b className="num dn">−{(maxBps / 100).toFixed(2)}%</b></div>
      {maxBps > 600 && <div className="nm" style={{ color: 'var(--gold)' }}>Above −6% you're paying more than most blocks cost on the chart ({(impact / 100).toFixed(1)}% here). Lower it unless you need out now.</div>}
      <div className="row"><span className="dim" style={{ fontSize: 12 }}>Shop for</span><div className="seg">{[30, 60, 120].map((t) => <button key={t} className={ttl === t ? 'on' : ''} onClick={() => setTtl(t)}>{t}s</button>)}</div><span className="sp" /><span className="dim" style={{ fontSize: 11 }}>then → pool if impact ≤ max, else cancel</span></div>
      {err && <div className="note" style={{ color: 'var(--dn)' }}>{err}</div>}
      <div className="row"><button className="btn" onClick={onClose}>Cancel</button><span className="sp" /><button className="btn pri" disabled={!!busy || (connected && !(sizeSol > 0))} onClick={() => (connected ? post() : needWallet())}>{!connected ? 'Connect wallet' : `Shop block at ≤ −${(maxBps / 100).toFixed(1)}%`}</button></div>
      <div className="nm">Bids inside your max fill now.</div>
    </> : <>
      <div className="tiles" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
        <div className="tile"><div className="l">Left to sell</div><div className="v num">{S(rfq.remainingSol, 2)} SOL</div><div className="s">of {S(rfq.sizeSol, 2)}</div></div>
        <div className="tile"><div className="l">Filled</div><div className="v num up">{S(rfq.filledSol, 2)} SOL</div></div>
        <div className="tile"><div className="l">{rfq.status === 'open' ? 'Clock' : 'Status'}</div><div className="v num">{rfq.status === 'open' ? rfq.secondsLeft + 's' : rfq.status}</div></div>
      </div>
      {rfq.counters.length > 0 && <div><div className="lbl">Counters — tap to accept</div>{rfq.counters.map((c) => <div className="kv" key={c.bidId}><span>{c.vault ? <span className="tag live">VAULT</span> : c.bidder} · {S(c.sol, 2)} SOL at <b className="dn">−{(c.discBps / 100).toFixed(2)}%</b></span><button className="btn sm pri" disabled={!!busy} onClick={() => takeBid(c.bidId).then(() => add('counter accepted ✓')).catch((e) => add('accept failed: ' + e.message))}>Accept</button></div>)}</div>}
      <div className="feed" style={{ maxHeight: 160 }}>{log.map((l, i) => <div className="it" key={i}><span className="dim">{l}</span></div>)}</div>
      <div className="row"><span className="sp" />{rfq.status === 'open' && <button className="btn" onClick={() => { K.rfqCancel(rfq.id, owner); setRfq({ ...rfq, status: 'cancelled' }); done.current = true }}>Stop</button>}<button className="btn" onClick={onClose}>Close</button></div>
    </>}
  </div></div>
}

/** Bidder: a live ping for a block someone wants to sell */
export function RfqPing({ r, bidder, onRespond, onDismiss, busy }: { r: K.Rfq; bidder: K.BidderSession | null; onRespond: (id: string, discBps: number, sol: number) => Promise<void>; onDismiss: () => void; busy: string }) {
  const [disc, setDisc] = useState(Math.max(300, r.maxBps)); const [left, setLeft] = useState(r.secondsLeft)
  useEffect(() => { const i = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000); return () => clearInterval(i) }, [])
  if (left <= 0) return null
  return <div className="toast" style={{ borderColor: 'var(--up)' }}>
    <div className="t">Block for sale · {r.symbol} <span className="sp" /><span className="num dim">{left}s</span></div>
    <div className="kv"><span>Size</span><b className="num">{S(r.remainingSol, 2)} SOL</b></div>
    <div className="kv"><span>Seller takes up to</span><b className="num dn">−{(r.maxBps / 100).toFixed(2)}%</b></div>
    <div className="row" style={{ marginTop: 8, gap: 6 }}>
      <button className="btn sm pri" disabled={!!busy || !bidder?.connected()} onClick={() => onRespond(r.id, r.maxBps, r.remainingSol)}>Fill at −{(r.maxBps / 100).toFixed(1)}%</button>
      <input className="num" style={{ width: 64, background: 'var(--s3)', border: '1px solid var(--line)', borderRadius: 6, padding: '4px 6px', color: 'var(--fg)' }} value={(disc / 100).toFixed(2)} onChange={(e) => setDisc(Math.min(800, Math.max(50, Math.round(+e.target.value * 100) || 300)))} />
      <button className="btn sm" disabled={!!busy || !bidder?.connected()} onClick={() => onRespond(r.id, disc, r.remainingSol)}>Counter</button>
      <span className="sp" /><button className="btn sm ghost" onClick={onDismiss}>✕</button>
    </div>
  </div>
}

/** Mode selector used at launch/import and on the vault tab (owner) */
export function ModePicker({ mode, ceiling, onChange, compact }: { mode: 'floor' | 'mm'; ceiling: number; onChange: (m: 'floor' | 'mm', c: number) => void; compact?: boolean }) {
  return <div>
    <div className="seg" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}><button className={mode === 'mm' ? 'on' : ''} onClick={() => onChange('mm', ceiling)}>Market maker</button><button className={mode === 'floor' ? 'on' : ''} onClick={() => onChange('floor', ceiling)}>Floor only</button></div>
    {mode === 'mm' ? <>
      <div className="row" style={{ marginTop: 8 }}><span className="dim" style={{ fontSize: 12 }}>Capture ceiling</span><input type="range" className="slider" min={5} max={30} step={5} value={Math.round(ceiling * 100)} onChange={(e) => onChange('mm', +e.target.value / 100)} /><b className="num">{Math.round(ceiling * 100)}%</b></div>
      {!compact && <div className="nm">Counters 20–50% of buys when price is stretched over VWAP · 0% on dips · all of it → chest → 60% desk bid, 40% defense. Public.</div>}
    </> : !compact && <div className="nm" style={{ marginTop: 6 }}>Never sells into buys. Desk bid + defense + redeem only.</div>}
  </div>
}
/** Live MM readout + scorecard */
export function VaultScore({ v, solPrice }: { v: K.VaultPub; solPrice: number }) {
  const l = v.live; const sc = v.score; const floorUsd = v.floor * solPrice
  return <>
    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
      <span className={'tag ' + (v.mode === 'mm' ? 'live' : '')}>{v.mode === 'mm' ? 'MARKET MAKER' : 'FLOOR'}</span>
      {v.mode === 'mm' && <><span className="dim" style={{ fontSize: 11 }}>capture now</span><b className={'num ' + (l.captureNow > 0 ? 'up' : 'dim')}>{Math.round(l.captureNow * 100)}%</b><span className="dim" style={{ fontSize: 11 }}>· stretch</span><b className={'num ' + (l.stretch > 0 ? 'up' : 'dn')}>{(l.stretch * 100).toFixed(1)}%</b><span className="dim" style={{ fontSize: 11 }}>· trigger</span><b className="num">{Math.round(l.triggerRate * 100)}%</b><span className="dim" style={{ fontSize: 11 }}>· {l.buysPerMin} buys/min · {l.tier} · σ {((l as any).sigma * 100 || 0).toFixed(1)}% · inv {((l as any).skew || 0) >= 0 ? '+' : ''}{(((l as any).skew || 0) * 100).toFixed(0)}% vs target · ceiling {Math.round(v.ceiling * 100)}%</span></>}
      <span className="sp" /><span className="dim" style={{ fontSize: 11 }}>defense {l.tranchesFired.length}/3 fired</span>
    </div>
    <div className="tiles" style={{ gridTemplateColumns: 'repeat(5,1fr)', marginTop: 8 }}>
      <div className="tile"><div className="l">Captured</div><div className="v num">{S(sc.captured, 2)} SOL</div><div className="s">{sc.captures} counters</div></div>
      <div className="tile"><div className="l">Redeployed</div><div className="v num">{S(sc.redeployed, 2)} SOL</div><div className="s">{sc.deskFills} desk · {sc.dips} dips</div></div>
      <div className="tile"><div className="l">Bought off-chart</div><div className="v num">{S(sc.deskBought, 2)} SOL</div><div className="s">sellers absorbed</div></div>
      <div className="tile"><div className="l">Floor / token</div><div className="v num" style={{ fontSize: 13 }}>${floorUsd ? floorUsd.toPrecision(2) : '—'}</div><div className="s">{sc.floor0 && v.floor ? ((v.floor / sc.floor0 - 1) * 100).toFixed(0) + '% since start' : 'chest ÷ supply'}</div></div>
      <div className="tile"><div className="l">Dev paid</div><div className="v num gold">{S(v.devPaid, 3)}</div><div className="s">{v.renounced ? 'renounced' : v.cut + '% of profit'}</div></div>
    </div>
  </>
}
