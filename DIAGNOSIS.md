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

## Backtest log
- 2026-10-27 · 100 SOL pool · 6h · 24 seeds · 30% chest: v1 vs +skew vs +zstretch vs +volDisc. skew/zstretch within noise (±0.1 SOL P&L); volDisc −7 SOL P&L at calm flow, off-chart fills 8.1 → 0.4 SOL. Kept skew + zstretch, dropped volDisc.
