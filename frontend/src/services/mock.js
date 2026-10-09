import { ZeroHash } from 'ethers'

const mockCase = {
  caseId: 'CASE-2026-001',
  title: 'Seized laptop',
  location: 'Ernakulam',
  courtId: `0x${'ab'.repeat(32)}`,
  leadInvestigator: '0x1000000000000000000000000000000000000001',
  status: 'Open',
  createdAt: String(Math.floor(Date.now() / 1000) - 3600),
}

let caseRecords = [mockCase]
let analysts = ['0x2000000000000000000000000000000000000002']
let evidenceRecords = [
  {
    id: '1',
    caseId: mockCase.caseId,
    description: 'Seized laptop',
    location: 'Records office',
    collectionMethod: 'Seized',
    fileHash: `0x${'12'.repeat(32)}`,
    certificateHash: ZeroHash,
    collector: mockCase.leadInvestigator,
    currentHolder: mockCase.leadInvestigator,
    stage: 'Collected',
    status: 'Active',
    createdAt: String(Math.floor(Date.now() / 1000) - 1800),
  },
]
let proposals = []
let nextEvidenceId = 2
const mockFiles = new Map()

function mockTx() {
  const hash = `0x${Array.from({ length: 64 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join('')}`
  return { hash, wait: async () => ({ hash, blockNumber: 100 }) }
}

export const MOCK_ACCOUNTS = {
  Investigator: '0x1000000000000000000000000000000000000001',
  'Forensic Analyst': '0x2000000000000000000000000000000000000002',
  'Court Official': '0x3000000000000000000000000000000000000003',
  Admin: '0x4000000000000000000000000000000000000004',
}

