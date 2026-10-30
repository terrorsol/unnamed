// A calm area chart for simple mode: smooth line, soft gradient, dotted grid, value pill on the right, finger-scrub to read any point.
// Plots market value (price × supply) because "$1.5M" reads better than "$0.0016".
import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { Coin } from '../lib/dex'
import * as K from '../lib/desk'
import { F } from '../lib/fmt'

export const RANGES: Record<string, { gecko: [string, number, number]; sec: number; n: number; label: string }> = {
  '1H': { gecko: ['minute', 1, 60], sec: 60, n: 60, label: 'past hour' },
  '1D': { gecko: ['minute', 15, 96], sec: 900, n: 96, label: 'past day' },
  '1W': { gecko: ['hour', 4, 42], sec: 3600, n: 168, label: 'past week' },
  '1M': { gecko: ['day', 1, 30], sec: 86400, n: 30, label: 'past month' },
  ALL: { gecko: ['day', 1, 365], sec: 86400, n: 365, label: 'all time' },
}
type Pt = { t: number; v: number }

async function load(coin: Coin, solPrice: number, r: string): Promise<Pt[]> {
  const R = RANGES[r]; const supply = 1e9
  // a coin minutes old has one 15-minute bar: step down to 1-minute, then 15-second bars until there is a line to draw
  const ours = async () => { for (const sec of [R.sec, 60, 15]) { if (sec > R.sec) continue; const b = (await K.candles(coin.mint, sec)).filter((x) => x.close > 0).slice(-Math.max(R.n, 60)).map((x) => ({ t: x.time * 1000, v: x.close * solPrice * supply })); if (b.length >= 6 || sec === 15) return b } return [] }
  if (coin.venue === 'launchlab' || !coin.pair) { const b = await ours().catch(() => []); if (b.length >= 2) return b }
  if (coin.pair) {
    const [path, agg, limit] = R.gecko
    const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${coin.pair}/ohlcv/${path}?aggregate=${agg}&limit=${limit}&currency=usd`, { headers: { accept: 'application/json' } }).catch(() => null)
    if (res && res.ok) { const d = await res.json().catch(() => null); const list: number[][] = d?.data?.attributes?.ohlcv_list || []; const pts = list.map(([ts, , , , c]) => ({ t: ts * 1000, v: c * supply })).sort((a, b) => a.t - b.t); if (pts.length >= 2) return pts }
  }
  return ours().catch(() => [])
}

export function AreaChart({ coin, solPrice, range, onRange, onChange, height = 220 }: { coin: Coin; solPrice: number; range: string; onRange: (r: string) => void; onChange?: (chg: number | null, scrub: Pt | null) => void; height?: number }) {
  const [pts, setPts] = useState<Pt[]>([]); const [loading, setLoading] = useState(true)
  const wrap = useRef<HTMLDivElement>(null); const cv = useRef<HTMLCanvasElement>(null); const [w, setW] = useState(360); const [hover, setHover] = useState<number | null>(null)
  useEffect(() => { let on = true; setLoading(true); const f = () => load(coin, solPrice, range).then((p) => { if (on) { setPts(p); setLoading(false) } }); f(); const i = setInterval(f, 30000); return () => { on = false; clearInterval(i) } }, [coin.mint, coin.pair, range, solPrice > 0])
  // the live value replaces the last point between refreshes
  const live = useMemo(() => { if (!pts.length || !coin.mcap) return pts; const p = pts.slice(); p[p.length - 1] = { ...p[p.length - 1], v: coin.mcap }; return p }, [pts, coin.mcap])
  useEffect(() => { if (!wrap.current) return; const ro = new ResizeObserver((e) => setW(Math.max(200, e[0].contentRect.width))); ro.observe(wrap.current); return () => ro.disconnect() }, [])
  const chg = live.length >= 2 ? (live[live.length - 1].v / live[0].v - 1) * 100 : null
  const up = (chg ?? 0) >= 0
  useEffect(() => { onChange?.(chg, hover != null ? live[hover] : null) }, [chg, hover, live])
  useEffect(() => {
    const c = cv.current; if (!c) return; const dpr = window.devicePixelRatio || 1; const H = height, W = w
    c.width = W * dpr; c.height = H * dpr; const ctx = c.getContext('2d')!; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H)
    // dotted grid
    ctx.fillStyle = 'rgba(255,255,255,.06)'; for (let x = 8; x < W; x += 16) for (let y = 8; y < H; y += 16) ctx.fillRect(x, y, 1, 1)
    if (live.length < 2) return
    const padR = 64, padT = 14, padB = 10, iw = W - padR, ih = H - padT - padB
    const vs = live.map((p) => p.v); let mn = Math.min(...vs), mx = Math.max(...vs); if (mx - mn < mx * 0.02) { mn *= 0.99; mx *= 1.01 }
    const X = (i: number) => (i / (live.length - 1)) * iw, Y = (v: number) => padT + (1 - (v - mn) / (mx - mn)) * ih
    const col = up ? '#86efac' : '#fb7185'
    // smooth path through midpoints
    const path = () => { ctx.beginPath(); ctx.moveTo(X(0), Y(vs[0])); for (let i = 1; i < vs.length; i++) { const xm = (X(i - 1) + X(i)) / 2, ym = (Y(vs[i - 1]) + Y(vs[i])) / 2; ctx.quadraticCurveTo(X(i - 1), Y(vs[i - 1]), xm, ym) } ctx.lineTo(X(vs.length - 1), Y(vs[vs.length - 1])) }
    path(); ctx.lineTo(iw, H); ctx.lineTo(0, H); ctx.closePath(); const g = ctx.createLinearGradient(0, padT, 0, H); g.addColorStop(0, up ? 'rgba(134,239,172,.28)' : 'rgba(251,113,133,.24)'); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.fill()
    path(); ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke()
    // right axis: 3 values
    ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.font = '11px Geist, system-ui, sans-serif'; ctx.textAlign = 'left'
    for (const k of [0, 0.5, 1]) { const v = mn + (mx - mn) * (1 - k); ctx.fillText(F(v), iw + 8, padT + k * ih + 4) }
    // last value: dashed line + pill
    const ly = Y(vs[vs.length - 1]); ctx.setLineDash([3, 4]); ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(iw, ly); ctx.stroke(); ctx.setLineDash([])
    ctx.beginPath(); ctx.arc(X(vs.length - 1), ly, 4, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill()
    const label = F(vs[vs.length - 1]); const tw = ctx.measureText(label).width + 14; const px0 = iw + 2, py0 = ly - 10
    ctx.fillStyle = col; ctx.beginPath(); (ctx as any).roundRect ? (ctx as any).roundRect(px0, py0, Math.min(tw, padR - 4), 20, 10) : ctx.rect(px0, py0, Math.min(tw, padR - 4), 20); ctx.fill()
    ctx.fillStyle = '#052e16'; ctx.font = '600 11px Geist, system-ui, sans-serif'; ctx.fillText(label, px0 + 7, ly + 4)
    // scrub
    if (hover != null && live[hover]) { const hx = X(hover), hy = Y(vs[hover]); ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.beginPath(); ctx.moveTo(hx, padT); ctx.lineTo(hx, H - padB); ctx.stroke(); ctx.beginPath(); ctx.arc(hx, hy, 5, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill() }
  }, [live, w, height, hover, up])
  const scrub = (e: React.PointerEvent) => { if (live.length < 2) return; const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); const iw = r.width - 64; const i = Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / iw)) * (live.length - 1)); setHover(i) }
  return <div className="ac">
    <div ref={wrap} className="ac-box" style={{ height }} onPointerDown={scrub} onPointerMove={(e) => (e.buttons || e.pointerType === 'mouse') && scrub(e)} onPointerUp={() => setHover(null)} onPointerLeave={() => setHover(null)}>
      <canvas ref={cv} style={{ width: '100%', height }} />
      {loading && !live.length && <div className="ac-empty">Loading chart…</div>}
      {!loading && live.length < 2 && <div className="ac-empty">No chart yet. Brand-new coins fill in after a few trades.</div>}
    </div>
    <div className="ac-chips">{Object.keys(RANGES).map((r) => <button key={r} className={r === range ? 'on' : ''} onClick={() => onRange(r)}>{r}</button>)}</div>
  </div>
}
