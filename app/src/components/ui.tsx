import React, { useEffect, useState } from 'react'
import type { Coin } from '../lib/dex'
import { onToast, type Toast } from '../lib/store'
import { F, pct, short } from '../lib/fmt'
import { useFlash } from '../hooks'

const EMO = ['🐸', '🐶', '🐱', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐵', '🐔', '🐧', '🐙', '🦄', '🐲', '👻', '🤖', '👽', '🍌', '🍕', '🚀', '💎', '🔥', '⚡', '🌙', '☀️', '🪐', '🧠']
const GR = ['linear-gradient(135deg,#ff7a59,#ffd166)', 'linear-gradient(135deg,#6a5cff,#43d4ff)', 'linear-gradient(135deg,#ff4fd8,#7a5cff)', 'linear-gradient(135deg,#3ecf8e,#1f7a8c)', 'linear-gradient(135deg,#ffb347,#ff3d81)', 'linear-gradient(135deg,#00d2ff,#3a7bd5)', 'linear-gradient(135deg,#f5576c,#f093fb)', 'linear-gradient(135deg,#a8ff78,#78ffd6)']
function hash(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h }
export function Pfp({ c, mint, lg }: { c?: Coin; mint?: string; lg?: boolean }) {
  const [bad, setBad] = useState(false)
  const k = c?.mint || mint || ''
  if (c?.image && !bad) return <img className={'pfp' + (lg ? ' lg' : '')} src={c.image} onError={() => setBad(true)} alt="" />
  const h = hash(k)
  return <span className={'pfp' + (lg ? ' lg' : '')} style={{ background: GR[h % GR.length] }}>{EMO[(h >> 4) % EMO.length]}</span>
}
/** every live number cell ticks like a terminal: green flash up, red flash down, keyed on the value itself */
export function Ch({ v }: { v: number }) { const fl = useFlash(v); return <span className={'num cell ' + (v >= 0 ? 'up' : 'dn') + (fl ? ' ' + fl : '')}>{pct(v)}</span> }
export function Mc({ v }: { v: number }) { const fl = useFlash(v); return <span className={'num cell' + (fl ? ' ' + fl : '')}>{F(v)}</span> }
/** wrap any rendered value; flashes when `v` moves */
export function Live({ v, children, className = '' }: { v: number | null | undefined; children: React.ReactNode; className?: string }) { const fl = useFlash(v); return <span className={('cell ' + className + (fl ? ' ' + fl : '')).trim()}>{children}</span> }
export function Status({ c }: { c: Coin }) {
  return c.onCurve ? <span className="tag curve">CURVE</span> : <span className="tag">{c.dex.toUpperCase().replace('PUMPSWAP', 'PUMP AMM')}</span>
}
export function Spark({ pts, up }: { pts: number[]; up: boolean }) {
  if (pts.length < 2) return <svg className="spark" />
  const mn = Math.min(...pts), mx = Math.max(...pts), r = mx - mn || 1
  const d = pts.map((p, i) => `${(i / (pts.length - 1)) * 84},${22 - ((p - mn) / r) * 20 + 1}`).join(' ')
  return <svg className="spark" viewBox="0 0 84 24"><polyline points={d} fill="none" stroke={up ? '#3ecf8e' : '#f0556b'} strokeWidth="1.5" /></svg>
}
export function Toasts() {
  const [list, set] = useState<Toast[]>([])
  useEffect(() => onToast((t) => { set((l) => [...l, t]); setTimeout(() => set((l) => l.filter((x) => x.id !== t.id)), t.kind === 'err' ? 9000 : 6000) }), [])
  return <div className="toasts">{list.map((t) => (
    <div key={t.id} className={'toast ' + t.kind}><div className="t">{t.title}</div>
      {t.rows?.map(([k, v]) => <div className="kv" key={k}><span>{k}</span><b>{v}</b></div>)}
      {t.href && <a href={t.href} target="_blank" rel="noreferrer">View on Solscan ↗</a>}
    </div>))}</div>
}
export function Addr({ a }: { a: string }) { return <a className="dim num" href={`https://solscan.io/token/${a}`} target="_blank" rel="noreferrer">{short(a)}</a> }
