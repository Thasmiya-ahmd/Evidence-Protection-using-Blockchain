export const CASE_STATUSES = ['None', 'Open', 'Rejected', 'Closed']
export const EVIDENCE_STAGES = ['Collected', 'ForensicAnalysis', 'SubmittedToCourt']
export const EVIDENCE_STATUSES = ['Active', 'Flagged', 'Revoked']

export function formatCase(item) {
  return {
    caseId: item.caseId,
    title: item.title,
    location: item.location,
    courtId: item.courtId,
    leadInvestigator: item.leadInvestigator,
    status: CASE_STATUSES[Number(item.status)] || 'Unknown',
    createdAt: String(item.createdAt),
  }
}

export function formatEvidence(item) {
  return {
    id: String(item.id),
    caseId: item.caseId,
    description: item.description,
    location: item.location,
    collectionMethod: item.collectionMethod,
    fileHash: item.fileHash,
    certificateHash: item.certificateHash,
    collector: item.collector,
    currentHolder: item.currentHolder,
    stage: EVIDENCE_STAGES[Number(item.stage)] || 'Unknown',
    status: EVIDENCE_STATUSES[Number(item.status)] || 'Unknown',
    createdAt: String(item.createdAt),
  }
}

export function formatTimestamp(seconds) {
  const value = new Date(Number(seconds) * 1000)
  return Number.isNaN(value.getTime()) ? 'Unknown time' : value.toLocaleString()
}

export function shortAddress(value = '') {
  return value ? `${value.slice(0, 6)}…${value.slice(-4)}` : '—'
}

export function shortHash(value = '', size = 12) {
  if (!value) return '—'
  return `${value.slice(0, size + 2)}…${value.slice(-6)}`
}

export function copyText(value) {
  return navigator.clipboard.writeText(value)
}
