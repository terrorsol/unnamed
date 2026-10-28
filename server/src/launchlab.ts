// Raydium LaunchLab: our launchpad. Every coin launched here sits on a curve bound to OUR platform config, so every buy and sell
// pays the platform fee (the tax) into a vault we claim per pool and forward to that coin's chest, and the creator fee goes
// to the dev. After graduation the LP lands in a fee-key NFT held by the platform wallet (LP fees forever).
// Shapes: default SOL config (constant product, 30 SOL × 1.073e9 virtual — same curve as pump, 85 SOL raise, 793.1M on the curve).
// All txs are built with the official SDK and signed by whoever owns them (dev in the wallet, vault through the keeper).
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js'
import BN from 'bn.js'
import { Raydium, TxVersion, LAUNCHPAD_PROGRAM, LAUNCHPAD_PLATFORM, LaunchpadPool, LaunchpadConfig, PlatformConfig, Curve, getPdaLaunchpadConfigId, getPdaLaunchpadPoolId, getPdaPlatformId, getPdaLaunchpadVaultId } from '@raydium-io/raydium-sdk-v2'
import bs58 from 'bs58'
import { createHash } from 'node:crypto'
import { conn, RPC } from './chain.ts'

export const WSOL = new PublicKey('So11111111111111111111111111111111111111112')
export const JITO_TIP = '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5'
export const PROGRAM = LAUNCHPAD_PROGRAM
export const CONFIG_ID = getPdaLaunchpadConfigId(PROGRAM, WSOL, 0, 0).publicKey // default SOL constant-product config
/** platform admin = the owner's wallet (signs CreatePlatformConfig once); platform id is its PDA */
export const PLATFORM_ADMIN = process.env.PLATFORM_ADMIN ? new PublicKey(process.env.PLATFORM_ADMIN) : null
export const PLATFORM_ID = process.env.PLATFORM_ID ? new PublicKey(process.env.PLATFORM_ID) : PLATFORM_ADMIN ? getPdaPlatformId(PROGRAM, PLATFORM_ADMIN).publicKey : null
/** fee wallet = server key that claims platform fees and holds the LP fee NFT (PLATFORM_SECRET base58; falls back to a key derived from VAULT_SECRET) */
export const TAX_BPS = Math.min(500, Math.max(0, +(process.env.TAX_BPS || 200)))          // platform fee on every curve trade → chest. cap 500
export const CREATOR_FEE_BPS = Math.min(50, Math.max(0, +(process.env.CREATOR_FEE_BPS || 50))) // → dev, on-chain. cap 50
let platformKp: Keypair | null = null
export function platformKeypair(): Keypair {
  if (platformKp) return platformKp
  if (process.env.PLATFORM_SECRET) platformKp = Keypair.fromSecretKey(bs58.decode(process.env.PLATFORM_SECRET))
  else platformKp = Keypair.fromSeed(createHash('sha256').update('unnamed-platform:' + (process.env.VAULT_SECRET || 'dev')).digest())
  return platformKp!
}

let rdP: Promise<Raydium> | null = null
const rd = () => (rdP ||= Raydium.load({ connection: conn, disableLoadToken: true, disableFeatureCheck: true, cluster: 'mainnet' }).catch((e) => { rdP = null; throw e }))
// the SDK keeps one owner; serialize builds so two callers never interleave
let chain: Promise<any> = Promise.resolve()
function withOwner<T>(owner: PublicKey, f: (r: Raydium) => Promise<T>): Promise<T> { const p = chain.then(async () => { const r = await rd(); r.setOwner(owner); return f(r) }); chain = p.catch(() => {}); return p }

