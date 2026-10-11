import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const contracts = [
  {
    artifactPath: path.resolve(
      backendDir,
      '..',
      'blockchain',
      'artifacts',
      'contracts',
      'EvidenceRegistry.sol',
      'EvidenceRegistry.json',
    ),
    destination: path.join(backendDir, 'src', 'abi', 'EvidenceRegistry.json'),
    name: 'EvidenceRegistry',
  },
  {
    artifactPath: path.resolve(
      backendDir,
      '..',
      'blockchain',
      'artifacts',
      'contracts',
      'PeopleRegistry.sol',
      'PeopleRegistry.json',
    ),
    destination: path.join(backendDir, 'src', 'abi', 'PeopleRegistry.json'),
    name: 'PeopleRegistry',
  },
  {
    artifactPath: path.resolve(
      backendDir,
      '..',
      'blockchain',
      'artifacts',
      'contracts',
      'AdminMultisig.sol',
      'AdminMultisig.json',
    ),
    destination: path.join(backendDir, 'src', 'abi', 'AdminMultisig.json'),
    name: 'AdminMultisig',
  },
]

await fs.mkdir(path.join(backendDir, 'src', 'abi'), { recursive: true })

for (const { artifactPath, destination, name } of contracts) {
  const content = await fs.readFile(artifactPath, 'utf8')
  const artifact = JSON.parse(content)
  if (!Array.isArray(artifact.abi)) {
    throw new Error(`The contract artifact has no ABI array: ${artifactPath}`)
  }
  await fs.writeFile(destination, `${JSON.stringify(artifact.abi, null, 2)}\n`, 'utf8')
  console.log(`Copied ${name} ABI to ${path.relative(backendDir, destination)}`)
}
