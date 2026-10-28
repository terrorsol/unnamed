import * as K from '../lib/desk'
import React, { useEffect, useState } from 'react'
import { Connection, VersionedTransaction } from '@solana/web3.js'
import type { Coin } from '../lib/dex'
import type { Holding } from '../lib/rpc'
import type { Fill, Lot } from '../lib/positions'
import { Pfp, Mc, Ch, Addr } from './ui'
import { F, S, ago, short } from '../lib/fmt'
import { solscan, confirmByPolling } from '../lib/rpc'
import type { Settings } from '../lib/store'
import { flipFee, FLIP_WINDOW_MIN } from '../lib/protocol'

function pnlCard(symbol: string, pnlSol: number, pct: number, held: string, solPrice: number) {
  const c = document.createElement('canvas'); c.width = 1200; c.height = 630; const x = c.getContext('2d')!
  x.fillStyle = '#0d0d0c'; x.fillRect(0, 0, 1200, 630); x.fillStyle = 'rgba(246,245,240,.07)'; x.fillRect(0, 0, 1200, 4)
  x.fillStyle = '#f3f2ec'; x.font = '700 34px Geist, sans-serif'; x.fillText('UNNAMED', 72, 90); x.fillStyle = 'rgba(243,242,236,.44)'; x.font = '500 26px Geist, sans-serif'; x.fillText('vaulted memecoin terminal', 240, 90)
  x.fillStyle = 'rgba(243,242,236,.66)'; x.font = '600 44px Geist, sans-serif'; x.fillText(symbol, 72, 220)
  x.fillStyle = pnlSol >= 0 ? '#3ecf8e' : '#f0556b'; x.font = '700 150px Geist, sans-serif'; x.fillText((pct >= 0 ? '+' : '') + pct.toFixed(0) + '%', 72, 380)
  x.fillStyle = '#f3f2ec'; x.font = '600 48px Geist, sans-serif'; x.fillText((pnlSol >= 0 ? '+' : '') + pnlSol.toFixed(2) + ' SOL  ·  $' + (Math.abs(pnlSol * solPrice)).toFixed(0), 72, 470)
  x.fillStyle = 'rgba(243,242,236,.44)'; x.font = '500 28px Geist, sans-serif'; x.fillText(held + ' · held ' + new Date().toLocaleDateString(), 72, 560)
  return c.toDataURL('image/png')
}
export function Portfolio({ sol, tokens, coins, lots, fills, solPrice, go, owner }: { sol: number | null; tokens: Holding[]; coins: Record<string, Coin>; lots: Record<string, Lot>; fills: Fill[]; solPrice: number; go: (p: string) => void; owner: string }) {
  if (!owner) return <div className="empty">Connect or unlock a wallet to see holdings</div>
  const rows = tokens.map((t) => { const c = coins[t.mint]; const val = c ? t.amount * c.priceUsd : 0; return { t, c, val, lot: lots[t.mint] } }).sort((a, b) => b.val - a.val)
  const tot = rows.reduce((a, r) => a + r.val, 0)
  const unreal = rows.reduce((a, r) => a + (r.lot && solPrice ? r.val / solPrice - r.lot.costSol : 0), 0)
  const dayAgo = Date.now() - 86400000; const realized = fills.filter((f) => f.side === 'sell').reduce((a, f) => a + f.sol, 0) - fills.filter((f) => f.side === 'buy' || f.side === 'create').reduce((a, f) => a + f.sol, 0)
  const today = fills.filter((f) => f.t > dayAgo).reduce((a, f) => a + (f.side === 'sell' ? f.sol : -f.sol), 0)
  return <>
    <div className="tiles" style={{ marginBottom: 14 }}>
      <div className="tile"><div className="l">Total</div><div className="v num">{F(tot + (sol || 0) * solPrice)}</div><div className="s num">{sol == null ? '—' : S(sol) + ' SOL'} cash · {F(tot)} tokens</div></div>
      <div className="tile"><div className="l">Unrealized</div><div className={'v num ' + (unreal >= 0 ? 'up' : 'dn')}>{unreal >= 0 ? '+' : ''}{S(unreal)} SOL</div><div className="s num">${S(Math.abs(unreal) * solPrice, 0)} · {rows.filter((r) => r.lot).length} tracked</div></div>
      <div className="tile"><div className="l">Net flow (all fills)</div><div className={'v num ' + (realized >= 0 ? 'up' : 'dn')}>{realized >= 0 ? '+' : ''}{S(realized)} SOL</div><div className="s">sells − buys, this browser</div></div>
      <div className="tile"><div className="l">Today</div><div className={'v num ' + (today >= 0 ? 'up' : 'dn')}>{today >= 0 ? '+' : ''}{S(today)} SOL</div><div className="s">{fills.filter((f) => f.t > dayAgo).length} fills</div></div>
      <div className="tile"><div className="l">Wallet</div><div className="v num" style={{ fontSize: 13 }}>{short(owner, 6)}</div><div className="s"><a href={`https://solscan.io/account/${owner}`} target="_blank" rel="noreferrer">solscan ↗</a></div></div>
    </div>
    <div className="lay">
      <div className="card"><h3>Holdings</h3><div style={{ overflowX: 'auto' }}><table><thead><tr><th>Token</th><th className="r">Amount</th><th className="r">Value</th><th className="r">Cost</th><th className="r">P&amp;L</th><th className="r">Held</th><th className="r">24h</th><th className="r"></th></tr></thead>
        <tbody>{rows.length === 0 && <tr><td colSpan={8} className="empty">No SPL tokens found</td></tr>}
          {rows.map(({ t, c, val, lot }) => { const vs = solPrice ? val / solPrice : 0; const pnl = lot ? vs - lot.costSol : 0; const hm = lot ? (Date.now() - lot.t) / 60000 : 999; const fee = flipFee(pnl, hm)
            return <tr key={t.mint} onClick={() => go('coin/' + t.mint)}>
              <td><div className="row"><Pfp c={c} mint={t.mint} /><div><div className="tk">{c?.symbol || lot?.symbol || short(t.mint, 3)}</div><div className="nm"><Addr a={t.mint} /></div></div></div></td>
              <td className="r num">{t.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
              <td className="r num">{c ? F(val) : <span className="dim">no market</span>}</td>
              <td className="r num">{lot ? S(lot.costSol) + ' SOL' : <span className="dim">—</span>}</td>
              <td className={'r num ' + (lot ? (pnl >= 0 ? 'up' : 'dn') : 'dim')}>{lot ? (pnl >= 0 ? '+' : '') + S(pnl) + ' SOL' : '—'}</td>
              <td className="r num dim">{lot ? ago(lot.t) : '—'}</td>
              <td className="r">{c ? <Ch v={c.ch24} /> : '—'}</td>
              <td className="r">{lot && c ? <button className="btn sm" onClick={(e) => { e.stopPropagation(); const url = pnlCard(c.symbol, pnl, lot.costSol ? (pnl / lot.costSol) * 100 : 0, t.amount.toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' ' + c.symbol, solPrice); const w = window.open(); if (w) { w.document.write('<body style="margin:0;background:#000"><img src="' + url + '" style="max-width:100%"></body>') } }}>Share</button> : null}</td></tr> })}</tbody></table></div></div>
      <div className="card"><h3>History</h3><div className="feed">{fills.map((f) => <div className="it" key={f.sig}><span className={f.side === 'sell' ? 'dn' : 'up'} style={{ width: 52, fontWeight: 600 }}>{f.side.toUpperCase()}</span><span className="tk" style={{ width: 70 }}>{f.symbol}</span><span className="num" style={{ flex: 1 }}>{S(f.sol)} SOL</span><a className="dim" href={solscan(f.sig)} target="_blank" rel="noreferrer">{ago(f.t)} ↗</a></div>)}{!fills.length && <div className="empty">Your trades from this app appear here</div>}</div></div>
    </div>
  </>
}

export function SettingsPage({ s, set, owner, signTx, conn }: { s: Settings; set: (p: Partial<Settings>) => void; owner?: string; signTx?: (t: VersionedTransaction) => Promise<VersionedTransaction>; conn?: Connection }) {
  const [rpc, setRpc] = useState(s.rpc)
  const [llp, setLlp] = useState<K.LLPlatform | null>(null); const [pst, setPst] = useState('')
  useEffect(() => { K.llPlatform().then(setLlp).catch(() => setLlp(null)) }, [pst])
  const setupPlatform = async () => {
    if (!owner || !signTx || !conn) return setPst('connect the admin wallet first')
    try { setPst('building…'); const { tx } = await K.llPlatformBuild(owner); setPst('sign…'); const signed = await signTx(VersionedTransaction.deserialize(Buffer.from(tx, 'base64'))); setPst('sending…'); const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 3 }); await confirmByPolling(conn, sig); setPst('done · ' + sig.slice(0, 8)) }
    catch (e: any) { setPst('failed: ' + String(e?.message || e).slice(0, 120)) }
  }
  const [srv, setSrv] = useState(localStorage.getItem('unnamed_server') || '')
  const [srvState, setSrvState] = useState<string>(''); const [adv, setAdv] = useState(false)
  const testSrv = async (u: string) => { setSrvState('…'); try { const r = await fetch(u.replace(/\/$/, '') + '/health'); const d = await r.json(); setSrvState(d.ok ? `up · ${d.vaults} vaults · desk ${d.desk?.openBids ?? 0} bids` : 'bad response') } catch { setSrvState('unreachable') } }
  return <div className="card" style={{ maxWidth: 560 }}><h3>Settings</h3><div className="panel">
    <div className="fld"><div className="lbl">Server</div><div className="row" style={{ gap: 6 }}><input placeholder={K.SERVER} value={srv} onChange={(e) => setSrv(e.target.value)} /><button className="btn sm" onClick={() => testSrv(srv || K.SERVER)}>Test</button></div><div className="nm" style={{ marginTop: 4 }}>{srvState || `Using ${K.SERVER}${K.SERVER_SOURCE === 'live' ? ' (auto-discovered live desk)' : ''}`}</div></div>
    <div className="two"><div className="fld"><div className="lbl">Slippage %</div><input type="number" step={0.5} min={0.1} max={50} value={s.slippageBps / 100} onChange={(e) => set({ slippageBps: Math.round(+e.target.value * 100) })} /></div>
      <div className="fld"><div className="lbl">Priority fee (SOL)</div><input type="number" step={0.0001} min={0} value={s.priorityFeeSol} onChange={(e) => set({ priorityFeeSol: +e.target.value })} /></div></div>
    <div className="two"><label className="row" style={{ gap: 8, fontSize: 12 }}><input type="checkbox" checked={s.autoFee} onChange={(e) => set({ autoFee: e.target.checked })} /> Auto priority fee (Helius estimate, High)</label><label className="row" style={{ gap: 8, fontSize: 12 }}><input type="checkbox" checked={s.mev} onChange={(e) => set({ mev: e.target.checked })} /> MEV protect: Jito tip on swaps ({s.jitoTipSol} SOL)</label></div>
    <div className="fld"><div className="lbl">Quick-buy size (SOL)</div><input type="number" step={0.05} min={0.01} value={s.quickBuy} onChange={(e) => set({ quickBuy: +e.target.value })} /></div>
    {llp && <div className="fld"><div className="lbl">Launchpad</div>
      {llp.chain?.exists ? <div className="nm">live · tax {(llp.chain.feeRate ?? 0).toFixed(2)}% → chests · creator {(llp.chain.creatorFeeRate ?? 0).toFixed(2)}% → dev · platform {llp.platformId?.slice(0, 8)}…</div>
        : !llp.platformId ? <div className="nm">server has no PLATFORM_ADMIN set — add your wallet address to the server env, then come back here</div>
        : owner && owner === llp.admin ? <div className="row" style={{ gap: 8 }}><button className="btn pri sm" onClick={setupPlatform} disabled={/…/.test(pst)}>Set up launchpad · 1 signature</button><span className="nm">tax {(llp.taxBps / 100).toFixed(1)}% → chests · creator {(llp.creatorFeeBps / 100).toFixed(2)}% → dev · {pst}</span></div>
        : <div className="nm">not set up yet · connect the admin wallet ({llp.admin?.slice(0, 6)}…) to create it</div>}
    </div>}
    <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setAdv(!adv)}>{adv ? 'Hide advanced' : 'Advanced'}</button>
    {adv && <div className="fld"><div className="lbl">RPC endpoint (Helius / Triton / QuickNode)</div><input value={rpc} onChange={(e) => setRpc(e.target.value)} /><div className="nm" style={{ marginTop: 4 }}>Applies after reload.</div></div>}
    <div className="row"><span className="sp" /><button className="btn pri" onClick={() => { set({ rpc }); if (srv.trim()) localStorage.setItem('unnamed_server', srv.trim().replace(/\/$/, '')); else localStorage.removeItem('unnamed_server'); location.reload() }}>Save &amp; reload</button></div>
  </div></div>
}

