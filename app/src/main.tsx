import React, { useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui'
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom'
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare'
import { BackpackWalletAdapter } from '@solana/wallet-adapter-backpack'
import '@solana/wallet-adapter-react-ui/styles.css'
import './fonts.css'
import './styles.css'
import './captain.css'
import App from './App'
import { loadSettings } from './lib/store'
import { isNative, nativeBoot } from './lib/native'
import { PhantomLink, SolflareLink } from './lib/deeplink'

nativeBoot()
function Root() {
  const s = loadSettings()
  // the phone app has no browser extensions: it reaches Phantom and Solflare through their deeplinks instead
  const wallets = useMemo(() => isNative() ? [PhantomLink(new PhantomWalletAdapter().icon), SolflareLink(new SolflareWalletAdapter().icon)] : [new PhantomWalletAdapter(), new SolflareWalletAdapter(), new BackpackWalletAdapter()], [])
  return (
    <ConnectionProvider endpoint={s.rpc} config={{ commitment: 'confirmed' }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider><App /></WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  )
}
createRoot(document.getElementById('root')!).render(<Root />)
