// Dev signature over an action, standalone so it can be unit-tested without the vault runtime.
import nacl from 'tweetnacl'
import bs58 from 'bs58'
/** The dev proves it's them before the vault signs anything for a launch: a wallet signature over `unnamed:<action>:<vaultId>:<mint>:<minute>` (valid 10 min).
 *  Without this, anyone who read a vault id off /vaults could make a funded, unarmed vault buy THEIR coin in block zero. */
export function devAuth(v: { id: string; dev: string }, action: string, mint: string, auth?: { msg?: string; sig?: string; sessionWallet?: string | null }) {
  if (process.env.DEV_AUTH === '0') return
  // an invite session is an HMAC the server minted for a wallet that signed once; if it is the dev's wallet, no extra message signature (no wallet popup)
  if (auth?.sessionWallet && auth.sessionWallet === v.dev) return
  if (!auth?.msg || !auth?.sig) throw new Error('dev signature required')
  const m = /^unnamed:([a-z-]+):([^:]+):([^:]+):(\d+)$/.exec(auth.msg); if (!m) throw new Error('bad auth message')
  if (m[1] !== action || m[2] !== v.id || m[3] !== mint) throw new Error('auth message does not match this launch')
  if (Math.abs(Date.now() / 60000 - +m[4]) > 10) throw new Error('auth message expired')
  if (!nacl.sign.detached.verify(new TextEncoder().encode(auth.msg), bs58.decode(auth.sig), bs58.decode(v.dev))) throw new Error('bad dev signature')
}
