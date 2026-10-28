# Security rundown (beta — test amounts only)

**Custody model**
- Trading, launching, desk fills, redeems: non-custodial. The user's key signs; the server never holds user funds.
- Vault: custodial in beta. One keypair per coin, generated server-side, AES-256-GCM encrypted at rest with `VAULT_SECRET`. The bot can only do what the rules say (buy dips, trim, pay cut, co-sign redeems/desk fills). Anyone with the server's disk + secret controls all chests. v1 replaces this with an on-chain program.
- In-app wallet: keypair in the user's browser, PBKDF2(310k)+AES-GCM with their password. Cleared site data = gone. Export key is shown once on demand.

**Desk fill safety**
- A fill is one tx with exactly 4 instructions; the server AND the bidder's browser independently verify instruction count, programs, accounts, amounts, fee and that the implied price honors the bid's discount, before either signs.
- Bids are soft-escrowed (balance checked at place + fill); a bidder who moves funds just gets a failed fill. Hard escrow lands with the program.
- Bidder auth over websocket = signed message with a 2-minute timestamp window.

**Redeem safety**
- Server verifies the holder-signed tx shape (ATA create, exact token amount, exact lamports from quote) before co-signing. Max 25% of chest per redeem, 7% haircut.

**Known gaps (fine for a closed beta, not for public)**
- Server: per-IP token bucket (60 reads / 20 writes per 10s), 200KB body cap, pubkey-shaped path params only. No auth on read endpoints (public by design).
- Helius key is in the frontend bundle — lock it to the domain in the Helius dashboard.
- Vault trades go through PumpPortal (0.5%) and the public pump route; no MEV protection yet.
- Family/leader scoring trusts DexScreener data.
- TP/SL runs in the user's browser; not reliable when the tab is closed.
- No ToS/geoblock page yet.
