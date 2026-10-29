// Simple mode (phones by default): the calm face of BANKER. One job per screen, dollars instead of SOL,
// plain safety checks, a chest you can watch fill. Same data and actions as the pro screens; only the presentation changes.
// Look: black, white and green like a bank app (Cash App / Robinhood calm), gold only for the chest and your level.
import React, { useMemo, useState } from 'react'
import type { Coin } from '../lib/dex'
import type * as K from '../lib/desk'
import type { RugCheck } from '../lib/rpc'
import { Pfp } from './ui'
import { F, S, ago, money } from '../lib/fmt'
import { classify, featsFromCoin } from '../lib/signal'
import { ladder } from './Progress'
import { burstFrom, coinRain } from '../lib/fx'
import { haptic, Roll } from './Flow'

export const USD_PRESETS = [5, 10, 25, 50]

/** one consistent line-icon set (24px grid, 1.75 stroke) */
const svg = (d: React.ReactNode, s = 20) => <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d}</svg>
export const Ic = {
  trending: (s?: number) => svg(<><path d="M3 17 9 11l4 4 8-8" /><path d="M15 7h6v6" /></>, s),
  shield: (s?: number) => svg(<><path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.2 7.5 9.5 4.4-1.3 7.5-4.9 7.5-9.5V6L12 3Z" /><path d="m9 12 2 2 4-4" /></>, s),
  wallet: (s?: number) => svg(<><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3" /><rect x="4" y="8" width="16" height="11" rx="2.5" /><path d="M16 13.5h.01" /></>, s),
  grid: (s?: number) => svg(<><rect x="4" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" /></>, s),
  bank: (s?: number) => svg(<><path d="M3.5 9.5 12 4.5l8.5 5H3.5Z" /><path d="M6 10v7M10 10v7M14 10v7M18 10v7M3.5 19.5h17" /></>, s),
  home: (s?: number) => svg(<><path d="M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5H15v-6h-6v6H5.5A1.5 1.5 0 0 1 4 19v-8.5Z" /></>, s),
  rocket: (s?: number) => svg(<><path d="M12 3c3 2.2 4.5 5.4 4.5 9.2V16h-9v-3.8C7.5 8.4 9 5.2 12 3Z" /><circle cx="12" cy="10" r="1.6" /><path d="M7.5 13.5 5 16v3l2.5-1.2M16.5 13.5 19 16v3l-2.5-1.2M10.5 19.5 12 21l1.5-1.5" /></>, s),
  book: (s?: number) => svg(<><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5v-13Z" /><path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5v-13Z" /></>, s),
  gear: (s?: number) => svg(<><circle cx="12" cy="12" r="3" /><path d="M12 3v2M12 19v2M4.2 7.5l1.7 1M18.1 15.5l1.7 1M4.2 16.5l1.7-1M18.1 8.5l1.7-1" /><circle cx="12" cy="12" r="7" /></>, s),
  trophy: (s?: number) => svg(<><path d="M8 4h8v5a4 4 0 0 1-8 0V4Z" /><path d="M8 6H5v1.5A3 3 0 0 0 8 10.5M16 6h3v1.5a3 3 0 0 1-3 3M12 13v4M8.5 20h7M10 17h4" /></>, s),
  user: (s?: number) => svg(<><circle cx="12" cy="8.5" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></>, s),
  lock: (s?: number) => svg(<><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>, s),
  check: (s?: number) => svg(<path d="m5 12.5 4.5 4.5L19 7.5" />, s),
  alert: (s?: number) => svg(<><path d="M12 8v5M12 16.5h.01" /><path d="M10.3 4.2 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z" /></>, s),
  chest: (s?: number) => svg(<><path d="M3.5 10.5A3.5 3.5 0 0 1 7 7h10a3.5 3.5 0 0 1 3.5 3.5V19h-17v-8.5Z" /><path d="M3.5 12.5h17" /><rect x="10.25" y="11" width="3.5" height="3.5" rx=".8" /></>, s),
  arrow: (s?: number) => svg(<path d="M5 12h14M13 6l6 6-6 6" />, s),
  chev: (s?: number) => svg(<path d="m9 6 6 6-6 6" />, s),
  bolt: (s?: number) => svg(<path d="M13.5 2.5 5 13.5h6.5L10.5 21.5 19 10.5h-6.5l1-8Z" />, s),
  info: (s?: number) => svg(<><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8h.01" /></>, s),
  swap: (s?: number) => svg(<><path d="M7 4 4 7l3 3M4 7h12M17 20l3-3-3-3M20 17H8" /></>, s),
  x: (s?: number) => svg(<path d="M6 6l12 12M18 6 6 18" />, s),
  back: (s?: number) => svg(<path d="M15 6l-6 6 6 6" />, s),
  star: (s?: number, on?: boolean) => <svg viewBox="0 0 24 24" width={s || 20} height={s || 20} fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" aria-hidden><path d="m12 3.8 2.5 5.1 5.6.8-4 4 .9 5.6-5-2.7-5 2.7.9-5.6-4-4 5.6-.8L12 3.8Z" /></svg>,
}

/** the chest mark: a gold tile with a line chest; `fill` (0..1) shows how much of the coin it backs; `bump` gives a soft pulse */
export function ChestArt({ size = 44, bump = false, fill = 0 }: { size?: number; bump?: boolean; fill?: number }) {
  const f = Math.max(0, Math.min(1, fill))
  return <span className={'s-chest' + (bump ? ' bump' : '')} style={{ width: size, height: size }} aria-hidden>
    {Ic.chest(Math.round(size * 0.5))}
    <i style={{ height: `${Math.max(6, f * 100)}%` }} />
  </span>
}

/** a progress ring (Cash App savings style) with something in the middle */
export function Ring({ frac, size = 56, stroke = 5, children, tone = 'gold' }: { frac: number; size?: number; stroke?: number; children?: React.ReactNode; tone?: 'gold' | 'green' }) {
  const r = (size - stroke) / 2, C = 2 * Math.PI * r, f = Math.max(0.02, Math.min(1, frac || 0))
  return <span className={'ring ' + tone} style={{ width: size, height: size }}>
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden><circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="ring-tr" /><circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} strokeLinecap="round" className="ring-fl" strokeDasharray={C} strokeDashoffset={C * (1 - f)} transform={`rotate(-90 ${size / 2} ${size / 2})`} /></svg>
    <span className="ring-in">{children}</span>
  </span>
}

/** the 3–4 checks a normal buyer cares about, in plain words */
export function safetyChecks(c: Coin, vault: K.VaultPub | null | undefined, rug: RugCheck | null | undefined) {
  const out: { ok: boolean; text: string }[] = []
  if (vault) out.push({ ok: true, text: `Protected by a chest · ${S(vault.chest, 2)} SOL behind it` })
  else out.push({ ok: false, text: 'No chest protecting this coin' })
  const h = rug || ((vault as any)?.holders as RugCheck | null)
  if (h) {
    out.push(h.mintAuthority ? { ok: false, text: 'The creator can still make more coins' } : { ok: true, text: 'Nobody can print more coins' })
    out.push(h.freezeAuthority ? { ok: false, text: 'The creator can freeze coins' } : { ok: true, text: 'Nobody can freeze your coins' })
    const big = vault ? (h.holders || []).filter((x) => x.address !== vault.pub).reduce((m, x) => Math.max(m, x.pct), 0) : h.top1Pct
    out.push(big > 20 ? { ok: false, text: `One wallet holds ${big.toFixed(0)}% of the coins` } : { ok: true, text: 'No single wallet holds too much' })
  }
  return out
}
export function Safety({ checks }: { checks: { ok: boolean; text: string }[] }) {
  return <div className="s-card">
    <div className="s-h">Safety check</div>
    {checks.map((x, i) => <div key={i} className={'s-check ' + (x.ok ? 'ok' : 'warn')}><span className="s-dot">{x.ok ? Ic.check(13) : Ic.alert(13)}</span>{x.text}</div>)}
  </div>
}

const chg = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(Math.abs(n) >= 100 ? 0 : 1)}%`
const risky = (c: Coin, vault?: K.VaultPub) => { const sg = classify(featsFromCoin(c, (vault as any)?.holders || null, !!vault)); return sg.label === 'RUG RISK' || sg.label === 'BUNDLED' || sg.label === 'CRASHING' }

/** one coin as a list row: rank, face, name (+shield if it has a chest), value, and a tinted change cell */
export function CoinRow({ c, vault, rank, onOpen, sub }: { c: Coin; vault?: K.VaultPub; rank?: number; onOpen: () => void; sub?: React.ReactNode }) {
  const ch = c.ch1h || 0
  return <button className="cr" onClick={onOpen}>
    {rank != null && <span className="cr-rank num">{rank}</span>}
    <Pfp c={c} lg />
    <span className="cr-mid">
      <span className="cr-name">{c.symbol}{vault && <span className="cr-shield" title="has a chest">{Ic.shield(13)}</span>}{risky(c, vault) && <span className="cr-warn">Careful</span>}</span>
      <span className="cr-sub num">{sub ?? <>{F(c.mcap)} <span className="cr-dim">value</span></>}</span>
    </span>
    <span className={'cr-chg num ' + (ch >= 0 ? 'up' : 'dn')}>{chg(ch)}<small>1h</small></span>
  </button>
}
/** kept for older callers */
export function CoinCard({ c, vault, onOpen }: { c: Coin; vault?: K.VaultPub; solPrice: number; onOpen: () => void; onBuy: () => void; usd: number }) { return <CoinRow c={c} vault={vault} onOpen={onOpen} /> }

const Trust = () => <div className="s-trust">{Ic.lock(14)}<span>Your money stays in your wallet. BANKER never holds it.</span></div>
const greeting = () => { const h = new Date().getHours(); return h < 5 ? 'Late night, captain' : h < 12 ? 'Morning, captain' : h < 18 ? 'Afternoon, captain' : 'Evening, captain' }
const DAY = 86400000

/** what the chests did today, across every coin: the social proof line */
function chestDay(vaults: K.VaultPub[]) {
  const since = Date.now() - DAY; let dips = 0, takes = 0, fees = 0, moves = 0, last = 0
  for (const v of vaults) for (const a of v.activity || []) { last = Math.max(last, a.t || 0); if (a.t < since) continue; moves++; if (a.kind === 'buy') dips++; else if (a.kind === 'capture') takes++; else if (a.kind === 'tax') fees += a.sol || 0 }
  return { dips, takes, fees, moves, last }
}

/** simple home: one job — pick a protected coin. A spotlight (the coin with the biggest chest) with one Buy, a ranked list, everything else one tap away. */
export function SimpleHome({ coins, byMint, vaults, solPrice, go, buyUsd, usd }: { coins: Coin[]; byMint: Record<string, Coin>; vaults: K.VaultPub[]; solPrice: number; go: (p: string) => void; buyUsd: (c: Coin, usd: number) => void; usd: number }) {
  const ours = vaults.filter((v) => v.mint && v.armed).map((v) => ({ v, c: byMint[v.mint!] })).filter((x) => x.c).sort((a, b) => b.v.chest - a.v.chest) as { v: K.VaultPub; c: Coin }[]
  const ourMints = new Set(ours.map((x) => x.c.mint))
  const popular = coins.map((c) => ({ c, s: classify(featsFromCoin(c, null, ourMints.has(c.mint))) })).filter((x) => x.s.label !== 'DEAD' && x.s.label !== 'RUG RISK' && x.s.label !== 'BUNDLED' && !ourMints.has(x.c.mint)).sort((a, b) => b.s.score - a.s.score).slice(0, 5)
  const inChests = vaults.reduce((a, v) => a + v.chest, 0)
  const day = chestDay(vaults)
  const top = ours[0]
  return <div className="s-home">
    <header className="hh">
      <div className="hh-k">{greeting()}</div>
      <div className="hh-v num"><Roll v={inChests} from0 fmt={(n) => S(n, 1) + ' SOL'} /></div>
      <div className="hh-s"><span className="live" />protecting holders right now{solPrice ? <> · ${S(inChests * solPrice, 0)}</> : null}</div>
      <div className="hh-stats">
        <div><b className="num">{ours.length}</b><span>{ours.length === 1 ? 'coin protected' : 'coins protected'}</span></div>
        {(() => { const dips = vaults.reduce((a, v) => a + (v.score?.dips || 0), 0); return dips > 0 ? <div><b className="num">{dips}</b><span>dips bought</span></div> : <div><b className="num">{day.moves}</b><span>moves today</span></div> })()}
        <div><b className="num">{day.last ? ago(day.last) : '—'}</b><span>since last move</span></div>
      </div>
    </header>
    {top && (() => { const { v, c } = top; const L = ladder(c.mcap); const ch = c.ch1h || 0
      return <section className="spot" onClick={() => go('coin/' + c.mint)}>
        <div className="spot-k"><span className="chip gold">{Ic.chest(13)} Biggest chest</span><span className="sp" /><span className={'spot-chg num ' + (ch >= 0 ? 'up' : 'dn')}>{chg(ch)} <small>1h</small></span></div>
        <div className="spot-id"><Pfp c={c} lg /><div className="spot-nm"><b>{c.symbol}</b><span>{c.name}</span></div><div className="spot-v"><b className="num">{F(c.mcap)}</b><span>value</span></div></div>
        <div className="spot-q">
          <div className="row"><span>{L.next ? <>Next goal <b className="num">{F(L.next)}</b></> : 'Every goal hit'}</span><span className="sp" /><b className="num gold">{Math.round(L.frac * 100)}%</b></div>
          <div className="meter"><i style={{ width: `${Math.max(3, L.frac * 100)}%` }} /></div>
          <div className="spot-chest">{Ic.shield(14)}<span><b className="num">{S(v.chest, 2)} SOL</b> chest buys the dips for holders</span></div>
        </div>
        <div className="spot-cta"><button className="btn pri big" onClick={(e) => { e.stopPropagation(); haptic(10); burstFrom(e.currentTarget, 8); buyUsd(c, usd) }} disabled={!solPrice}>Buy ${usd}</button><button className="btn big ghost" onClick={(e) => { e.stopPropagation(); go('coin/' + c.mint) }} aria-label="Open coin">See coin</button></div>
      </section> })()}
    {ours.length > 1 && <section className="grp">
      <div className="grp-hd"><b>Protected coins</b><span className="sp" /><a href="#/chests">All chests {Ic.chev(14)}</a></div>
      {ours.slice(1, 4).map(({ v, c }) => <CoinRow key={v.id} c={c} vault={v} onOpen={() => go('coin/' + c.mint)} sub={<>{F(c.mcap)} <span className="cr-dim">· {S(v.chest, 1)} SOL chest</span></>} />)}
    </section>}
    <section className="grp">
      <div className="grp-hd"><b>Popular right now</b><span className="sp" /><a href="#/trending">See all {Ic.chev(14)}</a></div>
      {!popular.length && <div className="s-empty">{coins.length ? 'Nothing else is moving right now.' : 'Loading coins…'}</div>}
      {popular.map(({ c }, i) => <CoinRow key={c.mint} c={c} rank={i + 1} onOpen={() => go('coin/' + c.mint)} />)}
    </section>
    <Trust />
    <a className="s-how" href="#/docs">How the chest works {Ic.chev(14)}</a>
  </div>
}

/** holder level: earned by holding, never by trading more. 1 point per day held per coin (max 30 a coin), +5 for each coin you hold that has a chest. */
export function holderLevel(lots: { t: number }[], chestCoins: number) {
  const xp = lots.reduce((a, l) => a + Math.min(30, Math.max(0, (Date.now() - l.t) / 86400000)), 0) + chestCoins * 5
  const level = Math.floor(Math.sqrt(xp / 2)) + 1
  const lo = 2 * (level - 1) ** 2, hi = 2 * level ** 2
  const title = level >= 8 ? 'Banker' : level >= 5 ? 'Diamond hands' : level >= 3 ? 'Steady hands' : 'New holder'
  return { xp, level, title, frac: Math.min(1, (xp - lo) / (hi - lo)), toNext: Math.max(0, hi - xp) }
}
function holdBadges(heldDays: number, pnlPct: number | null, chest: boolean) {
  const b: { t: string; k: string }[] = []
  if (chest) b.push({ t: 'Chest', k: 'chest' })
  if (heldDays >= 30) b.push({ t: 'Held 30d', k: 'gold' }); else if (heldDays >= 7) b.push({ t: 'Held 7d', k: 'gold' }); else if (heldDays >= 1) b.push({ t: 'Held 1d+', k: '' })
  if (pnlPct != null && pnlPct >= 100) b.push({ t: `${(1 + pnlPct / 100).toFixed(1)}×`, k: 'up' })
  return b
}
/** the shield-shaped level badge (gold: it's earned) */
export const LevelBadge = ({ n, lg }: { n: number; lg?: boolean }) => <span className={'lvb' + (lg ? ' lg' : '')}><svg viewBox="0 0 40 44" aria-hidden><path d="M20 2 4 8v11c0 10.5 7 18.5 16 23 9-4.5 16-12.5 16-23V8L20 2Z" /></svg><b className="num">{n}</b></span>

export function SimplePortfolio({ owner, onConnect, sol, tokens, coins, lots, vaults, solPrice, go }: { owner?: string; onConnect?: () => void; sol: number | null; tokens: { mint: string; amount: number }[]; coins: Record<string, Coin>; lots: Record<string, { costSol: number; t: number; symbol?: string }>; vaults: K.VaultPub[]; solPrice: number; go: (p: string) => void }) {
  const chestMints = new Set(vaults.filter((v) => v.armed && v.mint).map((v) => v.mint!))
  const merged = Object.values(tokens.reduce((m, t) => { (m[t.mint] ||= { mint: t.mint, amount: 0 }).amount += t.amount; return m }, {} as Record<string, { mint: string; amount: number }>))
  const rows = merged.map((t) => { const c = coins[t.mint]; const usd = c ? t.amount * c.priceUsd : 0; const lot = lots[t.mint]; const costUsd = lot ? lot.costSol * solPrice : 0; return { t, c, usd, lot, pnlPct: lot && costUsd > 0 ? (usd / costUsd - 1) * 100 : null, days: lot ? (Date.now() - lot.t) / 86400000 : 0 } }).filter((r) => r.c || r.lot).sort((a, b) => b.usd - a.usd)
  const total = rows.reduce((a, r) => a + r.usd, 0), cost = rows.reduce((a, r) => a + (r.lot ? r.lot.costSol * solPrice : 0), 0)
  const gain = cost > 0 ? total - cost : 0
  const lv = holderLevel(rows.filter((r) => r.lot).map((r) => r.lot!), rows.filter((r) => chestMints.has(r.t.mint)).length)
  // level up by holding → the big celebration (never for trading more)
  const [lvUp, setLvUp] = useState(false)
  React.useEffect(() => { if (!owner || !rows.length) return; let last = 0; try { last = +(localStorage.getItem('banker_level') || 0) } catch {} if (last && lv.level > last) { setLvUp(true); coinRain(); haptic([30, 50, 30, 50, 80]); setTimeout(() => setLvUp(false), 4200) } try { localStorage.setItem('banker_level', String(lv.level)) } catch {} }, [lv.level, rows.length, owner])
  if (!owner) return <div className="s-home">
    <header className="hh"><div className="hh-k">My coins</div><div className="hh-v num">$0.00</div><div className="hh-s">Connect a wallet to see what you own, how it's doing, and the chest behind each coin.</div></header>
    <button className="btn pri big" onClick={onConnect}>Connect wallet</button>
    <Trust />
  </div>
  return <div className="s-home">
    {lvUp && <div className="s-lvup"><LevelBadge n={lv.level} /><div><b>Level up · {lv.title}</b><div className="nm">You earned it by holding.</div></div></div>}
    <header className="hh">
      <div className="hh-k">Your coins are worth</div>
      <div className="hh-v num"><Roll v={total} from0 fmt={(n) => '$' + money(n)} /></div>
      {cost > 0 ? <div className={'hh-s num ' + (gain >= 0 ? 'up' : 'dn')}>{gain >= 0 ? '▲' : '▼'} ${money(Math.abs(gain))} ({chg((gain / cost) * 100)}) <span className="dim">since you bought</span></div> : <div className="hh-s">{rows.length ? `${rows.length} coin${rows.length > 1 ? 's' : ''} in your wallet` : 'Nothing bought yet'}</div>}
      {sol != null && <div className="hh-cash"><span>Ready to spend</span><b className="num">{S(sol, 3)} SOL</b><span className="dim num">${money(sol * solPrice)}</span></div>}
    </header>
    <section className="lvl">
      <LevelBadge n={lv.level} lg />
      <div className="lvl-mid"><div className="row"><b>{lv.title}</b><span className="sp" /><span className="dim num">{lv.toNext > 0 ? `${Math.ceil(lv.toNext)} pts to lvl ${lv.level + 1}` : 'Max level'}</span></div>
        <div className="meter"><i style={{ width: `${Math.max(3, lv.frac * 100)}%` }} /></div>
        <div className="dim">Level up by holding. Coins with a chest count extra.</div></div>
    </section>
    <section className="grp">
      <div className="grp-hd"><b>Your coins</b><span className="sp" /><span className="dim num">{rows.length}</span></div>
      {!rows.length && <div className="s-empty">No coins yet. Pick one with a chest on Home to start.</div>}
      {rows.map(({ t, c, usd, lot, pnlPct, days }) => <button key={t.mint} className="cr" onClick={() => go('coin/' + t.mint)}>
        <Pfp c={c} mint={t.mint} lg />
        <span className="cr-mid"><span className="cr-name">{c?.symbol || lots[t.mint]?.symbol || t.mint.slice(0, 4)}{chestMints.has(t.mint) && <span className="cr-shield">{Ic.shield(13)}</span>}</span>
          <span className="cr-badges">{holdBadges(days, pnlPct, false).map((b) => <span key={b.t} className={'s-badge ' + b.k}>{b.t}</span>)}{lot && days < 1 && <span className="cr-dim">bought {ago(lot.t)} ago</span>}{!lot && <span className="cr-dim">{F(c?.mcap || 0)} value</span>}</span></span>
        <span className="cr-right"><b className="num">${money(usd)}</b>{pnlPct != null && <span className={'num ' + (pnlPct >= 0 ? 'up' : 'dn')}>{chg(pnlPct)}</span>}</span>
      </button>)}
    </section>
  </div>
}

/** simple bottom bar: center is king — a raised round Home button, two tabs each side */
export function SimpleNav({ page, onMore, moreOn }: { page: string; onMore: () => void; moreOn: boolean }) {
  const tab = (href: string, key: string, ico: React.ReactNode, label: string) => <a href={href} className={'s-tab' + (page === key ? ' on' : '')} onClick={() => haptic(6)}>{ico}<span>{label}</span></a>
  return <nav className="s-nav">
    {tab('#/trending', 'trending', Ic.trending(22), 'Trending')}
    {tab('#/chests', 'chests', Ic.chest(22), 'Chests')}
    <a href="#/" className={'s-center' + (page === 'home' ? ' on' : '')} aria-label="Home" onClick={() => haptic(8)}><span className="s-center-btn"><span className="coin-face">{Ic.home(24)}</span></span><span className="s-center-lbl">Home</span></a>
    {tab('#/portfolio', 'portfolio', Ic.wallet(22), 'My coins')}
    <a href="#" className={'s-tab' + (moreOn ? ' on' : '')} onClick={(e) => { e.preventDefault(); haptic(6); onMore() }}>{Ic.grid(22)}<span>More</span></a>
  </nav>
}

/** trending: everything popular right now, filterable, risky ones flagged */
export function SimpleTrending({ coins, vaults, go }: { coins: Coin[]; vaults: K.VaultPub[]; solPrice: number; go: (p: string) => void; buyUsd: (c: Coin, usd: number) => void; usd: number }) {
  const [f, setF] = useState<'all' | 'chest' | 'up' | 'new'>('all')
  const vm = useMemo(() => new Map(vaults.filter((v) => v.mint && v.armed).map((v) => [v.mint!, v])), [vaults])
  const base = coins.map((c) => ({ c, s: classify(featsFromCoin(c, null, vm.has(c.mint))) })).filter((x) => x.s.label !== 'DEAD')
  const list = (f === 'chest' ? base.filter((x) => vm.has(x.c.mint)) : f === 'up' ? base.filter((x) => (x.c.ch1h || 0) > 0).sort((a, b) => (b.c.ch1h || 0) - (a.c.ch1h || 0)) : f === 'new' ? base.filter((x) => x.c.createdAt && Date.now() - x.c.createdAt < DAY).sort((a, b) => b.c.createdAt - a.c.createdAt) : base.sort((a, b) => b.s.score - a.s.score)).slice(0, 30)
  const F_ = [['all', 'Popular'], ['chest', 'Protected'], ['up', 'Gainers'], ['new', 'New today']] as const
  return <div className="s-home">
    <div className="s-title">Trending</div>
    <div className="chips">{F_.map(([k, l]) => <button key={k} className={f === k ? 'on' : ''} onClick={() => { setF(k); haptic(6) }}>{l}</button>)}</div>
    <section className="grp">
      {!list.length && <div className="s-empty">{coins.length ? 'Nothing here right now.' : 'Loading coins…'}</div>}
      {list.map(({ c }, i) => <CoinRow key={c.mint} c={c} vault={vm.get(c.mint)} rank={i + 1} onOpen={() => go('coin/' + c.mint)} />)}
    </section>
    <div className="s-note">Coins marked <b>Careful</b> look risky: insiders, a crash, or one wallet holding too much.</div>
  </div>
}

/** chests: every protected coin with its chest front and center */
export function SimpleChests({ byMint, vaults, solPrice, go, onLaunch }: { byMint: Record<string, Coin>; vaults: K.VaultPub[]; solPrice: number; go: (p: string) => void; onLaunch: () => void }) {
  const list = vaults.filter((v) => v.mint && v.armed).sort((a, b) => b.chest - a.chest)
  const total = list.reduce((a, v) => a + v.chest, 0)
  const day = chestDay(vaults)
  const word = (k: string) => (k === 'buy' ? 'Bought a dip' : k === 'capture' ? 'Took profit' : k === 'tax' ? 'Fees added' : k === 'redeem' ? 'Paid a cash-out' : 'Got funded')
  return <div className="s-home">
    <header className="hh">
      <div className="hh-k">In chests</div>
      <div className="hh-v num">{S(total, 1)} SOL</div>
      <div className="hh-s">{solPrice ? <>${S(total * solPrice, 0)} · </> : null}belongs to each coin's holders</div>
      <div className="hh-stats"><div><b className="num">{list.length}</b><span>{list.length === 1 ? 'chest' : 'chests'}</span></div>{(() => { const fees = list.reduce((a, v) => a + (v.taxClaimed || 0), 0); return fees > 0 ? <div><b className="num">{S(fees, 2)}</b><span>SOL from fees</span></div> : <div><b className="num">{day.moves}</b><span>moves today</span></div> })()}<div><b className="num">{day.last ? ago(day.last) : '—'}</b><span>since last move</span></div></div>
    </header>
    <section className="explain">
      <div><span className="ex-n">1</span><span>Every trade adds 2% to the coin's chest.</span></div>
      <div><span className="ex-n">2</span><span>The chest buys when the price dips and takes profit on pumps.</span></div>
      <div><span className="ex-n">3</span><span>Nobody can withdraw it. If you cash out, you get your share.</span></div>
    </section>
    <section className="grp">
      {!list.length && <div className="s-empty">No chests yet.</div>}
      {list.map((v) => { const c = byMint[v.mint!]; const L = ladder(c?.mcap || 0); const last = v.activity?.find((a) => ['buy', 'capture', 'tax', 'redeem', 'stake', 'seed'].includes(a.kind))
        return <button key={v.id} className="cr" onClick={() => go('coin/' + v.mint + '/vault')}>
          <Ring frac={L.frac} size={46} stroke={4}>{c ? <Pfp c={c} /> : Ic.chest(16)}</Ring>
          <span className="cr-mid"><span className="cr-name">{v.symbol}</span>
            <span className="cr-sub">{last ? <>{word(last.kind)} <span className="cr-dim">· {ago(last.t)} ago</span></> : 'Watching the price'}</span></span>
          <span className="cr-right"><b className="num gold">{S(v.chest, 2)} SOL</b><span className="dim num">{L.next ? `${Math.round(L.frac * 100)}% to ${F(L.next)}` : 'all goals hit'}</span></span>
        </button> })}
    </section>
    <button className="btn big ghost" onClick={onLaunch}>{Ic.rocket(18)} Launch a coin with a chest</button>
  </div>
}
