# MM backtest — 77 real coins replayed through the live policy (2026-10-28)

`server/scripts/mmreplay.ts` replays real 1-min candles + trades (89 scraped coins, 77 usable: pump.fun, pumpswap, launchlab) through `src/mm.ts` on a constant-product pool with the coin's real SOL reserve, and checks every invariant on every 5-second tick.

    cd server && node --experimental-strip-types scripts/mmreplay.ts <dir-of-scrape-json> chest=2 pct=5 tax=0.02 seed=1 [buys=0] [tp=0.1] [impact=0..1] [only=<mint>]

Setup used: vault holds 5% of supply + 2 SOL chest, 2% tax to the chest (launchlab shape), seeds 1–4. `tax=0` = import-style (no inflow).

## What was wrong

1. **Drawdown-stop accounting bug (real, live).** Captures of the vault's own inventory were booked as mm-leg proceeds and drove `mmTok` negative, which was floored to 0 — so any desk fill after a capture looked like a 100% loss on the leg. The stop fired on nothing, the desk bid halved for no reason. Fixed: `MM.bookSell` draws bought tokens first (their share of proceeds is leg P&L), the rest is `invGot` (inventory proceeds). New `mmCost` cost basis. Unit test in `test/mm.test.mjs`.
2. **One 755× coin dominated every aggregate.** XTO (pumpswap, 2,328 SOL pool): the tax-grown chest (14.8k SOL) bought a single 5,000 SOL "dip" at the top and lost 87% of it. Excluding it the leg was ~flat all along.
3. **Bought tokens were never sold back.** Captures were sized from inflow only; the leg accumulated inventory into every fade and got marked down.

## Policy changes (all in `src/mm.ts`, all live)

- **leg take-profit** `legTakeProfit: 0.10`, `legExitFrac: 0.8` — tokens the mm bought go back out into buys once price ≥ +10% over their cost, using ≤80% of the incoming buy. Not random, not capped by the inventory day trim. This is the market-making round trip.
- **desk bid**: only rests at/under the 30-min / 2-h VWAP ×1.02 (`deskBelowVwap`), respects the 10-min warmup (`deskWarmup`), capped at 10% of pool SOL (`deskBid(..., liqSol)`).
- **`maxBuySol: 25`** — no single dip / desk / accumulation buy above 25 SOL whatever the chest holds.
- **OTC block requests** (`respondRfq`) now go through the same `MM.deskBid` guards — before, an RFQ was sized from chest × 25% with none of the above, so the 755× failure was still reachable through the desk. Not exercised by the replay (it models the standing bid only); covered by a unit test + desk e2e.
- a capture whose confirmation times out and lands later is now booked into the mm leg too (`deferBook(..., after)`), so the drawdown stop never runs on stale numbers.
- `warmupMs` is env-tunable (`MM_WARMUP_MS`, e2e sets 0).

## Results (chest 2 SOL, 5% supply, tax 2%)

| config | violations | chest ≥ start | chest kept as SOL (median / worst) | mm-leg P&L on what it deployed (aggregate) | per-coin leg median |
|---|---|---|---|---|---|
| before fixes, seed 1 | 0 | 77/77 | 71% / 55% | −32.8% (−3,900 SOL; −3,930 of it XTO) | −14.9% |
| after, seed 1 | 0 | 77/77 | 89% / 65% | +0.9% | −1.3% |
| after, seed 2 (20% supply) | 0 | 77/77 | 86% / 63% | −2.4% | −4.2% |
| after, seed 3 | 0 | 77/77 | 90% / 64% | −0.3% | −3.0% |
| after, seed 4 | 0 | 77/77 | 90% / 66% | −0.5% | −2.5% |
| after, desk only (`buys=0`) | 0 | 77/77 | 100% / 70% | +2.7% | +3.8% |
| after, import-style `tax=0` seeds 1–2 | 0 | 57–59/77 | 120% / 34–42% | +0.7% / +2.8% | +7.7% / +8.3% |

"chest kept" = chest at the end ÷ (stake + tax received). Own-impact assumption (`impact=0/0.5/1`) changes nothing material.

## Honest read

- The chest never ends below its start on a taxed coin: the tax is what grows it.
- The mm leg (dip buys, desk blocks, accumulation) is a **stabilizer that roughly pays for itself** (−2%…+3% of what it deploys), not a profit engine. Desk-only is slightly better than desk + dip buys. Worst single coins still lose 75–90% of what the leg deployed on them, but that is now capped at ≤25 SOL per clip and stopped at −35%.
- Import-style (no tax): the chest grows on 57–65/77 coins from captures; "beats never trading" only on ~half, because the dataset is survivor-biased (median coin ends >1×) and captures sell into pumps.
- Not modelled: MEV/sandwiches on our sells, failed txs, latency. Captures land at the next tick's price, not the same block.
