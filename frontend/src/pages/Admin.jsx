import { useCallback, useEffect, useRef, useState } from 'react'
import { isAddress } from 'ethers'
import { useWallet } from '../context/wallet'
import AddressTag from '../components/AddressTag'
import StatusChip from '../components/StatusChip'
import TxButton from '../components/TxButton'

export default function Admin() {
  const { account, role, chain, notify } = useWallet()
  const [courts, setCourts] = useState([])
  const [owners, setOwners] = useState([])
  const [threshold, setThreshold] = useState(0)
  const [proposals, setProposals] = useState([])
  const [isOwner, setIsOwner] = useState(false)
  const [action, setAction] = useState('registerCourt')
  const [busy, setBusy] = useState(true)
  const formRef = useRef(null)

  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      const [registeredCourts, multisigOwners, requiredApprovals, ownerStatus, count] =
        await Promise.all([
          chain.getCourts(),
          chain.getOwners(),
          chain.getThreshold(),
          chain.isOwner(account),
          chain.getProposalCount(),
        ])
      const proposalItems = await Promise.all(
        Array.from({ length: count }, (_, index) => chain.getProposal(index)),
      )
      setCourts(registeredCourts)
      setOwners(multisigOwners)
      setThreshold(requiredApprovals)
      setIsOwner(ownerStatus)
      setProposals(proposalItems)
    } catch (error) {
      notify('error', error.message)
    } finally {
      setBusy(false)
    }
  }, [account, chain, notify])

  // Load multisig state from the signer-connected contracts on route entry.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { refresh() }, [refresh])

  async function propose(formElement) {
    if (!formElement.reportValidity()) throw new Error('Complete the required proposal fields.')
    const form = new FormData(formElement)
    const method = form.get('action')
    let args
    if (method === 'registerCourt') {
      args = [String(form.get('name')).trim(), String(form.get('location')).trim()]
    } else if (method === 'assignCourtOfficial') {
      const official = String(form.get('official')).trim()
      if (!isAddress(official)) throw new Error('Enter a valid court official wallet address.')
      args = [official, String(form.get('courtId'))]
    } else {
      const roleName = String(form.get('role'))
      const userAddress = String(form.get('account')).trim()
      if (!isAddress(userAddress)) throw new Error('Enter a valid wallet address.')
      args = [
        await chain.getRoleHash(roleName),
        userAddress,
      ]
    }
    const tx = await chain.proposeRegistryCall(method, args)
    return tx
  }

  if (role !== 'Admin') {
    return <section className="panel"><h1>Administrator access required</h1><p className="muted">This page is for an owner of the registry administration multisig.</p></section>
  }

  return (
    <div className="page-stack">
      <section className="page-heading">
        <div><p className="eyebrow">GOVERNANCE</p><h1>Multisig administration</h1><p className="subheading">Admin wallets can manage governance, but cannot view evidence.</p></div>
        <button className="button button-secondary" type="button" onClick={refresh} disabled={busy}>Refresh</button>
      </section>

      <section className="panel">
        <div className="panel-heading"><div><p className="eyebrow">SIGNERS</p><h2>Owners &amp; threshold</h2></div><strong className="threshold-chip">{threshold} of {owners.length}</strong></div>
        <div className="owner-grid">{owners.map((owner) => <div className="owner-card" key={owner}><AddressTag address={owner} /><span>{owner.toLowerCase() === account.toLowerCase() ? 'Connected owner' : 'Multisig owner'}</span></div>)}</div>
      </section>

      <div className="admin-content-grid">
        <section className="panel">
          <div className="panel-heading"><div><p className="eyebrow">PROPOSE ADMIN ACTION</p><h2>New proposal</h2></div></div>
          {!isOwner && <p className="error-note">Connected wallet is not a multisig owner.</p>}
          <form ref={formRef} className="stack-form" onSubmit={(event) => event.preventDefault()}>
            <label>Action
              <select name="action" value={action} onChange={(event) => setAction(event.target.value)}>
                <option value="registerCourt">Register court</option>
                <option value="assignCourtOfficial">Assign court official</option>
                <option value="grantRole">Grant role</option>
                <option value="revokeRole">Revoke role</option>
              </select>
            </label>
            {action === 'registerCourt' && <>
              <label>Court name<input name="name" placeholder="District Court" required /></label>
              <label>Location<input name="location" placeholder="Kochi" required /></label>
            </>}
            {action === 'assignCourtOfficial' && <>
              <label>Registered court<select name="courtId" required defaultValue=""><option value="" disabled>Select a court</option>{courts.map((court) => <option value={court.id} key={court.id}>{court.name} · {court.location}</option>)}</select></label>
              <label>Official wallet<input name="official" placeholder="0x…" pattern="^0x[a-fA-F0-9]{40}$" required /></label>
            </>}
            {(action === 'grantRole' || action === 'revokeRole') && <>
              <label>Role<select name="role" defaultValue="INVESTIGATOR"><option value="INVESTIGATOR">Investigator</option><option value="FORENSIC">Forensic analyst</option></select></label>
              <label>Account<input name="account" placeholder="0x…" pattern="^0x[a-fA-F0-9]{40}$" required /></label>
            </>}
            <TxButton disabled={!isOwner || busy} onClick={() => propose(formRef.current)} onSuccess={refresh}>Propose &amp; approve</TxButton>
          </form>
          <p className="form-help">A proposal counts its creator&apos;s approval. The transaction must reach {threshold} approvals and be executed before changing registry state.</p>
        </section>

        <section className="panel">
          <div className="panel-heading"><div><p className="eyebrow">REGISTERED JURISDICTIONS</p><h2>Courts</h2></div><span className="count-pill">{courts.length}</span></div>
          {courts.length === 0 ? <p className="muted">No courts have been registered.</p> : (
            <div className="court-table">
              {courts.map((court) => <div className="court-table-row" key={court.id}><strong>{court.name}</strong><span>{court.location}</span><code title={court.id}>{court.id.slice(0, 12)}…</code></div>)}
            </div>
          )}
        </section>
      </div>

      <section className="panel">
        <div className="panel-heading"><div><p className="eyebrow">MULTISIG QUEUE</p><h2>Proposals</h2></div><span className="count-pill">{proposals.length}</span></div>
        {proposals.length === 0 ? <p className="muted">{busy ? 'Loading proposals…' : 'No proposals created yet.'}</p> : (
          <div className="proposal-list">
            {[...proposals].reverse().map((proposal) => {
              const decoded = proposal.method
                ? { method: proposal.method, args: proposal.args }
                : chain.decodeProposal(proposal.data)
              const ownIndex = owners.findIndex((owner) => owner.toLowerCase() === account.toLowerCase())
              const approved = ownIndex >= 0 && (proposal.approvedByOwner?.[ownIndex] ?? proposal.approvedByOwner)
              const actionName = decoded?.method || 'Unknown registry call'
              const complete = proposal.approvals >= threshold
              return (
                <article className="proposal-card" key={proposal.id}>
                  <div className="proposal-card-heading"><strong>Proposal #{proposal.id}</strong><StatusChip kind={proposal.executed ? 'closed' : 'open'}>{proposal.executed ? 'Executed' : 'Pending'}</StatusChip></div>
                  <div className="proposal-details">
                    <span><small>Target</small><AddressTag address={proposal.to} /></span>
                    <span><small>Action</small><strong>{actionName}</strong></span>
                    <span><small>Approvals</small><strong>{proposal.approvals} / {threshold}</strong></span>
                  </div>
                  {decoded?.args?.length > 0 && <code className="decoded-args">{decoded.args.map((value) => typeof value === 'bigint' ? value.toString() : String(value)).join(' · ')}</code>}
                  <div className="proposal-buttons">
                    <TxButton
                      className="button button-secondary"
                      disabled={!isOwner || busy || proposal.executed || Boolean(approved)}
                      onClick={() => chain.approveProposal(proposal.id)}
                      onSuccess={refresh}
                    >Approve</TxButton>
                    <TxButton
                      className="button button-quiet"
                      disabled={!isOwner || busy || proposal.executed || !approved}
                      onClick={() => chain.revokeProposalApproval(proposal.id)}
                      onSuccess={refresh}
                    >Revoke my approval</TxButton>
                    <TxButton
                      disabled={!isOwner || busy || proposal.executed || !complete}
                      onClick={() => chain.executeProposal(proposal.id)}
                      onSuccess={refresh}
                    >Execute</TxButton>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
