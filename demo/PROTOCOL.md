# Protocol spec (what the demo engine simulates → what the Anchor programs implement)

## Launch
- Free creation. Bonding curve from zero, graduates at 85 SOL to AMM. Max 2.5% of supply per wallet. Sniping allowed.
- Optional vault stake at creation: stake → supply% vaulted via exponential pricing (10% cap, reached ≈3.1 SOL);
  creator cut of vault profits = vaulted% (≤10%). Stake is locked forever. Renounce forfeits the cut to the vault.
- Zero stake → protocol-run vault, no creator cut.
- Copies: declared copy of X streams 50% of its fees to X's vault; copy holders may swap into X via the desk (−5%).

## Vault (market maker, program-owned)
- Buys drawdowns: ≤40% of chest per crash, dampens dips (demo: −8% → −4.4%).
- Sells only above average holder cost basis AND 30-min VWAP, clips ≤25% of buy volume / ≤2% pool per fill,
  routes sells through the desk, never prints a sell candle, never sells in a downtrend, can never withdraw.
- Chest seeded at bond: 10–15% of migration liquidity + fee trickle.

## Early-flip fee (dump tax)
- Profit-only. Per-wallet 30-min clock from purchase (cost-weighted on adds). Fee = profit × 8% × (1 − held/30).
- Losses free. Small sells ≤1.25%. 100% of fee → that coin's vault. Fee inside min-out math (no failed sells).

## Desk (OTC block desk)
- Escrowed resting bids from third parties and the vault (vault bid ≈ 35% of chest near book). 60s rest, all-or-none.
- Min block 2% of pool reserve. Fills print to tape, never the chart. Opens when bonded and ≥ $100K mcap.
- Liquidity gating only — in a panic the AMM is always there.

## Redemption
- Burn tokens for pro-rata share of vault (demo: 93% of share). Undrainable — every redemption raises backing per token.

## Platform
- One flat fee ≤1.25% + fee per desk cross. Platform touches no vault, no treasury, no flip fee.