export const poolIdOf = (mint: string) => getPdaLaunchpadPoolId(PROGRAM, new PublicKey(mint), WSOL).publicKey
export type Pool = { poolId: string; status: number; creator: string; platformId: string; virtualA: bigint; virtualB: bigint; realA: bigint; realB: bigint; totalSellA: bigint; totalFundRaisingB: bigint; decA: number; decB: number; platformFee: bigint; migrated: boolean; priceSol: number; liqSol: number; soldPct: number }
const poolCache = new Map<string, { t: number; p: Pool | null }>()
/** exact pool read; null when this mint has no LaunchLab pool. Cached 1s. */
export async function pool(mint: string, maxAgeMs = 1000): Promise<Pool | null> {
  const c = poolCache.get(mint); if (c && Date.now() - c.t < maxAgeMs) return c.p
  const id = poolIdOf(mint); const info = await conn.getAccountInfo(id, 'processed').catch(() => null)
  let p: Pool | null = null
  if (info && info.owner.equals(PROGRAM)) {
    const d: any = LaunchpadPool.decode(info.data)
    const bn = (x: any) => BigInt(x.toString())
    const price = Curve.getPrice({ poolInfo: d, curveType: 0, decimalA: d.mintDecimalsA, decimalB: d.mintDecimalsB }).toNumber()
    const vB = bn(d.virtualB), rB = bn(d.realB), rA = bn(d.realA), tS = bn(d.totalSellA)
    // status: 0 funding (on the curve), 1 migrating, 2 migrated (trades on the CPMM now)
    p = { poolId: id.toBase58(), status: d.status, creator: d.creator.toBase58(), platformId: d.platformId.toBase58(), virtualA: bn(d.virtualA), virtualB: vB, realA: rA, realB: rB, totalSellA: tS, totalFundRaisingB: bn(d.totalFundRaisingB), decA: d.mintDecimalsA, decB: d.mintDecimalsB, platformFee: bn(d.platformFee), migrated: d.status >= 2, priceSol: price, liqSol: Number(vB + rB) / 1e9, soldPct: tS ? Number(rA * 10000n / tS) / 100 : 0 }
  }
  poolCache.set(mint, { t: Date.now(), p }); return p
}
export const isOurs = (p: Pool | null) => !!p && !!PLATFORM_ID && p.platformId === PLATFORM_ID.toBase58()

/** our platform config as the chain has it (null until the admin signs CreatePlatformConfig) */
export async function platform(): Promise<{ id: string; exists: boolean; feeRate?: number; creatorFeeRate?: number; feeWallet?: string; nftWallet?: string; name?: string } | null> {
  if (!PLATFORM_ID) return null
  const info = await conn.getAccountInfo(PLATFORM_ID).catch(() => null)
  if (!info) return { id: PLATFORM_ID.toBase58(), exists: false }
  const d: any = PlatformConfig.decode(info.data)
  return { id: PLATFORM_ID.toBase58(), exists: true, feeRate: +d.feeRate.toString() / 1e4, creatorFeeRate: +d.creatorFeeRate.toString() / 1e4, feeWallet: d.platformClaimFeeWallet.toBase58(), nftWallet: d.platformLockNftWallet.toBase58(), name: Buffer.from(d.name).toString('utf8').replace(/\0+$/, '') }
}
/** one-time: the admin's wallet signs this. Fee wallet / NFT wallet = our platform key. Fee rates in 1e-6 units (bps × 100). */
export async function buildPlatformTx(admin: PublicKey): Promise<{ tx: string; platformId: string }> {
  // reuse Raydium's own platform for the CPMM config it binds graduated pools to
  const ref = await conn.getAccountInfo(LAUNCHPAD_PLATFORM); if (!ref) throw new Error('reference platform not found')
  const refCfg: any = PlatformConfig.decode(ref.data)
  const pk = platformKeypair().publicKey
  const r = await withOwner(admin, (r) => r.launchpad.createPlatformConfig({
    platformAdmin: admin, platformClaimFeeWallet: pk, platformLockNftWallet: pk, platformVestingWallet: pk, cpConfigId: refCfg.cpConfigId,
    migrateCpLockNftScale: { platformScale: new BN(1_000_000), creatorScale: new BN(0), burnScale: new BN(0) },
    transferFeeExtensionAuth: pk, creatorFeeRate: new BN(CREATOR_FEE_BPS * 100), feeRate: new BN(TAX_BPS * 100),
    name: 'UNNAMED', web: process.env.PUBLIC_URL || 'https://terrorsol.github.io/unnamed/app/', img: '', txVersion: TxVersion.V0,
    computeBudgetConfig: { units: 200_000, microLamports: 50_000 },
  }))
  const tx = r.transaction as VersionedTransaction
  return { tx: Buffer.from(tx.serialize()).toString('base64'), platformId: getPdaPlatformId(PROGRAM, admin).publicKey.toBase58() }
}

