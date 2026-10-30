# BANKER · status · 2026-10-30

## Done (what we set out to build)

- Launchpad on Raydium LaunchLab under our platform config. One fee: 2% of every curve trade → that coin's chest. pump.fun kept as a non-default option + import path.
- Platform config self-creates: the server key is the admin; fund its wallet with 0.02 SOL (Settings shows the address) and it exists within a minute. Until then launches still go out under Raydium's platform.
- Vault (market maker): captures into pumps, dip tranches under VWAP, tax-funded accumulation toward a 5–50% supply target, standing desk bid (≤25% of chest) and no-fee ask at spot, tax claims, LP harvest after graduation, dev cut on realized profit, renounce, burn-to-redeem, deposits.
- Vault policy is pure code (server/src/mm.ts) with a simulator (`npm run mmsim`) and 6 policy tests. Hardened: crash episodes anchor to their own high, 40%/crash, 50%/day, cooldown, VWAP gate, pool-impact cap, seller-concentration check, toxic-desk pause that doubles + seller ban, keeper caps (75%/tx, 60%/hr, no withdraw).
- Launch modal: supply target slider, "tax builds it (free)" vs "buy at launch (X SOL)", chest slider, real-curve pricing.
- OTC desk: bids, sell offers, block requests, partial fills, non-custodial fills, vault as counterparty, off-chart tape on the coin tab and the desk page. Simple view = one action per side; Pro view = full book.
- Vamp defense: detector, flagged copy's tax 100% → original, declared copies 50%, switch offer at spot.
- Charts: own candles for our coins from the vault's exact pool reads (`/candles`), gecko for the rest, BANKER palette.
- Speed: parallel server discovery with session cache, single vendor chunk, lazy pages, exact price over websocket.
- Private beta gate: invite keys (`npm run invites -- 10 "wave 1"` on the server), bound to the first wallet that signs, 30-day sessions; every write route and the bidder socket require one while `GATE=1`; reads stay open. Gate screen in the app, "have a key?" on banker.cash. 15-check e2e.
- Brand: BANKER everywhere, black/white/green, bank mark; investor deck (`BANKER-deck.pdf`, source in `deck/`); waitlist landing live on banker.cash (repo `terrorsol/google`, gh-pages); `/waitlist` endpoint on the server.
- Live: server on Render (`unnamed-server.onrender.com`, helius, gate on, 2 SOL chest cap, 1 SOL import tier), app at `app.banker.cash`, landing at `banker.cash`. One brand wallet `BANKY…` is every vault (top holder on every coin) with per-vault chest ledgers booked from tx deltas; launched mints end in `…BANK` from a pre-ground pool; launch metadata self-hosted. Drawdown stop on the mm leg. Paper vault runs on CI against live coins (`paper.yml`).
- Tests: server 35/35, app 20/20, e2e launch 21 (+21 in shared-wallet mode) · gate 15 · desk 50 · app 22 · import 16 · mm 10; mainnet: platform config created, platform fee claim (1.16 SOL) landed, a holder sell simulates clean. See POSTMORTEM.md for the first live launch.

## Handoff (2026-10-30 afternoon) — pump sniper tax on the fast path

