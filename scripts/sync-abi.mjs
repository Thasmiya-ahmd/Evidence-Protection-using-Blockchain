import fs from 'node:fs'
import path from 'node:path'

const frontendAbiDir = path.resolve('./frontend/src/abi')
const backendAbiDir = path.resolve('./backend/src/abi')

const registryArtifact = JSON.parse(
  fs.readFileSync('./blockchain/artifacts/contracts/EvidenceRegistry.sol/EvidenceRegistry.json', 'utf8')
)
const multisigArtifact = JSON.parse(
  fs.readFileSync('./blockchain/artifacts/contracts/AdminMultisig.sol/AdminMultisig.json', 'utf8')
)

fs.mkdirSync(frontendAbiDir, { recursive: true })
fs.mkdirSync(backendAbiDir, { recursive: true })

fs.writeFileSync(
  path.join(frontendAbiDir, 'EvidenceRegistry.json'),
  JSON.stringify(registryArtifact.abi, null, 2)
)
fs.writeFileSync(
  path.join(frontendAbiDir, 'AdminMultisig.json'),
  JSON.stringify(multisigArtifact.abi, null, 2)
)
fs.writeFileSync(
  path.join(backendAbiDir, 'EvidenceRegistry.json'),
  JSON.stringify(registryArtifact.abi, null, 2)
)

console.log('ABIs synced successfully.')
