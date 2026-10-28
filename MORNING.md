# Morning note (overnight 2026-10-28)

Everything below ran simulated against mainnet, no funds. Full log in `DIAGNOSIS.md` → "Overnight 2026-10-28". Test state: server 23/23 unit, app 20/20 unit, e2e desk 50 · app 22 · mm 10 · import 16, mainnet preflight 24 checks (`reports-preflight` branch).

What's new since you went to bed, in order of importance:
1. **Vault signing is gated.** One keeper signs everything, with a purpose and a SOL-out amount; ≤75% of chest per tx, ≤100%/hour; treasury payouts and refunds exempt. Nothing can withdraw.
2. **Launch math is exact.** Our block-zero numbers match PumpPortal's real builds to the lamport (checked on mainnet in CI). The server now signs the vault's block-zero buy on its *real* cost, not PumpPortal's 3× padded ceiling, and refuses anything that isn't a plain pump buy for that mint from that wallet.
3. **Mayhem coins.** Most live pump curve coins today are Token-2022 ("mayhem mode"). PumpPortal's builder sometimes fails on them (pump error 6063); Jupiter buys them fine. Vault and app now dry-run every curve trade and switch to Jupiter when the chain says the build would fail. DexScreener misprices these coins; the exact curve read is what the vault/desk use, with GeckoTerminal as the data fallback.
4. **UI:** every live number ticks green/red on change, new tape rows slide in, the coin page "Rules" tab and Docs are rewritten in plain words (no preview rows), home tiles are 2×2 on phone.
5. The old `stake/(stake+1)×13.3%` supply estimate is gone: 1 SOL stake → ≈1.7% of supply at block zero (real curve). Shown that way in the launch modal now.

Then do the checklist below. Nothing else needs you.

# Checklist — vault + desk live on chain

Everything below is wired, e2e-tested against mocks, and every transaction shape has been simulated on mainnet by CI (no funds). The only step that needs a human is the deploy.

## 1. Deploy the real server (≈3 min)
1. https://render.com/deploy?repo=https://github.com/terrorsol/unnamed → Starter instance (always-on) + `/data` disk come from `render.yaml`.
2. Paste: `RPC_URL` (your Helius mainnet URL), `TREASURY` (fee wallet pubkey), `PINATA_JWT` (free at pinata.cloud → API keys; needed only for launches). `VAULT_SECRET` is generated.
3. **Test tier for today**: add `IMPORT_FEE_SOL=1` and `IMPORT_SEED_SOL=0.5` so your first real import costs 1 SOL, not 15. Remove both when you go public.
4. Optional: `PUMPPORTAL_KEY` (per-swap detection on bonding-curve coins; without it the bot polls the curve every ~5s).

## 2. Point the app at it (30 s)
App → Settings → Server → paste the Render URL → Test → Save. (Until then the app uses the tunnel desk, which has no vaults.)

## 3. First vault, real money (10 min)
1. Vault → Import → paste a pump coin you hold a little of (graduated, ≥ $100K mcap is easiest) → *I pay it* → sign the 1 SOL tx. The coin shows **VAULTED**; the Vault tab shows chest, floor, last move.
2. Deposit 1–2 SOL more on the Vault tab (Details → deposit). Watch the activity: standing desk bid appears within ~90 s; a capture only fires on a stretched buy ≥ 0.5 SOL (MM mode).
3. Force a visible move: buy 0.5 SOL of the coin from a second wallet on the chart. On a stretched price the vault counters within 3–9 s (random on purpose). On a −20% dip it buys tranche 1.
4. `/health` on the server shows `beta.keeper` (signature policy) and `beta.landing` (`sender`).

## 4. First desk fill, real money (5 min)
Wallet A rests a bid on the vaulted coin; wallet B (holding it) → Desk / OTC → *Sell into this offer*. One tx on Solscan with both wallets, no candle. Try a sell offer the other way.

## What to paste me if anything stalls
Toast text, the coin, and the signature. `/health`, `/vault/mint/<mint>` and `/tape/<mint>` on the server are public.

## Caps during beta
Chest ≤ 25 SOL per vault (`MAX_CHEST_SOL`), keeper per-tx ≤ 75% / hourly ≤ 100% of chest, desk fee 0.5% to `TREASURY`.
