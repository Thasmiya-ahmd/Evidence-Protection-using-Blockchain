import { Contract, JsonRpcProvider, getAddress } from 'ethers'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { forbidden, unavailable } from './utils/errors.js'

const registryAbiPath = fileURLToPath(new URL('./abi/EvidenceRegistry.json', import.meta.url))
const registryAbi = JSON.parse(fs.readFileSync(registryAbiPath, 'utf8'))

const peopleAbiPath = fileURLToPath(new URL('./abi/PeopleRegistry.json', import.meta.url))
const peopleAbi = JSON.parse(fs.readFileSync(peopleAbiPath, 'utf8'))

const multisigAbiPath = fileURLToPath(new URL('./abi/AdminMultisig.json', import.meta.url))
const multisigAbi = JSON.parse(fs.readFileSync(multisigAbiPath, 'utf8'))

export function getRevertReason(error) {
  return [
    error?.reason,
    error?.shortMessage,
    error?.message,
    error?.info?.error?.message,
    error?.data?.message,
  ].filter(Boolean).join(' ')
}

export function isConnectionError(error) {
  const text = [
    error?.code,
    error?.message,
    error?.shortMessage,
    error?.cause?.code,
    error?.cause?.message,
  ].filter(Boolean).join(' ').toLowerCase()
  return (
    text.includes('econnrefused') ||
    text.includes('econnreset') ||
    text.includes('etimedout') ||
    text.includes('timeout') ||
    text.includes('network') ||
    text.includes('fetch failed') ||
    text.includes('failed to fetch') ||
    text.includes('could not detect network') ||
    error?.code === 'NETWORK_ERROR' ||
    error?.code === 'SERVER_ERROR' ||
    error?.code === 'TIMEOUT'
  )
}

export function toPlainObject(item) {
  if (typeof item === 'bigint') {
    return item.toString()
  }
  if (Array.isArray(item)) {
    return item.map(toPlainObject)
  }
  if (item !== null && typeof item === 'object') {
    const keys = Object.keys(item)
    const hasNamedKeys = keys.some((k) => isNaN(Number(k)))
    const result = {}
    for (const key of keys) {
      if (hasNamedKeys && !isNaN(Number(key))) continue
      result[key] = toPlainObject(item[key])
    }
    return result
  }
  return item
}

