# UNNAMED — interactive demo

Single-file, zero-dependency demo of the launchpad: wallet, trading with price impact and the early-flip fee,
the vault (per-coin market maker), the desk (escrowed OTC bids, min block, all-or-none), take-profit / stop-loss
orders, launches with a vault stake, copies that stream fees to the original, burn-to-redeem, and a portfolio.
State persists in the browser (localStorage). All market data is simulated.

## Run locally
Open `index.html` in any browser. No build step.

## Deploy (pick one)
- **GitHub Pages**: push this folder to a repo → Settings → Pages → Deploy from branch `main` / root.
- **Netlify**: drag this folder onto app.netlify.com/drop.
- **Vercel**: `vercel --prod` inside this folder (framework: Other).

## Where the real protocol lives
`index.html` has a `trading engine` section — those functions (`quoteBuy`, `quoteSell`, `doSell`, `deskBook`,
`checkOrders`, the vault `tick`) are the exact rules the on-chain programs implement. `PROTOCOL.md` is the spec.
