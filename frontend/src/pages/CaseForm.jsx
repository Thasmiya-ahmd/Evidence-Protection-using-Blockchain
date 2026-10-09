import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import TxButton from '../components/TxButton'
import { useWallet } from '../context/wallet'

export default function CaseForm() {
  const { chain, notify, role } = useWallet()
  const navigate = useNavigate()
  const [locations, setLocations] = useState([])
  const [location, setLocation] = useState('')
  const [court, setCourt] = useState(null)
  const [loading, setLoading] = useState(true)
  const [caseId, setCaseId] = useState('')
  const [title, setTitle] = useState('')

  useEffect(() => {
    let active = true
    chain.getLocations()
      .then((result) => active && setLocations(result))
      .catch((error) => notify('error', error.message))
      .finally(() => active && setLoading(false))
    return () => { active = false }
  }, [chain, notify])

  useEffect(() => {
    let active = true
    if (!location) return undefined
    chain.getCourtForLocation(location)
      .then((result) => active && setCourt({ ...result, location }))
      .catch((error) => notify('error', error.message))
    return () => { active = false }
  }, [chain, location, notify])
  const courtPreview = court?.location === location ? court : null

  if (role !== 'Investigator') {
    return <section className="panel"><h1>Investigator access required</h1><p className="muted">Only an investigator wallet can open a case.</p></section>
  }

  return (
    <div className="page-stack narrow-page">
      <div className="page-heading">
        <div><p className="eyebrow">INVESTIGATOR</p><h1>Open a case</h1><p className="subheading">The registry automatically links this case to the court serving the selected location.</p></div>
      </div>
      <form className="panel form-panel" onSubmit={(event) => event.preventDefault()}>
        <label>
          Case ID
          <input value={caseId} onChange={(event) => setCaseId(event.target.value)} maxLength={128} required placeholder="CASE-2026-001" />
        </label>
        <label>
          Generic case title
          <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={128} required placeholder="Seized laptop" />
          <small className="hint">Keep this generic (e.g. Seized laptop). Do not enter names or personal details.</small>
        </label>
        <label>
          Jurisdiction location
          <select value={location} onChange={(event) => setLocation(event.target.value)} required disabled={loading}>
            <option value="">{loading ? 'Loading court locations…' : 'Select a registered location'}</option>
            {locations.map((item) => <option value={item} key={item}>{item}</option>)}
          </select>
        </label>
        {courtPreview && <div className="court-preview"><span>Linked court</span><strong>{courtPreview.name}</strong><small className="mono">{courtPreview.id}</small></div>}
        <TxButton
          disabled={!caseId.trim() || !title.trim() || !location || !courtPreview}
          onClick={() => chain.openCase(caseId.trim(), title.trim(), location)}
          onSuccess={() => navigate(`/cases/${encodeURIComponent(caseId.trim())}`)}
        >
          Open case on-chain
        </TxButton>
      </form>
    </div>
  )
}
