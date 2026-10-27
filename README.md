# UNNAMED — beta (real money, mainnet)

Non-custodial Solana memecoin terminal + launchpad. Every button is a real transaction signed by the user's wallet.

## What's live
| Feature | How |
|---|---|
| Wallet connect | Phantom / Solflare / Backpack via wallet-adapter |
| Board, prices, charts | DexScreener public API + embedded chart |
| New launches + curve trades | pump.fun live stream via PumpPortal websocket |
| Buy / sell (bonding curve) | PumpPortal `trade-local` → user signs → RPC send |
| Buy / sell (graduated) | Jupiter lite-api quote + swap (fallback PumpPortal auto) |
| Launch a coin | metadata → pump.fun IPFS → PumpPortal create tx (mint keypair + wallet co-sign) |
| Portfolio | on-chain balances (SPL + Token-2022), cost basis + hold clock kept in-browser |
| Protocol preview | vault / flip-fee / desk / redeem math computed live, labeled PREVIEW (not enforced on-chain yet) |

## Run
```
npm install
npm run dev        # http://localhost:5173
npm test           # protocol unit tests
npm run build      # → dist/
```
Set a fast RPC (Helius/Triton/QuickNode) in Settings — the public endpoint rate-limits.

## Deploy
Static site. Any of:
- **GitHub Pages**: push to `main`; `.github/workflows/pages.yml` builds and publishes.
- **Vercel / Netlify**: build `npm run build`, output `dist`.

## Fees
No platform fee in beta. PumpPortal 0.5% on curve trades, pump.fun 1%, Jupiter LP fees only.

## Roadmap → Beta v1
Anchor programs: `launch`, `vault`, `flip_fee`, `desk`, `redeem`, `copies` (see `PROTOCOL.md` in the demo package / the spec page). Devnet first, then capped mainnet beta, audit before uncapped mainnet.

## Layout
```
src/lib/dex.ts        DexScreener client
src/lib/pumpportal.ts stream + trade/create tx builders
src/lib/jupiter.ts    quote/swap
src/lib/trade.ts      buy/sell/launch routing
src/lib/rpc.ts        balances, send+confirm
src/lib/protocol.ts   UNNAMED rules (tested)
src/lib/positions.ts  local cost-basis ledger
src/components/       Board, CoinPage, Launch, Pages (Portfolio/Settings/About), ui
```

## In-app wallet (1-click trading)
Default wallet is a browser-side keypair encrypted with a user password (PBKDF2-310k → AES-GCM, localStorage). Deposit from Phantom, trade with no popups, withdraw anytime, export/import key. Phantom/Solflare/Backpack remain available under "Phantom / extension".

## Desk + vault (live, bot-run)
See `server/README.md`. Desk = non-custodial block bids matched by our server, settled by a two-signer tx. Vault = our bot running the market-maker rules per coin (custodial in beta).
