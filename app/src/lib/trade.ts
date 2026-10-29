// One entry point for real on-chain trades. Routes: pump bonding curve → PumpPortal; graduated → Jupiter (fallback PumpPortal auto).
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js'
import * as J from './jupiter'
import * as P from './pumpportal'
import { sendAndConfirm, priorityFee, type Fast } from './rpc'
import { MIN_TIP_LAMPORTS } from './fast'
import bs58 from 'bs58'
import { SOL_MINT, LAMPORTS } from './fmt'
import type { Settings } from './store'
import { dynSlippageBps } from './slip'
export { dynSlippageBps }
import { SERVER } from './desk'
import * as K from './desk'

export type Signer = (t: VersionedTransaction) => Promise<VersionedTransaction>
export type Ctx = { conn: Connection; owner: PublicKey; sign: Signer; settings: Settings; onStatus?: (s: string) => void; depthSol?: number; venue?: 'pump' | 'launchlab' }

/** Sender tip when MEV protection is on: the tip buys priority routing (validators + SWQOS), the CU price is still set by priorityFee. */
function fast(ctx: Ctx): Fast | undefined { return ctx.settings.mev ? { rpc: ctx.settings.rpc, payer: ctx.owner, tipLamports: Math.max(MIN_TIP_LAMPORTS, Math.floor(ctx.settings.jitoTipSol * LAMPORTS)) } : undefined }
async function fee(ctx: Ctx) { return ctx.settings.autoFee ? priorityFee(ctx.conn, ctx.settings.priorityFeeSol) : ctx.settings.priorityFeeSol }
/** true only when the chain says the tx would fail; network errors count as 'fine' so a flaky RPC never changes the route */
async function simFails(conn: Connection, tx: VersionedTransaction) { try { const r = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true }); return !!r.value.err } catch { return false } }

export async function buy(ctx: Ctx, mint: string, sol: number, onCurve: boolean): Promise<string> {
  const { conn, owner, sign, onStatus } = ctx; const settings = { ...ctx.settings, priorityFeeSol: await fee(ctx), slippageBps: dynSlippageBps(sol, ctx.depthSol, ctx.settings.slippageBps) }
  const pk = owner.toBase58()
  const slipPct = settings.slippageBps / 100
  if (ctx.venue === 'launchlab') {
    // our launchpad: the server builds the exact curve tx with the official SDK (no PumpPortal), the wallet signs, Sender lands it
    onStatus?.('Building buy…'); const { llTrade } = await import('./desk')
    const tx = VersionedTransaction.deserialize(Buffer.from((await llTrade(pk, 'buy', mint, sol, settings.slippageBps)).tx, 'base64'))
    return sendAndConfirm(conn, tx, sign, onStatus, fast(ctx))
  }
  if (onCurve) {
    onStatus?.('Building pump.fun buy…')
    const tx = await P.buildTrade({ publicKey: pk, action: 'buy', mint, amount: sol, denominatedInSol: true, slippage: slipPct, priorityFee: settings.priorityFeeSol, pool: 'auto' })
    // dry-run before the wallet prompt: PumpPortal's builder has failed on mayhem (Token-2022) curve coins; Jupiter routes those
    if (await simFails(conn, tx)) { onStatus?.('Routing via Jupiter…'); const q = await J.quote(SOL_MINT, mint, Math.floor(sol * LAMPORTS), settings.slippageBps); const jt = await J.buildSwap(q, pk, Math.floor(settings.priorityFeeSol * LAMPORTS), 0); return sendAndConfirm(conn, jt, sign, onStatus, fast(ctx)) }
    return sendAndConfirm(conn, tx, sign, onStatus, fast(ctx))
  }
  try {
    onStatus?.('Quoting on Jupiter…')
    const q = await J.quote(SOL_MINT, mint, Math.floor(sol * LAMPORTS), settings.slippageBps)
    onStatus?.('Building swap…')
    const tx = await J.buildSwap(q, pk, Math.floor(settings.priorityFeeSol * LAMPORTS), 0)
    return await sendAndConfirm(conn, tx, sign, onStatus, fast(ctx))
  } catch (e: any) {
    if (/signature|reject|user/i.test(String(e?.message))) throw e
    onStatus?.('Jupiter unavailable, trying PumpPortal…')
    const tx = await P.buildTrade({ publicKey: pk, action: 'buy', mint, amount: sol, denominatedInSol: true, slippage: slipPct, priorityFee: settings.priorityFeeSol, pool: 'auto' })
    return sendAndConfirm(conn, tx, sign, onStatus, fast(ctx))
  }
}

