// PumpPortal's wrapper buy → pump's own buy (launch.ts directPumpBuy): the chest's block-zero buy on pump launches
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, PublicKey, SystemProgram, TransactionMessage, TransactionInstruction, VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
const L = await import('../src/launch.ts')

const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'), FEEP = new PublicKey(L.PUMP_FEE_PROGRAM), WRAP = new PublicKey(L.PUMPPORTAL_PROGRAM)
const pda = (seeds, prog = PUMP) => PublicKey.findProgramAddressSync(seeds, prog)[0]
const vault = Keypair.generate().publicKey, dev = Keypair.generate().publicKey, mint = Keypair.generate().publicKey
const feeRec = Keypair.generate().publicKey, buyback = Keypair.generate().publicKey, ppFee = Keypair.generate().publicKey
const bc = pda([Buffer.from('bonding-curve'), mint.toBuffer()]), T = TOKEN_2022_PROGRAM_ID
// a pump Global account: fee_recipient @41, fee_recipients[7] @162, buyback_fee_recipients[8] @741 (1088 bytes)
const feeRec2 = Keypair.generate().publicKey, bb1 = Keypair.generate().publicKey, bb2 = Keypair.generate().publicKey
const GLOBAL = Buffer.alloc(1088); feeRec2.toBuffer().copy(GLOBAL, 41); feeRec.toBuffer().copy(GLOBAL, 162 + 32 * 3); bb1.toBuffer().copy(GLOBAL, 741); bb2.toBuffer().copy(GLOBAL, 741 + 32)
function wrapperTx({ swap } = {}) {
  const keys = [[pda([Buffer.from('global')]), 0], [feeRec, 1], [mint, 0], [bc, 1], [getAssociatedTokenAddressSync(mint, bc, true, T), 1], [getAssociatedTokenAddressSync(mint, vault, true, T), 1], [vault, 1, 1],
    [SystemProgram.programId, 0], [T, 0], [pda([Buffer.from('creator-vault'), dev.toBuffer()]), 1], [pda([Buffer.from('__event_authority')]), 0], [PUMP, 0], [pda([Buffer.from('global_volume_accumulator')]), 0],
    [pda([Buffer.from('user_volume_accumulator'), vault.toBuffer()]), 1], [pda([Buffer.from('fee_config'), PUMP.toBuffer()], FEEP), 0], [FEEP, 0], [pda([Buffer.from('bonding-curve-v2'), mint.toBuffer()]), 1], [ppFee, 1], [bb2, 1]]
    .map(([pubkey, w, s]) => ({ pubkey, isWritable: !!w, isSigner: !!s }))
  if (swap) swap(keys)
  const data = Buffer.alloc(26); Buffer.from(L.DISC.pp_buy, 'hex').copy(data); data.writeBigUInt64LE(3552950720606n, 8); data.writeBigUInt64LE(303000000n, 16); data[24] = 0x32
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 170000 }), createAssociatedTokenAccountIdempotentInstruction(vault, getAssociatedTokenAddressSync(mint, vault, true, T), vault, mint, T), new TransactionInstruction({ programId: WRAP, keys, data })]
  return new VersionedTransaction(new TransactionMessage({ payerKey: vault, recentBlockhash: '11111111111111111111111111111111', instructions: ixs }).compileToV0Message())
}

