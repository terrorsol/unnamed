import React, { useEffect, useState } from 'react'
import * as K from '../lib/desk'
import { F, S, ago, short } from '../lib/fmt'
import { solscan } from '../lib/rpc'

export type DeskCtx = { owner: string; connected: boolean; bidder: K.BidderSession | null; deskUp: boolean; busy: string; takeBid: (id: string) => Promise<void>; holdingUi: number; solPrice: number }

/** Order book + bid/take controls for one coin */
export function CoinDesk({ mint, symbol, d }: { mint: string; symbol: string; d: DeskCtx }) {
  const [book, setBook] = useState<K.Book | null>(null); const [err, setErr] = useState(''); const [sol, setSol] = useState('1'); const [disc, setDisc] = useState(400); const [msg, setMsg] = useState('')
  const load = () => K.getBook(mint, d.owner || undefined).then((b) => { setBook(b); setErr('') }).catch((e) => setErr(String(e.message || e)))
  useEffect(() => { load(); const i = setInterval(load, 5000); return () => clearInterval(i) }, [mint, d.owner])
  if (err) return <div className="panel"><div className="note">Desk server unreachable — <span className="dim">{err}</span>. Bids and fills resume automatically when it's back.</div></div>
  if (!book) return <div className="empty">Loading book…</div>
  const place = async () => { setMsg(''); try { await d.bidder!.place(mint, +sol, disc); setMsg('Bid placed · rests 60s, then fillable'); load() } catch (e: any) { setMsg(e.message) } }
  const cancel = async (id: string) => { await d.bidder?.cancel(id); load() }
  return <div className="panel" style={{ gap: 12 }}>
    <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
      <span className={'tag ' + (book.open ? 'live' : '')}>{book.open ? 'DESK OPEN' : 'DESK CLOSED'}</span>
      <span className="dim" style={{ fontSize: 11 }}>{book.open ? `min block ${S(book.minBlock || 0, 2)} SOL · bids ${book.rules.discMin / 100}–${book.rules.discMax / 100}% under spot · all-or-none · ${book.rules.feeBps / 100}% cross fee` : `opens when graduated and ≥ ${F(book.rules.gateUsd)} mc`}</span>
      <span className="sp" /><span className="status"><i className={d.deskUp && (d.bidder?.connected() ?? false) ? '' : 'off'} />{d.bidder?.connected() ? 'bidder link live' : d.connected ? 'bidder link off' : 'no wallet'}</span>
    </div>
    <div className="lay" style={{ gridTemplateColumns: '1fr 1fr', gap: 12 }}>
      <div>
        <div className="lbl">Block bids resting</div>
        <div className="card"><table><thead><tr><th className="r">Bid</th><th className="r">Disc</th><th className="r">Takes ≈</th><th className="r">Age</th><th className="r"></th></tr></thead><tbody>
          {book.bids.length === 0 && <tr><td colSpan={5} className="empty" style={{ padding: 18 }}>No bids resting</td></tr>}
          {book.bids.map((b) => { const px = book.market?.priceSol * (1 - b.discBps / 10000); const tokens = px ? b.sol / px : 0; const canTake = book.open && d.connected && !b.mine && b.restable && d.holdingUi >= tokens
            return <tr key={b.id}><td className="r num">{S(b.sol, 2)} SOL</td><td className="r num dn">−{(b.discBps / 100).toFixed(1)}%</td><td className="r num dim">{tokens ? tokens.toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' ' + symbol : '—'}</td><td className="r num dim">{ago(b.placedAt)}{!b.restable && <span className="gold"> · resting</span>}</td>
              <td className="r">{b.mine ? <button className="btn sm" onClick={() => cancel(b.id)}>Cancel</button> : <button className="btn sm pri" disabled={!canTake || !!d.busy} title={!b.restable ? 'resting' : d.holdingUi < tokens ? 'you hold less than this block' : ''} onClick={() => d.takeBid(b.id)}>Sell block</button>}</td></tr> })}
        </tbody></table></div>
        <div className="nm" style={{ marginTop: 6 }}>Selling a block delivers exactly the bid's size at the bidder's discount, off the pool — the chart doesn't move. One signature from you, the bidder co-signs within seconds, or nothing happens.</div>
      </div>
      <div>
        <div className="lbl">Place a block bid</div>
        <div className="presets">{[0.5, 1, 2, 5].map((v) => <button key={v} className={+sol === v ? 'on' : ''} onClick={() => setSol(String(v))}>{v} SOL</button>)}</div>
        <div className="inp" style={{ marginTop: 8 }}><input value={sol} onChange={(e) => setSol(e.target.value)} inputMode="decimal" /><span>SOL</span></div>
        <div className="row" style={{ marginTop: 8 }}><span className="dim" style={{ fontSize: 12 }}>Discount</span><input type="range" className="slider" min={book.rules.discMin} max={book.rules.discMax} step={25} value={disc} onChange={(e) => setDisc(+e.target.value)} /><b className="num dn">−{(disc / 100).toFixed(2)}%</b></div>
        <div className="kv" style={{ marginTop: 6 }}><span>Fills at</span><b className="num">{book.market?.priceSol ? (book.market.priceSol * (1 - disc / 10000) * d.solPrice).toPrecision(3) + ' USD' : '—'}</b></div>
        <div className="kv"><span>You receive ≈</span><b className="num">{book.market?.priceSol ? (+sol / (book.market.priceSol * (1 - disc / 10000))).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'} {symbol}</b></div>
        <button className="btn pri big" style={{ marginTop: 10 }} disabled={!book.open || !d.connected || !d.bidder?.connected() || !(+sol >= (book.minBlock || 0))} onClick={place}>{!d.connected ? 'Connect wallet' : !d.bidder?.connected() ? 'Linking bidder…' : +sol < (book.minBlock || 0) ? `Min block ${S(book.minBlock || 0, 2)} SOL` : 'Place bid'}</button>
        {msg && <div className="nm" style={{ marginTop: 6 }}>{msg}</div>}
        <div className="note" style={{ marginTop: 10 }}>Your SOL stays in your wallet — a bid is a standing promise your browser honors by co-signing fills while this tab is open. Close the tab and the bid lifts. Fills are all-or-none at your discount, verified by your own browser before it signs.</div>
      </div>
    </div>
  </div>
}

/** Standalone Desk page: every book with resting bids */
export function DeskPage({ go }: { go: (p: string) => void }) {
  const [list, setList] = useState<Awaited<ReturnType<typeof K.getBooks>> | null>(null); const [err, setErr] = useState('')
  useEffect(() => { const f = () => K.getBooks().then((l) => { setList(l); setErr('') }).catch((e) => setErr(String(e.message || e))); f(); const i = setInterval(f, 8000); return () => clearInterval(i) }, [])
  return <>
    <div className="tiles" style={{ marginBottom: 14, gridTemplateColumns: 'repeat(3,1fr)' }}>
      <div className="tile"><div className="l">Books with bids</div><div className="v num">{list ? list.length : '—'}</div></div>
      <div className="tile"><div className="l">SOL bid</div><div className="v num">{list ? S(list.reduce((a, b) => a + b.sol, 0), 2) : '—'}</div></div>
      <div className="tile"><div className="l">Status</div><div className="v status" style={{ fontSize: 13 }}><i className={err ? 'off' : ''} />{err ? 'desk server offline' : 'live'}</div></div>
    </div>
    <div className="card"><h3>Open books</h3><table><thead><tr><th>Coin</th><th className="r">Bids</th><th className="r">SOL resting</th><th className="r">Best discount</th></tr></thead><tbody>
      {(!list || !list.length) && <tr><td colSpan={4} className="empty">{err ? 'Desk server unreachable: ' + err : 'No bids resting anywhere yet. Open any graduated coin ≥ $100K and place one.'}</td></tr>}
      {list?.map((b) => <tr key={b.mint} onClick={() => go('coin/' + b.mint)}><td className="tk">{b.symbol} <span className="nm">{short(b.mint, 4)}</span></td><td className="r num">{b.bids}</td><td className="r num">{S(b.sol, 2)}</td><td className="r num dn">−{(b.bestDisc / 100).toFixed(1)}%</td></tr>)}
    </tbody></table></div>
    <div className="prose" style={{ marginTop: 18 }}><h2>How the desk works</h2><p>Holders who want out without crashing the chart sell a block to a resting bid, 3–5% under spot, off the pool. Bids are all-or-none and rest 60 seconds before they can be hit. Nobody custodies anything: the fill is one transaction signed by both sides. Min block is 2% of the pool's SOL reserve; the desk opens once a coin has graduated and holds a $100K market cap. 0.5% of each cross goes to the treasury.</p></div>
  </>
}

/** Vault panel for one coin */
export function CoinVault({ mint, v, isDev, onRenounce, solPrice }: { mint: string; v: K.VaultPub | null | undefined; isDev: boolean; onRenounce: () => void; solPrice: number }) {
  if (v === undefined) return <div className="empty" style={{ padding: 18 }}>Loading vault…</div>
  if (!v) return <div className="panel"><div className="note">No vault on this coin — it wasn't launched through UNNAMED with a stake. Coins launched here come with a program-style market maker funded by the dev's block-zero stake.</div></div>
  return <div className="panel" style={{ gap: 10 }}>
    <div className="tiles" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
      <div className="tile"><div className="l">Chest</div><div className="v num">{S(v.chest)} SOL</div><div className="s">buys dips, never withdraws</div></div>
      <div className="tile"><div className="l">Vault supply</div><div className="v num">{v.tokens.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div><div className="s">{v.pct}% target · avg {v.avgCost ? (v.avgCost * solPrice).toPrecision(3) : '—'} USD</div></div>
      <div className="tile"><div className="l">Dev cut</div><div className="v num">{v.renounced ? '0% · renounced' : v.cut + '%'}</div><div className="s">paid {S(v.devPaid, 3)} SOL</div></div>
      <div className="tile"><div className="l">Stake</div><div className="v num">{S(v.stakeSol)} SOL</div><div className="s">{v.armed ? 'armed' : 'awaiting funds'} · <a href={`https://solscan.io/account/${v.pub}`} target="_blank" rel="noreferrer">vault ↗</a></div></div>
    </div>
    <div className="lbl">Activity</div>
    <div className="feed" style={{ maxHeight: 260 }}>{v.activity.map((a, i) => <div className="it" key={i}><span className={a.kind === 'buy' || a.kind === 'seed' ? 'up' : a.kind === 'trim' ? 'dn' : a.kind === 'cut' ? 'gold' : 'dim'} style={{ width: 46, fontWeight: 600 }}>{a.kind.toUpperCase()}</span><span className="num" style={{ width: 90 }}>{a.sol != null ? S(a.sol, 3) + ' SOL' : ''}</span><span className="dim" style={{ flex: 1 }}>{a.msg}</span>{a.sig && <a className="dim" href={solscan(a.sig)} target="_blank" rel="noreferrer">↗</a>}<span className="nm">{ago(a.t)}</span></div>)}
      {!v.activity.length && <div className="empty" style={{ padding: 16 }}>Nothing yet</div>}</div>
    {isDev && !v.renounced && <div className="row"><span className="dim" style={{ fontSize: 11 }}>Renouncing forfeits your cut forever; the vault keeps running for holders.</span><span className="sp" /><button className="btn sm" onClick={onRenounce}>Renounce cut</button></div>}
    <div className="note"><b>Beta:</b> the vault runs as our bot holding this coin's vault wallet, enforcing the same rules the on-chain program will — dip buys ≤40% of chest per crash, trims only above holder cost and 30-min VWAP, no withdrawals. v1 moves it into a program so it's trustless.</div>
  </div>
}

export function VaultPage({ go, solPrice }: { go: (p: string) => void; solPrice: number }) {
  const [list, setList] = useState<K.VaultPub[] | null>(null); const [err, setErr] = useState('')
  useEffect(() => { const f = () => K.vaults().then((l) => { setList(l); setErr('') }).catch((e) => setErr(String(e.message || e))); f(); const i = setInterval(f, 10000); return () => clearInterval(i) }, [])
  const chest = list?.reduce((a, v) => a + v.chest, 0) || 0
  return <>
    <div className="tiles" style={{ marginBottom: 14, gridTemplateColumns: 'repeat(3,1fr)' }}>
      <div className="tile"><div className="l">Vaults armed</div><div className="v num">{list ? list.length : '—'}</div></div>
      <div className="tile"><div className="l">Chests total</div><div className="v num">{S(chest, 2)} SOL</div><div className="s">${S(chest * solPrice, 0)}</div></div>
      <div className="tile"><div className="l">Status</div><div className="v status" style={{ fontSize: 13 }}><i className={err ? 'off' : ''} />{err ? 'vault server offline' : 'running'}</div></div>
    </div>
    <div className="card"><h3>Vaults</h3><table><thead><tr><th>Coin</th><th className="r">Chest</th><th className="r">Supply</th><th className="r">Dev cut</th><th className="r">Last action</th></tr></thead><tbody>
      {(!list || !list.length) && <tr><td colSpan={5} className="empty">{err ? 'Vault server unreachable: ' + err : 'No vaults yet. Launch a coin with a stake and it shows up here.'}</td></tr>}
      {list?.map((v) => <tr key={v.id} onClick={() => v.mint && go('coin/' + v.mint)}><td className="tk">{v.symbol || '—'} <span className="nm">{v.mint ? short(v.mint, 4) : ''}</span></td><td className="r num">{S(v.chest)} SOL</td><td className="r num">{v.tokens.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td><td className="r num">{v.renounced ? '0%' : v.cut + '%'}</td><td className="r dim">{v.activity[0] ? `${v.activity[0].kind} · ${ago(v.activity[0].t)}` : '—'}</td></tr>)}
    </tbody></table></div>
    <div className="prose" style={{ marginTop: 18 }}><h2>How the vault works</h2><p>At launch the dev stakes SOL; the stake buys vault supply at block zero (10% cap, reached around 3.1 SOL) and the rest sits as the chest. The vault buys crashes — at most 40% of the chest per episode — and trims only when price is above every holder's cost basis and the 30-minute VWAP, in an uptrend. It never dumps and never withdraws. The dev's cut equals the vaulted percentage of trim profit, and can be renounced. Burn-to-redeem against the chest and copies ship with the on-chain version.</p></div>
  </>
}
