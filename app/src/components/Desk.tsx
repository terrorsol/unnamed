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
  if (!v) return <div className="panel"><div className="note">No vault on this coin yet. Launch through UNNAMED with a stake and it's free — or <a href={'#/import/' + mint} style={{ textDecoration: 'underline' }}>import this coin and activate a vault</a> for 15 SOL (5 seeds the chest). Then vault your bag.</div></div>
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
      <div className="note">Your tokens go to the vault (never resold — they're the vault's forever), the vault pays your pro-rata share of the chest minus a 7% haircut, atomically in one transaction you sign and the vault co-signs. This is the floor under every holder: the chest can't be withdrawn, only redeemed against.</div>
    </div>
    <div className="lbl" style={{ marginTop: 10 }}>Family {v.copyOf ? <span className="tag">COPY</span> : <span className="tag live">ORIGINAL</span>}</div>
    {fam && fam.members.length > 1 ? <div className="card"><table><thead><tr><th>Coin</th><th className="r">MC</th><th className="r">Vol 1h</th><th className="r">Score</th><th className="r"></th></tr></thead><tbody>
      {fam.members.map((m) => <tr key={m.mint} onClick={() => go('coin/' + m.mint)}><td className="tk">{m.symbol} {m.original && <span className="tag">ORIGINAL</span>} {m.leader && <span className="tag live">LEADER</span>}</td><td className="r num">{F(m.mcapUsd)}</td><td className="r num">{F(m.vol1h)}</td><td className="r num dim">{m.score ? m.score.toExponential(2) : '0'}</td><td className="r dim">{m.vault ? 'vault' : ''}</td></tr>)}
    </tbody></table></div> : <div className="nm">{v.copyOf ? `Copy of ${short(v.copyOf, 4)} — half of this vault's cut streams to the original's chest.` : 'No copies yet. Copies launched off this coin stream half their dev cut into this chest.'}</div>}
    {v.copyOf && <div className="kv" style={{ marginTop: 6 }}><span>Streamed to original</span><b className="num">{S(v.streamed || 0, 4)} SOL</b></div>}
  </>
}

export function MinePage({ owner, go, solPrice, onRenounce, onClaim, busy }: { owner: string; go: (p: string) => void; solPrice: number; onRenounce: (v: K.VaultPub) => void; onClaim: (mint: string) => void; busy: string }) {
  const [list, setList] = useState<K.VaultPub[] | null>(null); const [err, setErr] = useState('')
  useEffect(() => { if (!owner) return; const f = () => K.devVaults(owner).then((l) => { setList(l); setErr('') }).catch((e) => setErr(String(e.message || e))); f(); const i = setInterval(f, 10000); return () => clearInterval(i) }, [owner])
  if (!owner) return <div className="empty">Connect a wallet to see your launches</div>
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
        <td className="r"><div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>{v.mint && <button className="btn sm" disabled={!!busy} onClick={() => onClaim(v.mint!)}>Claim pump fees</button>}{v.armed && !v.renounced && <button className="btn sm" onClick={() => onRenounce(v)}>Renounce</button>}</div></td></tr>)}
    </tbody></table></div>
    <div className="note" style={{ marginTop: 12 }}><b>Dev rules.</b> Your cut equals the vaulted % and is paid only from vault trims above holder cost — you can't be paid by dumping. Renouncing is permanent. "Claim pump fees" collects the creator fees pump.fun accrues to you on curve trades.</div>
  </>
}

