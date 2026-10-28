import React, { useEffect, useState } from 'react'
import * as K from '../lib/desk'

/** Private beta gate: an invite key, bound to the wallet that redeems it. Reads work without it; every action needs the session it returns. */
export default function Gate({ wallet, connected, signMsg, needWallet, onOpen }: { wallet: string; connected: boolean; signMsg: (m: Uint8Array) => Promise<Uint8Array>; needWallet: () => void; onOpen: () => void }) {
  const [code, setCode] = useState(() => { try { return new URLSearchParams(location.hash.split('?')[1] || '').get('key') || '' } catch { return '' } })
  const [busy, setBusy] = useState(''); const [err, setErr] = useState('')
  useEffect(() => { setErr('') }, [code])
  const go = async () => {
    if (!connected) return needWallet()
    setBusy('Signing…'); setErr('')
    try {
      const msg = `banker:invite:${wallet}:${Math.floor(Date.now() / 60000)}`
      const sig = await signMsg(new TextEncoder().encode(msg))
      const bs58 = (await import('bs58')).default
      setBusy('Checking…'); const r = await K.inviteRedeem(code.trim(), wallet, msg, bs58.encode(sig))
      K.setSessionToken(r.token); onOpen()
    } catch (e: any) { setErr(String(e?.message || e).replace(/^Error:\s*/, '')) } finally { setBusy('') }
  }
  const ok = /^BANK-[A-Z2-9]{4}-[A-Z2-9]{4}$/i.test(code.trim())
  return <div className="gate">
    <svg viewBox="0 0 200 200" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinejoin="round" strokeLinecap="round" className="gatemark">
      <path d="M100 22 L178 62 H22 Z" /><rect x="30" y="62" width="140" height="14" /><rect x="42" y="76" width="12" height="64" /><rect x="76" y="76" width="12" height="64" /><rect x="112" y="76" width="12" height="64" /><rect x="146" y="76" width="12" height="64" /><rect x="30" y="148" width="140" height="12" /><path d="M20 174 H180" />
    </svg>
    <div className="gatettl">Private beta</div>
    <div className="nm">Enter your key. It binds to the wallet you sign with.</div>
    <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="BANK-XXXX-XXXX" spellCheck={false} autoCapitalize="characters" onKeyDown={(e) => e.key === 'Enter' && ok && !busy && go()} />
    {err && <div className="dn" style={{ fontSize: 12 }}>{err}</div>}
    <button className="btn pri big" style={{ width: '100%' }} disabled={!ok || !!busy} onClick={go}>{busy || (connected ? 'Enter' : 'Connect wallet to enter')}</button>
    <a className="nm" href="https://banker.cash" style={{ textDecoration: 'underline' }}>No key? Join the waitlist</a>
  </div>
}
