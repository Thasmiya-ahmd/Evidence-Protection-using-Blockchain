import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const artifactPath = path.resolve(
  backendDir,
  '..',
  'blockchain',
  'artifacts',
  'contracts',
  'EvidenceRegistry.sol',
  'EvidenceRegistry.json',
)
const destination = path.join(backendDir, 'src', 'abi', 'EvidenceRegistry.json')
const artifact = JSON.parse(await fs.readFile(artifactPath, 'utf8'))
if (!Array.isArray(artifact.abi)) throw new Error(`The contract artifact has no ABI array: ${artifactPath}`)
await fs.mkdir(path.dirname(destination), { recursive: true })
await fs.writeFile(destination, `${JSON.stringify(artifact.abi, null, 2)}\n`)
console.log(`Copied EvidenceRegistry ABI to ${path.relative(backendDir, destination)}`)
