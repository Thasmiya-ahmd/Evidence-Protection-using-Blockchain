import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { isAddress } from 'ethers'
import AddressTag from '../components/AddressTag'
import StatusChip from '../components/StatusChip'
import TxButton from '../components/TxButton'
import { useWallet } from '../context/wallet'
import { formatTimestamp } from '../utils/format'
import { errorMessage } from '../utils/errors'

export default function CaseDetail() {
  const { caseId } = useParams()
  const { account, role, chain, api, notify } = useWallet()
  const [record, setRecord] = useState(null)
  const [courtName, setCourtName] = useState('')
  const [analysts, setAnalysts] = useState([])
  const [evidence, setEvidence] = useState([])
  const [analystInput, setAnalystInput] = useState('')
  const [location, setLocation] = useState('')
  const [method, setMethod] = useState('')
  const [description, setDescription] = useState('')
  const [file, setFile] = useState(null)
  const [certificate, setCertificate] = useState(null)
  const [pendingCertificateLink, setPendingCertificateLink] = useState(null)
  const [progress, setProgress] = useState('')
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    setRecord(null)
    try {
      const caseRecord = await chain.getCase(caseId)
      const [assigned, items, court] = await Promise.all([
        chain.getAnalysts(caseId),
        chain.getCaseEvidence(caseId),
        chain.getCourtName(caseRecord.courtId),
      ])
      setRecord(caseRecord)
      setAnalysts(assigned)
      setEvidence(items)
      setCourtName(court)
    } catch (error) {
      notify('error', errorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [caseId, chain, notify])

  // Load the case using the connected signer so contract access checks apply.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { refresh() }, [refresh])

  async function uploadAndRegister(event) {
    event.preventDefault()
    const formElement = event.currentTarget
    if (!file) return notify('error', 'Choose the evidence file first.')
    setProgress('Step 1 of 3 · Computing browser SHA-256')
    try {
      const browserHash = await hashBrowserFile(file)
      setProgress('Step 2 of 3 · Uploading encrypted evidence')
      const uploaded = await api.uploadEvidenceFile(file, caseId)
      if (browserHash.toLowerCase() !== uploaded.fileHash.toLowerCase()) {
        throw new Error('Backend file hash differs from the browser hash. Evidence was not registered.')
      }
      let certificateHash = `0x${'00'.repeat(32)}`
      if (certificate) {
        const browserCertificateHash = await hashBrowserFile(certificate)
        const uploadedCertificate = await api.uploadEvidenceFile(certificate, caseId, 'certificate')
        if (browserCertificateHash.toLowerCase() !== uploadedCertificate.fileHash.toLowerCase()) {
          throw new Error('Backend certificate hash differs from the browser hash.')
        }
        certificateHash = uploadedCertificate.fileHash
      }
      setProgress('Step 3 of 3 · Confirm registerEvidence in MetaMask')
      const tx = await chain.registerEvidence({
        caseId,
        description: description.trim(),
        location: location.trim(),
        collectionMethod: method.trim(),
        fileHash: browserHash,
        certificateHash,
      })
      setProgress('Step 3 of 3 · Waiting for blockchain confirmation')
      const receipt = await tx.wait()
      if (certificateHash !== `0x${'00'.repeat(32)}`) {
        const records = await chain.getCaseEvidence(caseId)
        const registered = records.find(
          (item) =>
            item.fileHash.toLowerCase() === browserHash.toLowerCase() &&
            item.certificateHash.toLowerCase() === certificateHash.toLowerCase(),
        )
        if (!registered) {
          throw new Error('Evidence was registered on-chain, but its evidence ID could not be resolved to link the certificate.')
        }
        try {
          await api.linkEvidenceFile(certificateHash, registered.id)
        } catch (error) {
          setPendingCertificateLink({ fileHash: certificateHash, evidenceId: registered.id })
          setFile(null)
          setCertificate(null)
          setDescription('')
          setLocation('')
          setMethod('')
          formElement.reset()
          await refresh()
          throw new Error(
            `Evidence #${registered.id} was registered on-chain, but the certificate could not be linked: ${errorMessage(error)}`,
            { cause: error },
          )
        }
        setPendingCertificateLink(null)
      }

      setProgress('')
      notify('success', `Evidence registered · ${receipt.hash.slice(0, 10)}…${receipt.hash.slice(-6)}`)
      setFile(null)
      setCertificate(null)
      setDescription('')
      setLocation('')
      setMethod('')
      formElement.reset()
      await refresh()
    } catch (error) {
      setProgress('')
      notify('error', errorMessage(error))
    }
  }

  async function retryCertificateLink() {
    if (!pendingCertificateLink) return
    setProgress('Linking the registered certificate to its evidence record')
    try {
      await api.linkEvidenceFile(pendingCertificateLink.fileHash, pendingCertificateLink.evidenceId)
      setPendingCertificateLink(null)
      notify('success', `Certificate linked to evidence #${pendingCertificateLink.evidenceId}.`)
    } catch (error) {
      notify('error', errorMessage(error))
    } finally {
      setProgress('')
    }
  }

  if (loading) return <section className="panel"><div className="skeleton skeleton-large" /></section>
  if (!record) return <section className="panel"><h1>Case unavailable</h1><p className="muted">You don't have access to this case, or it does not exist.</p><Link to="/dashboard">Back to dashboard</Link></section>

  const isLead = record.leadInvestigator.toLowerCase() === account.toLowerCase()
  return (
    <div className="page-stack">
      <div className="breadcrumbs"><Link to="/dashboard">Dashboard</Link><span>/</span><span>{record.caseId}</span></div>
      <section className="panel">
        <div className="panel-heading case-detail-heading">
          <div><p className="eyebrow">CASE FILE · {record.caseId}</p><h1>{record.title}</h1><p className="subheading">{record.location} · {courtName || 'Court'}</p></div>
          <StatusChip>{record.status}</StatusChip>
        </div>
        <div className="metadata-grid">
          <div><span>Lead investigator</span><AddressTag address={record.leadInvestigator} /></div>
          <div><span>Court</span><strong>{courtName}</strong></div>
          <div><span>Opened</span><strong>{formatTimestamp(record.createdAt)}</strong></div>
        </div>
        {role === 'Court Official' && record.status === 'Open' && <CourtDecisions caseId={caseId} chain={chain} refresh={refresh} />}
      </section>

      <div className="case-detail-grid">
        <section className="panel">
          <div className="panel-heading"><div><p className="eyebrow">CASE ACCESS</p><h2>Assigned analysts</h2></div><span className="count-pill">{analysts.length}</span></div>
          {analysts.length ? <div className="analyst-list">
            {analysts.map((analyst) => (
              <div className="analyst-chip" key={analyst}><AddressTag address={analyst} />
                {isLead && record.status === 'Open' && <TxButton className="button button-quiet" onClick={() => chain.removeAnalyst(caseId, analyst)} onSuccess={refresh}>Remove</TxButton>}
              </div>
            ))}
          </div> : <p className="muted">No analysts assigned yet.</p>}
          {isLead && record.status === 'Open' && (
            <form className="inline-form" onSubmit={(event) => event.preventDefault()}>
              <input value={analystInput} onChange={(event) => setAnalystInput(event.target.value)} placeholder="Analyst wallet address" required />
              <TxButton
                disabled={!isAddress(analystInput)}
                onClick={() => chain.assignAnalyst(caseId, analystInput)}
                onSuccess={async () => { setAnalystInput(''); await refresh() }}
              >Assign analyst</TxButton>
            </form>
          )}
          {role === 'Court Official' && <p className="form-help">Court access is limited by the case&apos;s jurisdiction.</p>}
        </section>

        <section className="panel">
          <div className="panel-heading"><div><p className="eyebrow">CHAIN OF CUSTODY</p><h2>Evidence</h2></div><span className="count-pill">{evidence.length}</span></div>
          {evidence.length === 0 ? <div className="empty-inline"><strong>No evidence yet</strong><span>Register the first item to begin its custody record.</span></div> :
            <div className="evidence-list">
              {evidence.map((item) => <Link className="evidence-card" to={`/evidence/${item.id}`} key={item.id}>
                <div className="case-card-top"><span className="mono">Evidence #{item.id}</span><StatusChip>{item.status}</StatusChip></div>
                <strong>{item.description}</strong>
                <span>{item.stage} · Holder <AddressTag address={item.currentHolder} /></span>
              </Link>)}
            </div>}
        </section>
      </div>

      {isLead && record.status === 'Open' && (
        <section className="panel">
          <div className="panel-heading"><div><p className="eyebrow">REGISTER NEW ITEM</p><h2>Register evidence</h2></div></div>
          <p className="hint">Keep this generic (e.g. Seized laptop). Do not enter names or personal details.</p>
          <p className="muted">Step 1: Browser computes SHA-256. Step 2: Backend encrypts and confirms the hash. Step 3: MetaMask registers the hash on-chain. Uploaded files are encrypted and are not stored in plaintext.</p>
          {pendingCertificateLink && (
            <div className="progress-step">
              Certificate upload is pending for evidence #{pendingCertificateLink.evidenceId}.
              <button className="button button-secondary" disabled={Boolean(progress)} onClick={retryCertificateLink}>Retry certificate link</button>
            </div>
          )}
          <form className="evidence-form" onSubmit={uploadAndRegister}>
            <label className="wide-field">Evidence file<input type="file" required onChange={(event) => setFile(event.target.files?.[0] || null)} /></label>
            <label className="wide-field">Electronic-evidence certificate (optional)<input type="file" onChange={(event) => setCertificate(event.target.files?.[0] || null)} /></label>
            <label>Generic description<input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={256} required placeholder="Seized laptop" /></label>
            <label>Short collection location<input value={location} onChange={(event) => setLocation(event.target.value)} maxLength={128} required placeholder="Records office" /></label>
            <label>Collection method<input value={method} onChange={(event) => setMethod(event.target.value)} maxLength={128} required placeholder="Seized" /></label>
            <button className="button button-primary" disabled={Boolean(progress) || !file}>Upload &amp; register</button>
          </form>
          {progress && <div className="progress-step">{progress}</div>}
        </section>
      )}
    </div>
  )
}

function CourtDecisions({ caseId, chain, refresh }) {
  const [note, setNote] = useState('')
  return (
    <div className="case-action-bar">
      <label>Decision note<input value={note} onChange={(event) => setNote(event.target.value)} maxLength={512} placeholder="Decision note" /></label>
      <TxButton disabled={!note.trim()} onClick={() => chain.rejectCase(caseId, note.trim())} onSuccess={refresh} className="button button-danger">Reject case</TxButton>
      <TxButton disabled={!note.trim()} onClick={() => chain.closeCase(caseId, note.trim())} onSuccess={refresh} className="button button-secondary">Close case</TxButton>
    </div>
  )
}

async function hashBrowserFile(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return `0x${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}
