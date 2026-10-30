import { useEffect, useState, useCallback, useRef } from 'react'
import { useConnection } from '@solana/wallet-adapter-react'
import { PublicKey } from '@solana/web3.js'
import { LAMPORTS } from './lib/fmt'
import { holdings, type Holding } from './lib/rpc'
import * as D from './lib/dex'
import { openStream, type NewToken, type TradeEvt } from './lib/pumpportal'
import { loadSettings, saveSettings, type Settings } from './lib/store'

export function useRoute() {
  const [h, setH] = useState(location.hash || '#/')
  useEffect(() => { const f = () => setH(location.hash || '#/'); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f) }, [])
  const parts = h.replace(/^#\/?/, '').split('/')
  return { page: parts[0] || 'home', arg: parts[1] || '', arg2: parts[2] || '', go: (p: string) => { location.hash = '#/' + p } }
}
export function useSettings(): [Settings, (s: Partial<Settings>) => void] {
  const [s, set] = useState(loadSettings)
  return [s, (p) => set((o) => { const n = { ...o, ...p }; saveSettings(n); return n })]
}
export function useSolPrice() {
  const [p, setP] = useState(0)
  useEffect(() => {
    const f = () => D.tokensByMint(['So11111111111111111111111111111111111111112']).then((m) => { const c = Object.values(m)[0]; if (c) setP(c.priceUsd) }).catch(() => {})
    f(); const i = setInterval(f, 60000); return () => clearInterval(i)
  }, [])
  return p
}
export function useTrending() {
  const [coins, set] = useState<D.Coin[]>([]); const [err, setErr] = useState('')
  useEffect(() => {
    let on = true
    const f = () => D.trending().then((c) => { if (on) { set(c); setErr('') } }).catch((e) => on && setErr(String(e.message || e)))
    f(); const i = setInterval(f, 20000); return () => { on = false; clearInterval(i) }
  }, [])
  return { coins, err }
}
export function useNewTokens(max = 60) {
  const [list, set] = useState<NewToken[]>([]); const [live, setLive] = useState(false)
  const [trades, setTrades] = useState<TradeEvt[]>([])
  const ref = useRef<ReturnType<typeof openStream> | null>(null)
  useEffect(() => {
    ref.current = openStream((t) => { setLive(true); set((l) => [t, ...l].slice(0, max)) }, (t) => setTrades((l) => [t, ...l].slice(0, 80)))
    return () => ref.current?.close()
  }, [])
  return { list, live, trades, subscribe: (m: string[]) => ref.current?.subscribe(m) }
}
export function useWalletState(publicKey: PublicKey | null, refreshKey = 0) {
  const { connection } = useConnection()
  const [sol, setSol] = useState<number | null>(null); const [tokens, setTokens] = useState<Holding[]>([])
  const refresh = useCallback(async () => {
    if (!publicKey) { setSol(null); setTokens([]); return }
    connection.getBalance(publicKey).then((b) => setSol(b / LAMPORTS)).catch(() => {})
    holdings(connection, publicKey).then(setTokens).catch(() => {})
  }, [connection, publicKey])
  useEffect(() => { refresh(); const i = setInterval(refresh, 15000); return () => clearInterval(i) }, [refresh, refreshKey])
  return { sol, tokens, refresh, owner: publicKey?.toBase58() || '' }
}
/** The open coin's balance on its own, every 4 s (one cheap call, both token programs): the Sell button must not wait for the 15 s wallet sweep —
 *  Oct 29 a dev's fresh coin showed no Sell at all for a while after the launch. */
export function useMintHolding(publicKey: PublicKey | null, mint: string | null, refreshKey = 0) {
  const { connection } = useConnection(); const [h, setH] = useState<Holding | null>(null)
  const pk = publicKey?.toBase58() || ''
  useEffect(() => {
    setH(null); if (!publicKey || !mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return; let on = true
    const f = () => connection.getParsedTokenAccountsByOwner(publicKey, { mint: new PublicKey(mint) }).then((r) => {
      if (!on) return; let amount = 0, raw = 0n, decimals = 6
      for (const a of r.value) { const t = (a.account.data as any).parsed.info.tokenAmount; amount += +t.uiAmount || 0; raw += BigInt(t.amount || 0); decimals = t.decimals }
      setH(amount > 0 ? { mint, amount, decimals, raw: raw.toString() } : null) }).catch(() => {})
    f(); const i = setInterval(f, 4000); return () => { on = false; clearInterval(i) }
  }, [connection, pk, mint, refreshKey])
  return h
}
/** Hydrate a list of mints with DexScreener data; polls */
export function useCoins(mints: string[], ms = 15000) {
  const [m, set] = useState<Record<string, D.Coin>>({})
  const key = mints.join(',')
  useEffect(() => {
    if (!mints.length) return
    let on = true
    const f = () => D.tokensByMint(mints).then((r) => on && set((o) => ({ ...o, ...r }))).catch(() => {})
    f(); const i = setInterval(f, ms); return () => { on = false; clearInterval(i) }
  }, [key])
  return m
}

/** Flash class ('flash-up' / 'flash-dn') for ~1s whenever a numeric value changes. */
export function useFlash(v: number | null | undefined) {
  const prev = useRef(v); const [cls, setCls] = useState('')
  useEffect(() => { if (v == null || prev.current == null || v === prev.current) { prev.current = v; return } setCls(v > prev.current ? 'flash-up' : 'flash-dn'); prev.current = v; const t = setTimeout(() => setCls(''), 950); return () => clearTimeout(t) }, [v])
  return cls
}
/** A short confetti burst for a landed fill. */
export function confetti() {
  const el = document.createElement('div'); el.className = 'confetti'
  const cols = ['#2bd46a', '#d4af37', '#ffffff', '#9fb7ff']
  for (let i = 0; i < 26; i++) { const p = document.createElement('i'); p.style.left = 30 + Math.random() * 40 + '%'; p.style.background = cols[i % cols.length]; p.style.animationDelay = Math.random() * 0.25 + 's'; p.style.animationDuration = 0.9 + Math.random() * 0.6 + 's'; el.appendChild(p) }
  document.body.appendChild(el); setTimeout(() => el.remove(), 1800)
}
