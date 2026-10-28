# Morning checklist — vault + desk live on chain

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