**Sniper tax (pump.fun launches).** pump has no sell tax; the chest stands in for one. For `MM_SNIPER_WINDOW_MS` (20 s) after the launch
lands, every buy ≥ 0.03 SOL gets `MM_SNIPER_FRAC` (50%) of its SOL sold straight back into it by the chest that bought block zero. Never
under cost +1%, ≤10% of the pool per sale (the uncovered part re-queued for the next sale), 15% of the block-zero tokens kept for market
making after (`MM_SNIPER_KEEP`). Our launchpad only with `MM_SNIPER_LL=1`. Replays on the two real tapes: with a 7.3 SOL block-zero buy the
chest sold back 42–48% of the first 10–30 s of buys; at 4 SOL 29–44% (inventory runs out first).
**Fast path (pumpfast.ts).** Feed: pump curves watched at 'processed', each trade read from pump's own TradeEvent in the logs (exact SOL,
the curve's reserves after it) — no getTransaction, no market read. Sale: a direct pump `sell` built locally (IDL order + bonding_curve_v2
+ Global's recipients; cashback coins add the volume accumulator), self-checked (compute budget + sell + one ≤0.005 tip only), CU limit
75k (whole tx measured 54.5k on mainnet), CU price = p75 of THIS curve's recent write-lock fees ×1.1 (clamped 20k–2M µlamports), total
fees ≤4% of the sale or the CU price is cut / the sale skipped, jitodontfront marker, Sender + RPC, same bytes rebroadcast every 1.2 s,
confirmation polled every 300 ms, a dead blockhash = never landed (re-queued, never double-sold). Anything the fast path can't do falls
back to the guarded PumpPortal/Jupiter route — but a sale that was sent never falls back. Mainnet preflight: events decoded from real
pump txs; our direct sell simulated for a real holder (min-out from our math 1.3% under pump's gross, i.e. its fees). `PUMP_FAST=0` off.
Known bottleneck: every chest signs and pays from the one shared wallet, so all chest sales write-lock that account — fine at today's
volume; sharding chests across several wallets is the fix if many pump launches run at once.

## Handoff (2026-10-30 early morning, third pass) — read this first

**Third independent review → fixed (245d81f3).** Payouts: never to the vault's own wallet; one payout in flight per vault, persisted
before send (`_payPending`) and resolved from chain history on refund / sweep. Copy stream between two shared vaults is a ledger move.
Refund: one at a time, refuses while a launch can still land or while a live coin's vault is unarmed, books in-bundle funding and
launch buys first, cancels bid/ask while closing, waits for late books. `TEST_RECLAIM` (full withdraw) only for `TEST_RECLAIM_WALLETS`
(the owner's three wallets, Dockerfile) and wallets on their beta key. Arm refuses imported/crowd vaults; redeem / buy / copy / desk
fills refuse while closing. Crowd: fee paid once, one sweep at a time, per-backer paid map. A desk fill that confirms late is booked
from its own tx; an unreadable credit waits for the tx (`lateCredits`) instead of booking an estimate. Transient flags cleared on boot.

**Tx guard on every vault trade (txguard.ts).** The shared wallet signs trades other people build (PumpPortal, Jupiter, the Raydium
SDK); whatever program a trade calls gets the wallet's signing power for that tx. Before signing, the server simulates the exact tx
with inner instructions and walks every System / Token instruction it would run (top level + every CPI). Refused: SOL out beyond the
trade's bound (buy: amount × (1+slippage) × 1.03 + 0.02; sell: 3% of the expected proceeds + 0.02), any token other than the traded
coin or wSOL leaving the wallet, a sell larger than the share asked for, a buy sending the coin out, approve / setAuthority / burn /
close-to-someone-else, assign / allocate of the wallet. No simulation or no inner instructions = not signed (the tick retries). A
refused PumpPortal / LaunchLab build falls back to Jupiter, guarded the same way; refusals are logged as `guard` events.
An independent review of the first version found real bypasses (a wSOL account closed and refilled, the priority fee, wrapped SOL
spendable beyond what the simulation spent, a "buy" that just paid the builder, NaN, extra signers / durable nonce, an empty second token
account zeroing the vault's balance). All fixed, each with a test: only the venues and the plumbing may be called at top level (pump,
PumpSwap, PumpPortal's wrapper, Jupiter v6, LaunchLab, ComputeBudget, System, Token, ATA, memo); the vault must be the only signer and the
fee payer; no nonce instructions; base + priority fee count as SOL out; a wrap only counts as the vault's own into the classic wSOL ATA or
a Token account created and opened in the same tx (never after a close); everything wrapped and every buy's on-chain ceiling
(max_sol_cost / max_quote_in) must fit the bound — padded PumpPortal ceilings are pulled down first (`capBuyCeilings`); a buy must show
the coin arriving in the vault's coin account (simulation post-state); NaN fails closed; `tokenBalance` sums every account.
What a simulation can't prove: a program that behaves differently on chain than in the simulation (slot-gated, or a flag flipped right
after the build). The allowlist and the on-chain ceilings narrow it; an on-chain assertion instruction would close it (next step).
Mainnet (probe runs Oct 30 11:20–11:50): Helius returns parsed inner instructions; real buys pass on PumpPortal (SOL-quoted curve coin
0.0138 out, amm 0.0139) and Jupiter (0.0129) of a 0.0318 bound, LaunchLab SDK 0.0116; a fresh coin's create + PumpPortal buy passes;
real holder sells pass on PumpPortal + Jupiter; a 10% sell under a 5% limit, a 0.5 SOL drain, a token delegate and a foreign-token
transfer appended to a real buy are all refused. Note: most top pump curve coins today are quoted in another token (PumpPortal answers
6063 UnsupportedQuoteMint on them); ours are SOL-quoted. `TX_GUARD=0` turns the guard off (don't). 
**pump launches: the chest's block-zero buy no longer goes through PumpPortal's wrapper** (`directPumpBuy`, launch.ts). That buy can't be
simulated before the coin exists, so the guard can't cover it; instead the server rewrites PumpPortal's wrapper buy into pump's own `buy`
with the same accounts (pump's 16 IDL accounts + bonding_curve_v2 + a buyback fee recipient; PumpPortal's fee wallet dropped, so also
no 0.5% on the chest's buy). Every derivable account is checked against our own PDAs; any other shape keeps the wrapper buy and logs it.
Probe (Oct 30 11:28): the direct buy simulates clean right after a create_v2 in the same tx; without the two extra accounts pump answers
`BuybackFeeRecipientMissing`. Preflight now checks this every push. `PUMP_DIRECT_BUY=0` goes back to the wrapper.
`lateBooks` / `lateCredits` now persist to DATA_DIR/late-books.json across restarts.
App: the launch checks the wallet can cover coin + your buy + chest (+~0.035 rent & tip) before anything, instead of a wallet error.

## Handoff (2026-10-30 overnight, second pass) — read this first

**One-signature launches (both venues).** The stake no longer goes out ahead of the launch. The server appends the dev → vault transfer
to the create tx it mint-signs, so the wallet signs once and the Jito bundle [create + stake, vault buy] is all-or-nothing: a launch
that doesn't land costs nothing and leaves nothing in a vault. Arm books the stake from the create tx (the app passes the signature;
the server also finds it on chain). Mainnet preflight: real SDK creates with the stake inside simulate clean (LaunchLab 1061–1128 B,
pump 1139–1199 B of 1232), Jito accepts both bundle shapes, and the whole route (/vault/create → build → simulate) passes on both venues.

| Was | Now |
|---|---|
| Two wallet prompts; stake sent and confirmed first; a failed bundle left the stake in a vault ("drained?") | one prompt; nothing moves unless the launch lands; fallback to stake-first only if the transfer doesn't fit |
| pump.fun launches built in the browser (random mint, client-held mint key) | built on the server like ours: …BANK mint we hold, PumpPortal txs, keeper-checked vault buy (max_sol_cost tightened to cost +5%), same guards |
| pump coins: the vault saw nothing until DexScreener indexed the coin; no per-buy feed without a PumpPortal key; never auto-armed | read straight off the bonding curve; per-swap feed on the curve account; auto-arm + build guards via `onChain()` |
| a retry after a late landing could put a second coin out for one chest | server refuses with `already live: <mint>`; the app opens that coin |
| snipers who bought before arm were invisible (feed starts at arm) | the pool's SOL right after the bundle is known at build; the first tick sells into everything above it |
| per-buy mode dropped buys that landed during a sale | queued and sold into right after |
| arm waited ~18 s on each dead block-zero buy from earlier attempts | only the armed coin's buy is waited for |
| app's arm + autoArm racing could book the vault buy twice | one arm at a time per vault |
| autoArm re-armed a vault 3 s after its chest was withdrawn | arm refuses closed vaults; closed + empty vaults switch off; withdrawn vaults get no fee share |
| a fee claim confirming after its timeout was never credited | rebroadcast, 75 s, then kept on disk and credited when it lands; CU price 50k → 300k |
| a hung tick froze its vault forever | lock taken back after 3 min |
| websocket down → poller and pool read both fired on one buy | the poller counts as the feed; dedupe on backstop vs stream |
| Sell button missing/dead until the 15 s wallet sweep | the open coin's balance polls every 4 s; Sell asks the chain again before giving up, then says why |
| a coin launched without a chest had no way to get one | creator switches it on from the coin page, free; the 2% fee fills it from the next trade |

**Independent review of the money path (Oct 30, ~09:00 UTC) → fixed before the last server push.** A reviewer that hadn't seen the
work read every change since 49363cd1. With `TEST_RECLAIM=1` (image env) any chest booked above its real SOL is withdrawable, so these
were treated as critical: parallel `/vault/fund` booking one stake many times; a one-signature create bookable into another vault;
the arm lock letting waiters run together after a failure; two builds of one vault both landing on one stake; a vault arming onto a mint
another vault holds (shared-wallet token balances); fee claims handing unobserved fees to whoever observed volume (attach made that free);
desk bid fills debiting the first vault in the file; block-zero buys escaping booking on an RPC error. All fixed (see the commit
'ledger hardening…'), each with a test where it can be faked. Open by design: the pump chest buy still goes through PumpPortal's
wrapper program, which gets signer authority over the shared wallet for that tx — build it against the pump program directly next.
A second review of those fixes found more (ad09ea3d): parallel builds and build-vs-refund on one vault (now one money operation per
vault at a time), crowd contributions bookable from someone else's transfer, a credit before an await that a retry could repeat,
imports/crowds arming next to a launch, fees accruing on migrated (AMM) swaps, harvests booked off the wallet balance, a wall-clock
write-off of launch buys. Fixed with tests; a third review was run on that pass.

New on the coin page: launch progress row (chest → upload → build → sign → land, with a clock), "launch buy paid back" bar,
the chest's last moves, and a **sniper report** (first-minute buys/wallets/launch-block SOL and what the chest sold into them).
Tests: server 68 (incl. a faked-chain money-path suite: build → land → arm books stake + vault buy exactly once, racing arms, parallel fund, cross-vault and foreign transfers, in-flight builds, reclaimed mints),
app 23, e2e launch 37 (one signature, already-live retry, pump path, switch-on chest, chest card), app 22, desk 40, gate 15, import 16, mm 10.
Mainnet preflight 39/39. Read-only probe workflow: push to the `probe` branch → `reports-probe`.

State seen tonight: BANKY wallet 0.56 SOL, ledgers 0.03, **0.53 SOL unattributed** = 2% fees from m9GE…BANK after its chest was
withdrawn (no chest → platform revenue, by design). XYZ's vault is closed but still holds 2.75M XYZ (reclaim again to sell + withdraw).
The dead-mint BANKER vault switched itself off.

## Handoff (2026-10-30 morning) — read this first

What broke on Oct 29's launches and what's fixed (all pushed, live on Render at `846ccc31`+, unit + e2e green, mainnet preflight green):

| Broke | Root cause | Fix |
|---|---|---|
| Every launch with a vault buy: Jito "bundle contains an expired blockhash" | the create's blockhash was stamped early and aged while the server finished building (vault buy, SDK queue) and while the wallet signed | one fresh blockhash stamped at the very end of the server build on the create (mint re-signs) and the vault buy (signed after); pump.fun bundles restamped right before signing. **Mainnet proof:** preflight step `jito: takes a real launch bundle` sends the exact bundle shape from unfunded wallets — Jito accepts it (bundle id returned) |
| Bundle dropped/expired → app launched WITHOUT the vault buy | plain-send fallback | no fallback: resend ×3, rebuild on expired/dropped (×2, new signature), else "nothing launched, stake in the vault" |
| Vault create refused (2 SOL cap) → coin launched with no chest | app swallowed the error | launch stops before anything is spent |
| Refund pressed mid-launch killed the bundle | stake left the vault the bundle spends from | server refuses refund for 2 min after a launch build |
| Retries reused an empty (refunded) vault; vault armed onto a mint that never went live | stale reuse; arm trusted the app's mint | reuse only a still-funded vault; arm checks the coin exists and recovers the build that went live (`builtMints`) |
| Vault never armed / dev signature popups | invite session tied to one wallet | one key works on any wallet (redeem or link with one signature); arm also accepts the coin's on-chain creator |
| Coin page stuck on "Loading" for a new coin | waited on indexers | reads our own pool (`/market/:mint`); trade box after 10 s no matter what |
| Fees credited to no chest / payouts timing out | attribution with no observed volume; no priority fee | single-coin fallback; payouts with priority fee + rebroadcast, no double pay |
| A buy could be sold into twice | launchlab coins ran the websocket AND the pool-read detector | websocket only, pool read as backstop when the subscription is silent |
| …BANK mints all burned | every failed attempt popped one | dead mints return to the pool; `mints.yml` grinds and pushes fresh ones with the ADMIN_KEY secret |

Market maker (test launches, image env in `server/Dockerfile`, Render env overrides):
- block-zero vault buy up to 9 SOL inside the bundle; sells a slice of **every** incoming buy ≥0.05 SOL into it: ~10% of a small buy → **30% of a 2 SOL+ buy** (log curve, `MM_DYN_*`), first until the launch buy is back (never under cost +1%), then only above cost +4%, ≤8% of its tokens per sale, one at a time
- small dip buys / desk bids (≤0.2 SOL, ≤0.6 out), profit-gated on volume; Close & withdraw all sells everything and pays the dev the whole chest
- replay of XYZ's real 167-swap tape (+ the ~11 SOL of first-second buys) with this policy: 4 SOL block-zero buy → 54 sells, launch buy back, **+1.1 SOL** on the market-making leg plus ~1.6 SOL fees; 8 SOL → +1.0 (4.4% unsold at the end); 1.6 SOL → +0.34

Recommended next launch: BANKER launchpad · Buy at launch ~4 SOL (≈12%) · chest 0.5 · own buy 0 (vault is the first buy) · in-app wallet or Phantom (both fit the window now).

## Handoff (2026-10-29 overnight) — read this first

Pushed tonight on J's standing go (design + app shell only; trading/vault/desk/fee logic unchanged; both new server switches off):
- `68453bc8` phone "captain" design (default simple skin: black/white/green, gold only for chests/levels; one task per screen; keypad trade sheet with costs before commit; receipts; sheets instead of tabs) + iPhone app shell (Capacitor 8 in `app/ios`, Phantom/Solflare deeplink wallet `app/src/lib/deeplink.ts`, Taptic haptics, icons, `.github/workflows/ios.yml`). App Store steps: `APPSTORE.md`.
- `55d0e338` ios CI pipefail. `a320bfc5` terminal polish (stat bar, quick-buy pill, health dots, colored ticket, bottom status bar with latency). `1efb4ef7` deck (+4 slides).
- Checks at each push: unit app 23 / server 39, e2e app 22 · launch 21 · import 16 · gate 15 · mm 10 · desk 50, screenshot sweep, clean `npm ci` build. iOS simulator build passes on macOS-15. Preflight 32/33 (the LaunchLab ws swap wait times out on quiet pools; pre-existing).
- Working copy note: `npm install` in `/home/claude/unnamed-app` drops the Playwright link; restore with `ln -sfn /opt/npm-tools/node_modules/playwright node_modules/playwright`. Screenshot harness: scratchpad `shoot.sh [names]`.
- Only J can do: Apple Developer enrollment as the LLC (D-U-N-S), App Store Connect app + API key + 4 GitHub secrets, first TestFlight test of the Phantom round trip.

## Handoff (2026-10-28 evening)

State: **everything is paused on purpose.** No scheduled tasks run. Server on Render is the last pushed build; the commits below are **local only, not pushed** (a push to `main` redeploys Render — J said pause until he says go). TEST vault (`itkQy1XKM54`) still holds his 1.1 SOL stake; `MM_BUYS=0` on Render until he taps **Refund stake** (Vault page, his signature).

Just finished: the MM backtest he asked for. Verdict + all numbers in `BACKTEST.md`. Three policy changes + one real accounting bug fix in `server/src/mm.ts` (leg take-profit, desk bid gated by VWAP/warmup/pool-liq, 25 SOL per-buy cap, `bookSell`/`mmCost`). Follow-up (Opus 5.5 catch-up review): RFQ answers now share the desk-bid guards; late-landing captures book into the leg. Tests after the change: server 34/34 · e2e mm 10 · desk 50 · import 16 · gate 15 · launch 21.

Pushed 2026-10-28 20:10 CT on J's go (vault slippage 10% → 1.5% buy / 1% sell via `VAULT_SLIP_BUY_BPS`/`VAULT_SLIP_SELL_BPS`; `jitodontfront` marker on every tipped tx, `JITO_DONTFRONT=0` to disable). Next, from the MEV/UX research: move the vault worker to Render Frankfurt (region is immutable → new service + disk copy; plan it, don't wing it), simulate-then-cap compute units, Phantom/Blowfish review email, one-signature escrow OTC fills (program + audit), optional Privy embedded wallet for one-click.

When he says go, in order: `git push` (redeploys) → he taps Refund → flip `MM_BUYS: "1"` in `render.yaml` + push → then the list below.

Working copies: app source lives at `/home/claude/unnamed-app` and is synced into this repo's `app/` with `cp -r src e2e public index.html package.json vite.config.ts /home/claude/unnamed-pkg/app/` (check what differs with `diff -rq`). Run e2e suites one at a time; kill a stale server by PID (`ps -eo pid,args | grep src/index.ts`), never with a pkill pattern (kills the shell). Scratch data (89 real-coin JSONs for the replay) is in the session scratchpad `real/`; regenerate with `app/scripts/scrape.mjs` or the `reports-backtest` branch.

## Left, in order (tight)

1. **Refund stake** on TEST (Vault page, your signature) — then I flip MM_BUYS=1.
2. **Phantom domain review** (2-min form, answers in POSTMORTEM.md).
3. **Real import, 1 SOL chest** on a live coin — 1 h of watching fills, dip buys, the ledger vs the wallet (`/admin/wallet`).
4. **One real launch** with a 0.5 SOL chest, you + 2 testers trade it — proves create, bundle, tax → chest, accumulation, `…BANK` mint. 30 min.
5. Mint pool topped up from your PC (`npm run mints -- grind 50 push https://unnamed-server.onrender.com <ADMIN_KEY>`), Pinata JWT when you want IPFS permanence — 10 min.
6. Vesting-based free vault supply, TP/SL, Pro-desk mobile polish — 1 day each.
7. v2: token-2022 transfer hook (sell-only tax, vamp refusal) on Meteora DBC or our own curve — 1–2 weeks + audit.

## Cheapest way to be live for beta

| item | cost |
|---|---|
| Render Starter for the server (+ 1 GB disk for DATA_DIR) — live | ~$7.25/mo |
| Helius Developer RPC (websockets + sender) | $49/mo (free tier works for 5 testers) |
| Pinata (launch metadata) | free |
| GitHub Pages (app + landing) | free |
| banker.cash | bought |
| platform config rent | 0.01 SOL once |
| first launch: 0.1 rent + 0.5 dev buy + 0.5 chest | ~1.1 SOL |
| 5 tester wallets × 1 SOL | 5 SOL (yours to recover) |
| jito tips / priority fees across the beta | ~0.3 SOL |

**≈ $60/mo and ~7 SOL of capital, 5 of which comes back.** Nothing else is needed to let people launch, market-make and use the desk on mainnet.
