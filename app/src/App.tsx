import React, { useCallback, useMemo, useState, useEffect } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import * as K from './lib/desk'
import { DeskPage, VaultPage } from './components/Desk'
import { confirmByPolling } from './lib/rpc'
import WalletPanel from './components/WalletPanel'
import * as B from './lib/burner'
import { useRoute, useSettings, useSolPrice, useTrending, useNewTokens, useWalletState, useCoins } from './hooks'
import Board from './components/Board'
import CoinPage from './components/CoinPage'
import Launch from './components/Launch'
import { Portfolio, SettingsPage, About } from './components/Pages'
import { Toasts } from './components/ui'
import { toast } from './lib/store'
import * as T from './lib/trade'
import * as D from './lib/dex'
import { solscan } from './lib/rpc'
import { loadLedger, recordBuy, recordSell, recordCreate } from './lib/positions'
import { S, short } from './lib/fmt'
import type { Coin } from './lib/dex'

const NAV: [string, string][] = [['home', 'Home'], ['portfolio', 'Portfolio'], ['vault', 'Vault'], ['desk', 'Desk'], ['settings', 'Settings'], ['about', 'How it works']]

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
  const byMint = useMemo(() => { const m: Record<string, Coin> = { ...freshCoins, ...heldCoins }; coins.forEach((c) => (m[c.mint] = c)); results.forEach((c) => (m[c.mint] = c)); return m }, [coins, freshCoins, heldCoins, results])
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
  const [bidder, setBidder] = useState<K.BidderSession | null>(null); const [deskUp, setDeskUp] = useState(false); const [deskTick, setDeskTick] = useState(0)
  useEffect(() => { K.health().then(() => setDeskUp(true)).catch(() => setDeskUp(false)); const i = setInterval(() => K.health().then(() => setDeskUp(true)).catch(() => setDeskUp(false)), 30000); return () => clearInterval(i) }, [])
  useEffect(() => {
    if (!activeB58 || !deskUp) { setBidder(null); return }
    const sess = K.openBidder(connection, activeB58, signMsg, signLegacy, async (m) => { const c = await D.tokenPairs(m); return c?.raw?.priceNative ? +c.raw.priceNative : 0 }, (e) => {
      setDeskTick((t) => t + 1)
      if (e.type === 'filled') { toast({ kind: 'ok', title: 'Your bid was filled', rows: [['Paid', S(Number(BigInt(e.expect.sellerLamports) + BigInt(e.expect.fee)) / 1e9) + ' SOL'], ['Tx', short(e.sig, 6)]], href: solscan(e.sig) }); setTimeout(() => setRk((k) => k + 1), 1500) }
      if (e.type === 'fillfail') toast({ kind: 'err', title: 'Fill rejected by your browser', rows: [['Reason', e.error]] })
      if (e.type === 'error' && e.re !== 'place') toast({ kind: 'err', title: 'Desk', rows: [['Error', e.error]] })
    })
    setBidder(sess); return () => sess.close()
  }, [activeB58, deskUp, connection, signMsg, signLegacy])
  const takeBid = async (id: string) => {
    if (!activeB58) return needWallet()
    try { const { sig, quote } = await K.takeBid(connection, activeB58, id, signLegacy, setBusy); const got = Number(BigInt(quote.sellerLamports)) / 1e9; recordSell(ws.owner, quote.mint, quote.bid.symbol, 0, got, sig); setLedgerV((v) => v + 1); toast({ kind: 'ok', title: `Block sold on the desk`, rows: [['Received', S(got) + ' SOL'], ['Discount', '−' + (quote.bid.discBps / 100).toFixed(1) + '%'], ['Tx', short(sig, 6)]], href: solscan(sig) }); setTimeout(() => setRk((k) => k + 1), 1500) }
    catch (e: any) { toast({ kind: 'err', title: 'Desk fill failed', rows: [['Reason', String(e?.message || e).slice(0, 140)]] }) } finally { setBusy('') }
  }
  const [vaultV, setVaultV] = useState(0)
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
  const onLaunch = async (meta: any, dev: number, stake: number) => {
    const x = ctx(); if (!x) return needWallet()
    try {
      let vault: K.VaultPub | null = null
      if (stake > 0) { setBusy('Creating vault…'); vault = await K.vaultCreate(ws.owner, stake).catch((e) => { toast({ kind: 'err', title: 'Vault server unreachable — launching without a vault', rows: [['Error', String(e.message)]] }); return null }) }
      const { sig, mint } = await T.launch(x, meta, dev); recordCreate(ws.owner, mint, meta.symbol, dev, sig); setLedgerV((v) => v + 1); setLaunch(false)
      toast({ kind: 'ok', title: `${meta.symbol} is live on pump.fun`, rows: [['Mint', short(mint, 6)], ['Dev buy', S(dev) + ' SOL']], href: solscan(sig) }); go('coin/' + mint)
      if (vault) {
        try {
          setBusy('Funding vault…'); const t = new Transaction().add(SystemProgram.transfer({ fromPubkey: x.owner, toPubkey: new PublicKey(vault.pub), lamports: Math.floor(stake * 1e9) })); t.feePayer = x.owner; t.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
          const st = await signLegacy(t); const s2 = await connection.sendRawTransaction(st.serialize()); await confirmByPolling(connection, s2)
          setBusy('Arming vault…'); const v = await K.vaultArm(vault.id, mint, meta.symbol); setVaultV((n) => n + 1)
          toast({ kind: 'ok', title: `Vault armed · ${v.pct}% supply target`, rows: [['Stake', S(stake) + ' SOL'], ['Vault', short(v.pub, 6)]], href: solscan(s2) })
        } catch (e: any) { toast({ kind: 'err', title: 'Vault funding failed — coin is live, vault is not', rows: [['Reason', String(e?.message || e).slice(0, 120)], ['Vault address', vault.pub]] }) }
      }
      setTimeout(() => setRk((k) => k + 1), 1500)
    }
    catch (e: any) { toast({ kind: 'err', title: 'Launch failed', rows: [['Reason', String(e?.message || e).slice(0, 140)]] }) } finally { setBusy('') }
  }
  const quick = (c: Coin) => { if (!connected) return needWallet(); onBuy(c, settings.quickBuy) }
  const toggleWatch = (m: string) => setSettings({ watch: settings.watch.includes(m) ? settings.watch.filter((x) => x !== m) : [...settings.watch, m] })

  const content = () => {
    if (page === 'coin' && arg) { const h = ws.tokens.find((t) => t.mint === arg); return <CoinPage mint={arg} coin={byMint[arg]} solPrice={solPrice} holding={h} lot={ledger.lots[arg]} sol={ws.sol} connected={connected} busy={busy} onBuy={onBuy} onSell={onSell} needWallet={needWallet} quickSol={settings.quickBuy} watch={settings.watch} toggleWatch={toggleWatch} trades={fresh.trades} subscribe={fresh.subscribe} desk={{ owner: ws.owner, connected, bidder, deskUp, busy, takeBid, holdingUi: h?.amount || 0, solPrice }} deskTick={deskTick} vaultV={vaultV} onRenounce={renounce} /> }
    if (page === 'portfolio') return <Portfolio sol={ws.sol} tokens={ws.tokens} coins={byMint} lots={ledger.lots} fills={ledger.fills} solPrice={solPrice} go={go} owner={ws.owner} />
    if (page === 'settings') return <SettingsPage s={settings} set={setSettings} />
    if (page === 'about') return <About />
    if (page === 'vault') return <VaultPage go={go} solPrice={solPrice} />
    if (page === 'desk') return <DeskPage go={go} />
    if (false) return <div className="prose"><h2>{page === 'vault' ? 'Vault' : 'Desk'} <span className="tag pre">PREVIEW</span></h2><p>{page === 'vault' ? 'Program-owned market maker funded by the dev\'s block-zero stake. Buys dips (≤40% of chest per crash), trims only above holder cost basis and 30-min VWAP, never withdraws. Ships on-chain in Beta v1 — the per-coin preview is on each coin page under Protocol.' : 'Escrowed block bids at −3–5%, 60s rest, all-or-none, min block 2% of pool reserve, open once a coin has graduated and holds $100K mc. Ships with the vault program; the gating is already computed live on each coin page.'}</p></div>
    return <Board coins={q.trim() ? results : coins} fresh={fresh.list} freshCoins={freshCoins} trades={fresh.trades} live={fresh.live} solPrice={solPrice} watch={settings.watch} go={go} quick={quick} quickSol={settings.quickBuy} err={err} />
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
        <div className="foot">Non-custodial · mainnet-beta<br />Trades: pump.fun via PumpPortal, Jupiter<br />Data: DexScreener, pump.fun stream<br />Desk + vault: <span className={deskUp ? 'up' : 'dn'}>{deskUp ? 'online' : 'offline'}</span></div></nav>
      <main className="main">{content()}</main>
    </div>
    {wp && <WalletPanel onClose={() => setWp(false)} burner={burner} setBurner={setBurner} mode={mode} setMode={setMode} sol={ws.sol} onWithdraw={onWithdraw} />}
    {launch && <Launch onClose={() => setLaunch(false)} onLaunch={onLaunch} busy={busy} connected={connected} sol={ws.sol} needWallet={needWallet} />}
    <Toasts />
  </div>
}
