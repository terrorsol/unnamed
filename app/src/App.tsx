import React, { useCallback, useMemo, useRef, useState, useEffect } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import * as K from './lib/desk'
import { setLaunchCurve } from './lib/protocol'
import { DeskPage, VaultPage, MinePage, LeaderboardPage, ImportPage, RfqPing } from './components/Desk'
import { due, removeOrder, loadOrders } from './lib/orders'
import { confirmByPolling } from './lib/rpc'
import WalletPanel from './components/WalletPanel'
import * as B from './lib/burner'
import { STORE_SAFE } from './lib/native'
import { confetti, useRoute, useSettings, useSolPrice, useTrending, useNewTokens, useWalletState, useCoins } from './hooks'
import Home from './components/Home'
import CoinPage from './components/CoinPage'
import Launch from './components/Launch'
import Gate from './components/Gate'
import { Portfolio, SettingsPage, About } from './components/Pages'
const Simulate = React.lazy(() => import('./components/Simulate'))
const Compare = React.lazy(() => import('./components/Compare'))
import { SimpleHome, SimplePortfolio, SimpleNav, SimpleTrending, SimpleChests, Ic } from './components/Simple'
import { Toasts } from './components/ui'
import { toast } from './lib/store'
import * as T from './lib/trade'
import * as D from './lib/dex'
import { lastLanding, solscan } from './lib/rpc'
import { loadLedger, recordBuy, recordSell, recordCreate } from './lib/positions'
import { S, short } from './lib/fmt'
import type { Coin } from './lib/dex'

// three mains + bag; everything else lives under More
const I = {
  bank: <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="M3 9.5 12 4l9 5.5H3Z"/><path d="M5 9.5v8M9.5 9.5v8M14.5 9.5v8M19 9.5v8"/><path d="M3 17.5h18V20H3z"/></svg>,
  safe: <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="12" cy="12" r="3.5"/><path d="M12 8.5v2M12 13.5v2M8.5 12h2M13.5 12h2"/><path d="M6 20v1.5M18 20v1.5"/></svg>,
  desk: <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 8h13l-3-3M20 16H7l3 3"/></svg>,
  me: <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="8.5" r="3.5"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/></svg>,
}
const NAV: [string, string, string, React.ReactNode][] = [['home', 'Home', 'coins to watch', I.bank], ['vault', 'Vault', 'chests that defend coins', I.safe], ['desk', 'Desk', 'big trades, off the chart', I.desk], ['portfolio', 'Portfolio', 'what you own', I.me]]
const MORE: [string, string][] = [['dev', 'My launches'], ['vault/import', 'Add a chest to a coin'], ['settings', 'Settings'], ['docs', 'How it works']]

