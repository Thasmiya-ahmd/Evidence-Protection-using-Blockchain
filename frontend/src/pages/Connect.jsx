import { Navigate } from 'react-router-dom'
import { useWallet } from '../context/wallet'
import { MOCK_ACCOUNTS } from '../services/mock'

export default function Connect() {
  const {
    account,
    role,
    connect,
    connecting,
    chainMismatch,
    switchNetwork,
    mockMode,
    mockRole,
    setMockRole,
  } = useWallet()

  if (account && role && role !== 'None' && !chainMismatch) return <Navigate to="/dashboard" replace />

  return (
    <main className="connect-page">
      <header className="connect-brand">
        <span className="brand-mark">EP</span>
        <div><strong>Evidence Registry</strong><small>Private blockchain case management</small></div>
      </header>
      <section className="connect-card">
        <p className="eyebrow">SECURE WALLET ACCESS</p>
        <h1>Protect the chain of custody.</h1>
        <p className="connect-copy">
          Connect your authorized wallet to access cases and evidence permitted
          by the registry.
        </p>
        {chainMismatch && (
          <div className="network-warning">
            <strong>Wrong network</strong>
            <span>Switch MetaMask to local Hardhat (chain ID {import.meta.env.VITE_CHAIN_ID || 31337}) to continue.</span>
            <button className="button button-primary" type="button" onClick={switchNetwork}>
              Switch network
            </button>
          </div>
        )}
        {mockMode && (
          <label className="mock-role-select">
            Demonstration role
            <select value={mockRole} onChange={(event) => setMockRole(event.target.value)}>
              {Object.keys(MOCK_ACCOUNTS).map((item) => <option key={item}>{item}</option>)}
            </select>
          </label>
        )}
        <button
          type="button"
          className="button button-primary connect-button"
          onClick={connect}
          disabled={connecting || chainMismatch}
        >
          {connecting ? 'Connecting wallet…' : mockMode ? 'Start demo session' : 'Connect MetaMask'}
        </button>
        {!mockMode && (
          <p className="connect-footnote">
            Your wallet signs contract transactions. The application never asks
            for or stores your private key.
          </p>
        )}
        {account && role === 'None' && (
          <p className="connect-error">This wallet has no Evidence Registry role. Contact your administrator.</p>
        )}
      </section>
      <p className="connect-bottom">Evidence Protection · Ethereum-compatible private network</p>
    </main>
  )
}
