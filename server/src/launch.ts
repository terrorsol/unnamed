// Launch path: exact pump.fun block-zero math + a strict inspector for the vault's block-zero buy before the keeper signs it.
// Why: in the bundle [create+dev buy, vault buy] the vault tx is built by PumpPortal from numbers the CLIENT sent. The server
// must not trust them — it decodes the buy instruction and refuses anything that could cost more than policy allows, calls a
// program it doesn't expect, or moves SOL anywhere but the curve (and the Jito tip account).
// Shapes seen on mainnet (CI preflight, reports-preflight/launch-bundle.json): v0 txs with one lookup table; create = pump `create_v2`;
// the buy is routed through PumpPortal's wrapper program (their 0.5% fee), data = disc(8) + amount u64 + max_sol_cost u64, same as pump `buy`.
import { Connection, PublicKey, VersionedTransaction, SystemProgram, ComputeBudgetProgram } from '@solana/web3.js'
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

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
export const DISC = {
  buy: '66063d1201daebea',            // pump `buy`
  create: '181ec828051c0777',         // pump `create`
  create_v2: 'd6904cec5f8b31b4',      // pump `create_v2` (what PumpPortal builds today)
  pp_buy: '66323d1201daebea',         // PumpPortal wrapper buy (CPI into pump buy; same u64 amount + u64 max_sol_cost)
}
/** programs allowed to appear in a vault buy */
export const PUMPPORTAL_PROGRAM = 'FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe'
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
export const JITO_TIPS = ['96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5', 'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe', 'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY', 'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49', 'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh', 'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt', 'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL', '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT']

/** Full account list of a v0 tx: static keys, then every lookup table's writable and readonly entries, in message order. */
export async function resolveKeys(tx: VersionedTransaction, conn: Connection): Promise<string[]> {
  const msg = tx.message; const keys = msg.staticAccountKeys.map((k) => k.toBase58())
  const lookups = msg.version === 0 ? msg.addressTableLookups : []
  if (!lookups.length) return keys
  const tables = await Promise.all(lookups.map((l) => conn.getAddressLookupTable(l.accountKey).then((r) => r.value?.state.addresses.map((a) => a.toBase58()) || [])))
  const w: string[] = [], r: string[] = []
  lookups.forEach((l, i) => { for (const idx of l.writableIndexes) w.push(tables[i][idx] || `alt${i}:${idx}`); for (const idx of l.readonlyIndexes) r.push(tables[i][idx] || `alt${i}:${idx}`) })
  return [...keys, ...w, ...r]
}
const staticKeys = (tx: VersionedTransaction) => tx.message.staticAccountKeys.map((k) => k.toBase58())