function Tabs({ tabs, sel, go }: { tabs: [string, React.ReactNode][]; sel: string; go: (t: string) => void }) {
  const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const cur = tabs.find(([t]) => slug(t) === sel) || tabs[0]
  return <><div className="seg" style={{ marginBottom: 12 }}>{tabs.map(([t]) => <button key={t} className={cur[0] === t ? 'on' : ''} onClick={() => go(slug(t))}>{t}</button>)}</div>{cur[1]}</>
}
export default function App() {
  const { page, arg, arg2, go } = useRoute()
  const [settings, setSettings] = useSettings()
  // simple mode: on by default on phones, off on desktop; either can switch it
  const [phone, setPhone] = useState(() => { try { return matchMedia('(max-width: 1000px)').matches } catch { return false } })
  useEffect(() => { try { const m = matchMedia('(max-width: 1000px)'); const f = () => setPhone(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f) } catch { return } }, [])
  const simple = settings.simple ?? phone
  const nav = simple ? NAV.filter(([k]) => k !== 'desk') : NAV
  const toggleSimple = () => setSettings({ simple: !simple })
  const { connection } = useConnection(); const wallet = useWallet()
  const solPrice = useSolPrice()
  const { coins, err } = useTrending()
  const fresh = useNewTokens()
  const [rk, setRk] = useState(0)
  const [burner, setBurner] = useState<Keypair | null>(null)
  const [mode, setMode] = useState<'burner' | 'adapter'>(() => { try { return (localStorage.getItem('unnamed_wmode') as any) || (B.hasBurner() ? 'burner' : 'adapter') } catch { return 'adapter' } })
  useEffect(() => { try { localStorage.setItem('unnamed_wmode', mode) } catch {} }, [mode])
  const [wp, setWp] = useState(false)
  const activeB58 = mode === 'burner' ? (burner ? burner.publicKey.toBase58() : '') : (wallet.publicKey ? wallet.publicKey.toBase58() : '')
  const activeKey = useMemo(() => (activeB58 ? new PublicKey(activeB58) : null), [activeB58])
  const ws = useWalletState(activeKey, rk)
  const pendingVault = useRef<{ v: K.VaultPub; dev: string; stake: number; venue: string } | null>(null)
  const [lat, setLat] = useState<number | null>(null); const [busy, setBusy] = useState(''); const [launch, setLaunch] = useState(false); const openLaunch = () => { if (STORE_SAFE) { toast({ kind: 'info', title: 'Launch coins on app.banker.cash', rows: [['In the app', 'buy, sell and track coins']] }); return } setLaunch(true) }; const [llp, setLlp] = useState<K.LLPlatform | null>(null); useEffect(() => { K.llPlatform().then(setLlp).catch(() => {}) }, [launch]); const [more, setMore] = useState(false); const [q, setQ] = useState(''); const [results, setResults] = useState<Coin[]>([])
  const [ledgerV, setLedgerV] = useState(0)
  const ledger = useMemo(() => loadLedger(ws.owner), [ws.owner, ledgerV])
  const freshMints = useMemo(() => fresh.list.slice(0, 30).map((t) => t.mint), [fresh.list])
  const freshCoins = useCoins(freshMints, 12000)
  const heldCoins = useCoins(useMemo(() => ws.tokens.map((t) => t.mint), [ws.tokens]), 20000)
  const [deskUp, setDeskUp] = useState(false); const [vaultV, setVaultV] = useState(0)
  const [vaultList, setVaultList] = useState<K.VaultPub[]>([])
  useEffect(() => { if (!deskUp) { setVaultList([]); return } const f = () => K.vaults().then(setVaultList).catch(() => {}); f(); const i = setInterval(f, 10000); return () => clearInterval(i) }, [deskUp, vaultV])
  const vaulted = useMemo(() => new Set(vaultList.map((v) => v.mint!).filter(Boolean)), [vaultList])
  const vaultMints = useMemo(() => vaultList.map((v) => v.mint!).filter(Boolean), [vaultList])
  const vaultCoins = useCoins(vaultMints, 15000)

  const byMint = useMemo(() => { const m: Record<string, Coin> = { ...freshCoins, ...heldCoins, ...vaultCoins }; coins.forEach((c) => (m[c.mint] = c)); results.forEach((c) => (m[c.mint] = c)); return m }, [coins, freshCoins, heldCoins, vaultCoins, results])
  const connected = !!activeKey

  useEffect(() => { if (!q.trim()) { setResults([]); return } const t = setTimeout(() => D.search(q).then(setResults).catch(() => {}), 350); return () => clearTimeout(t) }, [q])

  // a wallet prompt the user closes (or phantom's "request blocked" screen) can leave the promise pending forever and wedge every button behind one busy flag: time it out
  const prompt = <T,>(p: Promise<T>, what: string) => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(what + ' not confirmed in the wallet (90s) — press the button again')), 90000))])
  const ctx = useCallback((): T.Ctx | null => {
    if (mode === 'burner') { if (!burner) return null; return { conn: connection, owner: burner.publicKey, sign: B.signWith(burner), settings, onStatus: setBusy } }
    if (!wallet.publicKey || !wallet.signTransaction) return null
    const st = wallet.signTransaction; return { conn: connection, owner: wallet.publicKey, sign: ((t: any) => prompt(st(t), 'transaction')) as any, settings, onStatus: setBusy }
  }, [mode, burner, wallet.publicKey, wallet.signTransaction, connection, settings])
  const needWallet = () => { setWp(true) }
  // --- signing helpers for legacy txs / messages (desk + vault) ---
  const signLegacy = useCallback(async (t: Transaction) => { if (mode === 'burner') { if (!burner) throw new Error('wallet locked'); t.partialSign(burner); return t } if (!wallet.signTransaction) throw new Error('wallet cannot sign'); return prompt(wallet.signTransaction(t), 'transaction') }, [mode, burner, wallet.signTransaction])
  const signMsg = useCallback(async (m: Uint8Array) => { if (mode === 'burner') { if (!burner) throw new Error('wallet locked'); return K.signMsgWith(burner)(m) } if (!wallet.signMessage) throw new Error('wallet cannot sign messages'); return prompt(wallet.signMessage(m), 'signature') }, [mode, burner, wallet.signMessage])
  const [bidder, setBidder] = useState<K.BidderSession | null>(null); const [deskTick, setDeskTick] = useState(0)
  const [pings, setPings] = useState<K.Rfq[]>([]); const [swaps, setSwaps] = useState<any[]>([])
  const allTrades = useMemo(() => [...swaps, ...fresh.trades].sort((a, b) => b.ts - a.ts).slice(0, 200), [swaps, fresh.trades])
  useEffect(() => { if (!deskUp) return; return K.openSwapFeed((sw) => setSwaps((l) => [{ mint: sw.mint, txType: sw.side, sol: sw.sol, tokens: 0, trader: sw.trader, mcapSol: 0, ts: sw.t, sig: sw.sig }, ...l].slice(0, 200))) }, [deskUp])
  // private beta gate: health says whether the server is gated; a stored session is re-checked once, and any 401 from a write re-opens the gate
  const [gated, setGated] = useState<boolean | null>(null)
  useEffect(() => { const chk = async () => { try { const h = await K.health(); (window as any).__reclaim = !!(h as any).beta?.testReclaim; setDeskUp(true); setLaunchCurve((h as any).curve); if (!h.gate) { setGated(false); return } const t = K.sessionToken(); if (!t) { setGated(true); return } const r = await K.inviteSession(t).catch(() => ({ ok: false })); if (!r.ok) K.setSessionToken(''); setGated(!r.ok) } catch { setDeskUp(false) } }; chk(); const ping = () => { const t0 = performance.now(); return K.health().then(() => { setDeskUp(true); setLat(Math.round(performance.now() - t0)) }).catch(() => setDeskUp(false)) }; ping(); const i = setInterval(ping, 15000); const onGate = () => { K.setSessionToken(''); setGated(true) }; K.gateBus.addEventListener('gate', onGate); return () => { clearInterval(i); K.gateBus.removeEventListener('gate', onGate) } }, [])
  useEffect(() => {
    if (!activeB58 || !deskUp) { setBidder(null); return }
    const sess = K.openBidder(connection, activeB58, signMsg, signLegacy, async (m) => { const c = await D.tokenPairs(m); return c?.raw?.priceNative ? +c.raw.priceNative : 0 }, (e) => {
      setDeskTick((t) => t + 1)
      if (e.type === 'sold') { confetti(); toast({ kind: 'ok', title: `Your sell offer filled`, rows: [['Received', S(Number(BigInt(e.expect.sellerLamports)) / 1e9) + ' SOL'], ['Tx', short(e.sig, 6)]], href: solscan(e.sig) }); setTimeout(() => setRk((k) => k + 1), 1500) }
      if (e.type === 'ask_posted') toast({ kind: 'ok', title: `${e.symbol}: someone is selling ${S(e.sol, 2)} SOL at ${e.discBps <= 0 ? '+' + (Math.abs(e.discBps) / 100).toFixed(1) + '% over' : (e.discBps / 100).toFixed(1) + '% under'} market`, rows: [['You have a bid on it', 'tap to buy the block instead']], href: '#/coin/' + e.mint + '/desk' })
      if (e.type === 'bid_posted') toast({ kind: 'ok', title: `${e.symbol}: a buyer wants ${S(e.sol, 2)} SOL at ${(e.discBps / 100).toFixed(1)}% under market`, rows: [['You have a sell offer on it', 'tap to sell into the bid']], href: '#/coin/' + e.mint + '/desk' })
      if (e.type === 'buy_rfq') toast({ kind: 'ok', title: `Someone wants ${S(e.sol, 2)} SOL of ${e.symbol} at +${(e.premiumBps / 100).toFixed(1)}% over market`, rows: [['Open for', e.secondsLeft + 's'], ['Sell to them', 'coin page → Desk / OTC']], href: '#/coin/' + e.mint })
      if (e.type === 'rfq' && e.rfq.seller !== activeB58) setPings((l) => [e.rfq, ...l.filter((x) => x.id !== e.rfq.id)].slice(0, 4))
      if (e.type === 'authed' && e.rfqs) setPings(e.rfqs.filter((r: K.Rfq) => r.seller !== activeB58).slice(0, 4))
      if (e.type === 'filled') { toast({ kind: 'ok', title: 'Your bid was filled', rows: [['Paid', S(Number(BigInt(e.expect.sellerLamports) + BigInt(e.expect.fee)) / 1e9) + ' SOL'], ['Tx', short(e.sig, 6)]], href: solscan(e.sig) }); setTimeout(() => setRk((k) => k + 1), 1500) }
      if (e.type === 'fillfail') toast({ kind: 'err', title: 'Fill rejected by your browser', rows: [['Reason', e.error]] })
      if (e.type === 'error' && e.re !== 'place') toast({ kind: 'err', title: 'Desk', rows: [['Error', e.error]] })
    })
    setBidder(sess); return () => sess.close()
  }, [activeB58, deskUp, connection, signMsg, signLegacy, gated])
  const onRespond = async (rfqId: string, discBps: number, sol: number) => {
    if (!bidder) return needWallet()
    try { await bidder.respond(rfqId, discBps, sol); setPings((l) => l.filter((x) => x.id !== rfqId)); toast({ kind: 'ok', title: discBps <= (pings.find((p) => p.id === rfqId)?.maxBps ?? discBps) ? 'Filling the block — seller is signing' : 'Counter sent to seller', rows: [['Your price', '−' + (discBps / 100).toFixed(2) + '%'], ['Size', S(sol, 2) + ' SOL']] }) }
    catch (e: any) { toast({ kind: 'err', title: 'Could not respond', rows: [['Reason', String(e?.message || e)]] }) }
  }
  const [gateQ, setGateQ] = useState<{ q: any; ok: (v: boolean) => void } | null>(null)
  const gate = (q: any) => new Promise<boolean>((ok) => { if (!q.needsConfirm) return ok(true); setGateQ({ q, ok: (v) => { setGateQ(null); ok(v) } }) })
  const landing = () => lastLanding.ms ? `${(lastLanding.ms / 1000).toFixed(1)}s via ${lastLanding.via || 'rpc'}` : '—'
  const takeAsk = async (id: string, sol?: number) => {
    if (!activeB58) return needWallet()
    try { const { sig, quote } = await K.takeAsk(connection, activeB58, id, signLegacy, setBusy, { sol, cuPriceMicro: Math.floor(Math.min(settings.priorityFeeSol, 0.0002) * 1e9 * 1e6 / 80_000) }); const paid = Number(BigInt(quote.sellerLamports) + BigInt(quote.fee)) / 1e9; recordBuy(ws.owner, quote.mint, quote.ask.symbol, paid, sig); setLedgerV((v) => v + 1); confetti(); toast({ kind: 'ok', title: `Bought a big chunk off the chart`, rows: [['Paid', S(paid) + ' SOL'], ['Price', (quote.ask.discBps < 0 ? '+' : '−') + (Math.abs(quote.ask.discBps) / 100).toFixed(1) + '% vs market'], ['Tx', short(sig, 6)]], href: solscan(sig) }); setTimeout(() => setRk((k) => k + 1), 1500) }
    catch (e: any) { toast({ kind: 'err', title: 'Could not buy the block', rows: [['Reason', String(e?.message || e).slice(0, 140)]] }) } finally { setBusy('') }
  }
  const takeBid = async (id: string, sol?: number) => {
    if (!activeB58) return needWallet()
    try { const { sig, quote } = await K.takeBid(connection, activeB58, id, signLegacy, setBusy, gate, { sol, cuPriceMicro: Math.floor(Math.min(settings.priorityFeeSol, 0.0002) * 1e9 * 1e6 / 80_000) }); const got = Number(BigInt(quote.sellerLamports)) / 1e9; recordSell(ws.owner, quote.mint, quote.bid.symbol, 0, got, sig); setLedgerV((v) => v + 1); confetti(); toast({ kind: 'ok', title: `Block sold on the desk`, rows: [['Received', S(got) + ' SOL'], ['Discount', '−' + (quote.bid.discBps / 100).toFixed(1) + '%'], ['Tx', short(sig, 6)]], href: solscan(sig) }); setTimeout(() => setRk((k) => k + 1), 1500) }
    catch (e: any) { toast({ kind: 'err', title: 'Big trade failed', rows: [['Reason', String(e?.message || e).slice(0, 140)]] }) } finally { setBusy('') }
  }
  const onRedeem = async (c: Coin, tokens: number, decimals: number) => {
    if (!activeB58) return needWallet()
    try { const { sig, sol } = await K.redeem(connection, activeB58, c.mint, tokens, decimals, signLegacy, setBusy); recordSell(ws.owner, c.mint, c.symbol, 0, sol, sig); setLedgerV((v) => v + 1); setVaultV((x) => x + 1); toast({ kind: 'ok', title: `Redeemed · cashed out ${c.symbol} at the floor`, rows: [['Received', S(sol, 4) + ' SOL'], ['Tx', short(sig, 6)]], href: solscan(sig) }); setTimeout(() => setRk((k) => k + 1), 1500) }
    catch (e: any) { toast({ kind: 'err', title: 'Redeem failed', rows: [['Reason', String(e?.message || e).slice(0, 140)]] }) } finally { setBusy('') }
  }
  const onClaim = async (mint: string, toVault?: K.VaultPub) => {
    const x = ctx(); if (!x) return needWallet()
    try {
      const before = await connection.getBalance(x.owner).then((b) => b / 1e9)
      const sig = await T.collectCreatorFee(x, mint); const after = await connection.getBalance(x.owner).then((b) => b / 1e9); const got = Math.max(0, after - before)
      toast({ kind: 'ok', title: `Creator fees claimed · ${S(got, 4)} SOL`, rows: [['Tx', short(sig, 6)]], href: solscan(sig) })
      if (toVault && got > 0.01) { setBusy('Sending to chest…'); const { sig: s2, vault } = await K.depositToVault(connection, x.owner.toBase58(), toVault, +(got - 0.002).toFixed(4), 0, 6, signLegacy, setBusy); setVaultV((v) => v + 1); toast({ kind: 'ok', title: `${S(got - 0.002, 4)} SOL → ${vault.symbol} chest`, href: solscan(s2) }) }
      setTimeout(() => setRk((k) => k + 1), 1500)
    } catch (e: any) { toast({ kind: 'err', title: 'Claim failed', rows: [['Reason', String(e?.message || e).slice(0, 140)]] }) } finally { setBusy('') }
  }
  // TP/SL engine: check armed orders against live prices while the tab is open
  const [ordersV, setOrdersV] = useState(0); const firing = React.useRef(false); const tokRef = React.useRef(ws.tokens); tokRef.current = ws.tokens; const busyRef = React.useRef(busy); busyRef.current = busy; const sellRef = React.useRef<(c: Coin, f: number) => Promise<void>>(async () => {})
  useEffect(() => {
    if (!ws.owner) return
    const i = setInterval(async () => {
      if (firing.current || busyRef.current) return
      const os = loadOrders(ws.owner); if (!os.length) return
      const mints = [...new Set(os.map((o) => o.mint))]; const m = await D.tokensByMint(mints).catch(() => ({} as Record<string, Coin>))
      for (const mint of mints) { const c = m[mint]; if (!c) continue
        for (const o of due(ws.owner, mint, c.priceUsd)) { const h = tokRef.current.find((t) => t.mint === mint); removeOrder(ws.owner, o.id); setOrdersV((v) => v + 1); if (!h) continue
          firing.current = true; toast({ kind: 'info', title: `${o.type === 'tp' ? 'Take profit' : 'Stop loss'} hit on ${o.symbol} — selling ${Math.round(o.frac * 100)}%` }); try { await sellRef.current(c, o.frac) } finally { firing.current = false } } }
    }, 6000); return () => clearInterval(i)
  }, [ws.owner])
  const onImport = async (mint: string) => {
    if (!activeB58) return needWallet()
    try { setBusy('Reserving vault…'); const v = await K.importCreate(activeB58, mint); const { sig, vault } = await K.payImport(connection, activeB58, v, signLegacy, setBusy); setVaultV((x) => x + 1); toast({ kind: 'ok', title: `${vault.symbol} is now VAULTED`, rows: [['Chest', S(vault.chest) + ' SOL'], ['Tx', short(sig, 6)]], href: solscan(sig) }); setTimeout(() => setRk((k) => k + 1), 1500); go('coin/' + mint) }
    catch (e: any) { toast({ kind: 'err', title: 'Import failed', rows: [['Reason', String(e?.message || e).slice(0, 140)]] }) } finally { setBusy('') }
  }
  const onCrowd = async (mint: string) => {
    if (!activeB58) return needWallet()
    try { setBusy('Opening takeover…'); const v = await K.importCrowd(activeB58, mint); setVaultV((x) => x + 1); toast({ kind: 'ok', title: `${v.symbol} takeover is open`, rows: [['Goal', v.crowd?.goalSol + ' SOL'], ['Escrow', short(v.pub, 6)]] }) }
    catch (e: any) { toast({ kind: 'err', title: 'Could not open takeover', rows: [['Reason', String(e?.message || e).slice(0, 140)]] }) } finally { setBusy('') }
  }
  const onContribute = async (v: K.VaultPub, sol: number) => {
    if (!activeB58) return needWallet()
    try { const { sig, vault } = await K.contribute(connection, activeB58, v, sol, signLegacy, setBusy); setVaultV((x) => x + 1); setTimeout(() => setRk((k) => k + 1), 1500); toast({ kind: vault.armed ? 'ok' : 'ok', title: vault.armed ? `${vault.symbol} is now VAULTED — takeover funded` : `Chipped in ${S(sol)} SOL`, rows: [['Raised', `${S(vault.crowd?.raised || 0, 2)} / ${vault.crowd?.goalSol} SOL`], ['Tx', short(sig, 6)]], href: solscan(sig) }) }
    catch (e: any) { toast({ kind: 'err', title: 'Contribution failed', rows: [['Reason', String(e?.message || e).slice(0, 140)]] }) } finally { setBusy('') }
  }
  const onDeposit = async (v: K.VaultPub, sol: number, tokens: number, decimals: number) => {
    if (!activeB58) return needWallet()
    try { const { sig, vault } = await K.depositToVault(connection, activeB58, v, sol, tokens, decimals, signLegacy, setBusy); setVaultV((x) => x + 1); toast({ kind: 'ok', title: 'Added to the chest', rows: [['Chest', S(vault.chest) + ' SOL'], ['Vault supply', vault.tokens.toLocaleString(undefined, { maximumFractionDigits: 0 })]], href: solscan(sig) }); setTimeout(() => setRk((k) => k + 1), 1500) }
    catch (e: any) { toast({ kind: 'err', title: 'Deposit failed', rows: [['Reason', String(e?.message || e).slice(0, 140)]] }) } finally { setBusy('') }
  }
  const onSwitch = async (from: Coin, toMint: string, toSymbol: string) => {
    const x = ctx(); if (!x) return needWallet()
    const h = ws.tokens.find((t) => t.mint === from.mint); if (!h) return
    try {
      const before = ws.sol || 0
      // same routing as the sell button: a resting desk bid that beats chart impact absorbs part of the exit first (zero chart impact on the coin you're leaving)
      let fracLeft = 1
      if (!from.onCurve && deskUp) {
        try {
          const px = from.raw?.priceNative ? +from.raw.priceNative : 0, liqSol = from.depthSol || 0, sizeSol = h.amount * px
          if (sizeSol > 0.2 && liqSol > 0) {
            const impact = K.poolImpactBps(sizeSol, liqSol); const book = await K.getBook(from.mint, activeB58!)
            const minB = book.minBlock || 0
            const best = book.bids.filter((b: any) => !b.mine && b.restable && !b.away && b.discBps < impact && Math.min(b.sol, sizeSol) >= Math.min(b.sol, minB)).sort((a: any, b: any) => a.discBps - b.discBps)[0]
            if (best) { const take = Math.min(best.sol, sizeSol); setBusy(`Desk takes ${S(take, 2)} SOL of ${from.symbol} at −${(best.discBps / 100).toFixed(1)}%…`); const { quote } = await K.takeBid(connection, activeB58!, best.id, signLegacy, setBusy, gate, { sol: take < best.sol - 1e-9 ? +take.toFixed(4) : undefined }); recordSell(ws.owner, from.mint, from.symbol, take / sizeSol, Number(BigInt(quote.sellerLamports)) / 1e9, ''); fracLeft = Math.max(0, 1 - take / sizeSol) }
          }
        } catch {}
      }
      if (fracLeft > 0.02) { setBusy('Selling ' + from.symbol + '…'); const sig1 = await T.sell(x, from.mint, fracLeft >= 0.98 ? 1 : fracLeft, BigInt(h.raw), from.onCurve); recordSell(ws.owner, from.mint, from.symbol, fracLeft, 0, sig1) }
      const after = await connection.getBalance(x.owner).then((b) => b / 1e9).catch(() => before); const got = Math.max(0, after - before - 0.003)
      if (got < 0.02) throw new Error('nothing to switch')
      // into the original: the vault's switch offer first (spot, no fee, no candle), the curve only for what's left
      let sig2 = '', viaVault = 0
      try { const bk = await K.getBook(toMint, activeB58!); const va = bk.asks.filter((a: any) => a.vault && !a.away).sort((a: any, b: any) => a.discBps - b.discBps)[0]
        if (va && got >= Math.max(0.1, (bk.minBlock || 0))) { const take = Math.min(va.sol, got); setBusy(`Vault hands you ${toSymbol} at spot, no fee…`); const r = await K.takeAsk(connection, activeB58!, va.id, signLegacy, setBusy, { sol: take < va.sol - 1e-9 ? +take.toFixed(4) : undefined }); sig2 = r.sig; viaVault = take; recordBuy(ws.owner, toMint, toSymbol, take, r.sig) } } catch {}
      const rest = +(got - viaVault).toFixed(4)
      if (rest >= 0.02) { const to = await D.tokenPairs(toMint); const ll = await K.llPool(toMint).catch(() => null); setBusy('Buying ' + toSymbol + '…'); sig2 = await T.buy({ ...x, venue: ll && !ll.migrated ? 'launchlab' : undefined }, toMint, rest, !!to?.onCurve || !!ll); recordBuy(ws.owner, toMint, toSymbol, rest, sig2) }
      setLedgerV((v) => v + 1)
      toast({ kind: 'ok', title: `Switched ${from.symbol} → ${toSymbol}`, rows: [['Moved', S(got) + ' SOL'], ...(viaVault ? [['Off-chart via vault', S(viaVault) + ' SOL · no fee'] as [string, string]] : []), ['Tx', short(sig2, 6)]], href: solscan(sig2) }); setTimeout(() => setRk((k) => k + 1), 1500); go('coin/' + toMint)
    } catch (e: any) { toast({ kind: 'err', title: 'Switch failed', rows: [['Reason', String(e?.message || e).slice(0, 140)]] }) } finally { setBusy('') }
  }
  const onMode = async (v: K.VaultPub, m: 'floor' | 'mm', c: number) => { try { await K.vaultSetMode(v.id, ws.owner, m, c); setVaultV((x) => x + 1); toast({ kind: 'ok', title: m === 'mm' ? `Market maker on · ceiling ${Math.round(c * 100)}%` : 'Floor mode' }) } catch (e: any) { toast({ kind: 'err', title: 'Mode change failed', rows: [['Reason', e.message]] }) } }
  const renounce = async (v: K.VaultPub) => { try { await K.vaultRenounce(v.id, ws.owner); setVaultV((x) => x + 1); toast({ kind: 'ok', title: 'You gave up your share' }) } catch (e: any) { toast({ kind: 'err', title: 'Renounce failed', rows: [['Reason', e.message]] }) } }
  const onWithdraw = async (to: string, sol: number) => { if (!burner) return; const sig = await B.withdraw(connection, burner, to, sol); toast({ kind: 'ok', title: `Sent ${S(sol)} SOL`, rows: [['To', short(to, 6)]], href: solscan(sig) }); setTimeout(() => setRk((k) => k + 1), 1500) }

  const onBuy = async (c: Coin, sol: number) => {
    const x = ctx(); if (!x) return needWallet()
    try { const sig = await T.buy({ ...x, depthSol: c.depthSol, venue: c.venue }, c.mint, sol, c.onCurve); recordBuy(ws.owner, c.mint, c.symbol, sol, sig); setLedgerV((v) => v + 1); toast({ kind: 'ok', title: `Bought ${c.symbol}`, rows: [['Landed', landing()], ['Spent', S(sol) + ' SOL'], ['Tx', short(sig, 6)]], href: solscan(sig) }); setTimeout(() => setRk((k) => k + 1), 1500) }
    catch (e: any) { toast({ kind: 'err', title: 'Buy failed', rows: [['Reason', String(e?.message || e).slice(0, 120)]] }) } finally { setBusy('') }
  }
  const onSell = async (c: Coin, frac: number) => {
    const x = ctx(); if (!x) return needWallet()
    const h = ws.tokens.find((t) => t.mint === c.mint); if (!h) return
    try { const before = ws.sol || 0; const sig = await T.sell({ ...x, depthSol: c.depthSol, venue: c.venue }, c.mint, frac, BigInt(h.raw), c.onCurve, (h.amount * (c.raw?.priceNative ? +c.raw.priceNative : 0)) * frac); const after = await connection.getBalance(x.owner).then((b) => b / 1e9).catch(() => before); recordSell(ws.owner, c.mint, c.symbol, frac, Math.max(0, after - before), sig); setLedgerV((v) => v + 1); toast({ kind: 'ok', title: `Sold ${Math.round(frac * 100)}% ${c.symbol}`, rows: [['Landed', landing()], ['Received', '≈ ' + S(Math.max(0, after - before)) + ' SOL'], ['Tx', short(sig, 6)]], href: solscan(sig) }); setTimeout(() => setRk((k) => k + 1), 1500) }
    catch (e: any) { toast({ kind: 'err', title: 'Sell failed', rows: [['Reason', String(e?.message || e).slice(0, 120)]] }) } finally { setBusy('') }
  }
  const onLaunch = async (meta: any, dev: number, stake: number, copyOf?: string, mode: 'floor' | 'mm' = 'mm', ceiling = 0.3, venue: 'launchlab' | 'pump' = 'launchlab', permTax = false, vaultBuy?: number, targetPct?: number) => {
    const buy = +(vaultBuy ?? stake * 0.5).toFixed(4)
    const x = ctx(); if (!x) return needWallet()
    try {
      let vault: K.VaultPub | null = null
      // a vault funded by a launch that failed later (expired blockhash, rejected signature) is reused on the retry instead of orphaning the stake
      const pend = pendingVault.current; if (stake > 0 && pend && pend.dev === ws.owner && pend.stake === stake && pend.venue === venue) vault = pend.v
      if (stake > 0 && !vault) { setBusy('Creating vault…'); vault = await K.vaultCreate(ws.owner, stake, copyOf, mode, ceiling, venue, buy, targetPct).catch((e) => { toast({ kind: 'err', title: 'Could not reach BANKER · launching without a chest', rows: [['Error', String(e.message)]] }); return null }) }
      let sig: string, mint: string, bundled = false
      if (vault) {
        // fund the vault first so it can buy in block zero (skipped when retrying with an already-funded vault)
        if (!pend || pend.v.id !== vault.id) { setBusy('Funding vault…'); const t = new Transaction().add(SystemProgram.transfer({ fromPubkey: x.owner, toPubkey: new PublicKey(vault.pub), lamports: Math.floor(stake * 1e9) })); t.feePayer = x.owner; t.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
        const st = await signLegacy(t); const s2 = await connection.sendRawTransaction(st.serialize()); await confirmByPolling(connection, s2); pendingVault.current = { v: vault, dev: ws.owner, stake, venue }
          // the server books the stake from the tx itself (one brand wallet holds every chest, so it can't read a deposit off the balance); retried until the tx is indexed
          for (let i = 0; i < 8; i++) { try { await K.vaultFund(vault.id, s2); break } catch (e: any) { if (i === 7) throw new Error('stake sent but not booked: ' + String(e?.message || e).slice(0, 80)); await new Promise((r) => setTimeout(r, 1500)) } } }
        const r = venue === 'launchlab' ? await T.launchOurs(x, meta, dev, vault, buy, { sendBundle: K.sendBundle, signMsg, permTax }) : await T.launchBlockZero(x, meta, dev, vault, buy, { bundleSign: K.bundleSign, sendBundle: K.sendBundle, signMsg }); sig = r.sig; mint = r.mint; bundled = r.bundled
      } else { const r = venue === 'launchlab' ? await T.launchOurs(x, meta, dev, null, 0, { sendBundle: K.sendBundle, permTax }) : await T.launch(x, meta, dev); sig = r.sig; mint = r.mint }
      pendingVault.current = null; recordCreate(ws.owner, mint, meta.symbol, dev, sig); setLedgerV((v) => v + 1); setLaunch(false)
      toast({ kind: 'ok', title: `${meta.symbol} is live${venue === 'launchlab' ? ' on BANKER' : ' on pump'}${bundled ? ' · vault in block zero' : ''}`, rows: [['Mint', short(mint, 6)], ['Dev buy', S(dev) + ' SOL']], href: solscan(sig) }); go('coin/' + mint)
      if (vault) {
        try { setBusy('Arming vault…'); const v = await K.vaultArm(vault.id, mint, meta.symbol, meta.name, await K.devAuth(signMsg, 'arm', vault.id, mint)); setVaultV((n) => n + 1); toast({ kind: 'ok', title: `Chest is on · aiming for ${v.pct}% of coins`, rows: [['Stake', S(stake) + ' SOL'], ['Vault', short(v.pub, 6)]] }) }
        catch (e: any) { toast({ kind: 'err', title: 'Your coin is live · the chest has not switched on yet', rows: [['Reason', String(e?.message || e).slice(0, 120)], ['Vault address', vault.pub]] }) }
      }
      setTimeout(() => setRk((k) => k + 1), 1500)
    }
    catch (e: any) { toast({ kind: 'err', title: 'Launch failed', rows: [['Reason', String(e?.message || e).slice(0, 140)], ...(pendingVault.current ? [['Your stake', 'still in the vault — press Create again to retry']] as [string, string][] : [])] }) } finally { setBusy('') }
  }
  // a launch whose coin went out but whose arm never ran (phantom blocked the message signature, bundle route down, tab closed): arm it from the Vault page
  const onArm = async (v: K.VaultPub) => { if (!v.mint) return; try { setBusy('Arming vault…'); const r = await K.vaultArm(v.id, v.mint, v.symbol || '', v.name || '', await K.devAuth(signMsg, 'arm', v.id, v.mint)); setVaultV((n) => n + 1); toast({ kind: 'ok', title: `Chest is on · aiming for ${r.pct}% of coins`, rows: [['Chest', S(r.chest) + ' SOL']] }) } catch (e: any) { toast({ kind: 'err', title: 'Arm failed', rows: [['Reason', String(e?.message || e).slice(0, 140)]] }) } finally { setBusy('') } }
  const onRefund = async (v: K.VaultPub) => { try { setBusy(v.armed ? 'Selling the vault and withdrawing…' : 'Refunding stake…'); const r = await K.vaultRefund(v.id, await K.devAuth(signMsg, 'refund', v.id, v.mint || 'none')); setVaultV((n) => n + 1); toast({ kind: 'ok', title: `${v.armed ? 'Withdrawn' : 'Stake refunded'} · ${S(r.sol)} SOL`, rows: [['To', short(ws.owner, 6)], ['Tx', short(r.sig, 6)]], href: solscan(r.sig) }); setTimeout(() => setRk((k) => k + 1), 1500) } catch (e: any) { toast({ kind: 'err', title: 'Refund failed', rows: [['Reason', String(e?.message || e).slice(0, 140)]] }) } finally { setBusy('') } }
  sellRef.current = onSell
  const quick = (c: Coin) => { if (!connected) return needWallet(); onBuy(c, settings.quickBuy) }
  const buyUsd = (c: Coin, usd: number) => { if (!connected) return needWallet(); if (!solPrice) return; onBuy(c, +(usd / solPrice).toFixed(4)) }
  const toggleWatch = (m: string) => setSettings({ watch: settings.watch.includes(m) ? settings.watch.filter((x) => x !== m) : [...settings.watch, m] })

  const content = () => {
    if (page === 'coin' && arg) { const h = ws.tokens.find((t) => t.mint === arg); return <CoinPage simple={simple} mint={arg} coin={byMint[arg]} solPrice={solPrice} holding={h} lot={ledger.lots[arg]} sol={ws.sol} connected={connected} busy={busy} onBuy={onBuy} onSell={onSell} needWallet={needWallet} quickSol={settings.quickBuy} watch={settings.watch} toggleWatch={toggleWatch} trades={allTrades} subscribe={fresh.subscribe} desk={{ owner: ws.owner, connected, bidder, deskUp, busy, takeBid, takeAsk, holdingUi: h?.amount || 0, solPrice }} deskTick={deskTick} vaultV={vaultV} onRenounce={renounce} onRedeem={onRedeem} onDeposit={onDeposit} onMode={onMode} onSwitch={onSwitch} go={go} ordersV={ordersV} bumpOrders={() => setOrdersV((v) => v + 1)} fills={ledger.fills} /> }
    if (page === 'trending') return <SimpleTrending coins={coins} vaults={vaultList} solPrice={solPrice} go={go} usd={10} buyUsd={buyUsd} />
    if (page === 'chests') return <SimpleChests byMint={byMint} vaults={vaultList} solPrice={solPrice} go={go} onLaunch={() => openLaunch()} />
    if (page === 'portfolio' && simple) return <SimplePortfolio owner={ws.owner || undefined} onConnect={needWallet} sol={ws.sol} tokens={ws.tokens} coins={byMint} lots={ledger.lots} vaults={vaultList} solPrice={solPrice} go={go} />
    if (page === 'portfolio') return <Portfolio onConnect={needWallet} sol={ws.sol} tokens={ws.tokens} coins={byMint} lots={ledger.lots} fills={ledger.fills} solPrice={solPrice} go={go} owner={ws.owner} />
    if (page === 'settings') return <SettingsPage s={settings} set={setSettings} owner={ws.owner || undefined} signTx={ctx()?.sign} conn={connection} />
    if (page === 'about') return <About />
    if (page === 'compare') return <Compare coins={coins} vaults={vaultList} solPrice={solPrice} go={go} />
    if (page === 'docs') return <Tabs tabs={[['How it works', <About />], ['Simulate', <Simulate />], ['Vaulted vs not', <Compare coins={coins} vaults={vaultList} solPrice={solPrice} go={go} />], ['Leaderboard', <LeaderboardPage owner={ws.owner} />]]} sel={arg} go={(t) => go('docs/' + t)} />
    if (page === 'simulate') return <Simulate />
    if (page === 'vault') return <Tabs tabs={[['Vaults', <VaultPage go={go} solPrice={solPrice} onLaunch={() => openLaunch()} />], ['Import', <ImportPage owner={ws.owner} connected={connected} busy={busy} onPay={onImport} onCrowd={onCrowd} onContribute={onContribute} go={go} initialMint={arg2 || ''} needWallet={needWallet} sol={ws.sol} />]]} sel={arg} go={(t) => go('vault/' + t)} />
    if (page === 'desk') return <DeskPage go={go} coins={coins} owner={ws.owner} bidder={bidder} />
    if (page === 'import') return <ImportPage owner={ws.owner} connected={connected} busy={busy} onPay={onImport} onCrowd={onCrowd} onContribute={onContribute} go={go} initialMint={arg || ''} needWallet={needWallet} sol={ws.sol} />
    if (page === 'dev' || page === 'mine') return <MinePage owner={ws.owner} go={go} solPrice={solPrice} onRenounce={renounce} onClaim={onClaim} onArm={onArm} onRefund={onRefund} busy={busy} onConnect={needWallet} onLaunch={() => openLaunch()} />
    if (page === 'leaderboard') return <LeaderboardPage owner={ws.owner} />
    if (simple && !q.trim()) return <SimpleHome coins={coins} byMint={byMint} vaults={vaultList} solPrice={solPrice} go={go} usd={10} buyUsd={buyUsd} />
    return <Home simple={simple} coins={q.trim() ? results : coins} byMint={byMint} vaults={vaultList} solPrice={solPrice} go={go} quick={quick} quickSol={settings.quickBuy} deskUp={deskUp} onLaunch={() => openLaunch()} fresh={fresh.list} freshCoins={freshCoins} trades={fresh.trades} live={fresh.live} err={err} watch={settings.watch} />
  }
  return <div className={'app' + (simple ? ' simple ' + (settings.skin || 'captain') + ' pg-' + (page || 'home') : '')}>
    <div className="top">
      <a className="logo" href="#/"><img src="banker.png" alt="" />BANKER<span>the bank that never closes</span></a>
      <div className="search"><span className="dim">⌕</span><input placeholder="CA or ticker" value={q} onChange={(e) => { setQ(e.target.value); if (page !== 'home') go('') }} /><kbd>/</kbd></div>
      <div className="qb"><span>⚡ Quick buy</span>{[0.1, 0.5, 1, 2].map((v) => <button key={v} className={settings.quickBuy === v ? 'on' : ''} onClick={() => setSettings({ quickBuy: v })}>{v}</button>)}</div>
      <span className="sp" />
      <button className={'btn wbtn' + (connected ? ' on' : '')} onClick={() => setWp(true)}>{connected ? <><span className="num">{ws.sol == null ? '…' : S(ws.sol) + ' SOL'}</span><span className="dim num">{short(activeKey!.toBase58(), 3)}</span>{mode === 'burner' && <span className="tag live">1-CLICK</span>}</> : (mode === 'burner' && B.hasBurner() ? 'Unlock wallet' : 'Connect wallet')}</button>
      <button className="btn pri" onClick={() => openLaunch()}>Launch</button>
    </div>
    <div className="body">
      <nav className="side">{nav.map(([k, l, d, i]) => <a key={k} href={'#/' + (k === 'home' ? '' : k)} className={'nav' + (page === k ? ' on' : '')}><span className="ico">{i}</span><span className="lab"><b>{l}</b><small>{d}</small></span></a>)}
        <div className="cap">More</div>{MORE.map(([k, l]) => <a key={k} href={'#/' + k} className={'nav sub' + ((page + '/' + arg === k || page === k) ? ' on' : '')}><span className="lab"><b>{l}</b></span></a>)}
        <button className="btn sm simple-toggle" onClick={toggleSimple} title="Simple hides the pro tools; Pro shows everything">{simple ? 'Simple mode · switch to Pro' : 'Pro mode · switch to Simple'}</button><div className="foot">{deskUp ? 'beta' : <span className="dn">server offline</span>}</div></nav>
      <main className="main">{gated ? <Gate wallet={activeB58} connected={connected} signMsg={signMsg} needWallet={needWallet} onOpen={() => { setGated(false); setVaultV((n) => n + 1) }} /> : <React.Suspense fallback={<div className="empty">…</div>}>{content()}</React.Suspense>}</main>
    </div>
    {!simple && <footer className="sbar">
      <span className={'sb-live ' + (deskUp ? 'up' : 'dn')}><i />{deskUp ? 'Live' : 'Reconnecting'}</span>
      {deskUp && lat != null && <span title="round trip to the BANKER server">server <b className="num">{lat} ms</b></span>}
      <span>SOL <b className="num">{solPrice ? '$' + solPrice.toFixed(2) : '—'}</b></span>
      <span title="the ⚡ button size">quick buy <b className="num">{settings.quickBuy} SOL</b></span>
      <span title="the price can move at most this much before a trade cancels">slippage <b className="num">{(settings.slippageBps / 100).toFixed(0)}%</b></span>
      <span title="tip that routes trades through validators fast">fast lane <b className={settings.mev ? 'up' : 'dim'}>{settings.mev ? 'on' : 'off'}</b></span>
      <span className="sp" />
      <span className="dim">non-custodial · your wallet signs every trade</span>
    </footer>}
    {simple && page !== 'coin' && <SimpleNav page={page} onMore={() => setMore(true)} moreOn={more} />}
    <nav className="mnav" style={{ gridTemplateColumns: `repeat(${nav.length + 1},1fr)` }}>{nav.map(([k, l, , i]) => <a key={k} href={'#/' + (k === 'home' ? '' : k)} className={page === k ? 'on' : ''}><b>{i}</b>{l}</a>)}<a href="#" onClick={(e) => { e.preventDefault(); setMore(true) }} className={more ? 'on' : ''}><b>≡</b>More</a></nav>
    {more && simple && <div className="modal s-sheet-bg" onClick={() => setMore(false)}><div className="s-sheet" onClick={(e) => e.stopPropagation()}>
      <div className="s-grab" />
      <button className="s-sheet-big" onClick={() => { setMore(false); openLaunch() }}>{Ic.rocket(22)}<span><b>Launch a coin</b><small>it comes with its own chest</small></span></button>
      <div className="s-sheet-grid">
        <a href="#/dev" onClick={() => setMore(false)}>{Ic.user(18)}<span>My launches</span></a>
        <a href="#/docs" onClick={() => setMore(false)}>{Ic.book(18)}<span>How it works</span></a>
        <a href="#/settings" onClick={() => setMore(false)}>{Ic.gear(18)}<span>Settings</span></a>
        <a href="#/leaderboard" onClick={() => setMore(false)}>{Ic.trophy(18)}<span>Leaderboard</span></a>
      </div>
      <button className="s-sheet-pro" onClick={() => { toggleSimple(); setMore(false) }}>Switch to Pro mode · charts, desk, all the tools</button>
    </div></div>}
    {more && !simple && <div className="modal" onClick={() => setMore(false)}><div className="box" onClick={(e) => e.stopPropagation()} style={{ width: 360 }}><h2>More</h2><div className="panel" style={{ gap: 4 }}>
      <button className="btn pri big" onClick={() => { setMore(false); openLaunch() }}>Launch a coin</button>
      {MORE.map(([k, l]) => <a key={k} href={'#/' + k} className="btn" onClick={() => setMore(false)}>{l}</a>)}
      <button className="btn" onClick={() => { toggleSimple(); setMore(false) }}>{simple ? 'Switch to Pro mode (all the tools)' : 'Switch to Simple mode'}</button></div></div></div>}
    {gateQ && <div className="modal" onClick={() => gateQ.ok(false)}><div className="box" onClick={(e) => e.stopPropagation()} style={{ width: 420 }}>
      <h2>Price moved since you posted</h2>
      <div className="kv"><span>You posted at</span><b className="num">{Number(gateQ.q.anchorPrice).toPrecision(4)} SOL</b></div>
      <div className="kv"><span>Spot now</span><b className="num dn">{Number(gateQ.q.priceSol).toPrecision(4)} SOL ({(gateQ.q.drift * 100).toFixed(1)}%)</b></div>
      <div className="kv"><span>This fill</span><b className="num">{Number(gateQ.q.px).toPrecision(4)} SOL · −{(gateQ.q.bid.discBps / 100).toFixed(1)}% vs now · you get {(Number(gateQ.q.sellerLamports) / 1e9).toFixed(3)} SOL</b></div>
      <div className="row" style={{ marginTop: 6 }}><button className="btn" onClick={() => gateQ.ok(false)}>Hold</button><span className="sp" /><button className="btn pri" onClick={() => gateQ.ok(true)}>Fill at new price</button></div>
    </div></div>}
    {wp && <WalletPanel onClose={() => setWp(false)} burner={burner} setBurner={setBurner} mode={mode} setMode={setMode} sol={ws.sol} onWithdraw={onWithdraw} />}
    {launch && <Launch onClose={() => setLaunch(false)} onLaunch={onLaunch} busy={busy} connected={connected} sol={ws.sol} wallet={ws.owner} walletKind={mode === 'burner' ? 'in-app' : (wallet.wallet?.adapter?.name?.toLowerCase() as any) || 'wallet'} needWallet={needWallet} taxBps={llp?.taxBps} permTaxBps={llp?.permTaxBps} platformReady={!!llp?.chain?.exists} />}
    <div className="toasts" style={{ bottom: 'auto', top: 64 }}>{pings.map((r) => <RfqPing key={r.id} r={r} bidder={bidder} onRespond={onRespond} onDismiss={() => setPings((l) => l.filter((x) => x.id !== r.id))} busy={busy} />)}</div>
    <Toasts />
  </div>
}
