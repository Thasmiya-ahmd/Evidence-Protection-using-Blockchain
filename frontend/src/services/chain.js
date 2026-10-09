import { Contract, isAddress, ZeroHash } from 'ethers'
import registryArtifact from '../abi/EvidenceRegistry.json'
import multisigArtifact from '../abi/AdminMultisig.json'
import {
  formatCase,
  formatEvidence,
} from '../utils/format'

export const ZERO_HASH = ZeroHash
export const TARGET_CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID || 31337)

export function createChain(signer) {
  const registry = new Contract(
    import.meta.env.VITE_REGISTRY_ADDRESS,
    registryArtifact,
    signer,
  )
  const multisig = new Contract(
    import.meta.env.VITE_MULTISIG_ADDRESS,
    multisigArtifact,
    signer,
  )

  return {
    registry,
    multisig,
    getRole: async (address) => {
      const role = await registry.getUserRole(address)
      return role === 'None' && await multisig.isOwner(address) ? 'Admin' : role
    },
    getMyCases: async () => Array.from(await registry.getMyCases(), formatCase),
    getCase: async (caseId) => formatCase(await registry.getCase(caseId)),
    getCaseEvidence: async (caseId) =>
      Array.from(await registry.getCaseEvidence(caseId), formatEvidence),
    getEvidence: async (id) => formatEvidence(await registry.getEvidence(id)),
    getCustodyHistory: (id) => registry.getCustodyHistory(id),
    getStatusHistory: (id) => registry.getStatusHistory(id),
    getAnalysts: (caseId) => registry.getAnalysts(caseId),
    getMyHeldEvidence: async () =>
      Array.from(await registry.getMyHeldEvidence(), (id) => id.toString()),
    getLocations: () => registry.getLocations(),
    getCourtForLocation: async (location) => {
      const [id, name] = await registry.getCourtForLocation(location)
      return { id, name }
    },
    getCourts: async () => {
      const [ids, names, locations] = await registry.getCourts()
      return ids.map((id, index) => ({ id, name: names[index], location: locations[index] }))
    },
    getCourtName: (courtId) => registry.courtName(courtId),
    getOfficialCourt: (address) => registry.officialCourt(address),
    openCase: (caseId, title, location) => registry.openCase(caseId, title, location),
    rejectCase: (caseId, reason) => registry.rejectCase(caseId, reason),
    closeCase: (caseId, note) => registry.closeCase(caseId, note),
    assignAnalyst: (caseId, analyst) => registry.assignAnalyst(caseId, analyst),
    removeAnalyst: (caseId, analyst) => registry.removeAnalyst(caseId, analyst),
    registerEvidence: (input) => registry.registerEvidence(input),
    transferCustody: (id, newHolder, reason) =>
      registry.transferCustody(id, newHolder, reason),
    submitToCourt: (id, note) => registry.submitToCourt(id, note),
    flagEvidence: (id, reason) => registry.flagEvidence(id, reason),
    resolveFlag: (id, note) => registry.resolveFlag(id, note),
    revokeEvidence: (id, reason) => registry.revokeEvidence(id, reason),
    verify: (id, fileHash) => registry.verify(id, fileHash),
    recordVerification: (id, fileHash) => registry.recordVerification(id, fileHash),
    logAccess: (id, purpose) => registry.logAccess(id, purpose),
    isOwner: (address) => multisig.isOwner(address),
    getOwners: () => multisig.getOwners(),
    getThreshold: async () => Number(await multisig.threshold()),
    getProposalCount: async () => Number(await multisig.proposalCount()),
    getProposal: async (id) => {
      const [to, data, executed, approvals] = await multisig.getProposal(id)
      const owners = await multisig.getOwners()
      const approvedByOwner = await Promise.all(
        owners.map((owner) => multisig.approvedBy(id, owner)),
      )
      return {
        id: String(id),
        to,
        data,
        executed,
        approvals: Number(approvals),
        approvedByOwner,
      }
    },
    decodeProposal: (data) => {
      const parsed = registry.interface.parseTransaction({ data })
      return parsed ? { method: parsed.name, args: Array.from(parsed.args) } : null
    },
    getRoleHash: (role) => {
      const functionName = {
        INVESTIGATOR: 'INVESTIGATOR_ROLE',
        FORENSIC: 'FORENSIC_ROLE',
        COURT: 'COURT_ROLE',
      }[role]
      if (!functionName) throw new Error('Unknown registry role')
      return registry[functionName]()
    },
    proposeRegistryCall: async (method, args) => {
      if (!['registerCourt', 'assignCourtOfficial', 'grantRole', 'revokeRole'].includes(method)) {
        throw new Error('Unsupported admin action')
      }
      if (method === 'assignCourtOfficial' && !isAddress(args[0])) {
        throw new Error('Invalid court official address')
      }
      const data = registry.interface.encodeFunctionData(method, args)
      return multisig.propose(await registry.getAddress(), data)
    },
    approveProposal: (id) => multisig.approve(id),
    revokeProposalApproval: (id) => multisig.revokeApproval(id),
    executeProposal: (id) => multisig.execute(id),
    listenForCourtEvents: async (courtId, fromBlock, onEvents) => {
      const latest = await registry.runner.provider.getBlockNumber()
      const events = []
      const queries = [
        ['CaseOpened', registry.filters.CaseOpened(courtId)],
        ['EvidenceRegistered', registry.filters.EvidenceRegistered(null, courtId)],
        ['EvidenceSubmittedToCourt', registry.filters.EvidenceSubmittedToCourt(null, courtId)],
      ]
      for (const [name, filter] of queries) {
        const past = await registry.queryFilter(filter, fromBlock, latest)
        for (const event of past) events.push(await shapeNotification(name, event))
      }
      if (events.length) onEvents(events)

      const listeners = []
      for (const [name, filter] of queries) {
        const listener = (...args) => {
          const event = args.at(-1)
          shapeNotification(name, event)
            .then((notification) => onEvents([notification]))
            .catch((error) => console.error('Court notification failed:', error))
        }
        registry.on(filter, listener)
        listeners.push([filter, listener])
      }
      return () => {
        for (const [filter, listener] of listeners) {
          registry.off(filter, listener)
        }
      }
    },
  }

  async function shapeNotification(name, event) {
    const timestamp = (await registry.runner.provider.getBlock(event.blockNumber))?.timestamp
    const args = event.args
    if (name === 'CaseOpened') {
      return {
        key: `${event.transactionHash}-${event.index}`,
        type: name,
        text: `New case opened: ${args.caseId}`,
        caseId: args.caseId,
        blockNumber: event.blockNumber,
        timestamp: String(timestamp || args.timestamp),
      }
    }
    return {
      key: `${event.transactionHash}-${event.index}`,
      type: name,
      text:
        name === 'EvidenceRegistered'
          ? `New evidence #${args.id} registered`
          : `Evidence #${args.id} submitted to court`,
      evidenceId: args.id.toString(),
      blockNumber: event.blockNumber,
      timestamp: String(timestamp || args.timestamp),
    }
  }
}
