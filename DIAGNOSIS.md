# Diagnosis → v1 plan (Oct 27, 2026)

## What we decided the product is
A memecoin terminal where **every coin can own a market maker that holders own**. Three mechanics people can't get elsewhere:
1. **Vault / MM** — captures a slice of stretched buys, redeploys it under the price (desk bid + dip tranches), never withdraws. Floor rises with volume.
2. **Desk** — block exits off-chart. Resting bids + RFQ ("shop my block at ≤ −3% for 60s"). Vault is always the floor bid.
3. **Vamps / copies** — declared copies stream half their cut to the original; family leader flagged; one-tap switch.
Plus the parts every terminal needs: 1-click wallet, fast board, signals, TP/SL, own chart.

## What's wrong today (diagnosis)
| # | Problem | Fix | v1? |
|---|---|---|---|
| 1 | MM has no inventory term: captures the same whether the vault holds 2% or 40% of supply | Avellaneda-Stoikov style skew: capture × (1 + k·q), defense × (1 − k·q), q = (vaulted% − target)/target | yes |
| 2 | Desk bid is a flat −4% regardless of volatility | **Tested, rejected.** 3%+2σ cut desk usage ~85% and vault P&L ~20% (`npm run backtest`); sellers use the desk only when it beats chart impact. −4% flat stays | no |
| 3 | Stretch is vs VWAP only; a +10% move on a calm coin ≠ +10% on a wild one | stretch measured in σ units blended with raw %. Neutral in the sim, kept for calm coins | yes |
| 4 | Graduated-coin buy detection is a 5s reserve-delta poll | Helius LaserStream/gRPC on the pool (Business plan) or `logsSubscribe` fallback; module stubbed, env-switched | v1.1 |
| 5 | Nav has 10 items; Desk/Leaderboard, Vault/Simulate, Mine/Import are the same subject | 6 items: Home · Desk · Vault · Dev · Portfolio · Settings; tabs inside | yes |
| 6 | Gains/losses only visible per coin | Portfolio header: realized / unrealized / today; coin page position tile shows P&L and % | yes |
| 7 | Launch asks for stake + mode; most devs just want "go" | Launch = name/ticker/image. Vault on by default, MM 30%. Advanced hidden | done |
| 8 | Sells: user had to know the desk exists | Smart sell routes automatically; OTC is one button | done |
| 9 | Nothing says *why* a coin is a runner / rug | Signal with reasons on board + coin page; synthetic-shape tests | done |
| 10 | Custodial vault, no program | On-chain program after beta (flip fee, trustless vault, treasury switch) | v2 |
| 11 | No way for an engineer to backtest without reading the UI | `npm run backtest` in `app/` prints the grid + JSON; `sim.ts` is the single source of the rules | yes |
| 12 | Fees: 0 platform fee | Deferred by decision | later |

## Why top MMs work (and what we copy)
- They **skew with inventory** (sell more when long, buy more when short) and **widen with volatility**. We add both.
- They **never chase**: no buys above VWAP, no sells below cost. Already true.
- They **redeploy**: profit goes back into quotes. Bundlers don't; that's our difference, and the floor is the proof.
- They're **invisible** via randomization. We randomize ±20% and trigger 40–70% — enough to have no fingerprint, while publishing every fill.

## Speed (what Axiom/GMGN do)
- Colocated RPC, sub-400ms execution; gRPC/Geyser feeds for new pairs and migrations; on-chain limit orders; Jito for landing.
- Ours: Helius RPC + priority estimate + Jito tip + rebroadcast; PumpPortal stream for curve (real-time); gRPC module for graduated coins behind `HELIUS_GRPC=` env. New-pair latency on curve is already stream-level; graduated is the gap.

## Funnels (one step, not click-throughs)
- Board → ⚡ quick buy (one tap, in-app wallet). Coin page → Buy preset → done. Sell → smart route → done. Block → OTC → set max loss → done. Launch → 3 fields → done. Import → paste mint → pay → done.
- No modals before a trade. Confirmations are toasts with Solscan links. Errors say what to change.

