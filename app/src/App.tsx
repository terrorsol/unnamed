import React, { useCallback, useMemo, useState, useEffect } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import * as K from './lib/desk'
import { DeskPage, VaultPage, MinePage, LeaderboardPage, ImportPage, RfqPing } from './components/Desk'
import { due, removeOrder, loadOrders } from './lib/orders'
import { confirmByPolling } from './lib/rpc'
import WalletPanel from './components/WalletPanel'
import * as B from './lib/burner'
import { useRoute, useSettings, useSolPrice, useTrending, useNewTokens, useWalletState, useCoins } from './hooks'
import Home from './components/Home'
import CoinPage from './components/CoinPage'
import Launch from './components/Launch'
import { Portfolio, SettingsPage, About } from './components/Pages'
import Simulate from './components/Simulate'
import { Toasts } from './components/ui'
import { toast } from './lib/store'
import * as T from './lib/trade'
import * as D from './lib/dex'
import { solscan } from './lib/rpc'
import { loadLedger, recordBuy, recordSell, recordCreate } from './lib/positions'
import { S, short } from './lib/fmt'
import type { Coin } from './lib/dex'

const NAV: [string, string][] = [['home', 'Home'], ['desk', 'Desk'], ['vault', 'Vault'], ['dev', 'Dev'], ['portfolio', 'Portfolio'], ['settings', 'Settings']]

