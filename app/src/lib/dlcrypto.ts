// The encryption half of the wallet deeplink protocol (Phantom / Solflare): pure, no browser, so it can be unit-tested.
import nacl from 'tweetnacl'
import bs58 from 'bs58'

export const newSecret = () => bs58.encode(nacl.box.keyPair().secretKey)
export const pubOf = (secretB58: string) => bs58.encode(nacl.box.keyPair.fromSecretKey(bs58.decode(secretB58)).publicKey)
export const sharedKey = (walletPubB58: string, secretB58: string) => nacl.box.before(bs58.decode(walletPubB58), bs58.decode(secretB58))
export function seal(obj: unknown, shared: Uint8Array) { const nonce = nacl.randomBytes(24); const box = nacl.box.after(new TextEncoder().encode(JSON.stringify(obj)), nonce, shared); return { nonce: bs58.encode(nonce), payload: bs58.encode(box) } }
export function open(dataB58: string, nonceB58: string, shared: Uint8Array) { const out = nacl.box.open.after(bs58.decode(dataB58), bs58.decode(nonceB58), shared); if (!out) throw new Error('Could not read the wallet answer'); return JSON.parse(new TextDecoder().decode(out)) }
/** https://phantom.app/ul/v1/<method>?…&redirect_link=banker://wallet/<method> */
export const link = (base: string, method: string, params: Record<string, string>, scheme = 'banker') => `${base}/${method}?${new URLSearchParams({ ...params, redirect_link: `${scheme}://wallet/${method}` })}`
