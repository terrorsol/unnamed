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
  // the vault's block-zero buy only exists inside the bundle: a launch never goes live without it (no plain fallback). An expired or dropped
  // bundle is rebuilt (fresh blockhash) and signed again, up to twice; otherwise nothing launches and the stake stays in the vault.
  for (let attempt = 0; ; attempt++) {
    try {
      onStatus?.('Building block-zero bundle…')
      const { mint, createTx, vaultTx, mintKp } = await P.buildLaunchBundle(owner.toBase58(), vault.pub, { name: meta.name, symbol: meta.symbol, uri }, devBuySol, vaultBuySol, settings.slippageBps / 100, Math.max(settings.priorityFeeSol || 0, 0.003))
      // one fresh blockhash on both txs right before anyone signs, then the mint re-signs
      const bh = (await conn.getLatestBlockhash('confirmed')).blockhash; createTx.message.recentBlockhash = bh; vaultTx.message.recentBlockhash = bh; createTx.sign([mintKp])
      onStatus?.('Vault signing…')
      const signedVault = await K.withDevAuth(deps.signMsg, 'bundle', vault.id, mint, (auth) => deps.bundleSign(vault.id, mint, Buffer.from(vaultTx.serialize()).toString('base64'), vaultBuySol, Buffer.from(createTx.serialize()).toString('base64'), auth))
      onStatus?.('Sign the create…'); const signedCreate = await sign(createTx)
      const bundle = [Buffer.from(signedCreate.serialize()).toString('base64'), signedVault.tx]
      for (let i = 0; i < 3; i++) {
        let bundleId = ''
        try { onStatus?.(i ? `Resending bundle (${i + 1}/3)…` : 'Sending bundle…'); bundleId = (await deps.sendBundle(bundle)).bundleId }
        catch (e: any) { if (/blockhash|expired/i.test(String(e?.message || e))) throw new Error('blockhash expired — rebuilding'); if (i === 2) throw new Error('Jito is not taking the launch bundle right now — nothing launched, your stake is still in the vault. Press Create again in a minute.'); await new Promise((r) => setTimeout(r, 1200)); continue }
        try { onStatus?.('Confirming…'); await confirmOrDropped(conn, signedCreate, bundleId, 20000); return { sig: bs58.encode(signedCreate.signatures[0]), mint, bundled: true } }
        catch (e: any) { if (/blockhash|block height|expired|dropped/i.test(String(e?.message || e))) throw e }
      }
      try { onStatus?.('Checking if it landed…'); await confirmByPollingB58(conn, signedCreate, 35000); return { sig: bs58.encode(signedCreate.signatures[0]), mint, bundled: true } }
      catch { throw new Error('the launch bundle did not land — nothing launched, your stake is still in the vault. Press Create again.') }
    } catch (e: any) {
      if (attempt >= 2 || !/blockhash|block height exceeded|expired|dropped/i.test(String(e?.message || e))) throw e
      onStatus?.(/dropped/i.test(String(e?.message)) ? 'Jito dropped it — rebuilding, sign again…' : 'That took too long — rebuilding, sign again…')
    }
  }
}
/** wait for the create to land, but stop early when Jito itself reports the bundle Failed/Invalid (then the caller rebuilds instead of waiting out the clock) */
async function confirmOrDropped(conn: Connection, tx: VersionedTransaction, bundleId: string, ms: number) {
  const sig = bs58.encode(tx.signatures[0]); const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const st = (await conn.getSignatureStatuses([sig]).catch(() => null))?.value?.[0]
    if (st) { if (st.err) throw new Error('Transaction failed on-chain: ' + JSON.stringify(st.err)); if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return }
    // only Jito's explicit 'Failed' (never forwarded) after a few seconds counts as dropped — 'Invalid'/unknown can just mean another region has it.
    // One last look at the create's signature first, so a bundle that did land is never rebuilt into a second coin.
    if (bundleId && Date.now() - t0 > 6000) { const b = await K.bundleStatus(bundleId).catch(() => null)
      if (b && /^failed$/i.test(b.status)) { const again = (await conn.getSignatureStatuses([sig]).catch(() => null))?.value?.[0]; if (!again) throw new Error('bundle dropped by Jito (Failed) — rebuilding') } }
    await new Promise((r) => setTimeout(r, 1200))
  }
  throw new Error('Confirmation timed out')
}
async function confirmByPollingB58(conn: Connection, tx: VersionedTransaction, ms = 60000) { const { confirmByPolling } = await import('./rpc'); await confirmByPolling(conn, bs58.encode(tx.signatures[0]), ms) }

/** Launch on OUR launchpad (Raydium LaunchLab under our platform config): the server builds create(+dev buy) for the dev to sign and, with a vault, the vault's
 *  block-zero buy already keeper-signed. Both go out as one Jito bundle — never a plain fallback that would put the coin live without the vault buy.
 *  fundInBundle (one-signature launch): the stake is not sent ahead; the server puts the dev → vault transfer inside the create tx itself, so the
 *  wallet signs once and a launch that doesn't land costs nothing. Every trade on the coin pays the platform fee into the chest from the first block. */
