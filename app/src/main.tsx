import React, { useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui'
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom'
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare'
import { BackpackWalletAdapter } from '@solana/wallet-adapter-backpack'
import '@solana/wallet-adapter-react-ui/styles.css'
import './styles.css'
import App from './App'
import { loadSettings } from './lib/store'

function Root() {
  const s = loadSettings()
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter(), new BackpackWalletAdapter()], [])
  return (
    <ConnectionProvider endpoint={s.rpc} config={{ commitment: 'confirmed' }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider><App /></WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  )
}
createRoot(document.getElementById('root')!).render(<Root />)