export function About() {
  return <div className="prose">
    <h2>Three things, one terminal</h2>
    <p><b>Vault.</b> A coin's own market maker, owned by its holders. Half the stake buys supply in the launch block, half sits in a chest. When a buy stretches the price, the vault sells a small slice into it and parks that SOL under the price — as a desk bid and as dip buys at −20 / −35 / −50%. It never withdraws. Timing, size and levels are randomized so it can't be front-run.</p>
    <p><b>Desk.</b> Off-chart trading on any coin that clears the gate (graduated and ≥ $100K, or on the curve and ≥ $50K, with $5K/h of volume). Rest a bid 1–15% under spot, or a sell offer up to 15% either side. A fill is one transaction both sides sign — no candle, no slippage. Partial fills down to the min block. Names on the book are pseudonymous.</p>
    <p><b>Vamps &amp; runners.</b> The home board scores every live coin: a <span className="tag pre">VAMP</span> tag means a younger, smaller copy of a coin that's moving — same ticker or name, launched inside its window, often the same deployer wallet or image — with a one-tap switch to the original. 🔥 marks runners by aged market cap × volume × buy pressure.</p>
    <h2>What's live right now</h2>
    <p>Every button is a real Solana transaction signed by your wallet. Curve coins route through pump.fun (via PumpPortal), graduated coins through Jupiter, landed through Helius Sender with a dual RPC route. Launches create real pump.fun coins with the vault in block zero via a Jito bundle. Prices come straight from the pool, not an indexer.</p>
    <h2>Fees</h2>
    <p>Desk fills pay 0.5% to the treasury. No fee on trades from us. pump.fun takes 1%, PumpPortal 0.5% on curve trades; Jupiter routes carry only LP fees. Network and priority fees apply to everything.</p>
    <h2>Custody</h2>
    <p>Trading and the desk are non-custodial — we never see your keys. Vaults are run by a bot wallet in this beta: every signature passes a policy gate (purpose allowlist, per-transaction and hourly caps, never a withdrawal) and the chest is capped at 25 SOL per vault. Memecoins can go to zero; size accordingly, and read every transaction in your wallet before signing.</p>
  </div>
}