test('the wrapper buy becomes pump\'s own buy: same accounts minus PumpPortal\'s fee wallet, same amount and ceiling', () => {
  const d = L.directPumpBuy(wrapperTx(), [], mint.toBase58(), vault.toBase58(), dev.toBase58(), GLOBAL)
  assert.ok(d.tx, d.why)
  const keys = d.tx.message.staticAccountKeys.map((k) => k.toBase58())
  assert.ok(!keys.includes(WRAP.toBase58()), 'wrapper program gone'); assert.ok(!keys.includes(ppFee.toBase58()), 'PumpPortal fee wallet gone')
  const b = L.inspectBuy(d.tx, vault.toBase58(), mint.toBase58(), 6)
  assert.equal(b.via, 'pump'); assert.equal(b.tokens, 3552950.720606); assert.equal(b.maxSolCost, 0.303); assert.deepEqual(b.ixs, ['compute', 'ata', 'buy'])
  const ix = d.tx.message.compiledInstructions.find((x) => keys[x.programIdIndex] === PUMP.toBase58())
  assert.equal(ix.accountKeyIndexes.length, 18); assert.equal(Buffer.from(ix.data).toString('hex').slice(48), '0100')   // track_volume Some(true), partial_fill Some(false)
  // fee recipient: the wrapper's one is in Global's list → kept; buyback: the wrapper's trailing account that Global lists (bb2), never PumpPortal's own
  assert.equal(keys[ix.accountKeyIndexes[1]], feeRec.toBase58()); assert.equal(keys[ix.accountKeyIndexes[17]], bb2.toBase58())
  // the vault is the only signer and the ceiling can still be tightened in place
  assert.equal(d.tx.message.header.numRequiredSignatures, 1)
  assert.ok(L.setMaxSolCost(d.tx, 0.12)); assert.equal(L.inspectBuy(d.tx, vault.toBase58(), mint.toBase58(), 6).maxSolCost, 0.12)
})
test('recipients come from pump\'s Global, not from the wrapper', () => {
  const stranger = Keypair.generate().publicKey
  const d = L.directPumpBuy(wrapperTx({ swap: (k) => { k[1].pubkey = stranger; k.splice(17) } }), [], mint.toBase58(), vault.toBase58(), dev.toBase58(), GLOBAL); assert.ok(d.tx, d.why)
  const keys = d.tx.message.staticAccountKeys.map((k) => k.toBase58()); const ix = d.tx.message.compiledInstructions.find((x) => keys[x.programIdIndex] === PUMP.toBase58())
  assert.equal(keys[ix.accountKeyIndexes[1]], feeRec2.toBase58())                                         // not listed → Global's fee_recipient
  assert.ok([bb1.toBase58(), bb2.toBase58()].includes(keys[ix.accountKeyIndexes[17]]))                   // none offered → one of Global's buyback list
  assert.ok(!keys.includes(stranger.toBase58()))
  assert.match(L.directPumpBuy(wrapperTx(), [], mint.toBase58(), vault.toBase58(), dev.toBase58(), Buffer.alloc(1088)).why, /no fee \/ buyback/)
})
test('anything that is not the shape we derived keeps the wrapper (null + why)', () => {
  const thief = Keypair.generate().publicKey
  assert.match(L.directPumpBuy(wrapperTx({ swap: (k) => { k[9].pubkey = thief } }), [], mint.toBase58(), vault.toBase58(), dev.toBase58(), GLOBAL).why, /account 9/)       // creator vault not the dev's
  assert.match(L.directPumpBuy(wrapperTx({ swap: (k) => { k[13].pubkey = thief } }), [], mint.toBase58(), vault.toBase58(), dev.toBase58(), GLOBAL).why, /account 13/)     // someone else's volume accumulator
    assert.match(L.directPumpBuy(wrapperTx({ swap: (k) => { k[8].pubkey = SystemProgram.programId } }), [], mint.toBase58(), vault.toBase58(), dev.toBase58(), GLOBAL).why, /token program/)
  assert.match(L.directPumpBuy(wrapperTx({ swap: (k) => { k.splice(15) } }), [], mint.toBase58(), vault.toBase58(), dev.toBase58(), GLOBAL).why, /wrapper shape/)
  assert.match(L.directPumpBuy(wrapperTx(), [], Keypair.generate().publicKey.toBase58(), vault.toBase58(), dev.toBase58(), GLOBAL).why, /account 2/)                        // a different mint
})
