# e2e (Playwright, mocked chain)

Real app build + real server, with RPC / DexScreener / PumpPortal mocked on :4390. No network, no keys.

    cd app && npm run build && npx playwright install chromium
    node e2e/desktest.mjs     # 50 checks: desk bids, sell offers, partial fills, vault bid, notifications
    node e2e/apptest.mjs      # 22: nav, coin page, settings, wallet gates
    node e2e/mmtest.mjs       # 10: market maker captures, tranches, mode switch
    node e2e/importtest.mjs   # 16: import a live coin, community takeover, treasury

`VAMPS=0` disables the vamp scanner (it needs the network). Each run wipes `app/.e2e-tmp`.
