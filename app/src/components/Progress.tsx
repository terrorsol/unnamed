import React, { useEffect, useRef, useState } from 'react'
import type { Coin } from '../lib/dex'
import type * as K from '../lib/desk'
import { confetti } from '../hooks'
import { coinRain } from '../lib/fx'
import { F, S, ago } from '../lib/fmt'
import { ChestArt } from './Simple'

/** The value milestones a coin climbs through. Same ladder the creator unlocks use. */
export const MILESTONES = [50_000, 150_000, 250_000, 500_000, 1_000_000, 5_000_000, 10_000_000]

/** where a value sits on the ladder: previous step, next step, and how far between them (0..1) */
export function ladder(mcap: number) {
  const v = Math.max(0, mcap || 0)
  const i = MILESTONES.findIndex((m) => v < m)
  if (i < 0) return { prev: MILESTONES[MILESTONES.length - 1], next: 0, frac: 1, done: MILESTONES.length }
  const prev = i === 0 ? 0 : MILESTONES[i - 1], next = MILESTONES[i]
  return { prev, next, frac: Math.min(1, Math.max(0, (v - prev) / (next - prev))), done: i }
}

/** a number that rolls to its new value instead of jumping */
function useRoll(target: number, ms = 900) {
  const [v, setV] = useState(target); const from = useRef(target); const raf = useRef(0)
  useEffect(() => {
    if (!Number.isFinite(target)) return
    const start = performance.now(), a = from.current, b = target
    cancelAnimationFrame(raf.current)
    const step = (t: number) => { const k = Math.min(1, (t - start) / ms); const e = 1 - Math.pow(1 - k, 3); setV(a + (b - a) * e); if (k < 1) raf.current = requestAnimationFrame(step); else from.current = b }
    raf.current = requestAnimationFrame(step); return () => cancelAnimationFrame(raf.current)
  }, [target])
  return v
}
/** true for a moment whenever the value goes up */
function useBump(v: number) {
  const [on, setOn] = useState(false); const last = useRef(v)
  useEffect(() => { if (v > last.current + 1e-9) { setOn(true); const t = setTimeout(() => setOn(false), 1200); last.current = v; return () => clearTimeout(t) } last.current = v }, [v])
  return on
}

const ic = (d: React.ReactNode) => <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d}</svg>
const IC = {
  shield: ic(<><path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></>),
  up: ic(<><path d="M4 16 10 10l4 4 6-7" /><path d="M15 7h5v5" /></>),
  coin: ic(<><circle cx="12" cy="12" r="8" /><path d="M9.5 9.5h4a1.75 1.75 0 0 1 0 3.5h-3a1.75 1.75 0 0 0 0 3.5h4M12 7.5v1.5M12 16.5V18" /></>),
  bank: ic(<><path d="M3 9.5 12 4l9 5.5H3Z" /><path d="M5 9.5v8M9.5 9.5v8M14.5 9.5v8M19 9.5v8M3 20h18" /></>),
  hand: ic(<><path d="M7 12V7a1.5 1.5 0 0 1 3 0v4M10 11V5.5a1.5 1.5 0 0 1 3 0V11M13 11V6.5a1.5 1.5 0 0 1 3 0V12" /><path d="M16 9.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-1a6 6 0 0 1-5-2.7L4 15.5a1.5 1.5 0 0 1 2.5-1.6L7 15" /></>),
  lock: ic(<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>),
  chest: <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden><path d="M3 10a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v9H3v-9Z" /><path d="M3 12h18" /><rect x="10" y="10.5" width="4" height="4" rx="1" /></svg>,
}
const MOVE: Record<string, [React.ReactNode, string]> = { buy: [IC.shield, 'bought the dip'], capture: [IC.up, 'took profit on a pump'], tax: [IC.coin, 'fees added to the chest'], redeem: [IC.bank, 'someone cashed out at the floor'], bid: [IC.hand, 'ready to buy big sells'], stake: [IC.lock, 'got funded'], seed: [IC.lock, 'got funded'] }