export function createChain({ rpcUrl, registryAddress, multisigAddress, peopleAddress }) {
  const provider = new JsonRpcProvider(rpcUrl)
  const registry = new Contract(registryAddress, registryAbi, provider)
  const people = peopleAddress ? new Contract(peopleAddress, peopleAbi, provider) : null
  const multisig = multisigAddress ? new Contract(multisigAddress, multisigAbi, provider) : null

  async function resolveUserRole(address) {
    const checksum = getAddress(address)
    try {
      const role = await registry.getUserRole(checksum)
      const isMultisigOwner = role === 'Admin'
      return { address: checksum, role, isMultisigOwner }
    } catch (error) {
      if (isConnectionError(error)) {
        throw unavailable('Blockchain service is unavailable')
      }
      throw unavailable('Could not read user role from blockchain')
    }
  }

  async function getRole(address) {
    const info = await resolveUserRole(address)
    return info.role
  }

  async function hashToId(fileHash) {
    try {
      const id = await registry.hashToId(fileHash)
      return id.toString()
    } catch (error) {
      if (isConnectionError(error)) {
        throw unavailable('Blockchain service is unavailable')
      }
      throw unavailable('Could not look up the evidence hash on blockchain')
    }
  }

  async function getEvidence(evidenceId, asAddress) {
    try {
      const evidence = await registry.getEvidence.staticCall(evidenceId, { from: getAddress(asAddress) })
      return {
        id: toPlainObject(evidence.id),
        caseId: evidence.caseId,
        description: evidence.description,
        location: evidence.location,
        collectionMethod: evidence.collectionMethod,
        fileHash: evidence.fileHash,
        collector: evidence.collector,
        currentHolder: evidence.currentHolder,
        stage: toPlainObject(evidence.stage),
        status: toPlainObject(evidence.status),
        review: toPlainObject(evidence.review),
        createdAt: toPlainObject(evidence.createdAt),
      }
    } catch (error) {
      const reason = getRevertReason(error)
      if (/not authorized for this case/i.test(reason)) {
        throw forbidden('Not authorized for this case')
      }
      if (/evidence not found/i.test(reason)) {
        return null
      }
      if (isConnectionError(error)) {
        throw unavailable('Blockchain service is unavailable')
      }
      throw unavailable(`Could not read evidence from blockchain: ${reason || error.message}`)
    }
  }

  async function getEvidenceDocs(evidenceId, asAddress) {
    try {
      const docs = await registry.getEvidenceDocs.staticCall(evidenceId, { from: getAddress(asAddress) })
      return {
        seizedAt: toPlainObject(docs.seizedAt),
        isElectronic: docs.isElectronic,
        seizureMemoHash: docs.seizureMemoHash,
        recordingHash: docs.recordingHash,
        certificateHash: docs.certificateHash,
      }
    } catch (error) {
      const reason = getRevertReason(error)
      if (/not authorized for this case/i.test(reason)) {
        throw forbidden('Not authorized for this case')
      }
      if (/evidence not found/i.test(reason)) {
        return null
      }
      if (isConnectionError(error)) {
        throw unavailable('Blockchain service is unavailable')
      }
      throw unavailable(`Could not read evidence docs from blockchain: ${reason || error.message}`)
    }
  }

  async function getAnalysisReports(evidenceId, asAddress) {
    try {
      const reports = await registry.getAnalysisReports.staticCall(evidenceId, { from: getAddress(asAddress) })
      return reports.map((report) => ({
        analyst: report.analyst,
        reportHash: report.reportHash,
        note: report.note,
        timestamp: toPlainObject(report.timestamp),
      }))
    } catch (error) {
      const reason = getRevertReason(error)
      if (/not authorized for this case/i.test(reason)) {
        throw forbidden('Not authorized for this case')
      }
      if (/evidence not found/i.test(reason)) {
        return []
      }
      if (isConnectionError(error)) {
        throw unavailable('Blockchain service is unavailable')
      }
      throw unavailable(`Could not read analysis reports from blockchain: ${reason || error.message}`)
    }
  }

  async function getProfile(address) {
    if (!people) {
      throw unavailable('People registry is not configured')
    }
    try {
      const p = await people.profileOf(getAddress(address))
      const statusMap = ['None', 'Pending', 'Active', 'Rejected', 'Suspended']
      const roleMap = ['None', 'Investigator', 'Analyst', 'CourtOfficial']
      const statusNum = Number(p.status)
      const roleNum = Number(p.role)
      const unitId = p.unitId.toString()

      let unitName = ''
      let unitLocation = ''
      if (unitId !== '0') {
        const u = await people.unitInfo(unitId)
        unitName = u[1]
        unitLocation = u[2]
      }

      return {
        status: statusMap[statusNum] || 'None',
        role: roleMap[roleNum] || 'None',
        unitId,
        unitName,
        unitLocation,
        detailsHash: p.detailsHash,
        requestedAt: p.requestedAt.toString(),
        decidedAt: p.decidedAt.toString(),
      }
    } catch (error) {
      if (isConnectionError(error)) {
        throw unavailable('Blockchain service is unavailable')
      }
      throw unavailable('Could not read profile from blockchain')
    }
  }

  async function onChainVerify(evidenceId, fileHash, address, kind) {
    if (!evidenceId || evidenceId === '0') {
      return { registered: false, evidenceId: null, matches: false }
    }
    const evidence = await getEvidence(evidenceId, address)
    if (!evidence) {
      return { registered: false, evidenceId: String(evidenceId), matches: false }
    }

    const reviewMap = ['Pending', 'Approved', 'Rejected']
    const review = reviewMap[Number(evidence.review)] || 'Pending'

    let matches = false
    const targetHash = fileHash ? fileHash.toLowerCase() : ''

    if (!targetHash || !/^0x[a-fA-F0-9]{64}$/.test(targetHash)) {
      return { registered: true, evidenceId: String(evidenceId), matches: false, review }
    }

    if (kind === 'evidence') {
      try {
        matches = await registry.verify.staticCall(evidenceId, targetHash, { from: getAddress(address) })
      } catch (error) {
        const reason = getRevertReason(error)
        if (/not authorized for this case/i.test(reason)) {
          throw forbidden('Not authorized for this case')
        }
        if (isConnectionError(error)) {
          throw unavailable('Blockchain service is unavailable')
        }
        throw unavailable('Could not verify the evidence hash on blockchain')
      }
      return { registered: true, evidenceId: String(evidenceId), matches: Boolean(matches), review }
    }

    if (kind === 'seizure_memo' || kind === 'recording' || kind === 'certificate') {
      const docs = await getEvidenceDocs(evidenceId, address)
      if (docs) {
        if (kind === 'seizure_memo') matches = String(docs.seizureMemoHash).toLowerCase() === targetHash
        else if (kind === 'recording') matches = String(docs.recordingHash).toLowerCase() === targetHash
        else if (kind === 'certificate') matches = String(docs.certificateHash).toLowerCase() === targetHash
      }
      return { registered: true, evidenceId: String(evidenceId), matches: Boolean(matches), review }
    }

    if (kind === 'report') {
      const reports = await getAnalysisReports(evidenceId, address)
      if (Array.isArray(reports)) {
        matches = reports.some((r) => String(r.reportHash).toLowerCase() === targetHash)
      }
      return { registered: true, evidenceId: String(evidenceId), matches: Boolean(matches), review }
    }

    // Default verify
    try {
      matches = await registry.verify.staticCall(evidenceId, targetHash, { from: getAddress(address) })
    } catch (error) {
      const reason = getRevertReason(error)
      if (/not authorized for this case/i.test(reason)) {
        throw forbidden('Not authorized for this case')
      }
      if (isConnectionError(error)) {
        throw unavailable('Blockchain service is unavailable')
      }
      throw unavailable('Could not verify the evidence hash on blockchain')
    }
    return { registered: true, evidenceId: String(evidenceId), matches: Boolean(matches), review }
  }

  async function verifyLinkedFile(evidenceId, fileHash, address, kind) {
    const targetHash = fileHash.toLowerCase()
    if (kind === 'evidence') {
      const evidence = await getEvidence(evidenceId, address)
      if (!evidence) throw forbidden('Not authorized for this case or evidence not found')
      if (String(evidence.fileHash).toLowerCase() !== targetHash) {
        return false
      }
      return true
    }

    if (kind === 'seizure_memo' || kind === 'recording' || kind === 'certificate') {
      const docs = await getEvidenceDocs(evidenceId, address)
      if (!docs) throw forbidden('Not authorized for this case or evidence not found')
      if (kind === 'seizure_memo' && String(docs.seizureMemoHash).toLowerCase() === targetHash) return true
      if (kind === 'recording' && String(docs.recordingHash).toLowerCase() === targetHash) return true
      if (kind === 'certificate' && String(docs.certificateHash).toLowerCase() === targetHash) return true
      return false
    }

    if (kind === 'report') {
      const reports = await getAnalysisReports(evidenceId, address)
      if (!reports || !Array.isArray(reports)) throw forbidden('Not authorized for this case or evidence not found')
      return reports.some((r) => String(r.reportHash).toLowerCase() === targetHash)
    }

    return false
  }

  return {
    provider,
    registry,
    people,
    multisig,
    resolveUserRole,
    getRole,
    hashToId,
    getEvidence,
    getEvidenceDocs,
    getAnalysisReports,
    getProfile,
    onChainVerify,
    verifyLinkedFile,
  }
}

