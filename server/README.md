# UNNAMED server — desk matcher + vault bot

Node 22, no build step. `npm start`.

Env:
- `RPC_URL` — Helius mainnet URL
- `TREASURY` — pubkey that receives desk cross fees (0.5%)
- `VAULT_SECRET` — long random string; encrypts vault keypairs at rest
- `DATA_DIR` — persistent dir for vaults.json (mount a volume)
- `PORT` — default 8787

## Deploy (pick one)
- **Render, one click:** https://render.com/deploy?repo=https://github.com/terrorsol/unnamed — the blueprint (`render.yaml` at repo root) sets the Dockerfile, the `/data` disk and generates `VAULT_SECRET`; you paste `RPC_URL` and `TREASURY`. Starter plan so the bot never sleeps.
- **Railway:** new project → deploy from GitHub → root directory `server` → env vars → volume at `/data`.

Then point the app at it: repo variable `SERVER_URL` (Settings → Secrets and variables → Actions → Variables) and re-run the Pages workflow, or in-app via `localStorage.unnamed_server`.

## First thing after deploy — mainnet smoke
In the service shell: `npm run smoke` — checks RPC, Helius Sender, Jito, PumpPortal, DexScreener, GeckoTerminal and the pool websocket (waits for one real swap and decodes it).
Add `--trade <mint> <sol> --key <base58 secret>` with a throwaway wallet holding ~0.05 SOL to do a real 0.01 SOL buy + sell through the vault path and time the landing.

Env knobs: `JITO=1` (vault trades as Jito bundles via PumpPortal bundle mode; default is Helius Sender when RPC is Helius), `FAST=0` (plain RPC), `TIP_SOL` (Sender tip, default 0.001), `VAULT_PRIORITY_SOL`, `JITO_URL`, `PUMPPORTAL_URL`, `DEX_URL`.
Live tape: every swap on a vaulted coin is appended to `/data/tape/<mint>.jsonl` and served at `GET /tape/<mint>`; replay it in `app/` with `npm run replay -- tape.jsonl`.

Endpoints: `/health`, `/books`, `/book/:mint`, `POST /quote`, `POST /fill`, `/vaults`, `/vault/:id`, `/vault/mint/:mint`, `POST /vault/create`, `POST /vault/arm`, `POST /vault/renounce`. WebSocket: bidder auth (signed message), place/cancel/refresh, fill relay.
