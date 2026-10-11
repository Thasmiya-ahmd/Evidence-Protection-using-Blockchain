import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const deploymentPath = path.resolve(backendDir, '..', 'blockchain', 'deployments', 'localhost.json')

if (!fs.existsSync(deploymentPath)) {
  console.error(`Deployment file not found at ${deploymentPath}`)
  process.exit(1)
}

const data = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'))

console.log('Copy and paste these into backend/.env:')
console.log(`REGISTRY_ADDRESS=${data.registry}`)
console.log(`MULTISIG_ADDRESS=${data.multisig}`)
console.log(`PEOPLE_ADDRESS=${data.people}`)
