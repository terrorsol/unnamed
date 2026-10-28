// One entry point for real on-chain trades. Routes: pump bonding curve → PumpPortal; graduated → Jupiter (fallback PumpPortal auto).
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js'
import * as J from './jupiter'
import * as P from './pumpportal'
import { sendAndConfirm, priorityFee } from './rpc'
import bs58 from 'bs58'
import { SOL_MINT, LAMPORTS } from './fmt'
import type { Settings } from './store'

export type Signer = (t: VersionedTransaction) => Promise<VersionedTransaction>
export type Ctx = { conn: Connection; owner: PublicKey; sign: Signer; settings: Settings; onStatus?: (s: string) => void }

async function fee(ctx: Ctx) { return ctx.settings.autoFee ? priorityFee(ctx.conn, ctx.settings.priorityFeeSol) : ctx.settings.priorityFeeSol }
export async function buy(ctx: Ctx, mint: string, sol: number, onCurve: boolean): Promise<string> {
  const { conn, owner, sign, onStatus } = ctx; const settings = { ...ctx.settings, priorityFeeSol: await fee(ctx) }
  const pk = owner.toBase58()
  const slipPct = settings.slippageBps / 100
  if (onCurve) {
    onStatus?.('Building pump.fun buy…')
    const tx = await P.buildTrade({ publicKey: pk, action: 'buy', mint, amount: sol, denominatedInSol: true, slippage: slipPct, priorityFee: settings.priorityFeeSol, pool: 'auto' })
    return sendAndConfirm(conn, tx, sign, onStatus)
  }
  try {
    onStatus?.('Quoting on Jupiter…')
    const q = await J.quote(SOL_MINT, mint, Math.floor(sol * LAMPORTS), settings.slippageBps)
    onStatus?.('Building swap…')
    const tx = await J.buildSwap(q, pk, Math.floor(settings.priorityFeeSol * LAMPORTS), settings.mev ? Math.floor(settings.jitoTipSol * LAMPORTS) : 0)
    return await sendAndConfirm(conn, tx, sign, onStatus)
  } catch (e: any) {
    if (/signature|reject|user/i.test(String(e?.message))) throw e
    onStatus?.('Jupiter unavailable, trying PumpPortal…')
    const tx = await P.buildTrade({ publicKey: pk, action: 'buy', mint, amount: sol, denominatedInSol: true, slippage: slipPct, priorityFee: settings.priorityFeeSol, pool: 'auto' })
    return sendAndConfirm(conn, tx, sign, onStatus)
  }
}

/** frac 0..1 of current holding; rawAmount = integer token units held */
export async function sell(ctx: Ctx, mint: string, frac: number, rawAmount: bigint, onCurve: boolean): Promise<string> {
  const { conn, owner, sign, onStatus } = ctx; const settings = { ...ctx.settings, priorityFeeSol: await fee(ctx) }
  const pk = owner.toBase58()
  const slipPct = settings.slippageBps / 100
  const pct = Math.round(frac * 100)
  if (onCurve) {
    onStatus?.('Building pump.fun sell…')
    const tx = await P.buildTrade({ publicKey: pk, action: 'sell', mint, amount: `${pct}%`, denominatedInSol: false, slippage: slipPct, priorityFee: settings.priorityFeeSol, pool: 'auto' })
    return sendAndConfirm(conn, tx, sign, onStatus)
  }
  const amt = frac >= 0.999 ? rawAmount : (rawAmount * BigInt(Math.round(frac * 10000))) / 10000n
  try {
    onStatus?.('Quoting on Jupiter…')
    const q = await J.quote(mint, SOL_MINT, amt, settings.slippageBps)
    onStatus?.('Building swap…')
    const tx = await J.buildSwap(q, pk, Math.floor(settings.priorityFeeSol * LAMPORTS), settings.mev ? Math.floor(settings.jitoTipSol * LAMPORTS) : 0)
    return await sendAndConfirm(conn, tx, sign, onStatus)
  } catch (e: any) {
    if (/signature|reject|user/i.test(String(e?.message))) throw e
    onStatus?.('Jupiter unavailable, trying PumpPortal…')
    const tx = await P.buildTrade({ publicKey: pk, action: 'sell', mint, amount: `${pct}%`, denominatedInSol: false, slippage: slipPct, priorityFee: settings.priorityFeeSol, pool: 'auto' })
    return sendAndConfirm(conn, tx, sign, onStatus)
  }
}

export async function launch(ctx: Ctx, meta: P.CreateMeta, devBuySol: number): Promise<{ sig: string; mint: string }> {
  const { conn, owner, sign, settings, onStatus } = ctx
  onStatus?.('Uploading metadata…')
  const uri = await P.uploadMetadata(meta)
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
export async function launchBlockZero(ctx: Ctx, meta: P.CreateMeta, devBuySol: number, vault: { id: string; pub: string }, vaultBuySol: number, deps: { bundleSign: (id: string, mint: string, tx: string, maxSol: number) => Promise<{ tx: string }>; sendBundle: (txs: string[]) => Promise<{ bundleId: string }> }): Promise<{ sig: string; mint: string; bundled: boolean }> {
  const { conn, owner, sign, settings, onStatus } = ctx
  onStatus?.('Uploading metadata…'); const uri = await P.uploadMetadata(meta)
  try {
    onStatus?.('Building block-zero bundle…')
    const { mint, createTx, vaultTx } = await P.buildLaunchBundle(owner.toBase58(), vault.pub, { name: meta.name, symbol: meta.symbol, uri }, devBuySol, vaultBuySol, settings.slippageBps / 100, settings.priorityFeeSol)
    onStatus?.('Vault signing…'); const signedVault = await deps.bundleSign(vault.id, mint, Buffer.from(vaultTx.serialize()).toString('base64'), vaultBuySol)
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