export type LaunchBuild = { mint: string; poolId: string; txs: string[]; devTokens: number; devCostSol: number; afterDev: { virtualA: bigint; virtualB: bigint; realA: bigint; realB: bigint } }
/** The create (+ dev buy) tx(s) for the dev to sign; the mint keypair has already co-signed. Platform = ours (must exist on chain). */
export async function buildLaunch(dev: PublicKey, meta: { name: string; symbol: string; uri: string }, devBuySol: number, platformId: PublicKey | null = PLATFORM_ID): Promise<LaunchBuild> {
  if (!platformId) throw new Error('no platform configured (PLATFORM_ADMIN)')
  const mintKp = Keypair.generate()
  const r: any = await withOwner(dev, (r) => r.launchpad.createLaunchpad({
    programId: PROGRAM, platformId, mintA: mintKp.publicKey, decimals: 6, name: meta.name, symbol: meta.symbol.slice(0, 10), uri: meta.uri, migrateType: 'cpmm',
    configId: CONFIG_ID, buyAmount: new BN(Math.floor(devBuySol * 1e9)), createOnly: devBuySol <= 0, slippage: new BN(1000), txVersion: TxVersion.V0, extraSigners: [mintKp],
    computeBudgetConfig: { units: 600_000, microLamports: 100_000 },
  }))
  const txs: VersionedTransaction[] = r.transactions
  for (const t of txs) { const keys = t.message.staticAccountKeys.map((k) => k.toBase58()); if (keys.includes(mintKp.publicKey.toBase58()) && t.message.header.numRequiredSignatures > 1) t.sign([mintKp]) }
  const z = quoteFresh(devBuySol)
  return { mint: mintKp.publicKey.toBase58(), poolId: poolIdOf(mintKp.publicKey.toBase58()).toBase58(), txs: txs.map((t) => Buffer.from(t.serialize()).toString('base64')), devTokens: z.tokens, devCostSol: z.cost, afterDev: z.after }
}
// default config curve (SDK LaunchpadPoolInitParam): virtual 30.00085 SOL × 1,073,025,605.6 tokens, 793.1M on the curve, 85 SOL raise
export const CURVE0 = { virtualA: 1_073_025_605_596_382n, virtualB: 30_000_852_951n, totalSellA: 793_100_000_000_000n, totalFundRaisingB: 85_000_000_000n, supply: 1_000_000_000_000_000n }
export type State = { virtualA: bigint; virtualB: bigint; realA: bigint; realB: bigint }
/** constant product on virtual reserves. Fees (protocol + platform + creator) come off the SOL in before it hits the curve. */
export function quote(s: State, solIn: number, feeBps = 25 + TAX_BPS + CREATOR_FEE_BPS) {
  const inL = BigInt(Math.floor(solIn * 1e9)); const net = inL * BigInt(10000 - feeBps) / 10000n
  const A = s.virtualA - s.realA, B = s.virtualB + s.realB
  const out = A - (A * B) / (B + net)
  const after = { virtualA: s.virtualA, virtualB: s.virtualB, realA: s.realA + out, realB: s.realB + net }
  const price = Number(after.virtualB + after.realB) / Number(after.virtualA - after.realA) / 1e3 // lamports/raw → SOL/token with 6 decimals
  return { tokens: Number(out) / 1e6, cost: solIn, after, priceSol: price, mcapSol: price * 1e9 }
}
export const quoteFresh = (solIn: number) => quote({ ...CURVE0, realA: 0n, realB: 0n }, solIn)
/** block zero: dev first (inside create), vault second in the same bundle */
export function blockZero(devSol: number, vaultSol: number) {
  const d = quoteFresh(devSol); const v = quote(d.after, vaultSol)
  return { devTokens: d.tokens, vaultTokens: v.tokens, devPct: d.tokens / 1e7, vaultPct: v.tokens / 1e7, priceSol: v.priceSol, mcapSol: v.mcapSol, vaultAvgCost: vaultSol / Math.max(v.tokens, 1e-9) }
}