/** The one card a normal person needs: how close this coin is to its next milestone, how big its chest is, and what the chest just did. */
export function ProgressCard({ coin, vault, solPrice, held = 0, simple = false }: { coin: Coin; vault?: K.VaultPub | null; solPrice: number; held?: number; simple?: boolean }) {
  const mcap = coin.mcap || 0
  const L = ladder(mcap)
  const seen = useRef<number | null>(null)
  // confetti when this coin crosses a milestone while you're watching (not on first paint)
  useEffect(() => { if (seen.current != null && L.done > seen.current) { confetti(); coinRain() } seen.current = L.done }, [L.done])
  const chest = vault?.chest || 0, chestUsd = chest * solPrice
  const chestRoll = useRoll(chest), bump = useBump(chest)
  const backs = mcap > 0 ? Math.min(100, (chestUsd / mcap) * 100) : 0
  const myFloorSol = vault && held > 0 ? (held / (vault.supply || 1e9)) * chest * 0.93 : 0
  const last = vault?.activity?.find((a) => MOVE[a.kind])
  const fees = vault?.taxClaimed || 0
  const feed = (vault?.activity || []).filter((a) => a.kind === 'capture' || a.kind === 'tax' || a.kind === 'buy').slice(0, 4)
  return <div className="card prog">
    <div className="prog-hd"><span className="lbl" style={{ margin: 0 }}>{simple ? 'Next goal' : 'Next milestone'}</span><span className="sp" /><b className="num">{L.next ? F(L.next) : 'every milestone hit'}</b></div>
    <div className="prog-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(L.frac * 100)}><i style={{ width: `${Math.max(2, L.frac * 100)}%` }} /></div>
    <div className="prog-steps">{MILESTONES.slice(0, 4).map((m) => <span key={m} className={mcap >= m ? 'hit' : ''}>{F(m)}</span>)}</div>
    <div className="nm">{L.next ? <>Worth <b className="num">{F(mcap)}</b> now · <b className="num">{Math.round(L.frac * 100)}%</b> of the way to {F(L.next)}</> : <>Worth <b className="num">{F(mcap)}</b></>}</div>
    {vault ? <div className={'prog-chest' + (bump ? ' bump' : '')}>
      <div className="prog-ico">{simple ? <ChestArt size={44} bump={bump} fill={backs / 100} /> : IC.chest}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="row" style={{ gap: 6 }}><span className="lbl" style={{ margin: 0 }}>{simple ? 'Safety chest' : 'Chest'}</span><span className="sp" /><b className="num" style={{ fontSize: 18 }}>{S(chestRoll, 2)} SOL</b></div>
        <div className="prog-fill"><i style={{ width: `${Math.max(2, backs)}%` }} /></div>
        <div className="nm">${S(chestUsd, 0)} · backs {backs < 1 ? backs.toFixed(1) : backs.toFixed(0)}% of the coin's value · {fees > 0 ? `${S(fees, 3)} SOL from fees so far` : '2% of every trade adds to it'}</div>
      </div>
    </div> : <div className="nm" style={{ marginTop: 8 }}>No chest on this coin yet.</div>}
    {vault && (vault.vaultBuySol || 0) >= 0.05 && (() => { const back = Math.min(vault.vaultBuySol!, vault.mm?.inv || 0); const f = back / vault.vaultBuySol!
      // the chest's own launch buy, paid back out of the snipers' and buyers' flow: the number that says the chest is not a bag
      return <div className="prog-back"><div className="row" style={{ gap: 6 }}><span className="lbl" style={{ margin: 0 }}>Launch buy paid back</span><span className="sp" /><b className="num">{S(back, 2)} / {S(vault.vaultBuySol!, 2)} SOL</b></div>
        <div className="prog-fill back"><i style={{ width: `${Math.max(2, f * 100)}%` }} /></div>
        <div className="nm">{f >= 0.999 ? 'All of it — every coin the chest still holds is free' : 'sold into incoming buys, a slice of each, never into a dump'}</div></div> })()}
    {vault?.sniper && vault.sniper.buys > 0 && <div className="prog-snipe">
      <div className="row" style={{ gap: 6 }}><span className="lbl" style={{ margin: 0 }}>Sniper report · first minute</span><span className="sp" /><b className="num">{S(vault.sniper.buySol, 2)} SOL in</b></div>
      <div className="nm">{vault.sniper.buys} buys from {vault.sniper.wallets} wallet{vault.sniper.wallets === 1 ? '' : 's'}{vault.sniper.blockZeroSol > 0 ? ` · ${S(vault.sniper.blockZeroSol, 2)} SOL in the launch block` : ''}{vault.sniper.sellSol > 0 ? ` · ${S(vault.sniper.sellSol, 2)} SOL sold back` : ''} · <b className="up">the chest sold {S(vault.sniper.soldInto, 3)} SOL into them</b></div>
      <a className="prog-post" target="_blank" rel="noreferrer" href={'https://x.com/intent/post?text=' + encodeURIComponent(`Snipers put ${S(vault.sniper.buySol, 1)} SOL into $${coin.symbol} in its first minute. Its chest sold ${S(vault.sniper.soldInto, 2)} SOL into them.\n\nbanker.cash`) + '&url=' + encodeURIComponent('https://app.banker.cash/#/coin/' + coin.mint)}>Post the sniper report ↗</a>
    </div>}
    {vault && myFloorSol > 0 && <div className="kv" style={{ marginTop: 6 }}><span>Your coins at the floor</span><b className="num up">≈ {S(myFloorSol, 4)} SOL (${S(myFloorSol * solPrice, 2)})</b></div>}
    {vault && feed.length >= 2 && (() => { const moves = feed
      return <div className="prog-feed"><span className="lbl" style={{ margin: 0 }}>What the chest did</span>{moves.map((a, i) => <div key={i} className="prog-fi"><span className="prog-mv">{MOVE[a.kind]?.[0]}</span><span className="pf-t">{a.kind === 'capture' ? (a.msg?.match(/sold into a ([\d.]+) SOL buy/) ? `sold into a ${a.msg!.match(/sold into a ([\d.]+) SOL buy/)![1]} SOL buy` : 'took profit on a pump') : MOVE[a.kind]?.[1]}</span><span className="sp" /><b className="num">{a.kind === 'buy' ? '−' : '+'}{S(a.sol || 0, 3)}</b><span className="nm">{ago(a.t)}</span></div>)}</div> })()}
    {last && feed.length < 2 && <div className="prog-last"><span className="prog-mv">{MOVE[last.kind][0]}</span><span>The chest {MOVE[last.kind][1]}{last.sol ? ` · ${S(last.sol, 3)} SOL` : ''}</span><span className="sp" /><span className="nm">{ago(last.t)} ago</span></div>}
  </div>
}