function Tabs({ tabs, sel, go }: { tabs: [string, React.ReactNode][]; sel: string; go: (t: string) => void }) {
  const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const cur = tabs.find(([t]) => slug(t) === sel) || tabs[0]
  return <><div className="seg" style={{ marginBottom: 12 }}>{tabs.map(([t]) => <button key={t} className={cur[0] === t ? 'on' : ''} onClick={() => go(slug(t))}>{t}</button>)}</div>{cur[1]}</>
}
export default function App() {
  const { page, arg, go } = useRoute()
  const [settings, setSettings] = useSettings()
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
  const [busy, setBusy] = useState(''); const [launch, setLaunch] = useState(false); const [q, setQ] = useState(''); const [results, setResults] = useState<Coin[]>([])
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

  const ctx = useCallback((): T.Ctx | null => {
    if (mode === 'burner') { if (!burner) return null; return { conn: connection, owner: burner.publicKey, sign: B.signWith(burner), settings, onStatus: setBusy } }
    if (!wallet.publicKey || !wallet.signTransaction) return null
    return { conn: connection, owner: wallet.publicKey, sign: wallet.signTransaction as any, settings, onStatus: setBusy }
  }, [mode, burner, wallet.publicKey, wallet.signTransaction, connection, settings])
  const needWallet = () => { setWp(true) }
  // --- signing helpers for legacy txs / messages (desk + vault) ---
  const signLegacy = useCallback(async (t: Transaction) => { if (mode === 'burner') { if (!burner) throw new Error('wallet locked'); t.partialSign(burner); return t } if (!wallet.signTransaction) throw new Error('wallet cannot sign'); return wallet.signTransaction(t) }, [mode, burner, wallet.signTransaction])
  const signMsg = useCallback(async (m: Uint8Array) => { if (mode === 'burner') { if (!burner) throw new Error('wallet locked'); return K.signMsgWith(burner)(m) } if (!wallet.signMessage) throw new Error('wallet cannot sign messages'); return wallet.signMessage(m) }, [mode, burner, wallet.signMessage])
  const [bidder, setBidder] = useState<K.BidderSession | null>(null); const [deskTick, setDeskTick] = useState(0)
  const [pings, setPings] = useState<K.Rfq[]>([]); const [swaps, setSwaps] = useState<any[]>([])
  const allTrades = useMemo(() => [...swaps, ...fresh.trades].sort((a, b) => b.ts - a.ts).slice(0, 200), [swaps, fresh.trades])
  useEffect(() => { if (!deskUp) return; return K.openSwapFeed((sw) => setSwaps((l) => [{ mint: sw.mint, txType: sw.side, sol: sw.sol, tokens: 0, trader: sw.trader, mcapSol: 0, ts: sw.t, sig: sw.sig }, ...l].slice(0, 200))) }, [deskUp])
  useEffect(() => { K.health().then(() => setDeskUp(true)).catch(() => setDeskUp(false)); const i = setInterval(() => K.health().then(() => setDeskUp(true)).catch(() => setDeskUp(false)), 30000); return () => clearInterval(i) }, [])
  useEffect(() => {
    if (!activeB58 || !deskUp) { setBidder(null); return }
    const sess = K.openBidder(connection, activeB58, signMsg, signLegacy, async (m) => { const c = await D.tokenPairs(m); return c?.raw?.priceNative ? +c.raw.priceNative : 0 }, (e) => {
      setDeskTick((t) => t + 1)
      if (e.type === 'buy_rfq') toast({ kind: 'ok', title: `Block buyer: ${S(e.sol, 2)} SOL of ${e.symbol} at +${(e.premiumBps / 100).toFixed(1)}%`, rows: [['Open for', e.secondsLeft + 's'], ['Fill it', 'coin page → Desk / OTC']], href: '#/coin/' + e.mint })
      if (e.type === 'rfq' && e.rfq.seller !== activeB58) setPings((l) => [e.rfq, ...l.filter((x) => x.id !== e.rfq.id)].slice(0, 4))
      if (e.type === 'authed' && e.rfqs) setPings(e.rfqs.filter((r: K.Rfq) => r.seller !== activeB58).slice(0, 4))
      if (e.type === 'filled') { toast({ kind: 'ok', title: 'Your bid was filled', rows: [['Paid', S(Number(BigInt(e.expect.sellerLamports) + BigInt(e.expect.fee)) / 1e9) + ' SOL'], ['Tx', short(e.sig, 6)]], href: solscan(e.sig) }); setTimeout(() => setRk((k) => k + 1), 1500) }
      if (e.type === 'fillfail') toast({ kind: 'err', title: 'Fill rejected by your browser', rows: [['Reason', e.error]] })
      if (e.type === 'error' && e.re !== 'place') toast({ kind: 'err', title: 'Desk', rows: [['Error', e.error]] })
    })
    setBidder(sess); return () => sess.close()
  }, [activeB58, deskUp, connection, signMsg, signLegacy])
  const onRespond = async (rfqId: string, discBps: number, sol: number) => {
    if (!bidder) return needWallet()
    try { await bidder.respond(rfqId, discBps, sol); setPings((l) => l.filter((x) => x.id !== rfqId)); toast({ kind: 'ok', title: discBps <= (pings.find((p) => p.id === rfqId)?.maxBps ?? discBps) ? 'Filling the block — seller is signing' : 'Counter sent to seller', rows: [['Your price', '−' + (discBps / 100).toFixed(2) + '%'], ['Size', S(sol, 2) + ' SOL']] }) }
    catch (e: any) { toast({ kind: 'err', title: 'Could not respond', rows: [['Reason', String(e?.message || e)]] }) }
  }
  const [gateQ, setGateQ] = useState<{ q: any; ok: (v: boolean) => void } | null>(null)
  const gate = (q: any) => new Promise<boolean>((ok) => { if (!q.needsConfirm) return ok(true); setGateQ({ q, ok: (v) => { setGateQ(null); ok(v) } }) })
  const takeBid = async (id: string) => {
    if (!activeB58) return needWallet()
    try { const { sig, quote } = await K.takeBid(connection, activeB58, id, signLegacy, setBusy, gate); const got = Number(BigInt(quote.sellerLamports)) / 1e9; recordSell(ws.owner, quote.mint, quote.bid.symbol, 0, got, sig); setLedgerV((v) => v + 1); toast({ kind: 'ok', title: `Block sold on the desk`, rows: [['Received', S(got) + ' SOL'], ['Discount', '−' + (quote.bid.discBps / 100).toFixed(1) + '%'], ['Tx', short(sig, 6)]], href: solscan(sig) }); setTimeout(() => setRk((k) => k + 1), 1500) }
    catch (e: any) { toast({ kind: 'err', title: 'Desk fill failed', rows: [['Reason', String(e?.message || e).slice(0, 140)]] }) } finally { setBusy('') }
  }
  const onRedeem = async (c: Coin, tokens: number, decimals: number) => {
    if (!activeB58) return needWallet()
    try { const { sig, sol } = await K.redeem(connection, activeB58, c.mint, tokens, decimals, signLegacy, setBusy); recordSell(ws.owner, c.mint, c.symbol, 0, sol, sig); setLedgerV((v) => v + 1); setVaultV((x) => x + 1); toast({ kind: 'ok', title: `Redeemed ${c.symbol} against the vault`, rows: [['Received', S(sol, 4) + ' SOL'], ['Tx', short(sig, 6)]], href: solscan(sig) }); setTimeout(() => setRk((k) => k + 1), 1500) }
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
    try { const { sig, vault } = await K.depositToVault(connection, activeB58, v, sol, tokens, decimals, signLegacy, setBusy); setVaultV((x) => x + 1); toast({ kind: 'ok', title: 'Deposited into the vault', rows: [['Chest', S(vault.chest) + ' SOL'], ['Vault supply', vault.tokens.toLocaleString(undefined, { maximumFractionDigits: 0 })]], href: solscan(sig) }); setTimeout(() => setRk((k) => k + 1), 1500) }
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
            const best = book.bids.filter((b: any) => !b.mine && b.restable && b.discBps < impact && b.sol <= sizeSol * 1.02).sort((a: any, b: any) => a.discBps - b.discBps)[0]
            if (best) { setBusy(`Desk takes ${S(best.sol, 2)} SOL of ${from.symbol} at −${(best.discBps / 100).toFixed(1)}%…`); const { quote } = await K.takeBid(connection, activeB58!, best.id, signLegacy, setBusy, gate); recordSell(ws.owner, from.mint, from.symbol, best.sol / sizeSol, Number(BigInt(quote.sellerLamports)) / 1e9, ''); fracLeft = Math.max(0, 1 - best.sol / sizeSol) }
          }
        } catch {}
      }
      if (fracLeft > 0.02) { setBusy('Selling ' + from.symbol + '…'); const sig1 = await T.sell(x, from.mint, fracLeft >= 0.98 ? 1 : fracLeft, BigInt(h.raw), from.onCurve); recordSell(ws.owner, from.mint, from.symbol, fracLeft, 0, sig1) }
      const after = await connection.getBalance(x.owner).then((b) => b / 1e9).catch(() => before); const got = Math.max(0, after - before - 0.003)
      if (got < 0.02) throw new Error('nothing to switch')
      const to = await D.tokenPairs(toMint); setBusy('Buying ' + toSymbol + '…'); const sig2 = await T.buy(x, toMint, +got.toFixed(4), !!to?.onCurve); recordBuy(ws.owner, toMint, toSymbol, got, sig2); setLedgerV((v) => v + 1)
      toast({ kind: 'ok', title: `Switched ${from.symbol} → ${toSymbol}`, rows: [['Moved', S(got) + ' SOL'], ['Tx', short(sig2, 6)]], href: solscan(sig2) }); setTimeout(() => setRk((k) => k + 1), 1500); go('coin/' + toMint)
    } catch (e: any) { toast({ kind: 'err', title: 'Switch failed', rows: [['Reason', String(e?.message || e).slice(0, 140)]] }) } finally { setBusy('') }
  }
  const onMode = async (v: K.VaultPub, m: 'floor' | 'mm', c: number) => { try { await K.vaultSetMode(v.id, ws.owner, m, c); setVaultV((x) => x + 1); toast({ kind: 'ok', title: m === 'mm' ? `Market maker on · ceiling ${Math.round(c * 100)}%` : 'Floor mode' }) } catch (e: any) { toast({ kind: 'err', title: 'Mode change failed', rows: [['Reason', e.message]] }) } }
  const renounce = async (v: K.VaultPub) => { try { await K.vaultRenounce(v.id, ws.owner); setVaultV((x) => x + 1); toast({ kind: 'ok', title: 'Cut renounced' }) } catch (e: any) { toast({ kind: 'err', title: 'Renounce failed', rows: [['Reason', e.message]] }) } }
  const onWithdraw = async (to: string, sol: number) => { if (!burner) return; const sig = await B.withdraw(connection, burner, to, sol); toast({ kind: 'ok', title: `Sent ${S(sol)} SOL`, rows: [['To', short(to, 6)]], href: solscan(sig) }); setTimeout(() => setRk((k) => k + 1), 1500) }

  const onBuy = async (c: Coin, sol: number) => {
    const x = ctx(); if (!x) return needWallet()
    try { const sig = await T.buy(x, c.mint, sol, c.onCurve); recordBuy(ws.owner, c.mint, c.symbol, sol, sig); setLedgerV((v) => v + 1); toast({ kind: 'ok', title: `Bought ${c.symbol}`, rows: [['Spent', S(sol) + ' SOL'], ['Tx', short(sig, 6)]], href: solscan(sig) }); setTimeout(() => setRk((k) => k + 1), 1500) }
    catch (e: any) { toast({ kind: 'err', title: 'Buy failed', rows: [['Reason', String(e?.message || e).slice(0, 120)]] }) } finally { setBusy('') }
  }
  const onSell = async (c: Coin, frac: number) => {
    const x = ctx(); if (!x) return needWallet()
    const h = ws.tokens.find((t) => t.mint === c.mint); if (!h) return
    try { const before = ws.sol || 0; const sig = await T.sell(x, c.mint, frac, BigInt(h.raw), c.onCurve); const after = await connection.getBalance(x.owner).then((b) => b / 1e9).catch(() => before); recordSell(ws.owner, c.mint, c.symbol, frac, Math.max(0, after - before), sig); setLedgerV((v) => v + 1); toast({ kind: 'ok', title: `Sold ${Math.round(frac * 100)}% ${c.symbol}`, rows: [['Received', '≈ ' + S(Math.max(0, after - before)) + ' SOL'], ['Tx', short(sig, 6)]], href: solscan(sig) }); setTimeout(() => setRk((k) => k + 1), 1500) }
    catch (e: any) { toast({ kind: 'err', title: 'Sell failed', rows: [['Reason', String(e?.message || e).slice(0, 120)]] }) } finally { setBusy('') }
  }
  const onLaunch = async (meta: any, dev: number, stake: number, copyOf?: string, mode: 'floor' | 'mm' = 'mm', ceiling = 0.3) => {
    const x = ctx(); if (!x) return needWallet()
    try {
      let vault: K.VaultPub | null = null
      if (stake > 0) { setBusy('Creating vault…'); vault = await K.vaultCreate(ws.owner, stake, copyOf, mode, ceiling).catch((e) => { toast({ kind: 'err', title: 'Vault server unreachable — launching without a vault', rows: [['Error', String(e.message)]] }); return null }) }
      let sig: string, mint: string, bundled = false
      if (vault) {
        // fund the vault first so it can buy in block zero
        setBusy('Funding vault…'); const t = new Transaction().add(SystemProgram.transfer({ fromPubkey: x.owner, toPubkey: new PublicKey(vault.pub), lamports: Math.floor(stake * 1e9) })); t.feePayer = x.owner; t.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
        const st = await signLegacy(t); const s2 = await connection.sendRawTransaction(st.serialize()); await confirmByPolling(connection, s2)
        const r = await T.launchBlockZero(x, meta, dev, vault, +(stake * 0.5).toFixed(4), { bundleSign: K.bundleSign, sendBundle: K.sendBundle }); sig = r.sig; mint = r.mint; bundled = r.bundled
      } else { const r = await T.launch(x, meta, dev); sig = r.sig; mint = r.mint }
      recordCreate(ws.owner, mint, meta.symbol, dev, sig); setLedgerV((v) => v + 1); setLaunch(false)
      toast({ kind: 'ok', title: `${meta.symbol} is live${bundled ? ' · vault in block zero' : ''}`, rows: [['Mint', short(mint, 6)], ['Dev buy', S(dev) + ' SOL']], href: solscan(sig) }); go('coin/' + mint)
      if (vault) {
        try { setBusy('Arming vault…'); const v = await K.vaultArm(vault.id, mint, meta.symbol, meta.name); setVaultV((n) => n + 1); toast({ kind: 'ok', title: `Vault armed · ${v.pct}% supply target`, rows: [['Stake', S(stake) + ' SOL'], ['Vault', short(v.pub, 6)]] }) }
        catch (e: any) { toast({ kind: 'err', title: 'Vault arm failed — coin is live', rows: [['Reason', String(e?.message || e).slice(0, 120)], ['Vault address', vault.pub]] }) }
      }
      setTimeout(() => setRk((k) => k + 1), 1500)
    }
    catch (e: any) { toast({ kind: 'err', title: 'Launch failed', rows: [['Reason', String(e?.message || e).slice(0, 140)]] }) } finally { setBusy('') }
  }
  sellRef.current = onSell
  const quick = (c: Coin) => { if (!connected) return needWallet(); onBuy(c, settings.quickBuy) }
  const toggleWatch = (m: string) => setSettings({ watch: settings.watch.includes(m) ? settings.watch.filter((x) => x !== m) : [...settings.watch, m] })

  const content = () => {
    if (page === 'coin' && arg) { const h = ws.tokens.find((t) => t.mint === arg); return <CoinPage mint={arg} coin={byMint[arg]} solPrice={solPrice} holding={h} lot={ledger.lots[arg]} sol={ws.sol} connected={connected} busy={busy} onBuy={onBuy} onSell={onSell} needWallet={needWallet} quickSol={settings.quickBuy} watch={settings.watch} toggleWatch={toggleWatch} trades={allTrades} subscribe={fresh.subscribe} desk={{ owner: ws.owner, connected, bidder, deskUp, busy, takeBid, holdingUi: h?.amount || 0, solPrice }} deskTick={deskTick} vaultV={vaultV} onRenounce={renounce} onRedeem={onRedeem} onDeposit={onDeposit} onMode={onMode} onSwitch={onSwitch} go={go} ordersV={ordersV} bumpOrders={() => setOrdersV((v) => v + 1)} fills={ledger.fills} /> }
    if (page === 'portfolio') return <Portfolio sol={ws.sol} tokens={ws.tokens} coins={byMint} lots={ledger.lots} fills={ledger.fills} solPrice={solPrice} go={go} owner={ws.owner} />
    if (page === 'settings') return <SettingsPage s={settings} set={setSettings} />
    if (page === 'about') return <About />
    if (page === 'simulate') return <Simulate />
    if (page === 'vault') return <Tabs tabs={[['Vaults', <VaultPage go={go} solPrice={solPrice} />], ['Simulate', <Simulate />]]} sel={arg} go={(t) => go('vault/' + t)} />
    if (page === 'desk') return <Tabs tabs={[['Books', <DeskPage go={go} />], ['Leaderboard', <LeaderboardPage owner={ws.owner} />]]} sel={arg} go={(t) => go('desk/' + t)} />
    if (page === 'dev' || page === 'mine' || page === 'import') return <Tabs tabs={[['My launches', <MinePage owner={ws.owner} go={go} solPrice={solPrice} onRenounce={renounce} onClaim={onClaim} busy={busy} />], ['Import a coin', <ImportPage owner={ws.owner} connected={connected} busy={busy} onPay={onImport} onCrowd={onCrowd} onContribute={onContribute} go={go} initialMint={page === 'import' ? arg : ''} needWallet={needWallet} sol={ws.sol} />], ['How it works', <About />]]} sel={page === 'import' ? 'import-a-coin' : arg} go={(t) => go('dev/' + t)} />
    if (page === 'leaderboard') return <LeaderboardPage owner={ws.owner} />
    if (false) return <div className="prose"><h2>{page === 'vault' ? 'Vault' : 'Desk'} <span className="tag pre">PREVIEW</span></h2><p>{page === 'vault' ? 'Program-owned market maker funded by the dev\'s block-zero stake. Buys dips (≤40% of chest per crash), trims only above holder cost basis and 30-min VWAP, never withdraws. Ships on-chain in Beta v1 — the per-coin preview is on each coin page under Protocol.' : 'Escrowed block bids at −3–5%, 60s rest, all-or-none, min block 2% of pool reserve, open once a coin has graduated and holds $100K mc. Ships with the vault program; the gating is already computed live on each coin page.'}</p></div>
    return <Home coins={q.trim() ? results : coins} byMint={byMint} vaults={vaultList} solPrice={solPrice} go={go} quick={quick} quickSol={settings.quickBuy} deskUp={deskUp} onLaunch={() => setLaunch(true)} fresh={fresh.list} freshCoins={freshCoins} trades={fresh.trades} live={fresh.live} err={err} watch={settings.watch} />
  }
  return <div className="app">
    <div className="top">
      <a className="logo" href="#/">UNNAMED<span>beta · mainnet</span></a>
      <div className="search"><span className="dim">⌕</span><input placeholder="Search name, ticker or mint" value={q} onChange={(e) => { setQ(e.target.value); if (page !== 'home') go('') }} /><kbd>/</kbd></div>
      <div className="qb"><span>⚡ Quick buy</span>{[0.1, 0.5, 1, 2].map((v) => <button key={v} className={settings.quickBuy === v ? 'on' : ''} onClick={() => setSettings({ quickBuy: v })}>{v}</button>)}</div>
      <span className="sp" />
      <button className="btn" onClick={() => setWp(true)}>{connected ? <><span className="status"><i /></span><span className="num">{ws.sol == null ? '…' : S(ws.sol) + ' SOL'}</span><span className="dim num">{short(activeKey!.toBase58(), 3)}</span>{mode === 'burner' && <span className="tag live">1-CLICK</span>}</> : (mode === 'burner' && B.hasBurner() ? 'Unlock wallet' : 'Connect wallet')}</button>
      <button className="btn pri" onClick={() => setLaunch(true)}>Launch</button>
    </div>
    <div className="body">
      <nav className="side">{NAV.map(([k, l]) => <a key={k} href={'#/' + (k === 'home' ? '' : k)} className={page === k ? 'on' : ''}>{l}</a>)}
        <div className="foot"><a href="#/dev/how-it-works" style={{ color: 'var(--fg3)' }}>How it works</a> · <a href="#/vault/simulate" style={{ color: 'var(--fg3)' }}>Simulate</a><br />Non-custodial · mainnet-beta<br />Desk + vault: <span className={deskUp ? 'up' : 'dn'}>{deskUp ? 'online' : 'offline'}</span></div></nav>
      <main className="main">{content()}</main>
    </div>
    <nav className="mnav">{([['home', 'Home', '◼'], ['desk', 'Desk', '⇄'], ['vault', 'Vault', '◆'], ['portfolio', 'Bag', '◎'], ['dev', 'Dev', '✦']] as [string, string, string][]).map(([k, l, i]) => <a key={k} href={'#/' + (k === 'home' ? '' : k)} className={page === k ? 'on' : ''}><b>{i}</b>{l}</a>)}</nav>
    {gateQ && <div className="modal" onClick={() => gateQ.ok(false)}><div className="box" onClick={(e) => e.stopPropagation()} style={{ width: 420 }}>
      <h2>Price moved since you posted</h2>
      <div className="kv"><span>You posted at</span><b className="num">{Number(gateQ.q.anchorPrice).toPrecision(4)} SOL</b></div>
      <div className="kv"><span>Spot now</span><b className="num dn">{Number(gateQ.q.priceSol).toPrecision(4)} SOL ({(gateQ.q.drift * 100).toFixed(1)}%)</b></div>
      <div className="kv"><span>This fill</span><b className="num">{Number(gateQ.q.px).toPrecision(4)} SOL · −{(gateQ.q.bid.discBps / 100).toFixed(1)}% vs now · you get {(Number(gateQ.q.sellerLamports) / 1e9).toFixed(3)} SOL</b></div>
      <div className="row" style={{ marginTop: 6 }}><button className="btn" onClick={() => gateQ.ok(false)}>Hold</button><span className="sp" /><button className="btn pri" onClick={() => gateQ.ok(true)}>Fill at new price</button></div>
    </div></div>}
    {wp && <WalletPanel onClose={() => setWp(false)} burner={burner} setBurner={setBurner} mode={mode} setMode={setMode} sol={ws.sol} onWithdraw={onWithdraw} />}
    {launch && <Launch onClose={() => setLaunch(false)} onLaunch={onLaunch} busy={busy} connected={connected} sol={ws.sol} needWallet={needWallet} />}
    <div className="toasts" style={{ bottom: 'auto', top: 64 }}>{pings.map((r) => <RfqPing key={r.id} r={r} bidder={bidder} onRespond={onRespond} onDismiss={() => setPings((l) => l.filter((x) => x.id !== r.id))} busy={busy} />)}</div>
    <Toasts />
  </div>
}