export type LaunchDeps = { sendBundle: (txs: string[]) => Promise<{ bundleId: string }>; signMsg?: (m: Uint8Array) => Promise<Uint8Array>; permTax?: boolean; fundInBundle?: boolean; uri?: Promise<string> | string; venue?: 'launchlab' | 'pump' }
export type LaunchOut = { sig: string; mint: string; bundled: boolean; already?: boolean; fundSol?: number }
export async function launchOurs(ctx: Ctx, meta: P.CreateMeta, devBuySol: number, vault: { id: string } | null, vaultBuySol: number, deps: LaunchDeps): Promise<LaunchOut> {
  const { onStatus } = ctx
  onStatus?.('Uploading metadata…'); const uri = deps.uri ? await deps.uri : await P.uploadMetadata(meta, SERVER)
  // the launch txs carry the server's blockhash (they are pre-signed by the mint and the vault), so slow wallet signing can outlive it: rebuild and sign again
  for (let attempt = 0; ; attempt++) {
    try { return await launchOursOnce(ctx, meta, uri, devBuySol, vault, vaultBuySol, deps) }
    catch (e: any) {
      const m = String(e?.message || e)
      // a retry after a launch that landed late: the server refuses a second coin for the same chest and names the live one
      const live = m.match(/already live: ([1-9A-HJ-NP-Za-km-z]{32,44})/); if (live) return { sig: '', mint: live[1], bundled: true, already: true }
      if (attempt >= 2 || !/blockhash|block height exceeded|expired|dropped/i.test(m)) throw e; onStatus?.(/dropped/i.test(m) ? 'Jito dropped it — rebuilding, sign again…' : 'That took too long — rebuilding, sign again…') }
  }
}
async function launchOursOnce(ctx: Ctx, meta: P.CreateMeta, uri: string, devBuySol: number, vault: { id: string } | null, vaultBuySol: number, deps: LaunchDeps): Promise<LaunchOut> {
  const { conn, owner, sign, onStatus } = ctx
  onStatus?.('Building launch…')
  const req = (auth?: K.DevAuth): K.LaunchBuildReq => ({ dev: owner.toBase58(), name: meta.name, symbol: meta.symbol, uri, devBuySol, vaultId: vault?.id, vaultBuySol, auth, permTax: !!deps.permTax, fundInBundle: !!deps.fundInBundle })
  const b = await K.withDevAuth(vault ? deps.signMsg : undefined, 'launch', vault?.id || '', owner.toBase58(), (auth) => deps.venue === 'pump' ? K.pumpLaunchBuild(req(auth)) : K.llLaunchBuild(req(auth)))
  const left = b.fundSol ? 'nothing was spent' : 'your stake is still in the vault'
  const txs = b.txs.map((x) => VersionedTransaction.deserialize(Buffer.from(x, 'base64')))
  onStatus?.(b.fundSol ? `Sign once: launch + ${(+b.fundSol).toFixed(2)} SOL stake…` : txs.length > 1 ? `Sign ${txs.length} transactions…` : 'Sign the create…')
  const signed: VersionedTransaction[] = []; for (const t of txs) signed.push(await sign(t))
  const sig = bs58.encode(signed[0].signatures[0])
  if (b.vaultTx) {
    // the vault's block-zero buy only exists inside the bundle: never fall back to a plain launch that would put the coin live without it
    const bundle = [...signed.map((t) => Buffer.from(t.serialize()).toString('base64')), b.vaultTx]
    for (let i = 0; i < 3; i++) {
      let bundleId = ''
      try { onStatus?.(i ? `Resending bundle (${i + 1}/3)…` : 'Sending bundle…'); bundleId = (await deps.sendBundle(bundle)).bundleId }
      catch (e: any) { if (/blockhash|expired/i.test(String(e?.message || e))) throw new Error('blockhash expired — rebuilding'); if (i === 2) throw new Error(`Jito is not taking the launch bundle right now — nothing launched, ${left}. Press Create again in a minute.`); await new Promise((r) => setTimeout(r, 1200)); continue }
      try { onStatus?.('Landing in block zero…'); await confirmOrDropped(conn, signed[0], bundleId, 20000); return { sig, mint: b.mint, bundled: true, fundSol: b.fundSol } }
      catch (e: any) { if (/blockhash|block height|expired|dropped/i.test(String(e?.message || e))) throw e }
    }
    // last look before saying nothing launched: a bundle can land in the final slots of its blockhash
    try { onStatus?.('Checking if it landed…'); await confirmByPollingB58(conn, signed[0], 35000); return { sig, mint: b.mint, bundled: true, fundSol: b.fundSol } }
    catch { throw new Error(`the launch bundle did not land — nothing launched, ${left}. Press Create again.`) }
  }
  for (const t of signed) { const s2 = await conn.sendRawTransaction(t.serialize(), { skipPreflight: false, maxRetries: 3 }); await confirmByPollingB58(conn, t); void s2 }
  return { sig, mint: b.mint, bundled: false, fundSol: b.fundSol }
}
