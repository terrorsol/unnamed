// Structural verification of a desk fill transaction. Both server and bidder client run this logic
// (client copy in app/src/lib/desk.ts) so neither side trusts the other's numbers.
import { Transaction, SystemProgram, PublicKey, SystemInstruction } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
export type Expect = { mint: string; seller: string; bidder: string; treasury: string; base: bigint; sellerLamports: bigint; fee: bigint; tokenProgram: string; decimals: number }
export function verifyFill(tx: Transaction, e: Expect): string | null {
  const ix = tx.instructions
  if (ix.length !== 4) return 'wrong instruction count'
  if (!tx.feePayer || tx.feePayer.toBase58() !== e.seller) return 'fee payer must be seller'
  const bidder = new PublicKey(e.bidder), seller = new PublicKey(e.seller), mint = new PublicKey(e.mint)
  const prog = new PublicKey(e.tokenProgram); if (!prog.equals(TOKEN_PROGRAM_ID) && !prog.equals(TOKEN_2022_PROGRAM_ID)) return 'unknown token program'
  const bAta = getAssociatedTokenAddressSync(mint, bidder, true, prog), sAta = getAssociatedTokenAddressSync(mint, seller, true, prog)
  // 0: create bidder ATA (idempotent), paid by seller, for the mint's token program
  const a = ix[0]; if (!a.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) || a.data[0] !== 1) return 'ix0 not create-ata-idempotent'
  if (!a.keys[0].pubkey.equals(seller) || !a.keys[1].pubkey.equals(bAta) || !a.keys[2].pubkey.equals(bidder) || !a.keys[3].pubkey.equals(mint) || !a.keys[5].pubkey.equals(prog)) return 'ix0 wrong accounts'
  // 1: TransferChecked seller → bidder (works for SPL Token and Token-2022; plain Transfer is rejected by 2022 mints with extensions)
  const t = ix[1]; if (!t.programId.equals(prog) || t.data[0] !== 12) return 'ix1 not transfer-checked'
  if (!t.keys[0].pubkey.equals(sAta) || !t.keys[1].pubkey.equals(mint) || !t.keys[2].pubkey.equals(bAta) || !t.keys[3].pubkey.equals(seller)) return 'ix1 wrong accounts'
  const amt = Buffer.from(t.data.subarray(1, 9)).readBigUInt64LE(); if (amt !== e.base) return `ix1 amount ${amt} != ${e.base}`
  if (t.data[9] !== e.decimals) return 'ix1 decimals mismatch'
  // 2: SOL bidder → seller
  const s = ix[2]; if (!s.programId.equals(SystemProgram.programId)) return 'ix2 not system'
  const sp = SystemInstruction.decodeTransfer(s); if (!sp.fromPubkey.equals(bidder) || !sp.toPubkey.equals(seller) || sp.lamports !== e.sellerLamports) return 'ix2 wrong transfer'
  // 3: SOL bidder → treasury (cross fee)
  const f = ix[3]; if (!f.programId.equals(SystemProgram.programId)) return 'ix3 not system'
  const fp = SystemInstruction.decodeTransfer(f); if (!fp.fromPubkey.equals(bidder) || fp.toPubkey.toBase58() !== e.treasury || fp.lamports !== e.fee) return 'ix3 wrong fee'
  return null
}