export type BuyInspect = { tokens: number; maxSolCost: number; tipSol: number; solOut: number; ixs: string[]; via: 'pump' | 'pumpportal' }
/** Decode every instruction of a pump buy tx. Throws on anything outside the expected shape. `solOut` = max SOL the tx can take from the payer (max_sol_cost + tip). `keys` from resolveKeys when the tx uses lookup tables. */
export function inspectBuy(tx: VersionedTransaction, payer: string, mint: string, tokenDecimals = 6, keys = staticKeys(tx)): BuyInspect {
  const msg = tx.message
  if (msg.header.numRequiredSignatures !== 1) throw new Error(`expected 1 signer, tx wants ${msg.header.numRequiredSignatures}`)
  if (keys[0] !== payer) throw new Error('fee payer is not the vault')
  let buy: { tokens: number; maxSolCost: number; via: 'pump' | 'pumpportal' } | null = null, tip = 0; const ixs: string[] = []
  for (const ix of msg.compiledInstructions) {
    const prog = keys[ix.programIdIndex]; const data = Buffer.from(ix.data); const accts = ix.accountKeyIndexes.map((i) => keys[i])
    if (!prog || prog.startsWith('alt')) throw new Error('program id not resolvable (lookup table)')
    if (prog === ComputeBudgetProgram.programId.toBase58()) { ixs.push('compute'); continue }
    if (prog === ATA_PROGRAM) { ixs.push('ata'); continue }
    if (prog === SystemProgram.programId.toBase58()) {
      if (data.readUInt32LE(0) !== 2) throw new Error('system instruction other than transfer')
      const to = accts[1]; const lamports = Number(data.readBigUInt64LE(4))
      if (!JITO_TIPS.includes(to)) throw new Error('SOL transfer to a non-tip account: ' + to)
      tip += lamports / 1e9; ixs.push('tip'); continue
    }
    if (prog === PUMP_PROGRAM.toBase58() || prog === PUMPPORTAL_PROGRAM) {
      const d = hex(data.subarray(0, 8))
      if (d === DISC.create || d === DISC.create_v2) throw new Error('vault tx must not create the coin')
      if (d !== DISC.buy && d !== DISC.pp_buy) throw new Error('unexpected instruction ' + d + ' on ' + prog.slice(0, 6))
      if (buy) throw new Error('two buys in one tx')
      if (!accts.includes(mint)) throw new Error('buy does not reference the mint')
      if (!accts.includes(payer)) throw new Error('buy does not involve the vault wallet')
      if (data.length < 24) throw new Error('buy data too short')
      buy = { tokens: Number(data.readBigUInt64LE(8)) / 10 ** tokenDecimals, maxSolCost: Number(data.readBigUInt64LE(16)) / 1e9, via: prog === PUMPPORTAL_PROGRAM ? 'pumpportal' : 'pump' }; ixs.push('buy'); continue
    }
    throw new Error('unexpected program ' + prog)
  }
  if (!buy) throw new Error('no pump buy instruction')
  if (!(buy.maxSolCost > 0) || !(buy.tokens > 0)) throw new Error('buy with zero amount')
  return { tokens: buy.tokens, maxSolCost: buy.maxSolCost, via: buy.via, tipSol: tip, solOut: buy.maxSolCost * 1.005 + tip, ixs }
}
/** Decode the dev side of a create(+buy) tx: the mint it creates and the dev buy, if any. */
export function inspectCreate(tx: VersionedTransaction, mint: string, tokenDecimals = 6, keys = staticKeys(tx)) {
  const msg = tx.message
  let created: string | null = null, buy: { tokens: number; maxSolCost: number } | null = null, tip = 0; const seen: string[] = []
  for (const ix of msg.compiledInstructions) {
    const prog = keys[ix.programIdIndex]; const data = Buffer.from(ix.data); const accts = ix.accountKeyIndexes.map((i) => keys[i]); const d = hex(data.subarray(0, 8))
    seen.push(`${(prog || 'alt?').slice(0, 6)}:${d}:${accts.length}`)
    if (prog === PUMP_PROGRAM.toBase58() && (d === DISC.create || d === DISC.create_v2)) { if (!accts.includes(mint)) throw new Error('create is for a different mint'); created = d === DISC.create ? 'create' : 'create_v2' }
    else if ((prog === PUMP_PROGRAM.toBase58() || prog === PUMPPORTAL_PROGRAM) && (d === DISC.buy || d === DISC.pp_buy) && data.length >= 24) buy = { tokens: Number(data.readBigUInt64LE(8)) / 10 ** tokenDecimals, maxSolCost: Number(data.readBigUInt64LE(16)) / 1e9 }
    else if (prog === SystemProgram.programId.toBase58() && data.length >= 12 && data.readUInt32LE(0) === 2 && JITO_TIPS.includes(accts[1])) tip += Number(data.readBigUInt64LE(4)) / 1e9
  }
  if (!created) throw new Error(`no create instruction · v${String(msg.version)} alts=${msg.version === 0 ? msg.addressTableLookups.length : 0} ixs=${seen.join(' ')}`)
  return { created, buy, tipSol: tip, signers: msg.header.numRequiredSignatures, seen }
}
