import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import TxButton from '../components/TxButton'
import { useWallet } from '../context/wallet'
import { errorMessage } from '../utils/errors'
import { shortHash } from '../utils/format'

async function sha256(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return `0x${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

export default function Verify() {
  const { id } = useParams()
  const { chain, api, notify } = useWallet()
  const [evidence, setEvidence] = useState(null)
  const [selectedFile, setSelectedFile] = useState(null)
  const [browserHash, setBrowserHash] = useState('')
  const [backendHash, setBackendHash] = useState('')
  const [chainMatch, setChainMatch] = useState(null)
  const [readable, setReadable] = useState(true)
  const [backendMessage, setBackendMessage] = useState('')
  const [checking, setChecking] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    chain.getEvidence(id)
      .then(setEvidence)
      .catch((error) => notify('error', errorMessage(error)))
      .finally(() => setLoading(false))
  }, [chain, id, notify])

  async function verifyFile() {
    if (!selectedFile || !evidence) return
    setChecking(true)
    setBrowserHash('')
    setBackendHash('')
    setChainMatch(null)
    setReadable(true)
    setBackendMessage('')
    try {
      const local = await sha256(await selectedFile.arrayBuffer())
      const verifyResult = await api.verifyEvidenceFile(evidence.fileHash)
      const onChain = await chain.verify(id, local)
      setBrowserHash(local)
      setBackendHash(verifyResult.recomputedHash || 'CORRUPTED')
      setChainMatch(Boolean(onChain))
      setReadable(verifyResult.readable)
      setBackendMessage(verifyResult.message || '')
    } catch (error) {
      notify('error', errorMessage(error))
    } finally {
      setChecking(false)
    }
  }

  const intact =
    Boolean(browserHash) &&
    readable &&
    browserHash.toLowerCase() === backendHash.toLowerCase() &&
    browserHash.toLowerCase() === evidence?.fileHash.toLowerCase() &&
    chainMatch === true

  if (loading) return <section className="panel"><div className="skeleton skeleton-large" /></section>
  if (!evidence) return <section className="panel"><h1>Evidence unavailable</h1><p className="muted">You don't have access to this case or evidence.</p><Link to="/dashboard">Back to dashboard</Link></section>

  return (
    <div className="page-stack narrow-page">
      <div className="breadcrumbs"><Link to={`/evidence/${id}`}>Evidence #{id}</Link><span>/</span><span>Integrity verification</span></div>
      <section className="panel verify-panel">
        <p className="eyebrow">EVIDENCE INTEGRITY</p>
        <h1>Verify original file</h1>
        <p className="muted">Compare the chosen file with the encrypted original held by the backend and the immutable on-chain SHA-256.</p>
        <label className="file-picker">Choose a file to verify<input type="file" onChange={(event) => { setSelectedFile(event.target.files?.[0] || null); setBrowserHash(''); setBackendHash(''); setChainMatch(null) }} /></label>
        <button className="button button-primary" type="button" disabled={!selectedFile || checking} onClick={verifyFile}>{checking ? 'Computing and comparing hashes…' : 'Verify file'}</button>
        {browserHash && (
          <>
            <div className={`verification-result ${intact ? 'intact' : 'tampered'}`}>
              <span>{intact ? '✓' : '!'}</span>
              <strong>{intact ? 'INTACT' : 'TAMPERING DETECTED'}</strong>
              <small>{intact ? 'Both copies match the evidence hash recorded on-chain.' : (!readable && backendMessage) ? backendMessage : 'One or more hashes do not match the registered evidence.'}</small>
            </div>
            <div className="verification-hashes">
              <HashResult label="Selected file (browser)" hash={browserHash} />
              <HashResult label="Stored encrypted file (backend)" hash={backendHash} />
              <HashResult label="On-chain registered hash" hash={evidence.fileHash} />
              <div className="hash-check"><span>Registry verify(id, hash)</span><strong>{chainMatch ? 'MATCH' : 'MISMATCH'}</strong></div>
            </div>
            <TxButton
              className="button button-secondary"
              onClick={() => chain.recordVerification(id, browserHash)}
            >
              Log this verification on-chain
            </TxButton>
          </>
        )}
      </section>
    </div>
  )
}

function HashResult({ label, hash }) {
  return <div className="hash-result"><span>{label}</span><code title={hash}>{shortHash(hash, 20)}</code></div>
}