export async function assertChainReady(chain, expectedChainId, registryAddress, multisigAddress, peopleAddress) {
  if (!registryAddress || !multisigAddress || !peopleAddress) {
    throw new Error('Blockchain startup check failed: registry, multisig, and people addresses are required')
  }
  let network
  try {
    network = await chain.provider.getNetwork()
  } catch {
    throw new Error('Blockchain startup check failed: RPC_URL is unreachable or did not return a network ID')
  }
  if (Number(network.chainId) !== expectedChainId) {
    throw new Error(
      `Blockchain startup check failed: RPC chain ID ${network.chainId} does not match configured CHAIN_ID ${expectedChainId}`,
    )
  }
  try {
    await chain.provider.getBlockNumber()
  } catch {
    throw new Error('Blockchain startup check failed: RPC_URL could not read the current block')
  }

  // Check code on all three addresses
  const checkCode = async (addr, name) => {
    let code
    try {
      code = await chain.provider.getCode(addr)
    } catch {
      throw new Error(`Blockchain startup check failed: RPC_URL could not read contract code for ${name}`)
    }
    if (!code || code === '0x') {
      throw new Error(`Blockchain startup check failed: no contract code exists at ${name} ${addr}`)
    }
  }

  await checkCode(registryAddress, 'REGISTRY_ADDRESS')
  if (multisigAddress) await checkCode(multisigAddress, 'MULTISIG_ADDRESS')
  if (peopleAddress) await checkCode(peopleAddress, 'PEOPLE_ADDRESS')

  // Check linked addresses on registry
  try {
    const linkedPeople = await chain.registry.people()
    if (getAddress(linkedPeople) !== getAddress(peopleAddress)) {
      throw new Error(`Blockchain startup check failed: registry.people() (${linkedPeople}) does not match PEOPLE_ADDRESS (${peopleAddress})`)
    }
  } catch (error) {
    if (error.message.includes('startup check failed')) throw error
    throw new Error(`Blockchain startup check failed: could not verify registry.people(): ${error.message}`)
  }

  try {
    const linkedAdmins = await chain.registry.admins()
    if (getAddress(linkedAdmins) !== getAddress(multisigAddress)) {
      throw new Error(`Blockchain startup check failed: registry.admins() (${linkedAdmins}) does not match MULTISIG_ADDRESS (${multisigAddress})`)
    }
  } catch (error) {
    if (error.message.includes('startup check failed')) throw error
    throw new Error(`Blockchain startup check failed: could not verify registry.admins(): ${error.message}`)
  }
}
