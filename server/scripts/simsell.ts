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
// raw pool + platform fields, to see which bucket the 2% landed in
try { const { LaunchpadPool, PlatformConfig, getPdaLaunchpadPoolId } = await import('@raydium-io/raydium-sdk-v2')
  const { PublicKey: PK } = await import('@solana/web3.js')
  const poolId = getPdaLaunchpadPoolId(LL.PROGRAM, new PK(M), new PK('So11111111111111111111111111111111111111112')).publicKey
  const ai = await C.conn.getAccountInfo(poolId); const d: any = LaunchpadPool.decode(ai!.data)
  const fee: any = {}; for (const k of Object.keys(d)) if (/fee|Fee/.test(k)) fee[k] = String(d[k]); console.log('pool fee fields', fee)
  const pi = await C.conn.getAccountInfo(LL.PLATFORM_ID!); const pc: any = PlatformConfig.decode(pi!.data)
  const pf: any = {}; for (const k of Object.keys(pc)) if (/fee|Fee|Rate|wallet|Wallet/.test(k)) pf[k] = String(pc[k]); console.log('platform config', pf)
} catch (e) { console.log('raw decode error', e.message) }
// where did the fee go: balance deltas + inner instructions of the pool's first txs (create + dev buy)
try { const { PublicKey: PK } = await import('@solana/web3.js'); const { getPdaLaunchpadPoolId } = await import('@raydium-io/raydium-sdk-v2')
  const poolId = getPdaLaunchpadPoolId(LL.PROGRAM, new PK(M), new PK('So11111111111111111111111111111111111111112')).publicKey
  const sigs = await C.conn.getSignaturesForAddress(poolId, { limit: 20 }); console.log('pool txs', sigs.length)
  for (const s of sigs.slice().reverse().slice(0, 4)) {
    const tx = await C.conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 1 }); if (!tx?.meta) continue
    const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58())
    const deltas = keys.map((k, i) => [k.slice(0, 8), (tx.meta!.postBalances[i] - tx.meta!.preBalances[i]) / 1e9]).filter(([, d]) => Math.abs(d as number) > 1e-6)
    console.log('tx', s.signature.slice(0, 16), 'err', JSON.stringify(tx.meta.err), 'deltas', JSON.stringify(deltas))
    const inner = (tx.meta.innerInstructions || []).flatMap((ii) => ii.instructions).map((ix: any) => ix.parsed ? `${ix.program}:${ix.parsed.type}:${JSON.stringify(ix.parsed.info).slice(0, 160)}` : ix.programId?.toBase58?.().slice(0, 8))
    console.log('  inner', inner.slice(0, 12).join('\n  inner '))
    console.log('  logs', (tx.meta.logMessages || []).filter((l) => /fee|Fee|Instruction:/.test(l)).slice(0, 10).join(' | '))
  }
} catch (e) { console.log('tx trace error', e.message) }
