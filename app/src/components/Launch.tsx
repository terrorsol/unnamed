import React, { useState } from 'react'
import { vaultPct } from '../lib/protocol'
import { S } from '../lib/fmt'
import type { CreateMeta } from '../lib/pumpportal'

type Props = { onClose: () => void; onLaunch: (m: CreateMeta, devBuy: number, stake: number) => void; busy: string; connected: boolean; sol: number | null; needWallet: () => void }
export default function Launch(p: Props) {
  const [name, setName] = useState(''); const [symbol, setSymbol] = useState(''); const [desc, setDesc] = useState(''); const [file, setFile] = useState<File | undefined>()
  const [tw, setTw] = useState(''); const [tg, setTg] = useState(''); const [web, setWeb] = useState('')
  const [dev, setDev] = useState(0.5); const [stake, setStake] = useState(1)
  const ok = name.trim().length > 1 && symbol.trim().length > 0 && symbol.length <= 10 && !!file
  const total = dev + stake + 0.02
  return <div className="modal" onClick={p.onClose}><div className="box" onClick={(e) => e.stopPropagation()}>
    <div className="row"><h2>Launch a coin</h2><span className="sp" /><span className="tag live">LIVE · pump.fun</span></div>
    <div className="two">
      <div className="fld"><div className="lbl">Name</div><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Glass Frog" maxLength={32} /></div>
      <div className="fld"><div className="lbl">Ticker</div><input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} placeholder="GLASS" maxLength={10} /></div>
    </div>
    <div className="fld"><div className="lbl">Description</div><textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="What is it" maxLength={500} /></div>
    <div className="fld"><div className="lbl">Image (required by pump.fun)</div><input type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0])} /></div>
    <div className="two" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
      <div className="fld"><div className="lbl">X / Twitter</div><input value={tw} onChange={(e) => setTw(e.target.value)} placeholder="https://x.com/…" /></div>
      <div className="fld"><div className="lbl">Telegram</div><input value={tg} onChange={(e) => setTg(e.target.value)} placeholder="https://t.me/…" /></div>
      <div className="fld"><div className="lbl">Website</div><input value={web} onChange={(e) => setWeb(e.target.value)} placeholder="https://" /></div>
    </div>
    <div className="fld"><div className="lbl">Dev buy (block zero) — <b className="num">{S(dev, 2)} SOL</b></div><input type="range" className="slider" min={0} max={5} step={0.05} value={dev} onChange={(e) => setDev(+e.target.value)} /></div>
    <div className="note"><div className="row"><b>Vault stake</b><span className="tag live">LIVE · bot</span><span className="sp" /><b className="num">{S(stake, 2)} SOL → {S(vaultPct(stake), 1)}% supply</b></div>
      <input type="range" className="slider" min={0} max={5} step={0.05} value={stake} onChange={(e) => setStake(+e.target.value)} style={{ marginTop: 6 }} />
      Your stake funds this coin's vault: half buys supply at block zero, half is the chest that buys crashes. It trims only above holder cost + 30-min VWAP, never dumps, never withdraws. Your cut = the vaulted %, renounceable. Set to 0 for a plain pump launch.</div>
    <div className="kv"><span>Cost now</span><b className="num">{S(total, 2)} SOL (dev buy + vault stake + ~0.02 fees)</b></div>
    <div className="kv"><span>Wallet</span><b className="num">{p.sol == null ? '—' : S(p.sol) + ' SOL'}</b></div>
    <div className="row"><button className="btn" onClick={p.onClose}>Cancel</button><span className="sp" />
      <button className="btn pri" disabled={!!p.busy || (p.connected && (!ok || (p.sol != null && total > p.sol)))} onClick={() => !p.connected ? p.needWallet() : p.onLaunch({ name: name.trim(), symbol: symbol.trim(), description: desc.trim(), file, twitter: tw || undefined, telegram: tg || undefined, website: web || undefined }, dev, stake)}>{p.busy || (!p.connected ? 'Connect wallet' : 'Create coin')}</button></div>
  </div></div>
}
