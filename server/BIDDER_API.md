# Desk bidder API

The desk is a pseudonymous block market. Anyone can run a bidder: a bot that rests bids under spot on many coins, answers RFQs, and co-signs fills. The vault is one bidder among many. Your SOL never leaves your wallet until a fill, and your side verifies every fill before signing — the server only matches and relays.

## 1. Connect
`wss://<server>/` (same host as the HTTP API) — send `{ "type": "auth", "pubkey": "<base58>", "ts": <ms>, "sig": "<base58 ed25519 of "unnamed-desk:<pubkey>:<ts>">" }`
→ `{ "type": "authed", "rfqs": [...open RFQs...] }`. Send `{ "type": "refresh" }` every ≤20s or your bids expire (30 min TTL from last refresh). One socket per wallet.

## 2. Rest a bid (under spot)
`{ "type": "place", "mint", "sol": 2, "discBps": 400 }` — 300–500 bps under spot, all-or-none, min block = max(0.2 SOL, 2% of pool), ≤5 open bids, balance must cover committed bids + 0.5% cross fee. Rests 60s before it is fillable (no sniping prints).
→ `{ "type": "placed", "bid": {...} }`. Cancel: `{ "type": "cancel", "id" }`.

## 3. Buy a block (at or above spot)
`{ "type": "buy_rfq", "mint", "sol": 5, "premiumBps": 150, "ttlSec": 120 }` — fillable immediately by any holder, 0–500 bps over spot, expires on its own. Holders online get `{ "type": "buy_rfq", ... }`.

## 4. Answer a seller's RFQ
You receive `{ "type": "rfq", "rfq": { id, mint, sizeSol, maxBps, secondsLeft, priceSol, remainingSol } }` when a seller shops a block. Reply `{ "type": "rfq_respond", "rfqId", "discBps", "sol" }` — ≤ maxBps fills (seller is asked to sign), above it is a counter the seller can tap. Counters are bounded 50–800 bps.

## 5. Fills (you co-sign)
You receive `{ "type": "fill", "bidId", "tx": "<base64 legacy tx, seller-signed>", "expect": { mint, seller, bidder, treasury, base, sellerLamports, fee, priceSol, discBps, decimals, tokenProgram } }`.
Verify the tx is exactly: `[createATA(idempotent, payer=seller, owner=you, mint, tokenProgram), transferChecked(seller→you, base, decimals), system.transfer(you→seller, sellerLamports), system.transfer(you→treasury, fee)]`, that `sellerLamports+fee` over `base` honors your discount vs spot within 1.5%, sign, send, then reply `{ "type": "filled", "bidId", "sig" }` or `{ "type": "reject", "bidId", "err" }`. Reference implementation: `app/src/lib/desk.ts` (`verifyFill`, `openBidder`) — the server runs the same check in `server/src/verify.ts`.

## 6. Read
`GET /book/<mint>` · `GET /books` · `GET /fills?mint=` · `GET /leaderboard?me=<pubkey>` · `GET /tape/<mint>` (swap tape of vaulted coins, ndjson) · `GET /health`.

Identity: the book, pings, tape and leaderboard show per-wallet aliases (`desk-xxxxx`), never pubkeys. Settlement is one on-chain transaction with both wallets — we hide nothing on-chain.
Rate limit: 300 reads / 60 writes per 10s per IP.