/** a buy/sell on a LaunchLab pool for `owner`, unsigned. `poolState` lets the vault buy in the launch bundle before the pool exists. */
export async function buildTrade(owner: PublicKey, action: 'buy' | 'sell', mint: string, amount: number | string, opts: { slippageBps?: number; poolState?: State; fromCreate?: boolean; tipLamports?: number; platformId?: PublicKey } = {}): Promise<VersionedTransaction> {
  const mintA = new PublicKey(mint)
  const slippage = new BN(Math.min(9999, Math.max(1, opts.slippageBps ?? 1000)))
  const base: any = { programId: PROGRAM, mintA, mintB: WSOL, slippage, txVersion: TxVersion.V0 as const, computeBudgetConfig: { units: 300_000, microLamports: 100_000 } }
  if (opts.tipLamports) base.txTipConfig = { address: new PublicKey(JITO_TIP), amount: new BN(opts.tipLamports) }
  let poolInfo: any
  if (opts.poolState) {
    const s = opts.poolState; const bn = (x: bigint) => new BN(x.toString())
    const poolId = poolIdOf(mint); const vaultA = getPdaLaunchpadVaultId(PROGRAM, poolId, mintA).publicKey, vaultB = getPdaLaunchpadVaultId(PROGRAM, poolId, WSOL).publicKey
    poolInfo = { configId: CONFIG_ID, platformId: opts.platformId || PLATFORM_ID, mintA, mintB: WSOL, vaultA, vaultB, virtualA: bn(s.virtualA), virtualB: bn(s.virtualB), realA: bn(s.realA), realB: bn(s.realB), totalSellA: bn(CURVE0.totalSellA), totalFundRaisingB: bn(CURVE0.totalFundRaisingB), mintDecimalsA: 6, mintDecimalsB: 9, supply: bn(CURVE0.supply), status: 0, migrateFee: new BN(0), vestingSchedule: { totalLockedAmount: new BN(0), cliffPeriod: new BN(0), unlockPeriod: new BN(0), startTime: new BN(0), totalAllocatedShare: new BN(0) }, totalLockedAmount: new BN(0), cliffPeriod: new BN(0), unlockPeriod: new BN(0), mintProgramFlag: 0, creator: owner, platformFee: new BN(0), protocolFee: new BN(0), epoch: new BN(0), bump: 0, migrateType: 1, cpmmCreatorFeeOn: 0, platformVestingShare: new BN(0) }
  }
  const r: any = await withOwner(owner, (r) => action === 'buy'
    ? r.launchpad.buyToken({ ...base, buyAmount: new BN(Math.floor(+amount * 1e9)), poolInfo, fromCreate: !!opts.fromCreate, skipCheckMintA: !!opts.poolState })
    : r.launchpad.sellToken({ ...base, sellAmount: new BN(typeof amount === 'string' && amount.endsWith('%') ? 0 : Math.floor(+amount * 1e6)), poolInfo }))
  return r.transaction as VersionedTransaction
}
/** sell a percentage of the owner's balance (vault sells are expressed as 'NN%') */
export async function sellPct(owner: PublicKey, mint: string, pct: number, slippageBps = 1000): Promise<VersionedTransaction> {
  const { tokenBalance } = await import('./chain.ts'); const bal = await tokenBalance(owner.toBase58(), mint)
  const raw = bal.raw * BigInt(Math.round(pct * 100)) / 10000n; if (raw <= 0n) throw new Error('nothing to sell')
  const r: any = await withOwner(owner, (r) => r.launchpad.sellToken({ programId: PROGRAM, mintA: new PublicKey(mint), mintB: WSOL, sellAmount: new BN(raw.toString()), slippage: new BN(slippageBps), txVersion: TxVersion.V0, computeBudgetConfig: { units: 300_000, microLamports: 100_000 } }))
  return r.transaction as VersionedTransaction
}

