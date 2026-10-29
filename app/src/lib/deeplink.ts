// Phantom / Solflare from inside the BANKER phone app.
// A phone app has no browser extension, so it talks to the wallet app through its deeplink protocol:
// we open phantom.app/ul/v1/<method> with an encrypted request, the wallet asks the user, and sends the answer back to banker://wallet/<method>.
// Keys never leave the wallet app; we only ever see public keys and signatures. Docs: docs.phantom.com/phantom-deeplinks
import { BaseMessageSignerWalletAdapter, WalletReadyState, WalletConnectionError, WalletSignTransactionError, WalletSignMessageError, WalletNotConnectedError, type WalletName } from '@solana/wallet-adapter-base'
import { PublicKey, Transaction, VersionedTransaction, type TransactionVersion } from '@solana/web3.js'
import bs58 from 'bs58'
import { openExternal, onAppUrl } from './native'
import { newSecret, pubOf, sharedKey, seal, open, link } from './dlcrypto'

type Kind = 'phantom' | 'solflare'
const CFG: Record<Kind, { base: string; keyParam: string; label: string; url: string }> = {
  phantom: { base: 'https://phantom.app/ul/v1', keyParam: 'phantom_encryption_public_key', label: 'Phantom', url: 'https://phantom.app' },
  solflare: { base: 'https://solflare.com/ul/v1', keyParam: 'solflare_encryption_public_key', label: 'Solflare', url: 'https://solflare.com' },
}
export const APP_URL = 'https://app.banker.cash'
export const SCHEME = 'banker'
const WAIT_MS = 3 * 60_000

type Saved = { dappSecret: string; walletPub?: string; session?: string; pubkey?: string }
const store = (k: Kind) => `banker_dl_${k}`
const load = (k: Kind): Saved | null => { try { return JSON.parse(localStorage.getItem(store(k)) || 'null') } catch { return null } }
const save = (k: Kind, s: Saved | null) => { try { s ? localStorage.setItem(store(k), JSON.stringify(s)) : localStorage.removeItem(store(k)) } catch {} }

/** wait for the wallet to send us back to banker://wallet/<method> */
function awaitReturn(method: string): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    let off = () => {}
    const t = setTimeout(() => { off(); reject(new Error('The wallet did not answer. Try again.')) }, WAIT_MS)
    off = onAppUrl((raw) => {
      let u: URL; try { u = new URL(raw) } catch { return }
      if (!u.href.includes(`wallet/${method}`)) return
      clearTimeout(t); off()
      const q = new URLSearchParams(u.search)
      if (q.get('errorCode')) reject(new Error(q.get('errorMessage') || 'Cancelled in the wallet'))
      else resolve(q)
    })
  })
}

class DeeplinkWallet extends BaseMessageSignerWalletAdapter {
  name: WalletName; url: string; icon: string
  readonly supportedTransactionVersions: ReadonlySet<TransactionVersion> = new Set(['legacy', 0] as TransactionVersion[])
  private kind: Kind; private s: Saved | null; private _pk: PublicKey | null = null; private _connecting = false
  constructor(kind: Kind, icon: string) {
    super(); this.kind = kind; this.name = CFG[kind].label as WalletName; this.url = CFG[kind].url; this.icon = icon
    this.s = load(kind); if (this.s?.pubkey && this.s.session) this._pk = new PublicKey(this.s.pubkey)
  }
  get publicKey() { return this._pk }
  get connecting() { return this._connecting }
  get readyState() { return WalletReadyState.Loadable }

  private secret() { if (!this.s) this.s = { dappSecret: newSecret() }; return this.s.dappSecret }
  private dappPub() { return pubOf(this.secret()) }
  private shared() { if (!this.s?.walletPub) throw new WalletNotConnectedError(); return sharedKey(this.s.walletPub, this.secret()) }
  private enc(obj: unknown) { return seal(obj, this.shared()) }
  private dec(data: string, nonce: string, shared = this.shared()) { return open(data, nonce, shared) }
  private link(method: string, params: Record<string, string>) { return link(CFG[this.kind].base, method, params, SCHEME) }

