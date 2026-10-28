import React, { useEffect, useRef, useState } from 'react'
import { createChart, type IChartApi, type ISeriesApi, type UTCTimestamp, CrosshairMode } from 'lightweight-charts'
import type { Coin } from '../lib/dex'
import * as D from '../lib/dex'
import type { VaultPub } from '../lib/desk'
import type { Fill, Lot } from '../lib/positions'
import type { Order } from '../lib/orders'
import type { TradeEvt } from '../lib/pumpportal'

type Bar = { time: UTCTimestamp; open: number; high: number; low: number; close: number; volume: number }
const TF: Record<string, { path: string; agg: number; sec: number }> = { '1m': { path: 'minute', agg: 1, sec: 60 }, '5m': { path: 'minute', agg: 5, sec: 300 }, '15m': { path: 'minute', agg: 15, sec: 900 }, '1h': { path: 'hour', agg: 1, sec: 3600 } }

/** Tiny live sparkline: last ~90 minutes of closes, refreshed every 30s. Used on the desk so you never trade blind. */
export function Spark({ pool, tone }: { pool?: string; tone: 'up' | 'dn' | '' }) {
  const ref = React.useRef<HTMLCanvasElement>(null); const [pts, setPts] = React.useState<number[]>([])
  React.useEffect(() => { if (!pool) return; let on = true; const f = () => fetch(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/minute?aggregate=1&limit=90&currency=usd`, { headers: { accept: 'application/json' } }).then((r) => r.json()).then((d) => { if (!on) return; const l: number[][] = d?.data?.attributes?.ohlcv_list || []; setPts(l.sort((a, b) => a[0] - b[0]).map((x) => x[4])) }).catch(() => {}); f(); const i = setInterval(f, 30000); return () => { on = false; clearInterval(i) } }, [pool])
  React.useEffect(() => { const c = ref.current; if (!c || pts.length < 2) return; const dpr = devicePixelRatio || 1; const W = c.clientWidth, H = c.clientHeight; c.width = W * dpr; c.height = H * dpr; const ctx = c.getContext('2d')!; ctx.scale(dpr, dpr); ctx.clearRect(0, 0, W, H)
    const mn = Math.min(...pts), mx = Math.max(...pts); const y = (v: number) => H - 3 - ((v - mn) / Math.max(1e-12, mx - mn)) * (H - 6); const col = getComputedStyle(c).getPropertyValue(tone === 'dn' ? '--dn' : '--up').trim() || '#2bd46a'
    ctx.beginPath(); pts.forEach((v, i) => { const x = (i / (pts.length - 1)) * W; i ? ctx.lineTo(x, y(v)) : ctx.moveTo(x, y(v)) }); ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.stroke()
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath(); ctx.fillStyle = col + '22'; ctx.fill() }, [pts, tone])
  return <canvas ref={ref} style={{ width: '100%', height: 44, display: 'block' }} />
}
async function gecko(pool: string, tf: string): Promise<Bar[]> {
  const t = TF[tf]
  const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/${t.path}?aggregate=${t.agg}&limit=300&currency=usd`, { headers: { accept: 'application/json' } })
  if (!r.ok) throw new Error('ohlcv ' + r.status)
  const d = await r.json(); const list: number[][] = d?.data?.attributes?.ohlcv_list || []
  return list.map(([ts, o, h, l, c, v]) => ({ time: ts as UTCTimestamp, open: o, high: h, low: l, close: c, volume: v })).sort((a, b) => a.time - b.time)
}

export default function Chart({ coin, solPrice, vault, fills, lot, orders, trades, owner }: { coin: Coin; solPrice: number; vault?: VaultPub | null; fills: Fill[]; lot?: Lot; orders: Order[]; trades: TradeEvt[]; owner: string }) {
  const el = useRef<HTMLDivElement>(null); const chart = useRef<IChartApi | null>(null); const cs = useRef<ISeriesApi<'Candlestick'> | null>(null); const vs = useRef<ISeriesApi<'Histogram'> | null>(null)
  const [tf, setTf] = useState<string>(() => { try { return localStorage.getItem('unnamed_tf') || '1m' } catch { return '1m' } })
  const [bars, setBars] = useState<Bar[]>([]); const [fallback, setFallback] = useState(false); const [legend, setLegend] = useState('')
  const lines = useRef<any[]>([])
  // chart instance
  useEffect(() => {
    if (!el.current) return
    const c = createChart(el.current, { localization: { locale: 'en-US' }, layout: { background: { color: '#000000' }, textColor: 'rgba(255,255,255,.5)', fontFamily: 'Geist, sans-serif', fontSize: 11 }, grid: { vertLines: { color: 'rgba(255,255,255,.04)' }, horzLines: { color: 'rgba(255,255,255,.04)' } }, crosshair: { mode: CrosshairMode.Normal }, rightPriceScale: { borderColor: 'rgba(255,255,255,.08)' }, timeScale: { borderColor: 'rgba(255,255,255,.08)', timeVisible: true, secondsVisible: false }, autoSize: true })
    const s = c.addCandlestickSeries({ upColor: '#26a69a', downColor: '#ef5350', borderVisible: false, wickUpColor: '#26a69a', wickDownColor: '#ef5350', priceFormat: { type: 'price', precision: 8, minMove: 0.00000001 } })
    const v = c.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', color: 'rgba(255,255,255,.18)' }); c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })
    c.subscribeCrosshairMove((p) => { const b = p.seriesData.get(s) as any; if (b) setLegend(`O ${b.open.toPrecision(4)}  H ${b.high.toPrecision(4)}  L ${b.low.toPrecision(4)}  C ${b.close.toPrecision(4)}`); else setLegend('') })
    chart.current = c; cs.current = s; vs.current = v
    return () => { c.remove(); chart.current = null }
  }, [])
  // history
  useEffect(() => {
    let on = true; setBars([]); setFallback(false)
    if (!coin.pair) { setFallback(true); return }
    const load = () => gecko(coin.pair!, tf).then((b) => { if (!on) return; if (!b.length) { setFallback(true); return } setBars(b) }).catch(() => on && setFallback(true))
    load(); const i = setInterval(load, 20000); return () => { on = false; clearInterval(i) }
  }, [coin.pair, tf])
  // live tick: fold the latest price into the last bar between refreshes
  useEffect(() => {
    if (!bars.length || !coin.priceUsd) return
    const sec = TF[tf].sec; const now = Math.floor(Date.now() / 1000); const bucket = (Math.floor(now / sec) * sec) as UTCTimestamp
    setBars((b) => { const last = b[b.length - 1]; const px = coin.priceUsd; if (!last) return b
      if (last.time === bucket) { const nb = { ...last, close: px, high: Math.max(last.high, px), low: Math.min(last.low, px) }; return [...b.slice(0, -1), nb] }
      if (bucket > last.time) return [...b, { time: bucket, open: last.close, high: Math.max(last.close, px), low: Math.min(last.close, px), close: px, volume: 0 }]
      return b })
  }, [coin.priceUsd])
  // curve coins: real trades from the stream tick the last bar with volume
  useEffect(() => {
    const t = trades[0]; if (!t || t.mint !== coin.mint || !bars.length || !solPrice) return
    const px = (t.mcapSol * solPrice) / 1e9; const sec = TF[tf].sec; const bucket = (Math.floor(t.ts / 1000 / sec) * sec) as UTCTimestamp
    setBars((b) => { const last = b[b.length - 1]; if (!last) return b; if (last.time === bucket) return [...b.slice(0, -1), { ...last, close: px, high: Math.max(last.high, px), low: Math.min(last.low, px), volume: last.volume + t.sol * solPrice }]; if (bucket > last.time) return [...b, { time: bucket, open: last.close, high: px, low: px, close: px, volume: t.sol * solPrice }]; return b })
  }, [trades[0]?.ts])
  // render
  useEffect(() => {
    const s = cs.current, v = vs.current, c = chart.current; if (!s || !v || !c || !bars.length) return
    s.setData(bars); v.setData(bars.map((b) => ({ time: b.time, value: b.volume, color: b.close >= b.open ? 'rgba(38,166,154,.35)' : 'rgba(239,83,80,.35)' })))
    // markers: vault actions + your fills
    const mk: any[] = []
    const snap = (ms: number) => (Math.floor(ms / 1000 / TF[tf].sec) * TF[tf].sec) as UTCTimestamp
    const first = bars[0].time
    for (const a of vault?.activity || []) { if (snap(a.t) < first) continue; if (a.kind === 'capture') mk.push({ time: snap(a.t), position: 'aboveBar', color: '#ff4d5e', shape: 'arrowDown', text: 'C' }); if (a.kind === 'buy') mk.push({ time: snap(a.t), position: 'belowBar', color: '#2bd46a', shape: 'arrowUp', text: a.msg?.includes('desk') ? 'OTC' : 'D' }); if (a.kind === 'redeem') mk.push({ time: snap(a.t), position: 'belowBar', color: '#d4af37', shape: 'circle', text: 'R' }) }
    for (const f of fills) { if (f.mint !== coin.mint || snap(f.t) < first) continue; mk.push({ time: snap(f.t), position: f.side === 'sell' ? 'aboveBar' : 'belowBar', color: f.side === 'sell' ? '#ff4d5e' : '#2bd46a', shape: f.side === 'sell' ? 'arrowDown' : 'arrowUp', text: f.side === 'sell' ? 'you' : 'you' }) }
    s.setMarkers(mk.sort((a, b) => a.time - b.time))
    // lines: entry, TP/SL
    lines.current.forEach((l) => s.removePriceLine(l)); lines.current = []
    if (lot && lot.tokens && lot.costSol) { /* entry in usd unknown precisely; skip */ }
    for (const o of orders.filter((o) => o.mint === coin.mint)) lines.current.push(s.createPriceLine({ price: o.trigUsd, color: o.type === 'tp' ? '#2bd46a' : '#ff4d5e', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: o.type.toUpperCase() }))
    if (vault && vault.floor && solPrice) lines.current.push(s.createPriceLine({ price: vault.floor * solPrice, color: '#d4af37', lineWidth: 1, lineStyle: 3, axisLabelVisible: true, title: 'floor' }))
  }, [bars, vault?.activity?.length, fills.length, orders.length, tf])
  useEffect(() => { try { localStorage.setItem('unnamed_tf', tf) } catch {} }, [tf])
  return <div className="chart" style={{ position: 'relative', background: '#000000' }}>
    {fallback && coin.pair ? <iframe src={D.chartUrl(coin.pair)} title="chart" allow="clipboard-write" /> : <>
      <div ref={el} style={{ position: 'absolute', inset: 0 }} />
      <div className="row" style={{ position: 'absolute', top: 8, left: 10, zIndex: 2, gap: 6 }}><div className="seg" style={{ padding: 1 }}>{Object.keys(TF).map((k) => <button key={k} className={tf === k ? 'on' : ''} style={{ padding: '3px 8px', fontSize: 11 }} onClick={() => setTf(k)}>{k}</button>)}</div><span className="dim num" style={{ fontSize: 11 }}>{legend}</span>{!bars.length && <span className="dim" style={{ fontSize: 11 }}>loading candles…</span>}</div>
      <div className="row" style={{ position: 'absolute', bottom: 8, left: 10, zIndex: 2, gap: 10, fontSize: 10 }}><span className="dn">▼ C capture</span><span className="up">▲ D dip buy · OTC desk fill</span><span className="gold">● R redeem · ┄ floor</span><span className="dim">▲▼ you</span></div>
    </>}
  </div>
}
