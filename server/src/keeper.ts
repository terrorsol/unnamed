// Keeper: the ONE place a vault key signs. Every signature states a purpose and the SOL that may leave the vault, and the keeper
// enforces caps before signing: per-purpose allowlist, per-tx and per-hour SOL-out ceilings, and a signed-tx log on the vault's tape.
// Today the key is decrypted in-process; the interface is what lets a remote signer (enclave/KMS with the same policy) replace it
// without touching the rules (KEEPER=remote later). Caps are deliberately generous: they stop a runaway or a bug, not the rules.
import { Keypair, Transaction, VersionedTransaction } from '@solana/web3.js'
export type Purpose = 'trade' | 'desk_fill' | 'redeem' | 'payout' | 'refund' | 'treasury'
export const HOURLY_OUT_PCT = +(process.env.KEEPER_HOURLY_OUT_PCT || 100)  // ≤100% of the chest may leave per hour across trades/fills/redeems (treasury + refunds are structural and exempt)
export const MAX_TX_OUT_PCT = +(process.env.KEEPER_MAX_TX_OUT_PCT || 75)    // ≤75% of the chest in a single tx (a tranche is ≤13%, a desk fill ≤66%)
const ledger = new Map<string, { t: number; sol: number; purpose: Purpose }[]>()
export const log = (vaultId: string) => (ledger.get(vaultId) || []).slice(-50)
export function outLastHour(vaultId: string) { const now = Date.now(); const l = (ledger.get(vaultId) || []).filter((x) => now - x.t < 3.6e6); ledger.set(vaultId, l); return l.reduce((a, x) => a + x.sol, 0) }
/** Throws when the signature would breach policy; otherwise records it and signs. `solOut` is the SOL this tx may move out of the vault (0 for sells/captures). */
export function sign<T extends Transaction | VersionedTransaction>(v: { id: string; chest: number; sk: Keypair }, tx: T, purpose: Purpose, solOut: number): T {
  if (!['trade', 'desk_fill', 'redeem', 'payout', 'refund', 'treasury'].includes(purpose)) throw new Error('keeper: unknown purpose')
  if (solOut < 0 || !Number.isFinite(solOut)) throw new Error('keeper: bad amount')
  const chest = Math.max(v.chest, 0.01)
  const exempt = purpose === 'refund' || purpose === 'treasury'
  if (!exempt && solOut > chest * (MAX_TX_OUT_PCT / 100) + 0.01) throw new Error(`keeper: ${solOut.toFixed(3)} SOL exceeds the per-tx cap (${MAX_TX_OUT_PCT}% of chest)`)
  if (!exempt && outLastHour(v.id) + solOut > chest * (HOURLY_OUT_PCT / 100) + 0.01) throw new Error(`keeper: hourly cap reached (${HOURLY_OUT_PCT}% of chest)`)
  if (tx instanceof VersionedTransaction) tx.sign([v.sk]); else tx.partialSign(v.sk)
  const l = ledger.get(v.id) || []; l.push({ t: Date.now(), sol: exempt ? 0 : solOut, purpose }); ledger.set(v.id, l)
  return tx
}
export const status = () => ({ policy: 'in-process', hourlyOutPct: HOURLY_OUT_PCT, maxTxOutPct: MAX_TX_OUT_PCT })
