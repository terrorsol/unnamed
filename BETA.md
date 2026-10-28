# BANKER · private beta

banker.cash · @bankerdotcash · the bank that never closes

Real mainnet, small amounts. Three things: a launchpad where every trade feeds the coin's own market maker, an off-chart desk on any coin, and a vamp detector. App: https://terrorsol.github.io/unnamed/app/

## Setup (2 min)
1. Open the app → **Connect wallet → In-app** → set a password. That's your signup. (Phantom/Solflare work too; every action prompts a signature.)
2. Fund it: tap the balance → address → send 0.5–2 SOL.
3. Home shows what's live: desks open, vaults running, the off-chart tape, runners and vamps.

## Things to try (in this order)
- **Launch a coin** (≈1.6 SOL): Launch → name, ticker, image → leave *BANKER launchpad* selected → Create. Two signatures (vault funding, then the create). Your coin gets a vault that buys in the launch block; every buy and sell of it pays **2% into its chest** and 0.5% to you. Watch the Vault tab: `tax → chest` shows up within ~4 min of the first trades, then bids under price and dip buys.
- **Buy and sell your coin** from a second wallet. Trades route through the pool directly; the price on the coin page comes from the pool, not an indexer.
- **Rest a bid**: Desk → pick a coin → bid 1–15% under → Place. Anyone holding that coin can sell into it, off-chart, no candle. Your SOL stays in your wallet until it fills.
- **Post a sell offer**: on a coin you hold → Desk / OTC → *post a sell offer* up to 15% either side. Active bidders get pinged.
- **Sell into a bid**: coin you hold → Desk / OTC → *Sell into this offer*. Partial fills down to the min block.
- **Import a pump coin** (test tier 1 SOL): Vault → Import → paste mint → *I pay it*. Or start a community takeover and chip in.
- **Vamps**: Home → Runners. A VAMP tag means a younger copy of a coin that's moving; tap *switch to original*.
- Switch apps on your phone mid-session: bids go *away* for 90s and come back when you return.

## What to report
Anything that stalls, any fill or launch that didn't land, any number that disagrees with Solscan. Include: the coin, what you tapped, the toast text, and the tx signature. `/health`, `/ll/platform`, `/vault/mint/<mint>` and `/tape/<mint>` on the server are public.

## Limits during beta
- Vault chests cap at 25 SOL. Vault keys are held by the server behind a policy gate (per-tx and hourly caps, no withdrawals).
- Launchpad tax 2% (max 5%), creator 0.5%; pump launches are still available but get no tax and no vamp defense.
- Desk fee 0.5% to treasury; min block = max(0.2 SOL, 2% of pool); 5 open bids per wallet.
- Nothing on the desk is custodial: a fill is one on-chain transaction both sides sign. The server only matches and relays.
- LP fees after graduation accrue to the platform's fee-key NFT; forwarding them into chests ships after the first graduation.
