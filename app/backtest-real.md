# Real-flow backtest · 21 coins · 2026-10-28T02:28Z

Flow rebuilt from 1-min candles so a constant-product pool reproduces each candle (net SOL = S·(√(close/open)−1), gross = candle volume), replayed through the vault rules with a 30% chest. real = actual last/first price; none final should track it (replay sanity check).

| mode | final (avg) | final (median) | peak | max drawdown | vault P&L (SOL) | final beats no-vault | drawdown beats no-vault |
|---|---|---|---|---|---|---|---|
| none | 3.694x | 2.506x | 7.613x | 52% | 0 | — | — |
| floor | 4.5x | 3.202x | 8.6x | 48% | 44.39 | 21/21 | 21/21 |
| mm | 4.492x | 3.183x | 8.574x | 48% | 42.07 | 21/21 | 21/21 |

| coin | venue | pool SOL | hours | vol SOL | real | none final | mm final | none DD | mm DD | mm vault | captured | desk | dips |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| GENI / SOL | pumpswap | 670.1 | 1.5 | 100616 | 2.18x | 2.296x | 2.707x | 4% | 4% | 201.03→326.29 | 11.15 | 0 | 0 |
| Frongus / SOL | pumpswap | 97.3 | 7.5 | 83658 | 4.505x | 7.042x | 8.37x | 82% | 79% | 29.18→127.69 | 2.56 | 0 | 13.88 |
| INVERSE / SOL | pumpswap | 497.6 | 0.9 | 72085 | 2.591x | 2.737x | 3.183x | 12% | 11% | 149.29→270.5 | 8.47 | 0 | 0 |
| INGUS / SOL | pumpswap | 594.8 | 2.4 | 63350 | 1.872x | 1.973x | 2.354x | 6% | 6% | 178.45→264.75 | 9.99 | 0 | 0 |
| Nothing / SOL | pumpswap | 581.6 | 0.9 | 61628 | 2.28x | 2.377x | 2.795x | 5% | 5% | 174.47→289.7 | 9.94 | 0 | 0 |
| INVERSE / SOL | pumpswap | 619.8 | 0.9 | 61514 | 2.232x | 2.32x | 2.735x | 2% | 2% | 185.94→303.84 | 10.3 | 0 | 0 |
| Nothing / SOL | pumpswap | 388.3 | 16.7 | 34299 | 2.147x | 2.265x | 2.865x | 43% | 41% | 116.5→197.27 | 8.23 | 0 | 24.2 |
| 🙏 / Nothing | pump-fun | 176.3 | 24.8 | 3722 | 0.627x | 0.669x | 1.111x | 84% | 73% | 52.9→52.41 | 5.14 | 0 | 21.19 |
| UTYA / SOL | pump-fun | 16.4 | 12.1 | 3528 | 1.529x | 2.198x | 3.026x | 83% | 78% | 4.92→7.78 | 0.54 | 0 | 2.64 |
| BAMBOO / PANDU | pump-fun | 24.1 | 7 | 2652 | 4.585x | 5.158x | 6.445x | 73% | 69% | 7.23→22.92 | 0.92 | 0 | 3.99 |
| SPREAD / SOL | pump-fun | 19.2 | 5 | 2551 | 2.776x | 3.319x | 4.29x | 66% | 60% | 5.77→13.31 | 0.56 | 0 | 2.76 |
| BP / SOL | pump-fun | 21.6 | 11.2 | 2325 | 3.18x | 3.65x | 4.59x | 70% | 65% | 6.49→16.44 | 0.61 | 0 | 2.67 |
| Movember / SOL | pump-fun | 21.2 | 0.7 | 1852 | 1.034x | 1.257x | 1.751x | 84% | 81% | 6.36→6.93 | 0.57 | 0 | 1.84 |
| NEVADA / SOL | pump-fun | 15.1 | 12.6 | 1851 | 2.414x | 2.892x | 3.843x | 75% | 69% | 4.54→8.41 | 0.41 | 0 | 2.23 |
| JQQQ / SOL | pump-fun | 15.1 | 0.8 | 1554 | 7.945x | 8.666x | 9.907x | 57% | 51% | 4.53→25.97 | 0.43 | 0 | 1.42 |
| GOPAD / SOL | pump-fun | 11.9 | 1.6 | 1509 | 12.82x | 13.952x | 15.592x | 50% | 45% | 3.57→26.12 | 0.33 | 0 | 1.22 |
| pandacat / SOL | pump-fun | 16.8 | 45.8 | 1508 | 3.338x | 3.763x | 4.839x | 70% | 66% | 5.03→12.82 | 0.72 | 0 | 2.72 |
| PEAKY / SOL | raydium-launchlab | 20 | 24.9 | 695 | 2.374x | 2.506x | 3.293x | 79% | 75% | 5.99→10.91 | 0.63 | 0 | 2.33 |
| PCAT / SOL | raydium-launchlab | 18.3 | 25.1 | 549 | 1.778x | 1.878x | 2.556x | 64% | 59% | 5.49→8.37 | 0.46 | 0 | 1.96 |
| munity / SOL | raydium-launchlab | 68.8 | 0.3 | 529 | 4.652x | 4.665x | 5.436x | 37% | 34% | 20.64→55.87 | 1.73 | 0 | 3.25 |
| FDOGE / SOL | raydium-launchlab | 18.9 | 14.8 | 299 | 1.936x | 1.999x | 2.646x | 52% | 45% | 5.68→9.16 | 0.58 | 0 | 1.8 |