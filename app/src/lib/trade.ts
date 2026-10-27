// One entry point for real on-chain trades. Routes: pump bonding curve → PumpPortal; graduated → Jupiter (fallback PumpPortal auto).
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js'
import * as J from './jupiter'
import * as P from './pumpportal'
import { sendAndConfirm } from './rpc'
import { SOL_MINT, LAMPORTS } from './fmt'
import type { Settings } from './store'

export type Signer = (t: VersionedTransaction) => Promise<VersionedTransaction>
export type Ctx = { conn: Connection; owner: PublicKey; sign: Signer; settings: Settings; onStatus?: (s: string) => void }

export async function buy(ctx: Ctx, mint: string, sol: number, onCurve: boolean): Promise<string> {
  const { conn, owner, sign, settings, onStatus } = ctx
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
    const tx = await J.buildSwap(q, pk, Math.floor(settings.priorityFeeSol * LAMPORTS))
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
  const { conn, owner, sign, settings, onStatus } = ctx
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
    const tx = await J.buildSwap(q, pk, Math.floor(settings.priorityFeeSol * LAMPORTS))
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