/** frac 0..1 of current holding; rawAmount = integer token units held */
export async function sell(ctx: Ctx, mint: string, frac: number, rawAmount: bigint, onCurve: boolean, sizeSol?: number): Promise<string> {
  const { conn, owner, sign, onStatus } = ctx; const settings = { ...ctx.settings, priorityFeeSol: await fee(ctx), slippageBps: dynSlippageBps(sizeSol || 0, ctx.depthSol, ctx.settings.slippageBps) }
  const pk = owner.toBase58()
  const slipPct = settings.slippageBps / 100
  const pct = Math.round(frac * 100)
  if (ctx.venue === 'launchlab') {
    onStatus?.('Building sell…'); const { llTrade } = await import('./desk')
    const ui = Number(frac >= 0.999 ? rawAmount : (rawAmount * BigInt(Math.round(frac * 10000))) / 10000n) / 1e6
    const tx = VersionedTransaction.deserialize(Buffer.from((await llTrade(pk, 'sell', mint, ui, settings.slippageBps)).tx, 'base64'))
    return sendAndConfirm(conn, tx, sign, onStatus, fast(ctx))
  }
  if (onCurve) {
    onStatus?.('Building pump.fun sell…')
    const tx = await P.buildTrade({ publicKey: pk, action: 'sell', mint, amount: `${pct}%`, denominatedInSol: false, slippage: slipPct, priorityFee: settings.priorityFeeSol, pool: 'auto' })
    if (await simFails(conn, tx)) { onStatus?.('Routing via Jupiter…'); const amt = frac >= 0.999 ? rawAmount : (rawAmount * BigInt(Math.round(frac * 10000))) / 10000n; const q = await J.quote(mint, SOL_MINT, amt, settings.slippageBps); const jt = await J.buildSwap(q, pk, Math.floor(settings.priorityFeeSol * LAMPORTS), 0); return sendAndConfirm(conn, jt, sign, onStatus, fast(ctx)) }
    return sendAndConfirm(conn, tx, sign, onStatus, fast(ctx))
  }
  const amt = frac >= 0.999 ? rawAmount : (rawAmount * BigInt(Math.round(frac * 10000))) / 10000n
  try {
    onStatus?.('Quoting on Jupiter…')
    const q = await J.quote(mint, SOL_MINT, amt, settings.slippageBps)
    onStatus?.('Building swap…')
    const tx = await J.buildSwap(q, pk, Math.floor(settings.priorityFeeSol * LAMPORTS), 0)
    return await sendAndConfirm(conn, tx, sign, onStatus, fast(ctx))
  } catch (e: any) {
    if (/signature|reject|user/i.test(String(e?.message))) throw e
    onStatus?.('Jupiter unavailable, trying PumpPortal…')
    const tx = await P.buildTrade({ publicKey: pk, action: 'sell', mint, amount: `${pct}%`, denominatedInSol: false, slippage: slipPct, priorityFee: settings.priorityFeeSol, pool: 'auto' })
    return sendAndConfirm(conn, tx, sign, onStatus, fast(ctx))
  }
}

export async function launch(ctx: Ctx, meta: P.CreateMeta, devBuySol: number): Promise<{ sig: string; mint: string }> {
  const { conn, owner, sign, settings, onStatus } = ctx
  onStatus?.('Uploading metadata…')
  const uri = await P.uploadMetadata(meta, SERVER)
  onStatus?.('Building create transaction…')
  const { tx, mint } = await P.buildCreate(owner.toBase58(), { name: meta.name, symbol: meta.symbol, uri }, devBuySol, settings.slippageBps / 100, settings.priorityFeeSol)
  const sig = await sendAndConfirm(conn, tx, sign, onStatus)
  return { sig, mint }
}

/** pump.fun creator-fee claim via PumpPortal (action collectCreatorFee) */
export async function collectCreatorFee(ctx: Ctx, mint: string): Promise<string> {
  const { conn, owner, sign, settings, onStatus } = ctx
  onStatus?.('Building claim…')
  const r = await fetch('https://pumpportal.fun/api/trade-local', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publicKey: owner.toBase58(), action: 'collectCreatorFee', mint, priorityFee: settings.priorityFeeSol }) })
  if (!r.ok) throw new Error('pumpportal: ' + (await r.text().catch(() => r.status)))
  const tx = VersionedTransaction.deserialize(new Uint8Array(await r.arrayBuffer()))
  return sendAndConfirm(conn, tx, sign, onStatus)
}