  async connect() {
    if (this._pk || this._connecting) return
    this._connecting = true
    try {
      const back = awaitReturn('connect')
      await openExternal(this.link('connect', { app_url: APP_URL, dapp_encryption_public_key: this.dappPub(), cluster: 'mainnet-beta' }))
      const q = await back
      const walletPub = q.get(CFG[this.kind].keyParam) || ''
      const shared = sharedKey(walletPub, this.secret())
      const d = this.dec(q.get('data') || '', q.get('nonce') || '', shared)
      this.s = { ...this.s!, walletPub, session: d.session, pubkey: d.public_key }; save(this.kind, this.s)
      this._pk = new PublicKey(d.public_key); this.emit('connect', this._pk)
    } catch (e: any) { const err = new WalletConnectionError(e?.message, e); this.emit('error', err); throw err } finally { this._connecting = false }
  }
  async disconnect() {
    const had = this._pk; this._pk = null
    if (this.s?.session) { try { const { nonce, payload } = this.enc({ session: this.s.session }); openExternal(this.link('disconnect', { dapp_encryption_public_key: this.dappPub(), nonce, payload })).catch(() => {}) } catch {} }
    this.s = null; save(this.kind, null); if (had) this.emit('disconnect')
  }
  private ser(t: Transaction | VersionedTransaction) { return bs58.encode(t instanceof VersionedTransaction ? t.serialize() : t.serialize({ requireAllSignatures: false, verifySignatures: false })) }
  private de<T extends Transaction | VersionedTransaction>(like: T, b58: string): T { const raw = bs58.decode(b58); return (like instanceof VersionedTransaction ? VersionedTransaction.deserialize(raw) : Transaction.from(raw)) as T }
  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    if (!this._pk || !this.s?.session) throw new WalletNotConnectedError()
    try {
      const back = awaitReturn('signTransaction')
      const { nonce, payload } = this.enc({ transaction: this.ser(tx), session: this.s.session })
      await openExternal(this.link('signTransaction', { dapp_encryption_public_key: this.dappPub(), nonce, payload }))
      const q = await back; const d = this.dec(q.get('data') || '', q.get('nonce') || '')
      return this.de(tx, d.transaction)
    } catch (e: any) { throw new WalletSignTransactionError(e?.message, e) }
  }
  async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
    if (!this._pk || !this.s?.session) throw new WalletNotConnectedError()
    try {
      const back = awaitReturn('signAllTransactions')
      const { nonce, payload } = this.enc({ transactions: txs.map((t) => this.ser(t)), session: this.s.session })
      await openExternal(this.link('signAllTransactions', { dapp_encryption_public_key: this.dappPub(), nonce, payload }))
      const q = await back; const d = this.dec(q.get('data') || '', q.get('nonce') || '')
      return (d.transactions as string[]).map((b, i) => this.de(txs[i], b))
    } catch (e: any) { throw new WalletSignTransactionError(e?.message, e) }
  }
  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    if (!this._pk || !this.s?.session) throw new WalletNotConnectedError()
    try {
      const back = awaitReturn('signMessage')
      const { nonce, payload } = this.enc({ message: bs58.encode(message), session: this.s.session, display: 'utf8' })
      await openExternal(this.link('signMessage', { dapp_encryption_public_key: this.dappPub(), nonce, payload }))
      const q = await back; const d = this.dec(q.get('data') || '', q.get('nonce') || '')
      return bs58.decode(d.signature)
    } catch (e: any) { throw new WalletSignMessageError(e?.message, e) }
  }
}

export const PhantomLink = (icon: string) => new DeeplinkWallet('phantom', icon)
export const SolflareLink = (icon: string) => new DeeplinkWallet('solflare', icon)
// for tests
export const __test = { CFG, DeeplinkWallet }
