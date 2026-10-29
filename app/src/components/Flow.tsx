// The buy/sell flow for simple mode: a pinned action bar, a bottom sheet in dollars, slide-to-confirm, and a success moment.
// Every step answers "what happens if I do this?" before you commit, and rewards you when it lands.
import React, { useEffect, useRef, useState } from 'react'
import type { Coin } from '../lib/dex'
import { onToast, loadSettings } from '../lib/store'
import type * as K from '../lib/desk'
import { Pfp } from './ui'
import { nativeHaptic } from '../lib/native'
import { burstFrom, coinBurst } from '../lib/fx'
import { S, money } from '../lib/fmt'
import { USD_PRESETS, Ic } from './Simple'

/** a short buzz on phones that support it (ignored elsewhere) */
export const haptic = (ms: number | number[] = 12) => { if (nativeHaptic(ms)) return; try { (navigator as any).vibrate?.(ms) } catch {} }

/** a number that rolls to its new value */
export function Roll({ v, fmt, from0 }: { v: number; fmt: (n: number) => string; from0?: boolean }) {
  const [x, setX] = useState(from0 ? 0 : v); const from = useRef(from0 ? 0 : v); const raf = useRef(0)
  useEffect(() => { const a = from.current, b = v, t0 = performance.now(); cancelAnimationFrame(raf.current); const f = (t: number) => { const k = Math.min(1, (t - t0) / (from0 && a === 0 ? 900 : 450)); const e = 1 - Math.pow(1 - k, 3); setX(a + (b - a) * e); if (k < 1) raf.current = requestAnimationFrame(f); else from.current = b }; raf.current = requestAnimationFrame(f); return () => cancelAnimationFrame(raf.current) }, [v])
  return <span className="num">{fmt(x)}</span>
}

/** slide the knob all the way to confirm; snaps back if you let go early */
export function SlideToConfirm({ label, onConfirm, disabled, tone = 'buy' }: { label: string; onConfirm: () => void; disabled?: boolean; tone?: 'buy' | 'sell' }) {
  const track = useRef<HTMLDivElement>(null); const [x, setX] = useState(0); const [drag, setDrag] = useState(false); const start = useRef(0); const done = useRef(false)
  const max = () => (track.current ? track.current.clientWidth - 56 : 240)
  const down = (e: React.PointerEvent) => { if (disabled) return; (e.target as HTMLElement).setPointerCapture?.(e.pointerId); setDrag(true); start.current = e.clientX - x; done.current = false; haptic(8) }
  const move = (e: React.PointerEvent) => { if (!drag) return; const nx = Math.max(0, Math.min(max(), e.clientX - start.current)); setX(nx); if (nx >= max() - 2 && !done.current) { done.current = true; haptic([18, 30, 18]); setDrag(false); setX(max()); onConfirm() } }
  const up = () => { if (!done.current) setX(0); setDrag(false) }
  useEffect(() => { if (!disabled && done.current) { const t = setTimeout(() => { setX(0); done.current = false }, 900); return () => clearTimeout(t) } }, [disabled])
  const p = Math.min(1, x / Math.max(1, max()))
  return <div ref={track} className={'slide ' + tone + (disabled ? ' off' : '')} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
    <div className="slide-fill" style={{ width: x + 56 }} />
    <span className="slide-lbl" style={{ opacity: 1 - p * 0.9 }}>{label}</span>
    <div className={'slide-knob' + (drag ? ' drag' : '')} style={{ transform: `translateX(${x}px)` }} onPointerDown={down} role="button" aria-label={label}>
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
    </div>
  </div>
}

type SheetProps = { coin: Coin; side: 'buy' | 'sell'; solPrice: number; held: number; balSol: number | null; connected: boolean; busy: string; vault?: K.VaultPub | null
  onClose: () => void; needWallet: () => void; buy: (sol: number) => Promise<unknown> | void; sell: (frac: number) => Promise<unknown> | void }

/** the app's progress words, in plain English */
const plain = (b: string) => !b ? 'Sending…' : /quot|jupiter|route/i.test(b) ? 'Finding the best price…' : /sign/i.test(b) ? 'Waiting for your wallet…' : /confirm|land|send/i.test(b) ? 'Locking it in…' : b
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'del']
const fmtTok = (n: number) => (n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(0))

