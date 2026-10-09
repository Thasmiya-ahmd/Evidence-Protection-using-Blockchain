import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useWallet } from '../context/wallet'
import AddressTag from '../components/AddressTag'
import StatusChip from '../components/StatusChip'
import { formatTimestamp } from '../utils/format'

function Loading() {
  return <div className="skeleton-list">{[1, 2, 3].map((item) => <div className="skeleton" key={item} />)}</div>
}

export default function Dashboard() {
  const { account, role, chain, notifications, notify } = useWallet()
  const [cases, setCases] = useState([])
  const [held, setHeld] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    async function load() {
      setLoading(true)
      try {
        if (role === 'Admin') {
          setCases([])
          return
        }
        const caseList = await chain.getMyCases()
        if (active) setCases(caseList)
        if (role === 'Forensic Analyst') {
          const ids = await chain.getMyHeldEvidence()
          const items = await Promise.all(ids.map((id) => chain.getEvidence(id)))
          if (active) setHeld(items)
        }
      } catch (error) {
        if (active) notify('error', error.message)
      } finally {
        if (active) setLoading(false)
      }
    }
    load()
    return () => { active = false }
  }, [account, chain, notify, role])

  const title =
    role === 'Investigator' ? 'Investigator workspace'
      : role === 'Forensic Analyst' ? 'Analyst workspace'
        : role === 'Court Official' ? 'Court dashboard'
          : 'Administration dashboard'

  return (
    <div className="page-stack">
      <section className="page-heading">
        <div>
          <p className="eyebrow">{role?.toUpperCase()} DASHBOARD</p>
          <h1>{title}</h1>
          <p className="subheading">Signed in as <AddressTag address={account} /></p>
        </div>
        {role === 'Investigator' && <Link className="button button-primary" to="/cases/new">+ Open case</Link>}
        {role === 'Admin' && <Link className="button button-primary" to="/admin">Review multisig</Link>}
      </section>

      {role === 'Admin' ? (
        <section className="panel welcome-panel">
          <p className="eyebrow">MULTISIG GOVERNANCE</p>
          <h2>Manage courts and registry roles</h2>
          <p className="muted">Administrative wallets cannot view case evidence. Use the multisig console to review and execute approved registry changes.</p>
          <Link to="/admin" className="button button-secondary">Open multisig console</Link>
        </section>
      ) : (
        <>
          <div className="stats-row">
            <article className="stat-card"><span>Cases you can access</span><strong>{loading ? '—' : cases.length}</strong></article>
            {role === 'Forensic Analyst' && <article className="stat-card"><span>Evidence currently held</span><strong>{loading ? '—' : held.length}</strong></article>}
            {role === 'Court Official' && <article className="stat-card"><span>Unread court notifications</span><strong>{notifications.length}</strong></article>}
          </div>
          <section className="panel">
            <div className="panel-heading">
              <div><p className="eyebrow">CASE ACCESS</p><h2>My cases</h2></div>
              {role === 'Investigator' && <Link to="/cases/new" className="text-link">Open a case →</Link>}
            </div>
            {loading ? <Loading /> : cases.length === 0 ? (
              <div className="empty-inline"><strong>No cases yet</strong><span>{role === 'Investigator' ? 'Open your first case to get started.' : 'No cases are currently assigned to this wallet.'}</span></div>
            ) : (
              <div className="case-grid">
                {cases.map((item) => (
                  <Link className="case-card" to={`/cases/${encodeURIComponent(item.caseId)}`} key={item.caseId}>
                    <div className="case-card-top"><span className="mono">{item.caseId}</span><StatusChip>{item.status}</StatusChip></div>
                    <strong>{item.title}</strong>
                    <span>{item.location} · {formatTimestamp(item.createdAt)}</span>
                  </Link>
                ))}
              </div>
            )}
          </section>
          {role === 'Forensic Analyst' && (
            <section className="panel">
              <div className="panel-heading"><div><p className="eyebrow">CUSTODY</p><h2>Evidence I hold</h2></div></div>
              {loading ? <Loading /> : held.length === 0 ? (
                <p className="muted">You are not the current holder of any evidence.</p>
              ) : (
                <div className="case-grid">
                  {held.map((item) => (
                    <Link className="case-card" to={`/evidence/${item.id}`} key={item.id}>
                      <div className="case-card-top"><span className="mono">Evidence #{item.id}</span><StatusChip>{item.status}</StatusChip></div>
                      <strong>{item.description}</strong>
                      <span>{item.caseId} · {item.stage}</span>
                    </Link>
                  ))}
                </div>
              )}
            </section>
          )}
          {role === 'Court Official' && (
            <section className="panel">
              <div className="panel-heading"><div><p className="eyebrow">COURT INBOX</p><h2>Recent notifications</h2></div><Link to="/notifications" className="text-link">View all →</Link></div>
              {notifications.length === 0 ? <p className="muted">No new court events. The app listens for new filings while connected.</p> : (
                <div className="notification-list">
                  {[...notifications].reverse().slice(0, 5).map((item) => (
                    <NotificationLink item={item} key={item.key} />
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  )
}

function NotificationLink({ item }) {
  const destination = item.caseId
    ? `/cases/${encodeURIComponent(item.caseId)}`
    : `/evidence/${item.evidenceId}`
  return (
    <Link className="notification-item" to={destination}>
      <span className="notification-symbol">↗</span>
      <span><strong>{item.text}</strong><small>{formatTimestamp(item.timestamp)}</small></span>
    </Link>
  )
}

export { NotificationLink }