export function createMockChain(role, address) {
  const walletAddress = address || MOCK_ACCOUNTS[role] || MOCK_ACCOUNTS.Investigator
  return {
    registry: null,
    multisig: null,
    getRole: async () => role,
    getMyCases: async () =>
      role === 'Admin'
        ? []
        : role === 'Court Official'
          ? caseRecords
          : caseRecords.filter(
              (item) =>
                item.leadInvestigator.toLowerCase() === walletAddress.toLowerCase() ||
                analysts.some((analyst) => analyst.toLowerCase() === walletAddress.toLowerCase()),
            ),
    getCase: async (caseId) => {
      const found = caseRecords.find((item) => item.caseId === caseId)
      if (!found || role === 'Admin') throw new Error("You don't have access to this case")
      return found
    },
    getCaseEvidence: async (caseId) =>
      evidenceRecords.filter((item) => item.caseId === caseId),
    getEvidence: async (id) => evidenceRecords.find((item) => item.id === String(id)),
    getCustodyHistory: async (id) => {
      const item = evidenceRecords.find((record) => record.id === String(id))
      return item
        ? [{ from: '0x0000000000000000000000000000000000000000', to: item.collector, stage: 0, reason: 'Evidence collected', timestamp: item.createdAt }]
        : []
    },
    getStatusHistory: async () => [],
    getAnalysts: async () => analysts,
    getMyHeldEvidence: async () =>
      evidenceRecords
        .filter((item) => item.currentHolder.toLowerCase() === walletAddress.toLowerCase())
        .map((item) => item.id),
    getLocations: async () => ['Ernakulam', 'Kollam', 'Kozhikode'],
    getCourtForLocation: async (location) => ({
      id: `0x${'ab'.repeat(32)}`,
      name: `${location} District Court`,
    }),
    getCourts: async () =>
      ['Ernakulam', 'Kollam', 'Kozhikode'].map((location, index) => ({
        id: `0x${String(index + 1).padStart(2, '0').repeat(32)}`,
        name: `${location} District Court`,
        location,
      })),
    getCourtName: async () => 'Ernakulam District Court',
    getOfficialCourt: async () => `0x${'ab'.repeat(32)}`,
    openCase: async (caseId, title, location) => {
      caseRecords.push({ ...mockCase, caseId, title, location, leadInvestigator: walletAddress })
      return mockTx()
    },
    rejectCase: async (caseId, reason) => {
      const item = caseRecords.find((record) => record.caseId === caseId)
      item.status = 'Rejected'
      item.note = reason
      return mockTx()
    },
    closeCase: async (caseId, note) => {
      const item = caseRecords.find((record) => record.caseId === caseId)
      item.status = 'Closed'
      item.note = note
      return mockTx()
    },
    assignAnalyst: async (_caseId, analyst) => {
      analysts = [...new Set([...analysts, analyst])]
      return mockTx()
    },
    removeAnalyst: async (_caseId, analyst) => {
      if (evidenceRecords.some((item) => item.currentHolder === analyst && item.stage !== 'SubmittedToCourt')) {
        throw new Error('Analyst still holds evidence')
      }
      analysts = analysts.filter((item) => item !== analyst)
      return mockTx()
    },
    registerEvidence: async (input) => {
      evidenceRecords.push({
        ...input,
        id: String(nextEvidenceId++),
        certificateHash: input.certificateHash || ZeroHash,
        collector: walletAddress,
        currentHolder: walletAddress,
        stage: 'Collected',
        status: 'Active',
        createdAt: String(Math.floor(Date.now() / 1000)),
      })
      return mockTx()
    },
    transferCustody: async (id, newHolder, reason) => {
      const item = evidenceRecords.find((record) => record.id === String(id))
      item.currentHolder = newHolder
      item.stage = analysts.includes(newHolder) ? 'ForensicAnalysis' : 'Collected'
      item.reason = reason
      return mockTx()
    },
    submitToCourt: async (id) => {
      evidenceRecords.find((record) => record.id === String(id)).stage = 'SubmittedToCourt'
      return mockTx()
    },
    flagEvidence: async (id, reason) => {
      const item = evidenceRecords.find((record) => record.id === String(id))
      item.status = 'Flagged'
      item.reason = reason
      return mockTx()
    },
    resolveFlag: async (id) => {
      evidenceRecords.find((record) => record.id === String(id)).status = 'Active'
      return mockTx()
    },
    revokeEvidence: async (id) => {
      evidenceRecords.find((record) => record.id === String(id)).status = 'Revoked'
      return mockTx()
    },
    verify: async (id, hash) =>
      evidenceRecords.find((record) => record.id === String(id)).fileHash.toLowerCase() === hash.toLowerCase(),
    recordVerification: async () => mockTx(),
    logAccess: async () => mockTx(),
    isOwner: async (owner) => owner.toLowerCase() === walletAddress.toLowerCase(),
    getOwners: async () => [
      walletAddress,
      '0x5000000000000000000000000000000000000005',
      '0x6000000000000000000000000000000000000006',
    ],
    getThreshold: async () => 2,
    getProposalCount: async () => proposals.length,
    getProposal: async (id) => proposals[Number(id)],
    decodeProposal: (data) => {
      const proposal = proposals.find((item) => item.data === data)
      return proposal ? { method: proposal.method, args: proposal.args } : null
    },
    getRoleHash: async (name) => `0x${String(name.length).padStart(2, '0').repeat(32)}`,
    proposeRegistryCall: async (method, args) => {
      proposals.push({
        id: String(proposals.length),
        to: '0x7000000000000000000000000000000000000007',
        method,
        args,
        data: '0x12345678',
        executed: false,
        approvals: 1,
        approvedByOwner: false,
      })
      return mockTx()
    },
    approveProposal: async (id) => {
      const item = proposals[Number(id)]
      item.approvals += 1
      item.approvedByOwner = true
      return mockTx()
    },
    revokeProposalApproval: async (id) => {
      const item = proposals[Number(id)]
      item.approvals -= 1
      item.approvedByOwner = false
      return mockTx()
    },
    executeProposal: async (id) => {
      proposals[Number(id)].executed = true
      return mockTx()
    },
    listenForCourtEvents: async () => () => {},
  }
}

export const mockApi = {
  loginWithWallet: async () => 'mock-session',
  uploadEvidenceFile: async (file) => {
    const buffer = await file.arrayBuffer()
    const digest = await crypto.subtle.digest('SHA-256', buffer)
    const fileHash = `0x${Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')}`
    mockFiles.set(fileHash, buffer)
    return {
      fileHash,
    }
  },
  linkEvidenceFile: async (fileHash, evidenceId) => ({ fileHash, evidenceId, linked: true }),
  downloadEvidenceFile: async (hash) => {
    const content = mockFiles.get(hash)
    if (!content) throw new Error('Mock file is not available')
    return content
  },
}
