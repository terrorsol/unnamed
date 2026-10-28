// diagnose a live coin on the server: node --experimental-strip-types scripts/simsell.ts <mint> <owner> — builds the owner's 100% sell + the platform claim and simulates both
import { PublicKey, VersionedTransaction } from '@solana/web3.js'
const LL = await import('../src/launchlab.ts'); const C = await import('../src/chain.ts')
const M = process.argv[2] || '7aAZbX5PsauTJmbsxm7Ab2j9UTP5K5mTYm8qcd7BANK', OWNER = new PublicKey(process.argv[3] || 'HuZGx4k41dCPuXR4PnBNdHNXJ4WzbUnDxo9wvU3VpXAY')
const bal = await C.tokenBalance(OWNER.toBase58(), M); console.log('dev balance', bal)
const p = await LL.pool(M, 0); console.log('pool', { realA: String(p.realA), realB: String(p.realB), platformFee: String(p.platformFee), status: p.status })
try { const tx = await LL.buildTrade(OWNER, 'sell', M, bal.ui, { slippageBps: 1000 })
  const sim = await C.conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true })
  console.log('SELL sim err', JSON.stringify(sim.value.err)); console.log((sim.value.logs || []).slice(-12).join('\n'))
} catch (e) { console.log('SELL build error', e.message, (e.stack||'').split('\n').slice(0,3).join(' | ')) }
try { const pend = await LL.pendingFee(M); console.log('pending platform fee SOL', pend)
  const tx = await LL.buildClaim(M, LL.PLATFORM_ID, LL.platformKeypair().publicKey); const sim = await C.conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true })
  console.log('CLAIM sim err', JSON.stringify(sim.value.err)); console.log((sim.value.logs || []).slice(-8).join('\n'))
} catch (e) { console.log('CLAIM build error', e.message) }
