import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useWallet } from '../context/wallet'
import { formatTimestamp } from '../utils/format'

export default function Notifications() {
  const { role, notifications, markNotificationsRead } = useWallet()

  useEffect(() => {
    markNotificationsRead().catch((error) => console.error('Could not mark notifications read:', error))
  }, [markNotificationsRead])

  if (role !== 'Court Official') {
    return <section className="panel"><h1>Court notifications</h1><p className="muted">This inbox is only available to court officials.</p></section>
  }

  return (
    <div className="page-stack">
      <section className="page-heading"><div><p className="eyebrow">COURT INBOX</p><h1>Notifications</h1><p className="subheading">Past and live registry events for your assigned court.</p></div></section>
      <section className="panel">
        {notifications.length === 0 ? <div className="empty-inline"><strong>No notifications</strong><span>New cases and evidence filings for your court will appear here.</span></div> : (
          <div className="notification-list">
            {[...notifications].reverse().map((item) => (
              <Link className="notification-item" to={item.caseId ? `/cases/${encodeURIComponent(item.caseId)}` : `/evidence/${item.evidenceId}`} key={item.key}>
                <span className="notification-symbol">↗</span>
                <span><strong>{item.text}</strong><small>Block {item.blockNumber} · {formatTimestamp(item.timestamp)}</small></span>
                <span className="text-link">Open →</span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
