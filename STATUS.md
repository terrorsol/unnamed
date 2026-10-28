# BANKER · status · 2026-10-28

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
- Tests: server 31/31, app 20/20, e2e launch 21 · app 22 · import 16 · mm 10 · desk 50 (desk has two checks being updated for the 25% bid); mainnet preflight in CI 31/33 → fixes pushed for the two.

## Left, in order (tight)

1. **Fund the platform wallet (0.02 SOL) and do one real launch on mainnet** — 1 hour. Proves tax claim, LP harvest, bundle landing, Phantom partial-sign. Everything is simulated; nothing replaces one real coin.
2. **Deploy the server on Render** (`render.yaml`, one click, set VAULT_SECRET / HELIUS RPC / PINATA_JWT) — 30 min. Today the desk runs off the CI tunnel, which drops.
3. **Point the app at banker.cash/app or keep app.banker.cash** — decide, 10 min. The landing owns the root.
4. **First tester cohort (5–10 wallets, 1 SOL each)** — 1 day of watching: launches, desk fills, vault moves, report bugs.
6. Vesting-based free vault supply (LaunchLab `totalLockedAmount`, unlocks after graduation) — 1 day, needs the custom-curve params verified on mainnet. Nice-to-have; tax-funded already removes the friction.
7. TP/SL orders, mobile polish on the Pro desk — 1 day.
8. v2: sell-only tax via a token-2022 **transfer hook** (rules live in the token, run on every dex: tax sells to the chest, refuse transfers to flagged vamps, launch caps) — ~300 lines, 1–2 weeks + a small audit. LaunchLab only allows the transfer-fee extension, so hooks mean launching on Meteora DBC (what hookedpad.com does) or our own curve. Non-custodial chests remain the bigger program, after beta volume.

## Cheapest way to be live for beta

| item | cost |
|---|---|
| Render Starter for the server (+ 1 GB disk for DATA_DIR) | ~$8/mo |
| Helius Developer RPC (websockets + sender) | $49/mo (free tier works for 5 testers) |
| Pinata (launch metadata) | free |
| GitHub Pages (app + landing) | free |
| banker.cash | bought |
| platform config rent | 0.01 SOL once |
| first launch: 0.1 rent + 0.5 dev buy + 0.5 chest | ~1.1 SOL |
| 5 tester wallets × 1 SOL | 5 SOL (yours to recover) |
| jito tips / priority fees across the beta | ~0.3 SOL |

**≈ $60/mo and ~7 SOL of capital, 5 of which comes back.** Nothing else is needed to let people launch, market-make and use the desk on mainnet.
