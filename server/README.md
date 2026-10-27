# UNNAMED server — desk matcher + vault bot

Node 22, no build step. `npm start`.

Env:
- `RPC_URL` — Helius mainnet URL
- `TREASURY` — pubkey that receives desk cross fees (0.5%)
- `VAULT_SECRET` — long random string; encrypts vault keypairs at rest
- `DATA_DIR` — persistent dir for vaults.json (mount a volume)
- `PORT` — default 8787

Deploy on Railway: new project → deploy from GitHub repo → root directory `server` → add the env vars → add a volume at `/data`. Then set the app's server URL: `VITE_SERVER_URL` in the Pages workflow, or in-app via localStorage `unnamed_server` until then.

Endpoints: `/health`, `/books`, `/book/:mint`, `POST /quote`, `POST /fill`, `/vaults`, `/vault/:id`, `/vault/mint/:mint`, `POST /vault/create`, `POST /vault/arm`, `POST /vault/renounce`. WebSocket: bidder auth (signed message), place/cancel/refresh, fill relay.