/** claim this pool's accrued platform fee (the tax) to the platform wallet; returns the tx to sign with the platform key */
export async function buildClaim(mint: string, platformId: PublicKey | null = PLATFORM_ID, feePayer?: PublicKey): Promise<VersionedTransaction> {
  if (!platformId) throw new Error('no platform')
  const pk = platformKeypair().publicKey
  const poolId = poolIdOf(mint); const vaultB = getPdaLaunchpadVaultId(PROGRAM, poolId, WSOL).publicKey
  // the coin's own vault pays the claim fee (keeper co-signs, 0 SOL out), so the platform wallet never needs funding
  const r: any = await withOwner(pk, (r) => r.launchpad.claimPlatformFee({ programId: PROGRAM, platformId, platformClaimFeeWallet: pk, poolId, mintB: WSOL, vaultB, feePayer, txVersion: TxVersion.V0, computeBudgetConfig: { units: 200_000, microLamports: 50_000 } }))
  return r.transaction as VersionedTransaction
}
/** unclaimed platform fee sitting in the pool (lamports) */
export async function pendingFee(mint: string): Promise<number> { const p = await pool(mint, 0); return p ? Number(p.platformFee) / 1e9 : 0 }
export const status = () => ({ venue: 'launchlab', program: PROGRAM.toBase58(), platformId: PLATFORM_ID?.toBase58() || null, admin: PLATFORM_ADMIN?.toBase58() || null, feeWallet: platformKeypair().publicKey.toBase58(), taxBps: TAX_BPS, creatorFeeBps: CREATOR_FEE_BPS, rpc: RPC.replace(/api-key=.*/, 'api-key=…') })

// ---- after graduation: LP fees. The LP from migration is locked in a fee-key NFT held by the platform wallet; harvesting pulls the accrued
// swap fees (SOL + token side) to the platform wallet. The vault's tick forwards the SOL to the chest. Experimental until the first graduation.
import { LOCK_CPMM_PROGRAM, CREATE_CPMM_POOL_PROGRAM, getCpLockPda, LockPositionLayout, getCpmmPdaPoolId } from '@raydium-io/raydium-sdk-v2'
export async function cpmmPoolIdOf(mint: string): Promise<PublicKey | null> {
  const ref = await conn.getAccountInfo(PLATFORM_ID || LAUNCHPAD_PLATFORM); if (!ref) return null
  const cfg: any = PlatformConfig.decode(ref.data); const a = new PublicKey(mint)
  for (const [m0, m1] of [[a, WSOL], [WSOL, a]]) { const id = getCpmmPdaPoolId(CREATE_CPMM_POOL_PROGRAM, cfg.cpConfigId, m0, m1).publicKey; const info = await conn.getAccountInfo(id).catch(() => null); if (info) return id }
  return null
}
/** the fee-key NFT in the platform wallet that locks this coin's post-graduation LP */
export async function lockNftFor(mint: string): Promise<{ nftMint: PublicKey; poolId: PublicKey } | null> {
  const poolId = await cpmmPoolIdOf(mint); if (!poolId) return null
  const pk = platformKeypair().publicKey
  const accs = await conn.getParsedTokenAccountsByOwner(pk, { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') })
  for (const a of accs.value) {
    const info = (a.account.data as any).parsed.info; if (info.tokenAmount.decimals !== 0 || info.tokenAmount.amount !== '1') continue
    const nft = new PublicKey(info.mint); const lock = await conn.getAccountInfo(getCpLockPda(LOCK_CPMM_PROGRAM, nft).publicKey).catch(() => null); if (!lock) continue
    const d: any = LockPositionLayout.decode(lock.data); if (d.poolId.equals(poolId)) return { nftMint: nft, poolId }
  }
  return null
}
/** harvest tx (owner = platform wallet, fee payer = the coin's vault) or null when there is nothing to harvest */
export async function buildHarvest(mint: string, feePayer: PublicKey): Promise<VersionedTransaction | null> {
  const lock = await lockNftFor(mint); if (!lock) return null
  const pk = platformKeypair().publicKey
  const r: any = await withOwner(pk, async (r) => { const { poolInfo, poolKeys } = await r.cpmm.getPoolInfoFromRpc(lock.poolId.toBase58()); return r.cpmm.harvestLockLp({ poolInfo, poolKeys, nftMint: lock.nftMint, lpFeeAmount: new BN('18446744073709551615'), feePayer, txVersion: TxVersion.V0, computeBudgetConfig: { units: 400_000, microLamports: 50_000 } }) })
  return r.transaction as VersionedTransaction
}
