// Launch path: exact pump.fun block-zero math + a strict inspector for the vault's block-zero buy before the keeper signs it.
// Why: in the bundle [create+dev buy, vault buy] the vault tx is built by PumpPortal from numbers the CLIENT sent. The server
// must not trust them — it decodes the buy instruction and refuses anything that could cost more than policy allows, calls a
// program it doesn't expect, or moves SOL anywhere but the curve (and the Jito tip account).
import { PublicKey, VersionedTransaction, SystemProgram, ComputeBudgetProgram } from '@solana/web3.js'
import { PUMP_PROGRAM } from './pool.ts'

// pump.fun bonding curve at creation (mainnet global config): virtual 30 SOL × 1.073e9 tokens, 1e9 total supply, ~793.1M tokens on the curve.
export const CURVE0 = { vSol: 30, vTok: 1_073_000_000, supply: 1_000_000_000, feeBps: 100 }
export type CurveState = { vSol: number; vTok: number }
/** tokens out for `sol` in at `s` (fee taken from the SOL side), and the state after */
export function curveBuy(s: CurveState, sol: number, feeBps = CURVE0.feeBps) {
  const net = sol * (1 - feeBps / 1e4); const k = s.vSol * s.vTok
  const vSol = s.vSol + net; const vTok = k / vSol; const tokens = s.vTok - vTok
  return { tokens, after: { vSol, vTok }, price: vSol / vTok }
}
/** Block zero for a launch: dev buys first (inside the create tx), the vault buys second in the same Jito bundle. */
export function blockZero(devSol: number, vaultSol: number) {
  const s0 = { vSol: CURVE0.vSol, vTok: CURVE0.vTok }
  const dev = curveBuy(s0, devSol); const vault = curveBuy(dev.after, vaultSol)
  const price = vault.after.vSol / vault.after.vTok
  return { devTokens: dev.tokens, vaultTokens: vault.tokens, devPct: dev.tokens / CURVE0.supply * 100, vaultPct: vault.tokens / CURVE0.supply * 100, priceSol: price, mcapSol: price * CURVE0.supply, vaultAvgCost: vaultSol / vault.tokens }
}

const DISC_BUY = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234])
const DISC_CREATE = Buffer.from([24, 30, 200, 40, 5, 28, 7, 119])
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
export const JITO_TIPS = ['96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5', 'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe', 'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY', 'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49', 'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh', 'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt', 'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL', '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT']

export type BuyInspect = { tokens: number; maxSolCost: number; tipSol: number; solOut: number; ixs: string[] }
/** Decode every instruction of a pump buy tx. Throws on anything outside the expected shape. `solOut` = max SOL the tx can take from the payer (max_sol_cost + tip). */
export function inspectBuy(tx: VersionedTransaction, payer: string, mint: string, tokenDecimals = 6): BuyInspect {
  const msg = tx.message
  if (msg.header.numRequiredSignatures !== 1) throw new Error(`expected 1 signer, tx wants ${msg.header.numRequiredSignatures}`)
  if (msg.addressTableLookups?.length) throw new Error('lookup tables not allowed in a vault buy')
  const keys = msg.staticAccountKeys.map((k) => k.toBase58())
  if (keys[0] !== payer) throw new Error('fee payer is not the vault')
  let buy: { tokens: number; maxSolCost: number } | null = null, tip = 0; const ixs: string[] = []
  for (const ix of msg.compiledInstructions) {
    const prog = keys[ix.programIdIndex]; const data = Buffer.from(ix.data)
    if (prog === ComputeBudgetProgram.programId.toBase58()) { ixs.push('compute'); continue }
    if (prog === ATA_PROGRAM) { ixs.push('ata'); continue }
    if (prog === SystemProgram.programId.toBase58()) {
      if (data.readUInt32LE(0) !== 2) throw new Error('system instruction other than transfer')
      const to = keys[ix.accountKeyIndexes[1]]; const lamports = Number(data.readBigUInt64LE(4))
      if (!JITO_TIPS.includes(to)) throw new Error('SOL transfer to a non-tip account: ' + to)
      tip += lamports / 1e9; ixs.push('tip'); continue
    }
    if (prog === PUMP_PROGRAM.toBase58()) {
      if (DISC_CREATE.equals(data.subarray(0, 8))) throw new Error('vault tx must not create the coin')
      if (!DISC_BUY.equals(data.subarray(0, 8))) throw new Error('unexpected pump instruction')
      if (buy) throw new Error('two buys in one tx')
      const mintKey = keys[ix.accountKeyIndexes[2]]; if (mintKey !== mint) throw new Error('buy is for a different mint')
      const user = keys[ix.accountKeyIndexes[6]]; if (user !== payer) throw new Error('buy credits a different wallet')
      buy = { tokens: Number(data.readBigUInt64LE(8)) / 10 ** tokenDecimals, maxSolCost: Number(data.readBigUInt64LE(16)) / 1e9 }; ixs.push('buy'); continue
    }
    throw new Error('unexpected program ' + prog)
  }
  if (!buy) throw new Error('no pump buy instruction')
  return { ...buy, tipSol: tip, solOut: buy.maxSolCost + tip, ixs }
}
/** Decode the dev side of a create(+buy) tx: the mint it creates and the dev buy, if any. */
export function inspectCreate(tx: VersionedTransaction, mint: string, tokenDecimals = 6) {
  const msg = tx.message; const keys = msg.staticAccountKeys.map((k) => k.toBase58())
  let created = false, buy: { tokens: number; maxSolCost: number } | null = null, tip = 0
  for (const ix of msg.compiledInstructions) {
    const prog = keys[ix.programIdIndex]; const data = Buffer.from(ix.data)
    if (prog === PUMP_PROGRAM.toBase58()) {
      if (DISC_CREATE.equals(data.subarray(0, 8))) { if (keys[ix.accountKeyIndexes[0]] !== mint) throw new Error('create is for a different mint'); created = true }
      else if (DISC_BUY.equals(data.subarray(0, 8))) buy = { tokens: Number(data.readBigUInt64LE(8)) / 10 ** tokenDecimals, maxSolCost: Number(data.readBigUInt64LE(16)) / 1e9 }
    } else if (prog === SystemProgram.programId.toBase58() && data.readUInt32LE(0) === 2 && JITO_TIPS.includes(keys[ix.accountKeyIndexes[1]])) tip += Number(data.readBigUInt64LE(4)) / 1e9
  }
  if (!created) throw new Error('no create instruction')
  return { created, buy, tipSol: tip, signers: msg.header.numRequiredSignatures }
}