export function LeaderboardPage({ owner }: { owner: string }) {
  const [list, setList] = useState<Awaited<ReturnType<typeof K.leaderboard>> | null>(null); const [fl, setFl] = useState<K.FillRec[]>([]); const [err, setErr] = useState('')
  useEffect(() => { const f = () => Promise.all([K.leaderboard(), K.fills()]).then(([l, f]) => { setList(l); setFl(f); setErr('') }).catch((e) => setErr(String(e.message || e))); f(); const i = setInterval(f, 15000); return () => clearInterval(i) }, [])
  return <div className="lay" style={{ gridTemplateColumns: '1fr 1fr' }}>
    <div className="card"><h3>Desk leaderboard <span className="dim" style={{ fontWeight: 500 }}>· volume crossed off-pool</span></h3><table><thead><tr><th>#</th><th>Wallet</th><th className="r">Sold blocks</th><th className="r">Bought blocks</th><th className="r">Fills</th><th className="r">Saved vs chart</th></tr></thead><tbody>
      {(!list || !list.length) && <tr><td colSpan={6} className="empty">{err ? 'Server unreachable' : 'No desk fills yet'}</td></tr>}
      {list?.map((r, i) => <tr key={r.wallet} className={r.wallet === owner ? 'on' : ''}><td className="dim num">{i + 1}</td><td className="num">{short(r.wallet, 4)}{r.wallet === owner && <span className="tag live" style={{ marginLeft: 6 }}>YOU</span>}</td><td className="r num">{S(r.soldSol, 2)} SOL</td><td className="r num">{S(r.boughtSol, 2)} SOL</td><td className="r num">{r.fills}</td><td className="r num up">≈{S(r.saved, 3)} SOL</td></tr>)}
    </tbody></table></div>
    <div className="card"><h3>Recent desk fills</h3><div className="feed">{fl.map((f) => <div className="it" key={f.sig}><span className="tk" style={{ width: 70 }}>{f.symbol}</span><span className="num" style={{ width: 80 }}>{S(f.sol, 2)} SOL</span><span className="num dn" style={{ width: 50 }}>−{(f.discBps / 100).toFixed(1)}%</span><span className="dim" style={{ flex: 1 }}>{f.vault ? 'vault bid' : short(f.bidder, 3)} ← {short(f.seller, 3)}</span><a className="dim" href={solscan(f.sig)} target="_blank" rel="noreferrer">↗</a><span className="nm">{ago(f.t)}</span></div>)}{!fl.length && <div className="empty">Nothing yet</div>}</div></div>
  </div>
}

/** Import an existing coin and activate a vault on it */
export function ImportPage({ owner, connected, busy, onPay, go, initialMint, needWallet, sol }: { owner: string; connected: boolean; busy: string; onPay: (mint: string) => Promise<void>; go: (p: string) => void; initialMint?: string; needWallet: () => void; sol: number | null }) {
  const [mint, setMint] = useState(initialMint || ''); const [q, setQ] = useState<K.ImportQuote | null>(null); const [err, setErr] = useState('')
  useEffect(() => { if (mint.trim().length < 32) { setQ(null); setErr(''); return } const t = setTimeout(() => K.importQuote(mint.trim()).then((x) => { setQ(x); setErr('') }).catch((e) => { setQ(null); setErr(String(e.message || e)) }), 400); return () => clearTimeout(t) }, [mint])
  const canPay = !!q && connected && !busy && (sol == null || sol >= (q.feeSol + 0.01))
  return <div style={{ maxWidth: 720 }}>
    <h2 style={{ margin: '0 0 6px', fontSize: 18 }}>Import a coin · activate a vault</h2>
    <div className="dim" style={{ marginBottom: 14, fontSize: 12 }}>Any coin with a market — pump, bonk, anything. Pay once, the vault runs the same rules as a native launch: buys crashes, trims only above cost and VWAP (≤2% per trim, ≤5% per day, ≤10% of volume), never withdraws. The coin gets the <span className="tag live">VAULTED</span> badge and a public activity feed.</div>
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
      <div className="kv"><span>→ UNNAMED treasury</span><b className="num">{q.treasurySol} SOL</b></div>
      <div className="kv"><span>Owner (gets the cut, can renounce)</span><b className="num">{owner ? short(owner, 6) : '—'}</b></div>
      <button className="btn pri big" disabled={!canPay && connected} onClick={() => (connected ? onPay(q.mint) : needWallet())}>{busy || (!connected ? 'Connect wallet' : sol != null && sol < q.feeSol + 0.01 ? `Need ${q.feeSol} SOL` : `Pay ${q.feeSol} SOL · activate vault`)}</button>
      <div className="note">After activation you can deposit your own tokens into the vault from the coin page — "vault your bag". Once in, they can only leave through trims above holder cost or holder redeems. Cut: 5% of trim profit, renounceable.</div>
    </div></div>}
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
      <div className="note">{isOwner ? <><b>Vault your bag.</b> Tokens you deposit become vault supply: they can only leave via rule-bound trims above holder cost (capped 2% / trim, 5% / day, 10% of volume) or holder redeems. It's a public, inspectable "I can't dump on you".</> : <><b>Anyone can top up the chest.</b> More chest = bigger dip buys and a bigger desk bid. Tokens deposited by non-owners also become vault supply.</>} Funders: {Object.keys(v.funders || {}).length || 0}.</div>
    </div>
  </>
}
