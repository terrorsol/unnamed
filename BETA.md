# UNNAMED desk · private beta

Real mainnet, small amounts. The desk is a pseudonymous block market: sell a block off-chart to a resting bid, shop it with a max loss, or buy a block at a premium with zero chart impact. Works on any coin that meets the rules (graduated ≥ $100K mc, or still on the curve ≥ $50K, trading in the last hour).

## Setup (2 min)
1. Open the app → **Connect wallet → In-app** → set a password. That's your signup. (Phantom/Solflare work too; fills will prompt a signature.)
2. Fund it: tap the balance → QR / address → send 0.1–0.5 SOL.
3. Go to **Desk**. "Desks open now" lists live coins that qualify. Paste any mint to open its desk.

## Things to try (in this order)
- **Rest a bid**: Desk → pick a coin → *Bid under* 3–5% → Place. It rests 60s, then anyone holding that coin can sell into it. Your SOL stays in your wallet until a fill; your browser verifies every fill before signing.
- **Sell into a bid**: on a coin you hold → Desk / OTC tab → **Sell →**. If your bag is smaller than the bid you fill what you have (≥ min block). Price = spot at signing minus the discount; if spot moved >5% since you posted, you're asked first.
- **Shop a block**: coin page → **OTC · sell a block** → size, max loss, clock. Resting bids sweep instantly; online bidders get pinged and can fill or counter.
- **Buy a block**: Desk → *Buy block* → size, max premium, clock. Holders get pinged and fill you off-chart.
- **Vault**: import a coin (pay 15 SOL, or start a community takeover and chip in), watch the chest, captures, tranches and the standing bid on the coin page.
- Switch apps on your phone mid-session: bids go *away* for 90s and come back when you return.

## What to report
Anything that stalls, any fill that didn't land, any number that disagrees with Solscan. Include: the coin, what you tapped, the toast text, and the tx signature if there is one. The server's `/health` and `/tape/<mint>` are public — paste them too.

## Limits during beta
- Vault chests cap at 25 SOL (keys are custodial until the on-chain program).
- Desk cross fee 0.5% to treasury; bids 3–5% under spot; min block = max(0.2 SOL, 2% of pool); 5 open bids per wallet.
- Nothing on the desk is custodial: a fill is one on-chain transaction both sides sign. The server only matches and relays.
