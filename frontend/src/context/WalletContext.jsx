import { useCallback, useEffect, useMemo, useState } from 'react'
import { BrowserProvider } from 'ethers'
import { useLocation, useNavigate } from 'react-router-dom'
import { createChain, TARGET_CHAIN_ID } from '../services/chain'
import { createMockChain, MOCK_ACCOUNTS, mockApi } from '../services/mock'
import * as api from '../services/api'
import { WalletContext } from './wallet.js'

const mockMode = String(import.meta.env.VITE_USE_MOCK).toLowerCase() === 'true'

export function WalletProvider({ children }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [account, setAccount] = useState('')
  const [role, setRole] = useState('')
  const [chain, setChain] = useState(null)
  const [provider, setProvider] = useState(null)
  const [signer, setSigner] = useState(null)
  const [chainMismatch, setChainMismatch] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [jwt, setJwt] = useState(sessionStorage.getItem('evidence-jwt') || '')
  const [notifications, setNotifications] = useState([])
  const [lastReadBlock, setLastReadBlock] = useState(0)
  const [toast, setToast] = useState(null)
  const [mockRole, setMockRole] = useState(
    import.meta.env.VITE_MOCK_ROLE || 'Investigator',
  )

  const notify = useCallback((type, message) => {
    setToast({ id: Date.now(), type, message })
  }, [])

  const dismissToast = useCallback(() => setToast(null), [])

  const bindWallet = useCallback(
    async (walletProvider, selectedAddress) => {
      const web3Provider = new BrowserProvider(walletProvider, 'any')
      const walletSigner = await web3Provider.getSigner(selectedAddress)
      const address = await walletSigner.getAddress()
      const network = await web3Provider.getNetwork()
      const wrongNetwork = Number(network.chainId) !== TARGET_CHAIN_ID
      setProvider(web3Provider)
      setSigner(walletSigner)
      setAccount(address)
      setChainMismatch(wrongNetwork)
      api.setSessionToken('')
      setJwt('')
      if (wrongNetwork) {
        setChain(null)
        setRole('')
        navigate('/connect')
        return
      }
      const connectedChain = createChain(walletSigner)
      setChain(connectedChain)
      const detectedRole = await connectedChain.getRole(address)
      setRole(detectedRole)
      try {
        const token = await api.loginWithWallet(address, walletSigner)
        setJwt(token)
      } catch (error) {
        notify('error', `Wallet connected, but backend login failed: ${error.message}`)
      }
      navigate(detectedRole === 'None' ? '/connect' : '/dashboard')
    },
    [navigate, notify],
  )

  const connect = useCallback(async () => {
    setConnecting(true)
    try {
      if (mockMode) {
        const address = MOCK_ACCOUNTS[mockRole] || MOCK_ACCOUNTS.Investigator
        setAccount(address)
        setRole(mockRole)
        setChain(createMockChain(mockRole, address))
        setProvider(null)
        setSigner(null)
        setChainMismatch(false)
        setJwt('mock-session')
        api.setSessionToken('mock-session')
        navigate('/dashboard')
        return
      }
      if (!window.ethereum) {
        throw new Error('MetaMask was not detected. Install or enable the wallet extension.')
      }
      const accounts = await window.ethereum.request({
        method: 'eth_requestAccounts',
      })
      if (!accounts?.length) throw new Error('No wallet account was selected.')
      await bindWallet(window.ethereum, accounts[0])
    } catch (error) {
      notify('error', error.message || 'Could not connect to MetaMask.')
    } finally {
      setConnecting(false)
    }
  }, [bindWallet, mockRole, navigate, notify])

  const disconnect = useCallback(() => {
    setAccount('')
    setRole('')
    setChain(null)
    setProvider(null)
    setSigner(null)
    setChainMismatch(false)
    setJwt('')
    setNotifications([])
    api.setSessionToken('')
    navigate('/connect')
  }, [navigate])

  const switchNetwork = useCallback(async () => {
    if (!window.ethereum) return
    const chainIdHex = `0x${TARGET_CHAIN_ID.toString(16)}`
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: chainIdHex }],
      })
    } catch (error) {
      if (error.code !== 4902) {
        notify('error', error.message || 'Could not switch networks.')
        return
      }
      await window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: chainIdHex,
            chainName: 'Hardhat Local',
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: [import.meta.env.VITE_RPC_URL || 'http://127.0.0.1:8545'],
          },
        ],
      })
    }
  }, [notify])

  useEffect(() => {
    if (mockMode || !window.ethereum) return undefined
    let disposed = false
    const changed = async (accounts) => {
      if (disposed) return
      if (!accounts.length) {
        disconnect()
        return
      }
      setConnecting(true)
      try {
        await bindWallet(window.ethereum, accounts[0])
      } catch (error) {
        notify('error', error.message || 'Could not load the selected wallet.')
      } finally {
        if (!disposed) setConnecting(false)
      }
    }
    const onAccountsChanged = (accounts) => changed(accounts)
    const onChainChanged = async () => {
      if (disposed || !account) return
      setConnecting(true)
      try {
        await bindWallet(window.ethereum, account)
      } catch (error) {
        notify('error', error.message || 'Could not load the selected network.')
      } finally {
        if (!disposed) setConnecting(false)
      }
    }
    window.ethereum.on('accountsChanged', onAccountsChanged)
    window.ethereum.on('chainChanged', onChainChanged)
    return () => {
      disposed = true
      window.ethereum.removeListener('accountsChanged', onAccountsChanged)
      window.ethereum.removeListener('chainChanged', onChainChanged)
    }
  }, [account, bindWallet, disconnect, notify])

  useEffect(() => {
    if (!chain || role !== 'Court Official' || !account || !chain.registry) {
      return undefined
    }
    let cancelled = false
    let stopListening
    const storageKey = `evidence-last-read:${TARGET_CHAIN_ID}:${account.toLowerCase()}`
    const savedBlock = Number(localStorage.getItem(storageKey) || 0)
    chain
      .getOfficialCourt(account)
      .then(async (courtId) => {
        if (!cancelled) setLastReadBlock(savedBlock)
        if (cancelled || /^0x0{64}$/i.test(courtId)) return
        stopListening = await chain.listenForCourtEvents(
          courtId,
          Math.max(0, savedBlock + 1),
          (items) => {
            if (!cancelled) {
              setNotifications((current) => {
                const seen = new Set(current.map((item) => item.key))
                return [...current, ...items.filter((item) => !seen.has(item.key))]
                  .sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber))
              })
            }
          },
        )
      })
      .catch((error) => notify('error', `Could not load court notifications: ${error.message}`))
    return () => {
      cancelled = true
      if (stopListening) stopListening()
    }
  }, [account, chain, notify, role])

  const markNotificationsRead = useCallback(async () => {
    if (!provider || !account) return
    const block = await provider.getBlockNumber()
    const storageKey = `evidence-last-read:${TARGET_CHAIN_ID}:${account.toLowerCase()}`
    localStorage.setItem(storageKey, String(block))
    setLastReadBlock(block)
  }, [account, provider])

  const apiService = useMemo(
    () => (mockMode ? mockApi : api),
    [],
  )
  const value = useMemo(
    () => ({
      account,
      role,
      chain,
      provider,
      signer,
      chainMismatch,
      connecting,
      jwt,
      mockMode,
      mockRole,
      setMockRole,
      connect,
      disconnect,
      switchNetwork,
      api: apiService,
      toast,
      notify,
      dismissToast,
      notifications,
      unreadNotifications: notifications.filter(
        (item) => Number(item.blockNumber) > lastReadBlock,
      ).length,
      markNotificationsRead,
      chainId: TARGET_CHAIN_ID,
      route: location.pathname,
    }),
    [
      account,
      role,
      chain,
      provider,
      signer,
      chainMismatch,
      connecting,
      jwt,
      mockRole,
      connect,
      disconnect,
      switchNetwork,
      apiService,
      toast,
      notify,
      dismissToast,
      notifications,
      lastReadBlock,
      markNotificationsRead,
      location.pathname,
    ],
  )

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}
