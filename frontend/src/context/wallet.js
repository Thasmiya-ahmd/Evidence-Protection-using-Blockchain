import { createContext, useContext } from 'react'

export const WalletContext = createContext(null)

export function useWallet() {
  const value = useContext(WalletContext)
  if (!value) throw new Error('useWallet must be used inside WalletProvider')
  return value
}
