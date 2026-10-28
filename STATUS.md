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
- Live: server on Render (`unnamed-server.onrender.com`, helius, gate on, 2 SOL chest cap, 1 SOL import tier), app at `app.banker.cash`, landing at `banker.cash`. One brand wallet `BANKY…` is every vault (top holder on every coin) with per-vault chest ledgers booked from tx deltas; launched mints end in `…BANK` from a pre-ground pool; launch metadata self-hosted. Drawdown stop on the mm leg. Paper vault runs on CI against live coins (`paper.yml`).
- Tests: server 32/32, app 20/20, e2e launch 21 · app 22 · import 16 · mm 10 · desk 50 (desk has two checks being updated for the 25% bid); mainnet preflight in CI 31/33 → fixes pushed for the two.

## Left, in order (tight)

1. **Fund `BANKYubgHd48UQt2VFtEytyE8QyeBHhiuptC3tHmfVPH` with 0.1 SOL** (platform config rent + fees) — you, 1 min. Nothing on-chain works before this.
2. **Paper vault on a live coin** (`paper.yml`, running) — 2 h of real prices, zero SOL. Read the decisions, fix anything odd.
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
