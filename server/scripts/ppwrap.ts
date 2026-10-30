// Read-only probe: how PumpPortal's wrapper buy (the chest's block-zero buy on pump launches) maps onto pump's own `buy`, and whether a direct
// pump buy built from our own account list simulates right after a create in the same tx (the state a Jito bundle gives the second tx).
// Nothing is signed or sent. Run in CI (probe branch) — needs a mainnet RPC.
import { Connection, PublicKey, VersionedTransaction, TransactionMessage, TransactionInstruction, Keypair, SystemProgram } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import bs58 from 'bs58'
import { resolveKeys } from '../src/launch.ts'

const RPC = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com'
const conn = new Connection(RPC, 'confirmed')
const PAYER = new PublicKey(process.env.PREFLIGHT_PAYER || '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9')
const PP = (process.env.PUMPPORTAL_URL || 'https://pumpportal.fun/api') + '/trade-local'
const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'), FEEP = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ'), WRAP = 'FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe'
const BUYBACK = ['5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD', '9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7', 'GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL', '3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR', '5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6', 'EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL', '5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD']
const pda = (seeds: (Buffer | Uint8Array)[], prog = PUMP) => PublicKey.findProgramAddressSync(seeds, prog)[0]
const log = (...a: any[]) => console.log('[ppwrap]', ...a)

