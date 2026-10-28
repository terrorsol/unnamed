# Morning note (overnight 2026-10-28, part 2 — our launchpad)

Decision from 4am: **UNNAMED is a launchpad on Raydium LaunchLab, pump stays as a non-default option + import.** Built, tested and simulated on mainnet overnight:

1. **Our launchpad.** Every coin launched here sits on a curve bound to OUR platform config. Every buy and sell pays a **2% tax** (`TAX_BPS`, max 5%) into a per-pool vault the server claims into that coin's chest every 2–4 min, plus **0.5% to the dev** on-chain (`CREATOR_FEE_BPS`). After graduation the LP lands in a fee-key NFT held by the platform wallet (LP fees forever; harvesting those into chests is the one piece left — first graduations are days away).
2. **Launch flow.** Launch modal → "UNNAMED launchpad" is the default, pump is the other option marked no tax / no vamp defense. Server builds the create(+dev buy) with the official Raydium SDK, the wallet signs, the vault's block-zero buy is keeper-signed, both go out as one Jito bundle. Vault seeds on arm if the bundle doesn't land. Mainnet preflight: platform-config create simulates OK, launch create simulates OK (191K CU), SDK buy on a live LaunchLab pool simulates OK, fee claim shape OK, pool decode matches.
3. **Trading on our coins** goes through SDK-built txs (no PumpPortal, no 0.5%), exact price straight from the pool, coin page works before any indexer has the coin.
4. **Vamps feeding runners.** Declared copies always streamed half the dev cut; now (a) the MM capture path streams too (was a bug), and (b) a vaulted coin the detector flags as a copy (score ≥0.8, original vaulted) becomes a copy automatically. On our launchpad a copy can't touch the original's pool at all.
5. **Keeper** caps survive restarts. Tax claims are paid for by the coin's own vault (keeper co-signs), so the platform wallet never needs funding.

Tests: server 23/23 unit, app 20/20, e2e desk 50 · app 22 · mm 10 · import 16 · **launch 16** (new, end to end in the browser), mainnet preflight 30 checks.

**You have two things to do before anyone launches:** set `PLATFORM_ADMIN` on Render to your wallet, then in the app → Settings → "Set up launchpad · 1 signature" with that wallet. That creates our platform on-chain (rent ≈ 0.01 SOL). Until then the modal defaults to pump.

Then do the checklist below. Nothing else needs you.

# Checklist — vault + desk live on chain

Everything below is wired, e2e-tested against mocks, and every transaction shape has been simulated on mainnet by CI (no funds). The only step that needs a human is the deploy.

## 1. Deploy the real server (≈3 min)
1. https://render.com/deploy?repo=https://github.com/terrorsol/unnamed → Starter instance (always-on) + `/data` disk come from `render.yaml`.
2. Paste: `RPC_URL` (your Helius mainnet URL), `TREASURY` (fee wallet pubkey), `PINATA_JWT` (free at pinata.cloud → API keys; needed only for launches), **`PLATFORM_ADMIN` (your wallet pubkey)**. `VAULT_SECRET` is generated. `TAX_BPS` defaults to 200 (2%).
3. **Test tier for today**: add `IMPORT_FEE_SOL=1` and `IMPORT_SEED_SOL=0.5` so your first real import costs 1 SOL, not 15. Remove both when you go public.
4. Optional: `PUMPPORTAL_KEY` (per-swap detection on bonding-curve coins; without it the bot polls the curve every ~5s).

## 2. Point the app at it (30 s)
App → Settings → Server → paste the Render URL → Test → Save. (Until then the app uses the tunnel desk, which has no vaults.)

## 2b. Create the launchpad (1 signature)
App → Settings → Launchpad → *Set up launchpad*. Sign. `/ll/platform` on the server shows `chain.exists: true`.

## 2c. First launch on our launchpad (5 min, ≈1.6 SOL)
Launch → name/ticker/image → leave UNNAMED launchpad selected → dev buy 0.5, stake 1 → Create. You sign twice (vault funding, then the create). Toast says *live on UNNAMED · vault in block zero*. Coin page shows the pool price. Buy 0.1 from a second wallet → within ~4 min the vault's activity shows `tax → chest`.

## 3. First vault on a pump coin, real money (10 min)
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
