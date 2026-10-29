# BANKER · status · 2026-10-29

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
