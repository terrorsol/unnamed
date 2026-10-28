# First live launch (TEST, 2026-10-28 12:24 CT) — what broke, what changed

Money: nothing lost. 0.5 SOL dev buy → 17.2M TEST (sold back from the in-app wallet). 1.1 SOL stake → sitting in the vault wallet `BANKY…` as the TEST vault's ledger; **Refund stake** on the Vault page returns it (one tap, in-app wallet signs). 0.019 SOL in fees/rent spent.

## What went wrong, in order

| # | symptom | cause | fix | proof |
|---|---|---|---|---|
| 1 | every write from the browser: "Failed to fetch" | CORS preflight didn't allow the `x-banker-session` header (reads and key redeem worked, so it looked fine) | `access-control-allow-headers: content-type, x-banker-session` | fetch from app.banker.cash origin → 400 "stake required" instead of network error |
| 2 | phantom asked to connect/sign on every reconnect | desk socket signed a fresh message on every `onopen` | an invite session (HMAC bound to the wallet) authenticates the socket; no signature when a session exists | gate e2e 15/15 |
| 3 | "Arming vault…" on every button, sell impossible | one shared busy flag + a wallet prompt that never resolved (phantom's block screen closed) | 90s timeout on every wallet prompt | — |
| 4 | vault's block-zero buy never landed | helius free plan has no bundle endpoint (`Method not available on your current plan`); create went out alone | `sendBundle` falls through helius → jito public block engine (NY, mainnet) | next launch |
| 5 | vault never armed → no supply, no mm | arm needed a second phantom message signature; phantom blocked it; app died there | **server auto-arms** a funded vault the moment its coin is on chain (polls every 15s); dev auth = the invite session, no message popups at all | TEST auto-armed 17:54 |
| 6 | tax-funded launch still signed a 0.55 SOL block-zero buy | `||` treated 0 as unset | `??` — 0 means no buy | launch e2e |
| 7 | app.banker.cash showed the repo README | github's branch builder (Jekyll) published `main` over the Actions deploy after github auto-committed the CNAME | Pages source → GitHub Actions | pages deployments list |
| 8 | 2% tax: `pool.platformFee = 0` | launchlab (2025 program) pays platform fees at trade time into **one vault per platform** (`Gpz8…`), not into the pool; our claim used the old pool path (`AccountNotFound`) | `claim_platform_fee_from_vault` every ~3 min → platform wallet; credit chests pro rata by observed taxed volume; vamp routing kept | diag simulation of the vault claim |
| 9 | event log empty after each deploy | ring buffer in memory | appended to `DATA_DIR/events.jsonl` | — |
| 10 | tokens "not in my wallet" | the launch ran from the in-app wallet (`HuZG…`), phantom never held them | UI now names the active wallet on the launch modal + vault card; BETA.md says pick one wallet | — |
| 11 | vault card = 12 zero tiles for a vault that hasn't armed | — | funded-not-armed = one line ("arming itself"); mm stats only once it has traded; deposit/redeem only when armed | — |
| 12 | phantom "could be malicious" / "domain is new" | blowfish reputation on a 2-hour-old domain | review request to phantom (form answers below); "new domain" clears on its own; launch modal says so | — |

## Verified on mainnet since (no SOL of yours involved)
- **platform fee claim**: the new `claim_platform_fee_from_vault` path ran live at 19:15 UTC and moved **1.1607 SOL** of accrued fees from the launchlab vault into `BANKY…` (balance now 2.45). That's TEST's trading (bots/snipers traded it after launch) × 2%. It sits as unattributed treasury because the vault wasn't tracking volume yet; from now on each coin's share lands in its chest every ~3 min.
- **paper vault** on a live coin ("Something", auto-picked, 1 SOL virtual): the coin fell 74% during the run; the policy fired two dip tranches (0.16 SOL) and the **drawdown stop held** at −35% on the deployed leg — no further buys. Added a 10-min no-buy warmup after arming so a vault seeded mid-crash doesn't treat the seed price as the high.

## What a launch is now
1 modal · 2 signatures (stake transfer, create) · **zero** message signatures · the vault arms itself · bundle via jito, plain-rpc fallback · tax claimed to the chest every ~3 min.

## Still open
- **Refund stake** on TEST when you're up (your signature; nothing moves without it).
- Phantom domain review: form at docs.phantom.com → "domain and transaction warnings" → review request. Answers: domain `app.banker.cash`; description "non-custodial Solana memecoin terminal + launchpad on Raydium LaunchLab; every button is a transaction the user's own wallet signs; open source github.com/terrorsol/unnamed; landing banker.cash; X @bankerdotcash"; txs: LaunchLab create/buy/sell, SystemProgram transfer (vault stake), SPL transfer (desk fills).
- Helius: free tier is fine for rpc; bundles now go to jito directly.
- Pinata JWT if you want IPFS permanence for metadata (self-hosted works).
- A real re-test: tax-funded launch, 0.3 chest, 0.1 dev buy, from ONE wallet (phantom, after importing nothing — just use phantom end to end).

## Before the next launch (me, after your refund tap)
- flip `MM_BUYS` to 1 in render.yaml (left at 0 so the armed TEST vault can't spend your 1.1 while it waits for the refund).
- flip `MAX_CHEST_SOL` from 2 to whatever you want the beta cap to be.

## Swap feed (per-coin tax attribution)
- The pool websocket on Render connects, but helius closes it after inactivity ("1001 Connection closed due to inactivity") — it reconnects and re-subscribes; a 4-second polling fallback (`getSignaturesForAddress`) now runs alongside so no swap is missed on any rpc.
- TEST's pool is empty now (bots round-tripped ~82 SOL in the first 30 min — that's the 1.64 SOL of fees — then everyone sold out), so per-coin crediting gets its first real check on the next launch: expect `platform fees claimed X → 1 chest` in the event log within ~3 min of the first trades.
