# Vamp scan · 2026-10-31T18:38:23.837Z · 116 coins on the board · 7 name families · 10 vamps flagged

## Flagged

| vamp | original | score | age | mcap | evidence |
|---|---|---|---|---|---|
| Satoshi `CEB3eg…` | Satoshi `Df7kaK…` | 0.85 | 6 min | $12K | same ticker · same name · launched 6 min after the original · 14% of the original's mcap |
| satoshi `HMrS9C…` | Satoshi `Df7kaK…` | 0.85 | 1 min | $3K | same ticker · same name · launched 10 min after the original · 4% of the original's mcap |
| Satoshi `DMe3Yi…` | Satoshi `Df7kaK…` | 0.85 | 0 min | $0K | same ticker · same name · launched 11 min after the original · 0% of the original's mcap |
| Bitty `3TSYdp…` | BITTY `9VAcRi…` | 0.85 | 0 min | $0K | same ticker · same name · launched 0 min after the original · 0% of the original's mcap |
| BITTY `ANB57B…` | BITTY `9VAcRi…` | 0.85 | 0 min | $0K | same ticker · same name · launched 0 min after the original · 0% of the original's mcap |
| Satoshi `Mx4UvA…` | Satoshi `Df7kaK…` | 0.8 | 2 min | $48K | same ticker · same name · launched 9 min after the original |
| t1 `EHM5Mt…` | t1 `Rb3gwb…` | 0.8 | 3 min | $3K | same ticker · same name · launched 0 min after the original |
| t1 `3Y2EfS…` | t1 `Rb3gwb…` | 0.8 | 3 min | $3K | same ticker · same name · launched 0 min after the original |
| LUMI `4CLJSk…` | LUMI `HvitmA…` | 0.75 | 11.0 h | $8K | same ticker · same name · launched 6.6 h after the original · 4% of the original's mcap |
| BNB `2LuuPJ…` | BNB `EYqygb…` | 0.55 | 3 min | $0K | same ticker · launched 21.7 h after the original · 0% of the original's mcap |

## Families (clusters with 2+ coins; leader = where the flow is)

- **bnb** → 👑 BNB ($323K, score 157.8) · BNB ($0K, score 0, vamp)
- **gato** → 👑 GATO ($6966K, score 1787.7) · Gato ($127K, score 8.3)
- **lumi** → 👑 LUMI ($193K, score 47.6) · LUMI ($8K, score 0.2, vamp)
- **satoshi** → 👑 Satoshi ($81K, score 1.1) · Satoshi ($4K, score 0.1) · Satoshi ($12K, score 0, vamp) · Satoshi ($48K, score 0, vamp) · satoshi ($3K, score 0, vamp) · Satoshi ($0K, score 0, vamp)
- **btc** → 👑 BTC ($11737K, score 1489.3) · BTC ($0K, score 0)
- **bitty** → 👑 BITTY ($3K, score 0) · Bitty ($0K, score 0, vamp) · BITTY ($0K, score 0, vamp)
- **t1** → 👑 t1 ($3K, score 0) · t1 ($3K, score 0, vamp) · t1 ($3K, score 0, vamp)

A flag needs: younger AND smaller than the original, a copied ticker/name, and (unless both are exact copies) one more signal — launched inside 48h, same deployer, or same image. Review: every row above should read as an obvious copy to a human; anything that does not is a false positive to fix in `server/src/vamp.ts`.