/** the trade sheet (a bet slip): pick dollars on a keypad, see exactly what you get and what it costs, slide to confirm, get a receipt */
export function TradeSheet(p: SheetProps) {
  const [amt, setAmt] = useState('10'); const [frac, setFrac] = useState(1); const [state, setState] = useState<'pick' | 'sending' | 'done' | 'err'>('pick'); const [err, setErr] = useState('')
  const [bounce, setBounce] = useState(0); const [details, setDetails] = useState(false); const fresh = useRef(true)
  const st = loadSettings()
  const usd = Math.min(100000, parseFloat(amt) || 0)
  const sol = p.solPrice ? usd / p.solPrice : 0
  const tokens = p.coin.priceUsd ? usd / p.coin.priceUsd : 0
  const sellUsd = p.held * frac * (p.coin.priceUsd || 0)
  const balUsd = p.balSol != null ? p.balSol * p.solPrice : null
  const speedUsd = ((st.priorityFeeSol || 0) + (st.mev ? st.jitoTipSol || 0 : 0)) * p.solPrice
  const short = p.side === 'buy' && balUsd != null && usd > balUsd - speedUsd
  const pick = (u: number, el?: Element) => { setAmt(String(u)); fresh.current = true; setBounce((b) => b + 1); haptic(6); if (el) burstFrom(el, 5) }
  const pickF = (f: number) => { setFrac(f); setBounce((b) => b + 1); haptic(6) }
  const key = (k: string) => { haptic(4); const f = fresh.current; fresh.current = false; setAmt((a0) => { const a = f && k !== 'del' ? '0' : a0; if (k === 'del') return a.length > 1 ? a.slice(0, -1) : '0'; if (k === '.') return a.includes('.') ? a : a + '.'; if (a.includes('.') && a.split('.')[1].length >= 2) return a; const n = a === '0' ? k : a + k; return parseFloat(n) > 100000 ? a : n }); setBounce((b) => b + 1) }
  const go = async () => {
    if (!p.connected) { p.needWallet(); return }
    setState('sending'); setErr('')
    // the app reports every trade with a toast ("Bought …" / "Buy failed"); the sheet reads that instead of guessing
    let res: 'ok' | 'err' | null = null; let why = ''
    const off = onToast((t) => { if (t.kind === 'ok' && /^(Bought|Sold)\b/.test(t.title)) res = 'ok'; else if (t.kind === 'err' && /(Buy|Sell) failed/.test(t.title)) { res = 'err'; why = t.rows?.[0]?.[1] || '' } })
    try { if (p.side === 'buy') await p.buy(+sol.toFixed(4)); else await p.sell(frac) } catch (e: any) { res = 'err'; why = String(e?.message || e) } finally { off() }
    if (res === 'ok') { setState('done'); haptic([20, 40, 60]); if (p.side === 'buy') setTimeout(() => coinBurst(innerWidth / 2, innerHeight * 0.42, 12), 180) }
    else if (res === 'err') { setState('err'); setErr(why.slice(0, 120)); haptic([60, 40, 60]) }
    else setState('pick')
  }
  return <div className="modal s-sheet-bg" onClick={() => state !== 'sending' && p.onClose()}>
    <div className="s-sheet trade" onClick={(e) => e.stopPropagation()}>
      <div className="s-grab" />
      {state === 'done' ? <div className="ts-done">
        <div className="ts-vault"><span className="ts-ring" /><span className="ts-ring r2" /><div className="ts-check"><svg viewBox="0 0 52 52" width="64" height="64"><circle cx="26" cy="26" r="24" fill="none" stroke="currentColor" strokeWidth="3" /><path d="M15 27l7 7 15-16" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" /></svg></div></div>
        <div className="ts-done-t">{p.side === 'buy' ? <>You own ${money(usd, usd % 1 ? 2 : 0)} of {p.coin.symbol}</> : <>Sold · ${money(sellUsd)} on its way</>}</div>
        <div className="ts-receipt">
          {p.side === 'buy' ? <><div className="kv"><span>Paid</span><b className="num">${money(usd)} · {S(sol, 4)} SOL</b></div><div className="kv"><span>Got</span><b className="num">≈ {fmtTok(tokens)} {p.coin.symbol}</b></div>{p.vault && <div className="kv"><span>Chest behind it</span><b className="num gold">{S(p.vault.chest, 2)} SOL</b></div>}</>
            : <><div className="kv"><span>Sold</span><b className="num">{Math.round(frac * 100)}% of your {p.coin.symbol}</b></div><div className="kv"><span>Back to your wallet</span><b className="num">≈ ${S(sellUsd, 2)}</b></div></>}
        </div>
        <div className="dim">{p.side === 'buy' ? 'It shows up in My coins in a few seconds.' : 'The SOL lands in your wallet in a few seconds.'}</div>
        <div className="ts-done-cta"><button className="btn pri big" onClick={p.onClose}>Done</button>{p.side === 'buy' && <a className="btn big ghost" href="#/portfolio" onClick={p.onClose}>My coins</a>}</div>
      </div> : <>
        <div className="ts-hd"><Pfp c={p.coin} /><b>{p.side === 'buy' ? 'Buy' : 'Sell'} {p.coin.symbol}</b><span className="sp" /><span className="dim num">{p.side === 'buy' ? (balUsd != null ? `$${money(balUsd)} available` : '') : `$${money(p.held * (p.coin.priceUsd || 0))} owned`}</span></div>
        <div className={'ts-amt num' + (short ? ' short' : '') + (amt.length > 6 ? ' long' : '')} key={bounce}>{p.side === 'buy' ? <>${amt.includes('.') ? money(Math.floor(+amt.split('.')[0] || 0), 0) + '.' + amt.split('.')[1] : money(+amt || 0, 0)}</> : <Roll v={sellUsd} fmt={(n) => '$' + n.toFixed(2)} />}</div>
        <div className="ts-sub num">{p.side === 'buy' ? <>≈ <Roll v={tokens} fmt={fmtTok} /> {p.coin.symbol}</> : <>{Math.round(frac * 100)}% of your {p.coin.symbol}</>}</div>
        <div className="ts-chips">{p.side === 'buy' ? USD_PRESETS.map((u) => <button key={u} className={usd === u ? 'on' : ''} onClick={(e) => pick(u, e.currentTarget)}>${u}</button>) : [0.25, 0.5, 0.75, 1].map((f) => <button key={f} className={frac === f ? 'on' : ''} onClick={() => pickF(f)}>{f === 1 ? 'All' : f * 100 + '%'}</button>)}</div>
        {p.side === 'buy' && <div className="ts-keys">{KEYS.map((k) => <button key={k} onClick={() => key(k)} aria-label={k === 'del' ? 'Delete' : k}>{k === 'del' ? <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6-7 6-7Z" /><path d="m12 9 5 5M17 9l-5 5" /></svg> : k}</button>)}</div>}
        <button className={'ts-det' + (details ? ' on' : '')} onClick={() => setDetails((d) => !d)}>
          <span className="ts-det-sum">{p.vault ? <span className="gold">Chest-protected</span> : <span>No chest</span>}<i>·</i><span>max slippage {(st.slippageBps / 100).toFixed(st.slippageBps % 100 ? 1 : 0)}%</span>{st.mev && <><i>·</i><span className="up">fast lane</span></>}</span>
          <span className="sp" /><span className="ts-det-chev">{details ? '−' : '+'}</span>
        </button>
        {details && <div className="ts-det-body">
          {p.side === 'buy' && <div className="kv"><span>You pay</span><b className="num">${money(usd)} · {S(sol, 4)} SOL</b></div>}
          <div className="kv"><span>Speed fee</span><b className="num">≈ ${S(speedUsd, 3)}</b></div>
          <div className="kv"><span>Price can move at most</span><b className="num">{(st.slippageBps / 100).toFixed(1)}% before it cancels</b></div>
          {p.vault && <div className="kv"><span>Into the chest</span><b className="num">2% of the trade</b></div>}
          <div className="kv"><span>Who holds your money</span><b>You. Your wallet signs.</b></div>
        </div>}
        {short && <div className="ts-warn">That's more than your wallet holds right now.</div>}
        {state === 'err' && <div className="ts-warn">{err || 'That didn\'t confirm. Check My coins before you try again.'}</div>}
        {!p.connected ? <button className="btn pri big" onClick={p.needWallet}>Connect wallet to {p.side}</button>
          : state === 'sending' ? <div className="slide sending"><span className="slide-lbl">{plain(p.busy)}</span><span className="slide-spin" /></div>
          : <SlideToConfirm tone={p.side} label={p.side === 'buy' ? `Slide to buy $${money(usd, usd % 1 ? 2 : 0)}` : `Slide to sell ${Math.round(frac * 100)}%`} disabled={(p.side === 'buy' && (usd <= 0 || short)) || (p.side === 'sell' && !p.held)} onConfirm={go} />}
        <div className="ts-foot">{Ic.lock(12)} Your wallet signs it. BANKER never holds your money.</div>
      </>}
    </div>
  </div>
}

/** the bar pinned to the bottom of a coin: Buy (opens the sheet), Sell when you hold, and ⚡ to buy $10 in one slide */
export function ActionBar({ held, onBuy, onSell, onQuick, quickUsd = 10 }: { held: number; onBuy: () => void; onSell: () => void; onQuick: () => void; quickUsd?: number }) {
  return <div className="s-actbar">
    {held > 0 && <button className="act sell" onClick={() => { haptic(8); onSell() }}>Sell</button>}
    <button className="act buy" onClick={(e) => { haptic(8); burstFrom(e.currentTarget, 10); onBuy() }}><span className="act-shine" />Buy</button>
    <button className="act quick" onClick={(e) => { haptic(8); burstFrom(e.currentTarget, 8); onQuick() }} aria-label={`Quick buy $${quickUsd}`}><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden><path d="M13.5 2 4 13.5h7L9.5 22 20 9.5h-7L13.5 2Z" /></svg><span>${quickUsd}</span></button>
  </div>
}
