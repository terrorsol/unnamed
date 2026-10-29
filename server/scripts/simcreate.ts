// Simulate a LaunchLab create (+ small dev buy) on mainnet with the curve from LL_SELL_BPS / LL_RAISE_SOL. Nothing is signed or sent.
//   LL_RAISE_SOL=200 node --experimental-strip-types scripts/simcreate.ts <payer-with-sol>
import { PublicKey, VersionedTransaction } from '@solana/web3.js'
import { conn } from '../src/chain.ts'
import * as L from '../src/launchlab.ts'
const payer = new PublicKey(process.argv[2] || 'BANKYubgHd48UQt2VFtEytyE8QyeBHhiuptC3tHmfVPH')
console.log('curve', JSON.stringify(L.curveInfo()))
for (const dev of [0, 0.05]) {
  try {
    const b = await L.buildLaunch(payer, { name: 'Sim Coin', symbol: 'SIMC', uri: 'https://app.banker.cash/banker.png' }, dev)
    for (const [i, t] of b.txs.entries()) {
      const tx = VersionedTransaction.deserialize(Buffer.from(t, 'base64'))
      const r = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true })
      console.log(`dev ${dev} SOL · tx ${i + 1}/${b.txs.length} · ${r.value.err ? 'ERR ' + JSON.stringify(r.value.err) : 'OK'} · units ${r.value.unitsConsumed}`)
      if (r.value.err) console.log((r.value.logs || []).slice(-12).join('\n'))
    }
    console.log(`dev ${dev} SOL → quoted ${(b.devTokens / 1e6).toFixed(2)}M tokens`)
  } catch (e: any) { console.log(`dev ${dev}: build failed: ${e.message}`) }
}
process.exit(0)
