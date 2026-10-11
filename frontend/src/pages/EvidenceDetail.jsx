import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import AddressTag from '../components/AddressTag'
import FileHash from '../components/FileHash'
import StatusChip from '../components/StatusChip'
import TxButton from '../components/TxButton'
import { useWallet } from '../context/wallet'
import { formatTimestamp } from '../utils/format'
import { errorMessage } from '../utils/errors'

export default function EvidenceDetail() {
  const { id } = useParams()
  const { account, role, chain, api, notify } = useWallet()
  const [evidence, setEvidence] = useState(null)
  const [caseRecord, setCaseRecord] = useState(null)
  const [analysts, setAnalysts] = useState([])
  const [custody, setCustody] = useState([])
  const [statusHistory, setStatusHistory] = useState([])
  const [recipient, setRecipient] = useState('')
  const [reason, setReason] = useState('')
  const [flagReason, setFlagReason] = useState('')
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    setEvidence(null)
    setCaseRecord(null)
    try {
      const item = await chain.getEvidence(id)
      const [caseDetails, assigned, history, statuses] = await Promise.all([
        chain.getCase(item.caseId),
        chain.getAnalysts(item.caseId),
        chain.getCustodyHistory(id),
        chain.getStatusHistory(id),
      ])
      setEvidence(item)
      setCaseRecord(caseDetails)
      setAnalysts(assigned)
      setCustody(Array.from(history))
      setStatusHistory(Array.from(statuses))
    } catch (error) {
      notify('error', errorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [chain, id, notify])

  // Load evidence through the access-controlled signer connection.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { refresh() }, [refresh])

  const [courtMatches, setCourtMatches] = useState(false)
  useEffect(() => {
    let active = true
    if (role !== 'Court Official' || !caseRecord) return undefined
    chain.getOfficialCourt(account)
      .then((id) => active && setCourtMatches(id.toLowerCase() === caseRecord.courtId.toLowerCase()))
      .catch((error) => active && notify('error', error.message))
    return () => { active = false }
  }, [account, caseRecord, chain, notify, role])

  if (loading) return <section className="panel"><div className="skeleton skeleton-large" /></section>
  if (!evidence || !caseRecord) return <section className="panel"><h1>Evidence unavailable</h1><p className="muted">You don't have access to this case or evidence.</p><Link to="/dashboard">Back to dashboard</Link></section>

  const active = evidence.status === 'Active'
  const submitted = evidence.stage === 'SubmittedToCourt'
  const openCase = caseRecord.status === 'Open'
  const currentHolder = evidence.currentHolder.toLowerCase() === account.toLowerCase()
  const holderCandidates = [caseRecord.leadInvestigator, ...analysts]
    .filter((address, index, list) => list.findIndex((item) => item.toLowerCase() === address.toLowerCase()) === index)
    .filter((address) => address.toLowerCase() !== account.toLowerCase())

  async function download(hash) {
    try {
      const { blob, filename } = await api.downloadEvidenceFile(hash, id)
      const objectUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = filename
      link.click()
      URL.revokeObjectURL(objectUrl)
    } catch (error) {
      notify('error', errorMessage(error))
    }
  }

  return (
    <div className="page-stack">
      <div className="breadcrumbs"><Link to="/dashboard">Dashboard</Link><span>/</span><Link to={`/cases/${encodeURIComponent(evidence.caseId)}`}>{evidence.caseId}</Link><span>/</span><span>Evidence #{evidence.id}</span></div>
      <section className="panel evidence-heading">
        <div className="panel-heading">
          <div><p className="eyebrow">EVIDENCE RECORD · #{evidence.id}</p><h1>{evidence.description}</h1><p className="subheading">{evidence.caseId} · {evidence.location} · {evidence.collectionMethod}</p></div>
          <div className="chip-stack"><StatusChip>{evidence.status}</StatusChip><StatusChip kind={evidence.stage.toLowerCase()}>{evidence.stage}</StatusChip></div>
        </div>
        <div className="metadata-grid evidence-metadata">
          <div><span>Collected by</span><AddressTag address={evidence.collector} /></div>
          <div><span>Current holder</span><AddressTag address={evidence.currentHolder} /></div>
          <div><span>Jurisdiction court</span><strong>{caseRecord.location}</strong></div>
          <div><span>Recorded on</span><strong>{formatTimestamp(evidence.createdAt)}</strong></div>
        </div>
        <div className="hash-list"><FileHash hash={evidence.fileHash} label="Evidence SHA-256" />{evidence.certificateHash !== `0x${'00'.repeat(32)}` && <FileHash hash={evidence.certificateHash} label="Certificate SHA-256" />}</div>
      </section>

      <div className="evidence-page-grid">
        <section className="panel">
          <div className="panel-heading"><div><p className="eyebrow">IMMUTABLE AUDIT TRAIL</p><h2>Custody timeline</h2></div></div>
          {custody.length === 0 ? <p className="muted">No custody records.</p> : (
            <ol className="custody-timeline">
              {custody.map((record, index) => <li key={`${record.timestamp}-${index}`}>
                <span className="timeline-dot" />
                <div className="timeline-card"><span className="timeline-title">{['Collected', 'Forensic analysis', 'Submitted to court'][Number(record.stage)] || evidence.stage}</span>
                  <p>{record.reason}</p><div><AddressTag address={record.from} /> <span>→</span> <AddressTag address={record.to} /></div><small>{formatTimestamp(record.timestamp)}</small>
                </div>
              </li>)}
            </ol>
          )}
        </section>

        <div className="page-stack">
          <section className="panel">
            <div className="panel-heading"><div><p className="eyebrow">PERMITTED OPERATIONS</p><h2>Evidence actions</h2></div></div>
            <div className="evidence-actions">
              {currentHolder && active && !submitted && openCase && (
                <form className="action-form" onSubmit={(event) => event.preventDefault()}>
                  <h3>Transfer custody</h3>
                  {holderCandidates.length ? <select value={recipient} onChange={(event) => setRecipient(event.target.value)} required>
                    <option value="">Select lead investigator or assigned analyst</option>
                    {holderCandidates.map((address) => <option value={address} key={address}>{address.toLowerCase() === caseRecord.leadInvestigator.toLowerCase() ? 'Lead investigator' : 'Assigned analyst'} · {address}</option>)}
                  </select> : <p className="muted">No other eligible case holder.</p>}
                  <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Transfer reason" maxLength={512} required />
                  <TxButton disabled={!recipient || !reason.trim()} onClick={() => chain.transferCustody(id, recipient, reason.trim())} onSuccess={refresh}>Transfer custody</TxButton>
                </form>
              )}
              {currentHolder && active && !submitted && openCase && <TxButton className="button button-secondary" onClick={() => chain.submitToCourt(id, 'Evidence submitted to court')} onSuccess={refresh}>Submit to court</TxButton>}
              {(role === 'Investigator' || role === 'Forensic Analyst') && active && <form className="action-form" onSubmit={(event) => event.preventDefault()}>
                <h3>Flag evidence</h3><input value={flagReason} onChange={(event) => setFlagReason(event.target.value)} placeholder="Reason for flagging" maxLength={512} required />
                <TxButton disabled={!flagReason.trim()} onClick={() => chain.flagEvidence(id, flagReason.trim())} onSuccess={refresh} className="button button-secondary">Flag evidence</TxButton>
              </form>}
              {role === 'Court Official' && evidence.status === 'Flagged' && <p className="form-help">Court access is read-only. Evidence status decisions require the admin multisig.</p>}
              <TxButton className="button button-quiet" onClick={() => chain.logAccess(id, 'Viewed or downloaded evidence')} onSuccess={() => notify('success', 'Evidence access logged on-chain.')}>Log evidence access</TxButton>
              <Link className="button button-secondary" to={`/evidence/${id}/verify`}>Verify file integrity</Link>
              <button type="button" className="button button-quiet" onClick={() => download(evidence.fileHash)}>Download original file</button>
              {evidence.certificateHash !== `0x${'00'.repeat(32)}` && <button type="button" className="button button-quiet" onClick={() => download(evidence.certificateHash)}>Download certificate</button>}
              {role === 'Court Official' && !courtMatches && <p className="form-help">Court access is limited to the official assigned to this case&apos;s jurisdiction.</p>}
              <button type="button" style={{ opacity: 0.1, position: 'absolute', bottom: 0, right: 0 }} onClick={() => api.tamperEvidenceFile(evidence.fileHash).then(() => notify('success', 'File tampered')).catch(e => notify('error', errorMessage(e)))}>Demo: tamper stored file</button>
            </div>
          </section>

          <section className="panel">
            <div className="panel-heading"><div><p className="eyebrow">STATUS AUDIT</p><h2>Status history</h2></div></div>
            {statusHistory.length === 0 ? <p className="muted">No status changes recorded.</p> : (
              <ul className="status-history">
                {statusHistory.map((item, index) => <li key={`${item.timestamp}-${index}`}><StatusChip>{['Active', 'Flagged', 'Revoked'][Number(item.status)] || item.status}</StatusChip><div><strong>{item.reason}</strong><small><AddressTag address={item.by} /> · {formatTimestamp(item.timestamp)}</small></div></li>)}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
