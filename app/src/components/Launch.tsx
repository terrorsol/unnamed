import React, { useState } from 'react'
import { solForPct } from '../lib/protocol'
import { S } from '../lib/fmt'
import type { CreateMeta } from '../lib/pumpportal'
import * as D from '../lib/dex'
import { ModePicker } from './Desk'

export type Venue = 'launchlab' | 'pump'
type Props = { onClose: () => void; onLaunch: (m: CreateMeta, devBuy: number, stake: number, copyOf?: string, mode?: 'floor' | 'mm', ceiling?: number, venue?: Venue, permTax?: boolean, vaultBuy?: number, targetPct?: number) => void; taxBps?: number; permTaxBps?: number; platformReady?: boolean; busy: string; connected: boolean; sol: number | null; needWallet: () => void }
export default function Launch(p: Props) {
  const [name, setName] = useState(''); const [symbol, setSymbol] = useState(''); const [desc, setDesc] = useState(''); const [file, setFile] = useState<File | undefined>()
  const [tw, setTw] = useState(''); const [tg, setTg] = useState(''); const [web, setWeb] = useState('')
  const [dev, setDev] = useState(0.5); const [pct, setPct] = useState(20); const [buyNow, setBuyNow] = useState(false); const [chest, setChest] = useState(0.5); const [mode, setMode] = useState<'floor' | 'mm'>('mm'); const [ceiling, setCeiling] = useState(0.3); const [adv, setAdv] = useState(false)
  const [cq, setCq] = useState(''); const [cres, setCres] = useState<D.Coin[]>([]); const [copyOf, setCopyOf] = useState<D.Coin | null>(null); const [venue, setVenue] = useState<Venue>('launchlab'); const [permTax, setPermTax] = useState(false)
  React.useEffect(() => { if (!cq.trim() || copyOf) { setCres([]); return } const t = setTimeout(() => D.search(cq).then((r) => setCres(r.slice(0, 5))).catch(() => {}), 300); return () => clearTimeout(t) }, [cq, copyOf])
  const ok = name.trim().length > 1 && symbol.trim().length > 0 && symbol.length <= 10 && !!file
  const feeOff = venue === 'launchlab' ? 25 + (p.taxBps ?? 200) : 0
  const taxFunded = venue === 'launchlab' && !buyNow
  const vaultBuy = taxFunded ? 0 : solForPct(pct, dev, feeOff); const stake = +(vaultBuy + chest).toFixed(3)
  const total = dev + stake + (venue === 'launchlab' ? 0.1 : 0.02)
  return <div className="modal" onClick={p.onClose}><div className="box" onClick={(e) => e.stopPropagation()}>
    <div className="row"><h2>Launch a coin</h2><span className="sp" /><span className="tag live">{venue === 'launchlab' ? `${((p.taxBps ?? 200) / 100).toFixed(1)}% tax → chest` : 'pump.fun'}</span></div>
    <div className="venue">
      <button className={venue === 'launchlab' ? 'on' : ''} onClick={() => setVenue('launchlab')}><b>BANKER launchpad</b><span>{p.platformReady === false ? `platform config not live yet (Settings) — launches work, the ${((p.taxBps ?? 200) / 100).toFixed(1)}% tax starts once it is` : `${((p.taxBps ?? 200) / 100).toFixed(1)}% of every curve trade → the coin's chest · desk fills skip it · vault from block zero`}</span></button>
      <button className={venue === 'pump' ? 'on' : ''} onClick={() => setVenue('pump')}><b>pump.fun</b><span>bigger crowd, no tax, no vamp defense — the vault still works</span></button>
    </div>
    {venue === 'launchlab' && (p.permTaxBps ?? 0) > 0 && <label className="row" style={{ gap: 8, fontSize: 12, marginBottom: 8 }}><input type="checkbox" checked={permTax} onChange={(e) => setPermTax(e.target.checked)} /> {((p.permTaxBps ?? 100) / 100).toFixed(1)}% on every transfer, forever (token-2022)</label>}
    <div className="two">
      <div className="fld"><div className="lbl">Name</div><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Glass Frog" maxLength={32} /></div>
      <div className="fld"><div className="lbl">Ticker</div><input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} placeholder="GLASS" maxLength={10} /></div>
    </div>
    <div className="fld"><div className="lbl">Image</div><input type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0])} /></div>
    <button className="btn ghost" style={{ alignSelf: 'flex-start', height: 28, padding: 0 }} onClick={() => setAdv(!adv)}>{adv ? '− Hide advanced' : '+ Advanced · socials, dev buy, copy-of'}</button>
    {adv && <>
    <div className="fld"><div className="lbl">Description</div><textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="What is it" maxLength={500} /></div>
    <div className="two" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
      <div className="fld"><div className="lbl">X / Twitter</div><input value={tw} onChange={(e) => setTw(e.target.value)} placeholder="https://x.com/…" /></div>
      <div className="fld"><div className="lbl">Telegram</div><input value={tg} onChange={(e) => setTg(e.target.value)} placeholder="https://t.me/…" /></div>
      <div className="fld"><div className="lbl">Website</div><input value={web} onChange={(e) => setWeb(e.target.value)} placeholder="https://" /></div>
    </div>
    <div className="fld"><div className="lbl">Copy of (optional) — half your cut streams to the original</div>
      {copyOf ? <div className="row"><span className="tag">COPY OF</span><b>{copyOf.symbol}</b><span className="nm">{copyOf.name}</span><span className="sp" /><button className="btn sm" onClick={() => { setCopyOf(null); setCq('') }}>Clear</button></div>
        : <><input value={cq} onChange={(e) => setCq(e.target.value)} placeholder="search ticker or mint of the original" />{cres.length > 0 && <div className="card" style={{ marginTop: 4 }}>{cres.map((c) => <div key={c.mint} className="it row" style={{ padding: '7px 10px', cursor: 'pointer', borderBottom: '1px solid var(--line)' }} onClick={() => { setCopyOf(c); setCres([]) }}><b>{c.symbol}</b><span className="nm">{c.name.slice(0, 24)}</span><span className="sp" /><span className="dim num">{c.mcap ? '$' + Math.round(c.mcap / 1000) + 'K' : ''}</span></div>)}</div>}</>}
    </div>
    <div className="fld"><div className="lbl">Dev buy (block zero) — <b className="num">{S(dev, 2)} SOL</b></div><input type="range" className="slider" min={0} max={5} step={0.05} value={dev} onChange={(e) => setDev(+e.target.value)} /></div>
    </>}
    <div className="note">
      <div className="row"><b>Vault supply</b><span className="sp" /><b className="num">{pct}%{taxFunded ? '' : ` · ${S(vaultBuy, 2)} SOL`}</b></div>
      <input type="range" className="slider" min={5} max={50} step={1} value={pct} onChange={(e) => setPct(+e.target.value)} style={{ marginTop: 6 }} />
      {venue === 'launchlab' && <div className="seg" style={{ marginTop: 8 }}><button className={!buyNow ? 'on' : ''} onClick={() => setBuyNow(false)}>Tax builds it · free</button><button className={buyNow ? 'on' : ''} onClick={() => setBuyNow(true)}>Buy at launch · {S(solForPct(pct, dev, feeOff), 1)} SOL</button></div>}
      <div className="row" style={{ marginTop: 8 }}><b>Chest</b><span className="sp" /><b className="num">{S(chest, 2)} SOL</b></div>
      <input type="range" className="slider" min={0.05} max={10} step={0.05} value={chest} onChange={(e) => setChest(+e.target.value)} style={{ marginTop: 6 }} />
      <div className="nm" style={{ marginTop: 6 }}>{taxFunded ? `Every trade pays ${((p.taxBps ?? 200) / 100).toFixed(0)}% into the chest. The vault buys under VWAP until it holds ${pct}% of supply, then market-makes with it.` : `The vault buys ${pct}% of supply in the launch block and keeps the chest for dips. Every trade adds ${((p.taxBps ?? 200) / 100).toFixed(0)}% to the chest.`} Your cut = {pct}% of vault profit, renounceable.</div>
      {adv && <div style={{ marginTop: 8 }}><ModePicker mode={mode} ceiling={ceiling} onChange={(m, c) => { setMode(m); setCeiling(c) }} compact /></div>}{!adv && <div className="nm">Market maker · capture ceiling {Math.round(ceiling * 100)}%</div>}</div>
    <div className="kv"><span>Cost now</span><b className="num">{S(total, 2)} SOL</b></div>
    <div className="nm">dev buy {S(dev, 2)}{vaultBuy ? ` + vault buy ${S(vaultBuy, 2)}` : ''} + chest {S(chest, 2)} + {venue === 'launchlab' ? '0.1 pool rent' : '0.02 fees'}</div>
    <div className="kv"><span>Wallet</span><b className="num">{p.sol == null ? '—' : S(p.sol) + ' SOL'}</b></div>
    <div className="row"><button className="btn" onClick={p.onClose}>Cancel</button><span className="sp" />
      <button className="btn pri" disabled={!!p.busy || (p.connected && (!ok || (p.sol != null && total > p.sol)))} onClick={() => !p.connected ? p.needWallet() : p.onLaunch({ name: name.trim(), symbol: symbol.trim(), description: desc.trim(), file, twitter: tw || undefined, telegram: tg || undefined, website: web || undefined }, dev, stake, copyOf?.mint, mode, ceiling, venue, venue === 'launchlab' && permTax, vaultBuy, pct)}>{p.busy || (!p.connected ? 'Connect wallet' : 'Create coin')}</button></div>
  </div></div>
}
