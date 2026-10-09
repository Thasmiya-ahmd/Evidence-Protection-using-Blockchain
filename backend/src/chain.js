import { Contract, JsonRpcProvider, getAddress } from 'ethers'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { forbidden, unavailable } from './utils/errors.js'

const registryAbiPath = fileURLToPath(new URL('./abi/EvidenceRegistry.json', import.meta.url))
const registryAbi = JSON.parse(fs.readFileSync(registryAbiPath, 'utf8'))

export function createChain({ rpcUrl, registryAddress }) {
  const provider = new JsonRpcProvider(rpcUrl)
  const registry = new Contract(registryAddress, registryAbi, provider)

  async function getRole(address) {
    try {
      return await registry.getUserRole(getAddress(address))
    } catch {
      throw unavailable('Could not read the current wallet role from blockchain')
    }
  }

  async function hashToId(fileHash) {
    try {
      return (await registry.hashToId(fileHash)).toString()
    } catch {
      throw unavailable('Could not look up the evidence hash on blockchain')
    }
  }

  async function getEvidenceAs(evidenceId, address) {
    try {
      return await registry.getEvidence.staticCall(evidenceId, { from: getAddress(address) })
    } catch (error) {
      if (isAccessRevert(error)) return null
      throw unavailable('Could not check evidence access on blockchain')
    }
  }

  async function canView(evidenceId, address) {
    return Boolean(await getEvidenceAs(evidenceId, address))
  }

  async function onChainVerify(evidenceId, fileHash, address) {
    const evidence = await getEvidenceAs(evidenceId, address)
    if (!evidence) throw forbidden()
    const primaryHash = String(evidence.fileHash).toLowerCase()
    const certificateHash = String(evidence.certificateHash).toLowerCase()
    let matches = false
    if (primaryHash === fileHash.toLowerCase()) {
      try {
        matches = await registry.verify.staticCall(evidenceId, fileHash, { from: getAddress(address) })
      } catch (error) {
        if (isAccessRevert(error)) throw forbidden()
        throw unavailable('Could not verify the evidence hash on blockchain')
      }
    } else if (certificateHash === fileHash.toLowerCase()) {
      matches = true
    }
    return { registered: true, evidenceId: String(evidenceId), matches }
  }

  async function verifyLinkedFile(evidenceId, fileHash, address, kind) {
    const evidence = await getEvidenceAs(evidenceId, address)
    if (!evidence) throw forbidden()
    const fieldHash = kind === 'certificate' ? evidence.certificateHash : evidence.fileHash
    if (String(fieldHash).toLowerCase() !== fileHash.toLowerCase()) {
      throw forbidden('The evidence record does not contain this file hash in the expected field')
    }
    return { registered: true, evidenceId: String(evidenceId), matches: true }
  }

  return { provider, registry, getRole, hashToId, canView, onChainVerify, verifyLinkedFile }
}

export async function assertChainReady(chain, expectedChainId, registryAddress) {
  let network
  try {
    network = await chain.provider.getNetwork()
  } catch {
    throw new Error('Blockchain startup check failed: RPC_URL is unreachable or did not return a network ID')
  }
  if (Number(network.chainId) !== expectedChainId) {
    throw new Error(`Blockchain startup check failed: RPC chain ID ${network.chainId} does not match configured CHAIN_ID ${expectedChainId}`)
  }
  let code
  try {
    await chain.provider.getBlockNumber()
    code = await chain.provider.getCode(registryAddress)
  } catch {
    throw new Error('Blockchain startup check failed: RPC_URL could not read the current block or contract code')
  }
  if (!code || code === '0x') {
    throw new Error(`Blockchain startup check failed: no contract code exists at REGISTRY_ADDRESS ${registryAddress}`)
  }
}

function isAccessRevert(error) {
  const text = [
    error?.reason,
    error?.shortMessage,
    error?.message,
    error?.info?.error?.message,
  ].filter(Boolean).join(' ')
  return /not authorized for this case/i.test(text)
}
