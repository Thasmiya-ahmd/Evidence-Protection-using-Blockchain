import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useWallet } from '../context/wallet'
import AddressTag from './AddressTag'
import RoleBadge from './RoleBadge'
import Toast from './Toast'

export default function Layout() {
  const {
    account,
    role,
    disconnect,
    unreadNotifications,
    toast,
    dismissToast,
    mockMode,
  } = useWallet()
  const navigate = useNavigate()

  if (!account) return <Outlet />

  return (
    <div className="app-shell">
      {mockMode && <div style={{ background: '#f59e0b', color: '#fff', textAlign: 'center', padding: '4px', fontSize: '0.8rem', fontWeight: 'bold' }}>MOCK MODE (OFFLINE DEMO)</div>}
      <header className="topbar">
        <Link className="brand" to="/dashboard">
          <span className="brand-mark">EP</span>
          <span>
            <strong>Evidence Registry</strong>
            <small>Chain of custody management</small>
          </span>
        </Link>
        <nav className="top-navigation" aria-label="Main navigation">
          <NavLink to="/dashboard">Dashboard</NavLink>
          {role !== 'Admin' && <NavLink to="/cases">My cases</NavLink>}
          {role === 'Investigator' && <NavLink to="/cases/new">Open case</NavLink>}
          {role === 'Court Official' && (
            <NavLink to="/notifications">
              Notifications
              {unreadNotifications > 0 && <span className="notification-count">{unreadNotifications}</span>}
            </NavLink>
          )}
          {role === 'Admin' && <NavLink to="/admin">Multisig admin</NavLink>}
        </nav>
        <div className="account-controls">
          {mockMode && <span className="mock-tag">MOCK</span>}
          <RoleBadge role={role} />
          <AddressTag address={account} />
          <button
            type="button"
            className="icon-button"
            title="Disconnect wallet"
            onClick={() => {
              disconnect()
              navigate('/connect')
            }}
          >
            ↪
          </button>
        </div>
      </header>
      <Toast toast={toast} onDismiss={dismissToast} />
      <main className="main-content">
        <Outlet />
      </main>
      <footer className="footer">
        <span>Evidence Protection · Blockchain Registry</span>
        <span>{mockMode ? 'Mock demonstration mode' : 'Wallet-connected local network'}</span>
      </footer>
    </div>
  )
}
