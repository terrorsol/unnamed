import React, { useState } from 'react'
import type { Coin } from '../lib/dex'
import type { Holding } from '../lib/rpc'
import type { Fill, Lot } from '../lib/positions'
import { Pfp, Mc, Ch, Addr } from './ui'
import { F, S, ago, short } from '../lib/fmt'
import { solscan } from '../lib/rpc'
import type { Settings } from '../lib/store'
import { flipFee, FLIP_WINDOW_MIN } from '../lib/protocol'

export function Portfolio({ sol, tokens, coins, lots, fills, solPrice, go, owner }: { sol: number | null; tokens: Holding[]; coins: Record<string, Coin>; lots: Record<string, Lot>; fills: Fill[]; solPrice: number; go: (p: string) => void; owner: string }) {
  if (!owner) return <div className="empty">Connect or unlock a wallet to see holdings</div>
  const rows = tokens.map((t) => { const c = coins[t.mint]; const val = c ? t.amount * c.priceUsd : 0; return { t, c, val, lot: lots[t.mint] } }).sort((a, b) => b.val - a.val)
  const tot = rows.reduce((a, r) => a + r.val, 0)
  return <>
    <div className="tiles" style={{ marginBottom: 14 }}>
      <div className="tile"><div className="l">SOL</div><div className="v num">{sol == null ? '—' : S(sol)}</div><div className="s num">${S((sol || 0) * solPrice, 2)}</div></div>
      <div className="tile"><div className="l">Tokens</div><div className="v num">{F(tot)}</div><div className="s">{rows.length} positions</div></div>
      <div className="tile"><div className="l">Total</div><div className="v num">{F(tot + (sol || 0) * solPrice)}</div><div className="s">on-chain, live</div></div>
      <div className="tile"><div className="l">Wallet</div><div className="v num" style={{ fontSize: 13 }}>{short(owner, 6)}</div><div className="s"><a href={`https://solscan.io/account/${owner}`} target="_blank" rel="noreferrer">solscan ↗</a></div></div>
      <div className="tile"><div className="l">Fills recorded</div><div className="v num">{fills.length}</div><div className="s">this browser</div></div>
    </div>
    <div className="lay">
      <div className="card"><h3>Holdings</h3><div style={{ overflowX: 'auto' }}><table><thead><tr><th>Token</th><th className="r">Amount</th><th className="r">Value</th><th className="r">Cost</th><th className="r">P&amp;L</th><th className="r">Held</th><th className="r">Flip fee now</th><th className="r">24h</th></tr></thead>
        <tbody>{rows.length === 0 && <tr><td colSpan={8} className="empty">No SPL tokens found</td></tr>}
          {rows.map(({ t, c, val, lot }) => { const vs = solPrice ? val / solPrice : 0; const pnl = lot ? vs - lot.costSol : 0; const hm = lot ? (Date.now() - lot.t) / 60000 : 999; const fee = flipFee(pnl, hm)
            return <tr key={t.mint} onClick={() => go('coin/' + t.mint)}>
              <td><div className="row"><Pfp c={c} mint={t.mint} /><div><div className="tk">{c?.symbol || lot?.symbol || short(t.mint, 3)}</div><div className="nm"><Addr a={t.mint} /></div></div></div></td>
              <td className="r num">{t.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
              <td className="r num">{c ? F(val) : <span className="dim">no market</span>}</td>
              <td className="r num">{lot ? S(lot.costSol) + ' SOL' : <span className="dim">—</span>}</td>
              <td className={'r num ' + (lot ? (pnl >= 0 ? 'up' : 'dn') : 'dim')}>{lot ? (pnl >= 0 ? '+' : '') + S(pnl) + ' SOL' : '—'}</td>
              <td className="r num dim">{lot ? ago(lot.t) : '—'}</td>
              <td className="r num">{lot ? (fee > 0 ? <span className="gold">{S(fee, 4)} SOL · {Math.max(0, FLIP_WINDOW_MIN - hm).toFixed(0)}m</span> : <span className="dim">0</span>) : '—'}</td>
              <td className="r">{c ? <Ch v={c.ch24} /> : '—'}</td></tr> })}</tbody></table></div></div>
      <div className="card"><h3>History</h3><div className="feed">{fills.map((f) => <div className="it" key={f.sig}><span className={f.side === 'sell' ? 'dn' : 'up'} style={{ width: 52, fontWeight: 600 }}>{f.side.toUpperCase()}</span><span className="tk" style={{ width: 70 }}>{f.symbol}</span><span className="num" style={{ flex: 1 }}>{S(f.sol)} SOL</span><a className="dim" href={solscan(f.sig)} target="_blank" rel="noreferrer">{ago(f.t)} ↗</a></div>)}{!fills.length && <div className="empty">Your trades from this app appear here</div>}</div></div>
    </div>
  </>
}

export function SettingsPage({ s, set }: { s: Settings; set: (p: Partial<Settings>) => void }) {
  const [rpc, setRpc] = useState(s.rpc)
  return <div className="card" style={{ maxWidth: 560 }}><h3>Settings</h3><div className="panel">
    <div className="fld"><div className="lbl">RPC endpoint (Helius / Triton / QuickNode recommended for speed)</div><input value={rpc} onChange={(e) => setRpc(e.target.value)} /><div className="nm" style={{ marginTop: 4 }}>Applies after reload.</div></div>
    <div className="two"><div className="fld"><div className="lbl">Slippage %</div><input type="number" step={0.5} min={0.1} max={50} value={s.slippageBps / 100} onChange={(e) => set({ slippageBps: Math.round(+e.target.value * 100) })} /></div>
      <div className="fld"><div className="lbl">Priority fee (SOL)</div><input type="number" step={0.0001} min={0} value={s.priorityFeeSol} onChange={(e) => set({ priorityFeeSol: +e.target.value })} /></div></div>
    <div className="fld"><div className="lbl">Quick-buy size (SOL)</div><input type="number" step={0.05} min={0.01} value={s.quickBuy} onChange={(e) => set({ quickBuy: +e.target.value })} /></div>
    <div className="row"><span className="sp" /><button className="btn pri" onClick={() => { set({ rpc }); location.reload() }}>Save &amp; reload</button></div>
  </div></div>
}

export function About() {
  return <div className="prose">
    <h2>What's live right now</h2>
    <p>Every button on the board, coin page, launch modal and portfolio is a real Solana transaction signed by your wallet. Buys and sells on bonding-curve coins route through pump.fun via PumpPortal; graduated coins route through Jupiter. Launches create real pump.fun coins. Balances and holdings are read from the chain. Prices, charts and the board come from DexScreener; new launches and curve trades stream from pump.fun in real time.</p>
    <h2>Desk and vault — live, bot-run</h2>
    <p><b>Desk:</b> resting block bids 3–5% under spot on any graduated coin over $100K. A fill is one transaction signed by both seller and bidder; our server only matches and relays, it never holds funds. <b>Vault:</b> coins launched here with a stake get a vault wallet our bot runs under fixed rules — buys crashes, trims only above holder cost and 30-min VWAP, never withdraws, pays the dev cut. The vault is custodial in this beta (our bot holds the vault key); v1 moves it into an on-chain program.</p>
    <h2>Still a preview</h2>
    <p>The early-flip fee, burn-to-redeem and copies need the on-chain programs. They're computed and shown with a <span className="tag pre">PREVIEW</span> tag, not enforced. Your cost basis and hold clock are kept in this browser.</p>
    <h2>Fees</h2>
    <p>No platform fee from us in this beta. PumpPortal charges <code>0.5%</code> on curve trades; pump.fun charges its usual 1%. Jupiter routes carry only DEX LP fees. Network fees + your priority fee apply to everything.</p>
    <h2>Safety</h2>
    <p>Non-custodial: we never see keys. Set slippage and priority in Settings. Memecoins can go to zero; size accordingly. This is beta software — verify every transaction in your wallet before signing.</p>
  </div>
}