## Backtest contract for engineers
`app/src/lib/sim.ts` — `simulate(params)` and `compare(params)`; `app/scripts/backtest.mjs` runs the grid. Rules constants live once in `server/src/rules.ts` and are mirrored in `sim.ts` (same functions, same numbers; `test/sim.test.mjs` pins the claims). Change a constant, run `npm run backtest`, read the deltas.

## Live-chain log
- 2026-10-28 · **mainnet preflight 19/19** (CI, no funds): pumpportal curve/amm/bundle/create/creator-fee txs build and simulate clean; our Sender tip appended to a pumpportal tx simulates clean; jupiter api.jup.ag v0+ALT swap + tip simulates clean; desk fill verifies on a real mint; Helius ws decoded a live swap in 2.6s. Found and fixed: bonding-curve coins have no DexScreener liquidity (depth now from pump's virtual constant product), 4/40 top pumpswap mints are Token-2022 (fills use TransferChecked + mint-owner program), stale pools in GeckoTerminal's dex listing.
- 2026-10-28 · desk is two-sided (block buys at a premium) and pseudonymous; community-takeover imports; beta chest cap 25 SOL; bidder API documented.
- 2026-10-27 · landing path moved to Helius Sender (tip ≥0.001 SOL to a Sender tip account + CU price; dual-routed), Jito bundles via PumpPortal bundle mode / Helius sendBundle proxy. Fixed a parse bug that closed every desk. Tick is concurrent per vault; reserve-delta fallback when the pool websocket is down. Nothing has executed on mainnet yet — first real run is `npm run smoke --trade` after deploy.

## Backtest log
- 2026-10-28 · **launchpad tax** · 100 SOL pool · 15% chest · MM · 6h · 12 seeds · ~1,540 SOL volume. 2% tax → chest collects **30.8 SOL** over the run; chest at end 13.3 SOL vs 1.9 without the tax (the difference was redeployed into dip buys); max drawdown 77.2% vs 79.0%; final 2.73× vs 2.65×. The tax is the only funding source that scales with the coin itself. Simulate page: "Launched here" toggle.
- 2026-10-27 · yield question (should vault profit ever leave the chest?) · 100 SOL pool · 30 SOL chest · 12h · 40 seeds. Paying out 0→75% of *realized capture profit* changes nothing on the chart (final 2.26x→2.25x) because realized profit is tiny: 0.06–0.71 SOL per 12h on 30 SOL. Skimming *gross* captures (bundler model) pays 0.9/1.7/3.2 SOL at 25/50/100% skim, costs 4–20% of desk+dip support and stops the chest compounding. Decision: no yield, no payout; the vault redeploys everything. `payout`/`skim` stay as sim params for anyone who wants to re-run it.
- 2026-10-27 · 100 SOL pool · 6h · 24 seeds · 30% chest: v1 vs +skew vs +zstretch vs +volDisc. skew/zstretch within noise (±0.1 SOL P&L); volDisc −7 SOL P&L at calm flow, off-chart fills 8.1 → 0.4 SOL. Kept skew + zstretch, dropped volDisc.

## Overnight 2026-10-28 (simulated, no funds)
- **Keeper**: every vault signature now goes through `server/src/keeper.ts` with a purpose and a SOL-out amount. Caps: ≤75% of chest per tx, ≤100% per hour across trades/fills/redeems; treasury payouts and refunds are structural and exempt (and don't count toward the hour). `/health` → `beta.keeper`. Unit test walks the whole cap sequence.
- **Launch path, checked against mainnet**: CI preflight now builds the real 2-tx launch bundle through PumpPortal (random mint, simulate only) and saves the txs to `reports-preflight/launch-bundle.json`. Findings: txs are v0 with one lookup table; the create is pump `create_v2` (disc `d6904cec5f8b31b4`), and the buy is routed through PumpPortal's wrapper program `FAdo9N…` (their 0.5%), same data layout as pump `buy` (u64 tokens, u64 max_sol_cost). pump quotes tokens on the **gross** SOL and charges the 1% fee on top — `blockZero(0.05, 0.1)` reproduces PumpPortal's 1,785,357.737104 / 3,552,950.720606 tokens exactly. PumpPortal pads `max_sol_cost` ~3× in bundle mode (0.303 for a 0.1 SOL buy), so the server computes the **real** cost from the create tx's dev buy + our token amount (bundles are atomic) and signs only when that is inside policy; the tx is also refused if it touches any program but ComputeBudget / ATA / pump / PumpPortal, moves SOL anywhere but a Jito tip account, has a second signer, or credits another wallet.
- `arm()` no longer trusts "signed block-zero": if the vault wallet holds no tokens after the bundle (Jito dropped it), it seeds on the open market instead of sitting unseeded.
- Launch modal / server supply-target used a made-up `stake/(stake+1)×13.3%` curve. Replaced by the real curve: 1 SOL stake → 0.5 SOL at block zero → ≈1.7% of supply (was shown as 6.65%).
- **Tranche timing** (mm e2e): with the wick filter (two ticks below trigger, 3.5–6.5 s apart) plus the 0–4 s random delay, a −25% dump is bought 8–17 s after it prints. The e2e budget was 13 s and flaked; now 22 s. Product behaviour unchanged — a dip buy is not a race.
- **Mayhem / Token-2022 curve coins (mainnet, 08:00 UTC)**: all of the top-10 live pump curve coins were Token-2022 ("mayhem mode"). PumpPortal's builder produces a buy that fails simulation with pump error 6063 on every one of them; Jupiter routes the same buy fine (181K CU). Both the vault (`chain.ts pumpTrade`) and the app (`trade.ts buy/sell`) now dry-run the PumpPortal tx and switch to Jupiter when the chain says it would fail — no fee burned, no stuck vault. DexScreener's price for mayhem coins is unreliable (30% off, once 1000× off); the exact curve decode (`vSol/vTok`, creator at offset 49, len 166) is what the vault and desk use.
- UI: every live number cell ticks (green/red flash on change) via `Mc`/`Ch`/`Live`; new tape and feed rows slide in; the coin page "Rules" tab lost its PREVIEW rows (early-flip fee, wallet cap, stake pricing — all v2 program things) and now states what is enforced today.

## Overnight 2026-10-28, part 2 — the launchpad (04:20–06:00 CT)
Decision: UNNAMED is a launchpad on **Raydium LaunchLab**; pump stays as a non-default option and the import path. Why: a buy/sell tax is impossible on pump; LaunchLab's platform config gives a per-trade platform fee (≤5%, ours 2% → that coin's chest), a creator fee (≤0.5% → dev), pumpportal/jupiter/indexer support, and a real (smaller) crowd via bonk-style frontends. Meteora DBC was rejected as a third code path with no crowd.
- `server/src/launchlab.ts`: platform config (admin = owner wallet, fee + NFT wallet = a server key derived from `VAULT_SECRET`, LP 100% to the platform fee-key NFT), `buildLaunch` (official SDK, mint keypair co-signs server side, dev signs in the wallet), vault block-zero buy built against the post-dev-buy pool state with `fromCreate`, Jito tip on it, exact pool decode (`virtualB+realB / virtualA−realA`, same 30 SOL × 1.073e9 curve as pump but fees come OFF the SOL in), SDK buy/sell for vault and app, per-pool tax claim paid for by the coin's own vault, post-graduation LP-fee harvest via the lock NFT (experimental).
- Mainnet preflight (30/30): platform-config create simulates OK; launch create simulates OK (191K CU); SDK buy on a live LaunchLab pool simulates OK; claim shape OK (`NoAssetsToCollect` on a pool with nothing pending = right instruction); live pool decode matches.
- `market()` reads our pools first (exact, before any indexer), with own 1h volume from pool deltas so the desk gate works on fresh launches; swaps from pool deltas feed the tape and ticker; migrated pools fall back to the amm path.
- **Security hole closed**: anyone could read a vault id off `/vaults` and make a funded, unarmed vault buy THEIR coin at block zero (or arm it on a wrong mint). Every launch-side signature (`/ll/launch/build`, `/vault/bundle-sign`, `/vault/arm`) now needs a dev wallet signature over `unnamed:<action>:<vaultId>:<mint>:<minute>` (10-min window). API-level e2e runs with `DEV_AUTH=0`.
- Vamps feeding runners: one `payCut` path for captures and trims (captures previously skipped the copy stream); detector-flagged vamps (score ≥0.8, original vaulted) become copies automatically.
- Keeper ledger persists; launch retry reuses the funded vault; coin page reads our pool before the indexer; Settings has the one-signature platform setup; docs/BETA rewritten.
- 06:10–06:50 CT: LaunchLab pools on the per-swap websocket (same WSOL-delta decode as PumpSwap; mainnet preflight decoded a 1.84 SOL sell 6.6s into listening). Token-2022 transfer-fee launches (`PERM_TAX_BPS` 100, cap 500): `transferFeeExtensionParams` on create, platform key is the withdraw authority, harvest = accounts → mint → platform ATA → sold on the pool → SOL to chest every ~20 min; create simulates on mainnet (190K CU). Vamp → runner money flow: a detector-flagged vamp's platform tax is forwarded 100% to the original's chest (declared copies 50%); the vault keeps a standing no-fee ask at spot (10% of inventory, ≥ min block) so the switch flow buys the original off-chart. Desk gate skipped for our coins (exact price + vault on both sides). Launched coins carry symbol/name/image on the vault record so the coin page is complete before any indexer. Not done: LP harvest and transfer-tax harvest verified on-chain (need a real launch), flip fee (needs our own program).

## Status after this pass (v1 scope)
| Area | State |
|---|---|
| Wallet (in-app 1-click + extensions) | live |
| Board / Home (ours first, runners, vault tape; market + stream tabs) | live |
| Buy / sell (curve via PumpPortal, graduated via Jupiter; auto fee, Helius Sender tip + dual-route, rebroadcast) | live |
| Smart sell → desk when it beats the chart | live |
| Desk: resting bids, RFQ (max loss + clock, pings, counters), vault bid, leaderboard, fills | live (server) |
| Vault: MM mode (capture, tranches, redeploy), floor mode, redeem, deposits, import, copies | live (server, custodial) |
| Launchpad (Raydium LaunchLab, our platform config, 2% tax → chest, 0.5% → dev) · block-zero bundle · pump as option | built, e2e 18, mainnet preflight; needs the admin signature + one funded launch |
| Graduated-coin buys: pool websocket, per-swap, same slot | built, needs Helius WS try |
| Signals (runner/rug/bundle/crash/dead with reasons) | live, tested on synthetic shapes |
| Own chart with vault/desk/your markers + floor | live |
| TP/SL | browser-side only (no key server-side by design) |
| Backtest (`npm run backtest`) · live replay of real flow (`npm run replay -- gecko:<pool>` or a server tape) · daily 80–100 real-coin replay in CI (`reports-backtest` branch) | live |
| Mainnet preflight in CI (`reports-preflight` branch) — every integration simulated against the chain on each server change | live |
| Desk: buy-side blocks, pseudonymous book/tape, bidder API (`server/BIDDER_API.md`) | live (server) |
| Import: dev-paid or community takeover (escrow = vault wallet, auto-arm, refunds) | live (server) |
| Server deploy: Render one-click (`render.yaml`) · `npm run smoke` mainnet checks + optional micro-trade | ready |
| On-chain program (flip fee, trustless vault, treasury switch) | v2 |
| Platform fee, referrals, ToS | deferred by decision / v1.1 |
