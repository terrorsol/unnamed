import React, { useState } from 'react'
import { Keypair } from '@solana/web3.js'
import { useWallet } from '@solana/wallet-adapter-react'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import * as B from '../lib/burner'
import { S, short } from '../lib/fmt'
import { toast } from '../lib/store'

type Props = { onClose: () => void; burner: Keypair | null; setBurner: (k: Keypair | null) => void; mode: 'burner' | 'adapter'; setMode: (m: 'burner' | 'adapter') => void; sol: number | null; onWithdraw: (to: string, sol: number) => Promise<void> }
export default function WalletPanel(p: Props) {
  const w = useWallet()
  const [pw, setPw] = useState(''); const [pw2, setPw2] = useState(''); const [imp, setImp] = useState(''); const [showImp, setShowImp] = useState(false)
  const [secret, setSecret] = useState(''); const [to, setTo] = useState(''); const [amt, setAmt] = useState(''); const [busy, setBusy] = useState(false)
  const has = B.hasBurner()
  const run = async (f: () => Promise<void>) => { setBusy(true); try { await f() } catch (e: any) { toast({ kind: 'err', title: String(e?.message || e) }) } finally { setBusy(false) } }
  const copy = (t: string) => navigator.clipboard?.writeText(t).then(() => toast({ kind: 'ok', title: 'Copied' })).catch(() => {})
  return <div className="modal" onClick={p.onClose}><div className="box" onClick={(e) => e.stopPropagation()}>
    <div className="row"><h2>Wallet</h2><span className="sp" /><div className="seg"><button className={p.mode === 'burner' ? 'on' : ''} onClick={() => p.setMode('burner')}>In-app</button><button className={p.mode === 'adapter' ? 'on' : ''} onClick={() => p.setMode('adapter')}>Phantom / extension</button></div></div>
    {p.mode === 'adapter' ? <>
      <div className="note">Connect a browser wallet. Every trade pops a signature request in the extension. Best for larger size; slower for sniping.</div>
      <div className="row"><WalletMultiButton />{w.publicKey && <span className="num dim">{short(w.publicKey.toBase58(), 6)}</span>}</div>
    </> : !has ? <>
      <div className="note"><b>In-app wallet = one-click trades.</b> A fresh keypair is generated in your browser and encrypted with a password you choose. Deposit 0.5–2 SOL from Phantom, trade with zero popups, withdraw anytime. We never see the key. Clearing site data deletes it — export the key once it's created.</div>
      <div className="two"><div className="fld"><div className="lbl">Password</div><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></div><div className="fld"><div className="lbl">Confirm</div><input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" /></div></div>
      <div className="row"><button className="btn ghost" onClick={() => setShowImp(!showImp)}>{showImp ? 'Hide import' : 'Import existing key instead'}</button><span className="sp" />
        <button className="btn pri" disabled={busy || pw.length < 8 || pw !== pw2} onClick={() => run(async () => { const kp = await B.createBurner(pw, showImp && imp ? B.parseSecret(imp) : undefined); p.setBurner(kp); p.setMode('burner'); toast({ kind: 'ok', title: showImp && imp ? 'Wallet imported' : 'Wallet created', rows: [['Address', short(kp.publicKey.toBase58(), 6)]] }) })}>{pw.length < 8 ? 'Password ≥ 8 chars' : showImp && imp ? 'Import' : 'Create wallet'}</button></div>
      {showImp && <div className="fld"><div className="lbl">Secret key (base58 or JSON array)</div><input type="password" value={imp} onChange={(e) => setImp(e.target.value)} placeholder="paste private key" /><div className="note" style={{ marginTop: 6, color: 'var(--dn)' }}>Only import a key you're fine losing. Never paste your main wallet. This stays encrypted in this browser only.</div></div>}
    </> : !p.burner ? <>
      <div className="note">In-app wallet <b className="num">{short(B.stored()!.pub, 6)}</b> is locked.</div>
      <div className="fld"><div className="lbl">Password</div><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run(async () => p.setBurner(await B.unlockBurner(pw)))} autoFocus /></div>
      <div className="row"><button className="btn ghost dn" onClick={() => { if (confirmRemove()) { B.removeBurner(); p.setBurner(null); p.onClose() } }}>Forget wallet</button><span className="sp" /><button className="btn pri" disabled={busy || !pw} onClick={() => run(async () => p.setBurner(await B.unlockBurner(pw)))}>Unlock</button></div>
    </> : <>
      <div className="tiles" style={{ gridTemplateColumns: '1fr 1fr' }}><div className="tile"><div className="l">Balance</div><div className="v num">{p.sol == null ? '…' : S(p.sol) + ' SOL'}</div></div><div className="tile"><div className="l">Address · tap to copy</div><div className="v num" style={{ fontSize: 12, cursor: 'pointer' }} onClick={() => copy(p.burner!.publicKey.toBase58())}>{p.burner.publicKey.toBase58()}</div></div></div>
      <div className="note"><b>Deposit:</b> send SOL from Phantom to the address above. Trades sign instantly with no popup. Keep it small — this is a hot wallet in a browser.</div>
      <div className="fld"><div className="lbl">Withdraw</div><div className="two"><input value={to} onChange={(e) => setTo(e.target.value)} placeholder="destination address" style={{ background: 'var(--s2)', border: '1px solid var(--line)', borderRadius: 8, padding: '9px 11px' }} /><div className="row"><input value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="SOL" inputMode="decimal" style={{ background: 'var(--s2)', border: '1px solid var(--line)', borderRadius: 8, padding: '9px 11px', width: 90 }} /><button className="btn" disabled={busy || !to || !(+amt > 0)} onClick={() => run(() => p.onWithdraw(to, +amt))}>Send</button><button className="btn ghost" onClick={() => setAmt(String(Math.max(0, (p.sol || 0) - 0.001).toFixed(4)))}>max</button></div></div></div>
      <div className="row"><button className="btn ghost" onClick={() => setSecret(secret ? '' : B.exportSecret(p.burner!))}>{secret ? 'Hide key' : 'Export private key'}</button><button className="btn ghost" onClick={() => p.setBurner(null)}>Lock</button><span className="sp" /><button className="btn ghost dn" onClick={() => { if (confirmRemove()) { B.removeBurner(); p.setBurner(null); p.onClose() } }}>Forget wallet</button></div>
      {secret && <div className="note"><div className="num" style={{ wordBreak: 'break-all', cursor: 'pointer' }} onClick={() => copy(secret)}>{secret}</div><div style={{ marginTop: 6, color: 'var(--dn)' }}>Anyone with this key owns the funds. Tap to copy, store offline, then hide.</div></div>}
    </>}
  </div></div>
}
let armed = 0
function confirmRemove() { const now = Date.now(); if (now - armed < 4000) { armed = 0; return true } armed = now; toast({ kind: 'info', title: 'Tap "Forget wallet" again to confirm', rows: [['Warning', 'Funds are lost unless you exported the key']] }); return false }
