# BANKER on the App Store

The phone app is the same code as app.banker.cash, wrapped with Capacitor 8 (`app/ios`). One codebase: every fix to the web app ships to the phone app on the next build.

## What's built

| Piece | Where | What it does |
|---|---|---|
| iOS project | `app/ios/` (Swift Package Manager, no CocoaPods) | Opens in Xcode as-is: `cd app && npx cap open ios` |
| App config | `app/capacitor.config.json` | Bundle id `cash.banker.app`, black background, status bar over the header |
| Wallet connect | `app/src/lib/deeplink.ts` | Phantom and Solflare through their official deeplinks. The app opens the wallet app, the user approves there, the wallet sends the answer back to `banker://wallet/...`. Keys never leave the wallet app. Requests and answers are encrypted (x25519 + XSalsa20-Poly1305, same as Phantom's docs). Unit-tested in `app/test/deeplink.test.mjs`. |
| In-app wallet | existing | Still works: created on the phone, encrypted with the user's password, never sent anywhere. |
| Native feel | `app/src/lib/native.ts` | Real Taptic Engine haptics (Safari ignores vibrate, so the web app had none on iPhone), light status bar, splash screen, Android back button |
| Link back | `app/scripts/ios-plist.mjs` | Registers `banker://`, lets the app open `phantom://` / `solflare://`, portrait only, dark UI |
| Icons + splash | `app/resources/` | Generated into the Xcode asset catalog by `@capacitor/assets` |
| Fonts | `app/src/fonts/` | Geist ships inside the app (no font CDN, works offline) |
| Home-screen app | `app/public/manifest.webmanifest` | Today, before the App Store: Safari → Share → Add to Home Screen gives a full-screen BANKER app with the icon |
| CI build | `.github/workflows/ios.yml` | Actions → ios → Run. With no secrets: a simulator build (proves it compiles). With secrets + `upload`: signs, archives and uploads to TestFlight. |

## What you need to do (only you can)

1. **Apple Developer Program as an organization**, not an individual. Apple's crypto rules (guideline 3.1.5) only allow wallet-type apps from organizations. Use the LLC; you need its D-U-N-S number (free from Dun & Bradstreet, takes a few days). $99/year.
2. **App Store Connect → My Apps → +**: name BANKER, bundle id `cash.banker.app`, SKU `banker-ios`.
3. **API key** for CI: App Store Connect → Users and Access → Integrations → App Store Connect API → generate a key with the App Manager role. Add four GitHub secrets: `APPLE_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8_BASE64` (`base64 -i AuthKey_XXXX.p8`).
4. Run the **ios** workflow with `upload` ticked. The build shows up in TestFlight in about 15 minutes. Install TestFlight on your phone and test it there.
5. Fill in the store listing (copy below), privacy answers, age rating, then **Submit for Review**.

## Review risks, honestly

- **3.1.5(iv), coin launches.** Apple says apps that facilitate ICOs must come from approved financial institutions. Moonshot and pump.fun both ship a create-coin flow in their iOS apps, so there's precedent, but a reviewer can still flag it. If the first review bounces on this, run the ios workflow again with `store_safe` ticked. That hides launching in the phone app only; buying, selling, chests and My coins all stay, and launching stays on the web.
- **3.1.5(iii), exchange.** Swaps go through Jupiter, a non-custodial on-chain router, from the user's own wallet. BANKER never holds funds. Say that in the review notes (below).
- **4.2, minimum functionality.** Wrapped websites get rejected. Native pieces here: Taptic haptics, wallet-app handoff, custom URL scheme, splash, status bar. Push notifications for chest moves would make this airtight. That's the next thing to add.
- **5.1.1, privacy.** You need a privacy policy URL (banker.cash/privacy). The app collects no names, emails or accounts. The wallet address is sent to the BANKER server to show chests and positions.
- **Rewards.** Don't add "earn crypto for inviting friends" in the iOS build. 3.1.5(v) bans crypto rewards for tasks. Holder levels are fine: they aren't currency.

## Store listing draft

- **Name:** BANKER
- **Subtitle:** Memecoins with a safety chest
- **Promotional text:** Every coin here has a chest that buys the dips for its holders. Your money stays in your wallet.
- **Description:**
  BANKER is the calm way to buy memecoins.
  Every coin launched on BANKER comes with a safety chest: 2% of every trade goes into it, it buys when the price dips and takes profit on pumps, and nobody can withdraw it.
  • Buy in dollars with a keypad, see exactly what you get and what it costs before you slide to confirm
  • Watch each coin climb toward its next goal
  • Plain-English safety checks on every coin
  • Your wallet signs every trade. BANKER never holds your money
  • Level up by holding, not by trading more
  Crypto is risky. Only buy what you're fine losing.
- **Keywords:** memecoin,solana,crypto,wallet,coins,trading,chest,phantom,defi,sol
- **Category:** Finance
- **Age rating:** 18+ (crypto trading)
- **Review notes:** "BANKER is a non-custodial Solana app. Users connect Phantom or Solflare (or create an on-device wallet). Every trade is signed in the user's wallet and routed on-chain through Jupiter; BANKER never holds user funds. To test, create an in-app wallet from Connect wallet → In-app. No account or login is needed."

## Local commands

```
cd app
npm run build && npx cap sync ios && node scripts/ios-plist.mjs   # refresh the iOS project
npx cap open ios                                                  # open in Xcode (Mac)
```
