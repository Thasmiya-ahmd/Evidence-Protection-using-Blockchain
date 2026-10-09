import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const frontendDirectory = path.resolve(scriptDirectory, '..')
const repositoryDirectory = path.resolve(frontendDirectory, '..')
const abiDirectory = path.join(frontendDirectory, 'src', 'abi')

await mkdir(abiDirectory, { recursive: true })

for (const contractName of ['EvidenceRegistry', 'AdminMultisig']) {
  const artifactPath = path.join(
    repositoryDirectory,
    'blockchain',
    'artifacts',
    'contracts',
    `${contractName}.sol`,
    `${contractName}.json`,
  )
  const artifact = JSON.parse(await readFile(artifactPath, 'utf8'))
  if (!Array.isArray(artifact.abi)) {
    throw new Error(`Compiled artifact has no ABI: ${artifactPath}`)
  }
  await writeFile(
    path.join(abiDirectory, `${contractName}.json`),
    `${JSON.stringify(artifact.abi, null, 2)}\n`,
    'utf8',
  )
  console.log(`Copied ABI: ${contractName}`)
}