const mintKp = Keypair.generate(); const mint = mintKp.publicKey
const body = [
  { publicKey: PAYER.toBase58(), action: 'create', tokenMetadata: { name: 'probe', symbol: 'PRB', uri: 'https://ipfs.io/ipfs/bafkreigh2akiscaildc' }, mint: mint.toBase58(), denominatedInSol: 'true', amount: 0.05, slippage: 10, priorityFee: 0.0005, pool: 'pump' },
  { publicKey: PAYER.toBase58(), action: 'buy', mint: mint.toBase58(), denominatedInSol: 'true', amount: 0.1, slippage: 10, priorityFee: 0.00005, pool: 'pump' },
]
const r = await fetch(PP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
if (!r.ok) { log('pumpportal HTTP', r.status, (await r.text()).slice(0, 200)); process.exit(0) }
const [t0, t1] = ((await r.json()) as string[]).map((e) => VersionedTransaction.deserialize(bs58.decode(e)))
const k0 = await resolveKeys(t0, conn), k1 = await resolveKeys(t1, conn)
// the create: which token program, who the creator is
const createIx = t0.message.compiledInstructions.find((ix) => k0[ix.programIdIndex] === PUMP.toBase58() && Buffer.from(ix.data.subarray(0, 8)).toString('hex') === 'd6904cec5f8b31b4')
const tokenProgram = createIx && createIx.accountKeyIndexes.map((i) => k0[i]).includes(TOKEN_2022_PROGRAM_ID.toBase58()) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
log('create', createIx ? 'create_v2' : 'NOT FOUND', 'token program', tokenProgram.toBase58().slice(0, 6), 'create accounts', createIx?.accountKeyIndexes.length)
const bc = pda([Buffer.from('bonding-curve'), mint.toBuffer()])
const labels: Record<string, string> = {
  [pda([Buffer.from('global')])]: 'global', [mint.toBase58()]: 'mint', [bc.toBase58()]: 'bonding_curve',
  [getAssociatedTokenAddressSync(mint, bc, true, tokenProgram).toBase58()]: 'associated_bonding_curve',
  [getAssociatedTokenAddressSync(mint, PAYER, true, tokenProgram).toBase58()]: 'associated_user', [PAYER.toBase58()]: 'user',
  '11111111111111111111111111111111': 'system_program', [tokenProgram.toBase58()]: 'token_program',
  [pda([Buffer.from('creator-vault'), PAYER.toBuffer()]).toBase58()]: 'creator_vault(creator=payer)',
  [pda([Buffer.from('__event_authority')]).toBase58()]: 'event_authority', [PUMP.toBase58()]: 'pump_program',
  [pda([Buffer.from('global_volume_accumulator')]).toBase58()]: 'global_volume_accumulator',
  [pda([Buffer.from('user_volume_accumulator'), PAYER.toBuffer()]).toBase58()]: 'user_volume_accumulator',
  [pda([Buffer.from('fee_config'), PUMP.toBuffer()], FEEP).toBase58()]: 'fee_config', [FEEP.toBase58()]: 'fee_program',
  [pda([Buffer.from('bonding-curve-v2'), mint.toBuffer()]).toBase58()]: 'bonding_curve_v2', [WRAP]: 'pumpportal_wrapper',
}
for (const b of BUYBACK) labels[b] = 'buyback_fee_recipient'
const msg = t1.message; const isW = (i: number) => msg.isAccountWritable(i), isS = (i: number) => msg.isAccountSigner(i)
for (const ix of msg.compiledInstructions) {
  const prog = k1[ix.programIdIndex]; log('ix', prog.slice(0, 8), 'data', Buffer.from(ix.data).toString('hex'), 'accounts', ix.accountKeyIndexes.length)
  if (prog === WRAP) ix.accountKeyIndexes.forEach((i, n) => log(`   ${String(n).padStart(2)} ${k1[i]} ${isW(i) ? 'W' : '-'}${isS(i) ? 'S' : '-'} ${labels[k1[i]] || '?'}`))
}
// global: fee_recipient at 8 + 1 (initialized) + 32 (authority)
const gi = await conn.getAccountInfo(pda([Buffer.from('global')])); const feeRecipient = new PublicKey(gi!.data.subarray(41, 73))
log('global.fee_recipient', feeRecipient.toBase58(), 'global len', gi!.data.length)
const wrapIx = msg.compiledInstructions.find((ix) => k1[ix.programIdIndex] === WRAP)!
const wd = Buffer.from(wrapIx.data); const amount = wd.readBigUInt64LE(8), maxSol = wd.readBigUInt64LE(16)
const wrapAccts = wrapIx.accountKeyIndexes.map((i) => k1[i]); const fr = wrapAccts.find((a) => !labels[a] && a !== feeRecipient.toBase58())
log('wrapper amount', amount, 'max_sol_cost', maxSol, 'unlabelled accounts', wrapAccts.filter((a) => !labels[a]).join(','))

// a direct pump buy, accounts in the IDL's order + the remaining accounts the official SDK adds (bonding_curve_v2, a buyback fee recipient)
function directBuy(feeRec: PublicKey, buyback: PublicKey, withRemaining = true) {
  const keys = [
    [pda([Buffer.from('global')]), false], [feeRec, true], [mint, false], [bc, true], [getAssociatedTokenAddressSync(mint, bc, true, tokenProgram), true],
    [getAssociatedTokenAddressSync(mint, PAYER, true, tokenProgram), true], [PAYER, true, true], [SystemProgram.programId, false], [tokenProgram, false],
    [pda([Buffer.from('creator-vault'), PAYER.toBuffer()]), true], [pda([Buffer.from('__event_authority')]), false], [PUMP, false],
    [pda([Buffer.from('global_volume_accumulator')]), false], [pda([Buffer.from('user_volume_accumulator'), PAYER.toBuffer()]), true],
    [pda([Buffer.from('fee_config'), PUMP.toBuffer()], FEEP), false], [FEEP, false],
    ...(withRemaining ? [[pda([Buffer.from('bonding-curve-v2'), mint.toBuffer()]), false], [buyback, true]] : []),
  ].map(([pubkey, w, s]: any) => ({ pubkey, isWritable: !!w, isSigner: !!s }))
  const data = Buffer.alloc(26); Buffer.from('66063d1201daebea', 'hex').copy(data, 0); data.writeBigUInt64LE(amount, 8); data.writeBigUInt64LE(maxSol, 16); data[24] = 1; data[25] = 0
  return new TransactionInstruction({ programId: PUMP, keys, data })
}
const alts = (await Promise.all([...(t0.message.addressTableLookups || []), ...(t1.message.addressTableLookups || [])].map((l) => conn.getAddressLookupTable(l.accountKey)))).map((x) => x.value!).filter(Boolean)
const m0 = TransactionMessage.decompile(t0.message, { addressLookupTableAccounts: alts })
for (const [label, ix] of [['direct buy, SDK remaining accounts', directBuy(feeRecipient, new PublicKey(BUYBACK[0]))], ['direct buy, no remaining accounts', directBuy(feeRecipient, new PublicKey(BUYBACK[0]), false)], ...(fr ? [['direct buy, wrapper\'s fee recipient ' + fr.slice(0, 6), directBuy(new PublicKey(fr), new PublicKey(BUYBACK[0]))]] : [])] as [string, TransactionInstruction][]) {
  try {
    const m = new TransactionMessage({ payerKey: m0.payerKey, recentBlockhash: m0.recentBlockhash, instructions: [...m0.instructions, createAssociatedTokenAccountIdempotentInstruction(PAYER, getAssociatedTokenAddressSync(mint, PAYER, true, tokenProgram), PAYER, mint, tokenProgram), ix] })
    const tx = new VersionedTransaction(m.compileToV0Message(alts)); const size = tx.serialize().length
    const s = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, innerInstructions: true })
    log(label, '· size', size, '· err', JSON.stringify(s.value.err), '· CU', s.value.unitsConsumed, '·', (s.value.logs || []).filter((l) => /Error|error|failed|Program log: Instruction/.test(l)).slice(-6).join(' | '))
  } catch (e: any) { log(label, 'build/sim threw', String(e.message).slice(0, 200)) }
}
// the wrapper path in the same combined form, for comparison
try {
  const m1 = TransactionMessage.decompile(t1.message, { addressLookupTableAccounts: alts })
  const m = new TransactionMessage({ payerKey: m0.payerKey, recentBlockhash: m0.recentBlockhash, instructions: [...m0.instructions, ...m1.instructions.filter((ix) => !ix.programId.equals(new PublicKey('ComputeBudget111111111111111111111111111111')))] })
  const tx = new VersionedTransaction(m.compileToV0Message(alts))
  const s = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true })
  log('wrapper buy (combined) · size', tx.serialize().length, '· err', JSON.stringify(s.value.err), '· CU', s.value.unitsConsumed)
} catch (e: any) { log('wrapper combined threw', String(e.message).slice(0, 200)) }