/** Launch with the vault in block zero: PumpPortal builds [create+dev buy, vault buy]; dev signs #1 (+mint), the server signs #2 with the vault key; both go to Jito as one bundle. Falls back to a plain launch if the bundle path fails before anything is sent. */
export async function launchBlockZero(ctx: Ctx, meta: P.CreateMeta, devBuySol: number, vault: { id: string; pub: string }, vaultBuySol: number, deps: { bundleSign: (id: string, mint: string, tx: string, maxSol: number, createTx?: string, auth?: K.DevAuth) => Promise<{ tx: string }>; sendBundle: (txs: string[]) => Promise<{ bundleId: string }>; signMsg?: (m: Uint8Array) => Promise<Uint8Array> }): Promise<{ sig: string; mint: string; bundled: boolean }> {
  const { conn, owner, sign, settings, onStatus } = ctx
  onStatus?.('Uploading metadata…'); const uri = await P.uploadMetadata(meta, SERVER)
  try {
    onStatus?.('Building block-zero bundle…')
    const { mint, createTx, vaultTx } = await P.buildLaunchBundle(owner.toBase58(), vault.pub, { name: meta.name, symbol: meta.symbol, uri }, devBuySol, vaultBuySol, settings.slippageBps / 100, settings.priorityFeeSol)
    onStatus?.('Vault signing…'); const auth = deps.signMsg ? await K.devAuth(deps.signMsg, 'bundle', vault.id, mint) : undefined; const signedVault = await deps.bundleSign(vault.id, mint, Buffer.from(vaultTx.serialize()).toString('base64'), vaultBuySol, Buffer.from(createTx.serialize()).toString('base64'), auth)
    onStatus?.('Sign the create…'); const signedCreate = await sign(createTx)
    onStatus?.('Sending bundle…'); await deps.sendBundle([Buffer.from(signedCreate.serialize()).toString('base64'), signedVault.tx])
    onStatus?.('Confirming…'); await confirmByPollingB58(conn, signedCreate)
    return { sig: bs58.encode(signedCreate.signatures[0]), mint, bundled: true }
  } catch (e: any) {
    if (/signature|reject|user/i.test(String(e?.message))) throw e
    onStatus?.('Bundle unavailable — plain launch…')
    const { tx, mint } = await P.buildCreate(owner.toBase58(), { name: meta.name, symbol: meta.symbol, uri }, devBuySol, settings.slippageBps / 100, settings.priorityFeeSol)
    const sig = await sendAndConfirm(conn, tx, sign, onStatus); return { sig, mint, bundled: false }
  }
}
async function confirmByPollingB58(conn: Connection, tx: VersionedTransaction) { const { confirmByPolling } = await import('./rpc'); await confirmByPolling(conn, bs58.encode(tx.signatures[0])) }

/** Launch on OUR launchpad (Raydium LaunchLab under our platform config): the server builds create(+dev buy) for the dev to sign and, with a vault, the vault's
 *  block-zero buy already keeper-signed. Both go out as one Jito bundle; if the bundle path fails before anything is sent, the create goes out alone and
 *  the vault seeds on arm. Every trade on the coin pays the platform fee into the chest from the first block. */
export async function launchOurs(ctx: Ctx, meta: P.CreateMeta, devBuySol: number, vault: { id: string } | null, vaultBuySol: number, deps: { sendBundle: (txs: string[]) => Promise<{ bundleId: string }>; signMsg?: (m: Uint8Array) => Promise<Uint8Array>; permTax?: boolean }): Promise<{ sig: string; mint: string; bundled: boolean }> {
  const { conn, owner, sign, onStatus } = ctx
  onStatus?.('Uploading metadata…'); const uri = await P.uploadMetadata(meta, SERVER)
  // the launch txs carry the server's blockhash (they are pre-signed by the mint and the vault), so slow wallet signing can outlive it: rebuild once and sign again
  for (let attempt = 0; ; attempt++) {
    try { return await launchOursOnce(ctx, meta, uri, devBuySol, vault, vaultBuySol, deps) }
    catch (e: any) { if (attempt >= 1 || !/blockhash|block height exceeded|expired/i.test(String(e?.message || e))) throw e; onStatus?.('That took too long — rebuilding, sign again…') }
  }
}
async function launchOursOnce(ctx: Ctx, meta: P.CreateMeta, uri: string, devBuySol: number, vault: { id: string } | null, vaultBuySol: number, deps: { sendBundle: (txs: string[]) => Promise<{ bundleId: string }>; signMsg?: (m: Uint8Array) => Promise<Uint8Array>; permTax?: boolean }): Promise<{ sig: string; mint: string; bundled: boolean }> {
  const { conn, owner, sign, onStatus } = ctx
  onStatus?.('Building launch…')
  const b = await K.withDevAuth(vault ? deps.signMsg : undefined, 'launch', vault?.id || '', owner.toBase58(), (auth) => K.llLaunchBuild({ dev: owner.toBase58(), name: meta.name, symbol: meta.symbol, uri, devBuySol, vaultId: vault?.id, vaultBuySol, auth, permTax: !!deps.permTax }))
  const txs = b.txs.map((x) => VersionedTransaction.deserialize(Buffer.from(x, 'base64')))
  onStatus?.(txs.length > 1 ? `Sign ${txs.length} transactions…` : 'Sign the create…')
  const signed: VersionedTransaction[] = []; for (const t of txs) signed.push(await sign(t))
  const sig = bs58.encode(signed[0].signatures[0])
  if (b.vaultTx) {
    try { onStatus?.('Sending bundle…'); await deps.sendBundle([...signed.map((t) => Buffer.from(t.serialize()).toString('base64')), b.vaultTx]); onStatus?.('Confirming…'); await confirmByPollingB58(conn, signed[0]); return { sig, mint: b.mint, bundled: true } }
    catch (e: any) { onStatus?.('Bundle unavailable — plain launch…') }
  }
  for (const t of signed) { const s2 = await conn.sendRawTransaction(t.serialize(), { skipPreflight: false, maxRetries: 3 }); await confirmByPollingB58(conn, t); void s2 }
  return { sig, mint: b.mint, bundled: false }
}
