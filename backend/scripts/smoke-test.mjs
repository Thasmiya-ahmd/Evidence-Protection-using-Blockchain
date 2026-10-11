import 'dotenv/config'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Contract, JsonRpcProvider, Wallet, id as ethersId, parseEther } from 'ethers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const backendDir = path.resolve(__dirname, '..')

const baseUrl = process.env.SMOKE_BASE_URL || 'http://localhost:5000'
const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545'

// Hardhat standard test accounts
// #0: Admin 1
// #1: Investigator TVM
// #2: Forensic Analyst
// #4: Court TVM
// #5: Court EKM
// #6: Admin 2 (Owner 2)
// #8: Investigator EKM (Other)
// #9: Outsider
const testKeys = {
  TEST_KEY_ADMIN: process.env.TEST_KEY_ADMIN,
  TEST_KEY_ADMIN2: process.env.TEST_KEY_ADMIN2 || process.env.TEST_KEY_OWNER2,
  TEST_KEY_INVESTIGATOR: process.env.TEST_KEY_INVESTIGATOR,
  TEST_KEY_ANALYST: process.env.TEST_KEY_ANALYST,
  TEST_KEY_COURT_TVM: process.env.TEST_KEY_COURT_TVM,
  TEST_KEY_COURT_EKM: process.env.TEST_KEY_COURT_EKM,
  TEST_KEY_INVESTIGATOR_OTHER: process.env.TEST_KEY_INVESTIGATOR_OTHER,
  TEST_KEY_OUTSIDER: process.env.TEST_KEY_OUTSIDER,
}
const stepNames = [
  'Step A: health and role logins',
  'Step B: profile flow',
  'Step C: evidence creation and linking',
  'Step D: pending evidence access',
  'Step E: approved evidence access',
  'Step F: analyst reports and evidence file list',
  'Step G: custody transfer',
  'Step H: analyst removal',
  'Step I: tamper detection',
]

// Load addresses from deployments/localhost.json or .env
let registryAddress = process.env.REGISTRY_ADDRESS
let multisigAddress = process.env.MULTISIG_ADDRESS
let peopleAddress = process.env.PEOPLE_ADDRESS

const deploymentPath = path.resolve(backendDir, '..', 'blockchain', 'deployments', 'localhost.json')
if (fs.existsSync(deploymentPath)) {
  const dep = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'))
  if (!registryAddress) registryAddress = dep.registry
  if (!multisigAddress) multisigAddress = dep.multisig
  if (!peopleAddress) peopleAddress = dep.people
}

const registryAbi = JSON.parse(fs.readFileSync(path.resolve(backendDir, 'src', 'abi', 'EvidenceRegistry.json'), 'utf8'))
const peopleAbi = JSON.parse(fs.readFileSync(path.resolve(backendDir, 'src', 'abi', 'PeopleRegistry.json'), 'utf8'))
const multisigAbi = JSON.parse(fs.readFileSync(path.resolve(backendDir, 'src', 'abi', 'AdminMultisig.json'), 'utf8'))

const provider = new JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 })

let passedCount = 0
let failedCount = 0
let skippedCount = 0

function pass(name, details = '') {
  passedCount++
  console.log(`PASS ${name}${details ? ': ' + details : ''}`)
}

function fail(name, reason) {
  failedCount++
  console.error(`FAIL ${name}: ${reason}`)
  process.exitCode = 1
}

function skip(name, reason) {
  skippedCount++
  console.log(`SKIPPED ${name} (${reason})`)
}

async function assertHttpStatus(response, expectedStatus, method, url) {
  const route = new URL(url).pathname + new URL(url).search
  let bodyText
  if (response.headers.has('content-disposition')) {
    bodyText = `<binary attachment omitted; ${response.headers.get('content-type') || 'unknown content type'}>`
  } else {
    bodyText = await response.clone().text()
    try {
      const parsed = JSON.parse(bodyText)
      const redact = (value) => {
        if (Array.isArray(value)) return value.map(redact)
        if (value && typeof value === 'object') {
          return Object.fromEntries(
            Object.entries(value).map(([key, child]) => [
              key,
              /token|signature|private.?key/i.test(key) ? '<redacted>' : redact(child),
            ]),
          )
        }
        return value
      }
      bodyText = JSON.stringify(redact(parsed))
    } catch {
      // Keep non-JSON response text intact for diagnostics.
    }
  }

  console.log(`HTTP ${method} ${route} expected=${expectedStatus} actual=${response.status} body=${bodyText || '<empty>'}`)
  assert.equal(response.status, expectedStatus, `${method} ${route} expected HTTP ${expectedStatus}, received ${response.status}`)
}

async function fetchWithRateLimit(url, options, retries = 6) {
  const method = (options?.method || 'GET').toUpperCase()
  for (let attempt = 0; attempt <= retries; attempt++) {
    let response
    try {
      response = await fetch(url, options)
    } catch (error) {
      const cause = error.cause
      console.error(
        `HTTP request failed: ${method} ${new URL(url).pathname}; ` +
        `cause=${cause?.code || 'UNKNOWN'} ${cause?.message || error.message}`,
      )
      throw error
    }
    if (response.status === 429) {
      if (attempt === retries) return response
      const retryAfter = response.headers.get('retry-after') || response.headers.get('ratelimit-reset')
      let waitSeconds = 15
      if (retryAfter) {
        const parsed = Number(retryAfter)
        if (!isNaN(parsed) && parsed > 0) {
          waitSeconds = parsed > 1_000_000 ? Math.max(1, Math.ceil(parsed - Date.now() / 1000)) : parsed
        }
      }
      console.log(`waiting for rate limit... (${waitSeconds}s)`)
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000))
      continue
    }
    return response
  }
}

const tokenCache = new Map()
const loginDataCache = new Map()

async function login(wallet) {
  const addr = wallet.address.toLowerCase()
  if (tokenCache.has(addr)) {
    return { token: tokenCache.get(addr), ...loginDataCache.get(addr) }
  }

  const nonceResponse = await fetchWithRateLimit(`${baseUrl}/api/auth/nonce`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: wallet.address }),
  })
  await assertHttpStatus(nonceResponse, 200, 'POST', `${baseUrl}/api/auth/nonce`)
  const nonce = await nonceResponse.json()
  const signature = await wallet.signMessage(nonce.message)

  const response = await fetchWithRateLimit(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: wallet.address, signature }),
  })
  await assertHttpStatus(response, 200, 'POST', `${baseUrl}/api/auth/login`)
  const data = await response.json()
  tokenCache.set(addr, data.token)
  loginDataCache.set(addr, data)
  return data
}

function auth(token) {
  return { Authorization: `Bearer ${token}` }
}

async function adminDo(contract, fn, args, admin1Wallet, admin2Wallet, multisigContract) {
  const target = await contract.getAddress()
  const data = contract.interface.encodeFunctionData(fn, args)
  const id = await multisigContract.proposalCount()
  // Each call waits for its mined receipt before the same admin submits again.
  await (await multisigContract.connect(admin1Wallet).propose(target, data)).wait()
  await (await multisigContract.connect(admin2Wallet).approve(id)).wait()
  await (await multisigContract.connect(admin1Wallet).execute(id)).wait()
}

async function run() {
  console.log('=== Evidence Chain Backend Smoke Test ===')
  let activeSubstep = 'setup'
  let stepAPassed = false
  let stepBPassed = false
  let stepCPassed = false
  let stepDPassed = false
  let stepEPassed = false
  let stepFPassed = false
  let stepGPassed = false
  let stepHPassed = false

  const setSubstep = (name) => {
    activeSubstep = name
    console.log(`  SUBSTEP ${name}`)
  }

  const missingKeys = Object.entries(testKeys).filter(([, value]) => !value).map(([name]) => name)
  const invalidKeys = Object.entries(testKeys)
    .filter(([, value]) => value && !/^0x[a-fA-F0-9]{64}$/.test(value))
    .map(([name]) => name)
  const missingAddresses = [
    ['REGISTRY_ADDRESS', registryAddress],
    ['MULTISIG_ADDRESS', multisigAddress],
    ['PEOPLE_ADDRESS', peopleAddress],
  ].filter(([, value]) => !value).map(([name]) => name)

  if (missingKeys.length || invalidKeys.length || missingAddresses.length) {
    const reason = [
      ...missingKeys.map((name) => `${name} not set`),
      ...invalidKeys.map((name) => `${name} is invalid`),
      ...missingAddresses.map((name) => `${name} not set`),
    ].join(', ')
    for (const name of stepNames) skip(name, reason)
    console.log(`\nSMOKE TEST SUMMARY: 0 passed, 0 failed, ${skippedCount} skipped`)
    return
  }

  // Setup contracts and signers
  const adminWallet = new Wallet(testKeys.TEST_KEY_ADMIN, provider)
  const admin2Wallet = new Wallet(testKeys.TEST_KEY_ADMIN2, provider)
  const investigatorWallet = new Wallet(testKeys.TEST_KEY_INVESTIGATOR, provider)
  const investigatorOtherWallet = new Wallet(testKeys.TEST_KEY_INVESTIGATOR_OTHER, provider)
  const analystWallet = new Wallet(testKeys.TEST_KEY_ANALYST, provider)
  const courtTvmWallet = new Wallet(testKeys.TEST_KEY_COURT_TVM, provider)
  const courtEkmWallet = new Wallet(testKeys.TEST_KEY_COURT_EKM, provider)
  const outsiderWallet = new Wallet(testKeys.TEST_KEY_OUTSIDER, provider)

  const registry = new Contract(registryAddress, registryAbi, provider)
  const people = new Contract(peopleAddress, peopleAbi, provider)
  const multisig = new Contract(multisigAddress, multisigAbi, provider)

  // Step a: /api/health ok and logins return expected roles
  setSubstep('Step A: health check and wallet logins')
  try {
    const healthUrl = `${baseUrl}/api/health`
    const healthRes = await fetchWithRateLimit(healthUrl)
    await assertHttpStatus(healthRes, 200, 'GET', healthUrl)
    const health = await healthRes.json()
    assert.equal(health.ok, true)

    const adminLog = await login(adminWallet)
    assert.equal(adminLog.role, 'Admin', 'Admin role mismatch')

    const invLog = await login(investigatorWallet)
    assert.equal(invLog.role, 'Investigator', 'Investigator role mismatch')

    const anaLog = await login(analystWallet)
    assert.equal(anaLog.role, 'Forensic Analyst', 'Analyst role mismatch')

    const tvmLog = await login(courtTvmWallet)
    assert.equal(tvmLog.role, 'Court Official', 'Court TVM role mismatch')

    const outLog = await login(outsiderWallet)
    assert.equal(outLog.role, 'None', 'Outsider role mismatch')

    stepAPassed = true
    pass('Step A: /api/health ok and role logins verified')
  } catch (err) {
    fail('Step A: health and role logins', `${activeSubstep}: ${err.message}`)
  }

  // Step b: PROFILE FLOW
  if (!stepAPassed) {
    skip('Step B: Profile flow', 'depends on Step A')
  } else {
  setSubstep('Step B: query public stations')
  try {
    // Look up Kollam station
    const unitsUrl = `${baseUrl}/api/units?type=station&location=Kollam`
    const unitsRes = await fetchWithRateLimit(unitsUrl)
    await assertHttpStatus(unitsRes, 200, 'GET', unitsUrl)
    const units = await unitsRes.json()
    assert.ok(units.length > 0, 'No stations found in Kollam')
    const kollamStationId = units[0].id

    // Random wallet 1
    const randomWallet1 = Wallet.createRandom().connect(provider)
    // Fund it from admin
    setSubstep('Step B: fund first applicant')
    await (await adminWallet.sendTransaction({ to: randomWallet1.address, value: parseEther('0.1') })).wait()

    const log1 = await login(randomWallet1)
    assert.equal(log1.role, 'None')

    // POST /api/profile
    setSubstep('Step B: submit first profile')
    const profileUrl = `${baseUrl}/api/profile`
    const profRes1 = await fetchWithRateLimit(profileUrl, {
      method: 'POST',
      headers: { ...auth(log1.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: 'Investigator',
        unitId: kollamStationId,
        fullName: 'Test Officer 1',
        designation: 'Sub Inspector',
        employeeId: 'POL12345',
        email: 'officer1@keralapolice.test',
        phone: '+919876543210',
      }),
    })
    await assertHttpStatus(profRes1, 200, 'POST', profileUrl)
    const profData1 = await profRes1.json()

    // Send requestProfile on chain
    setSubstep('Step B: submit first profile request on chain')
    await (await people.connect(randomWallet1).requestProfile(profData1.roleNumber, profData1.unitId, profData1.detailsHash)).wait()

    // Now role is Pending
    assert.equal(await registry.getUserRole(randomWallet1.address), 'Pending')

    // As admin, GET /api/admin/profiles/pending shows hashMatches true
    const adminLog = await login(adminWallet)
    setSubstep('Step B: admin reads first pending profile')
    const pendingUrl = `${baseUrl}/api/admin/profiles/pending`
    const pendingRes1 = await fetchWithRateLimit(pendingUrl, {
      headers: auth(adminLog.token),
    })
    await assertHttpStatus(pendingRes1, 200, 'GET', pendingUrl)
    const pendingList1 = (await pendingRes1.json()).pending
    const entry1 = pendingList1.find((p) => p.address.toLowerCase() === randomWallet1.address.toLowerCase())
    assert.ok(entry1, 'Applicant 1 not found in pending list')
    assert.equal(entry1.hashMatches, true, 'hashMatches should be true for applicant 1')

    // Random wallet 2 with WRONG hash
    const randomWallet2 = Wallet.createRandom().connect(provider)
    setSubstep('Step B: fund second applicant')
    await (await adminWallet.sendTransaction({ to: randomWallet2.address, value: parseEther('0.1') })).wait()

    const log2 = await login(randomWallet2)
    setSubstep('Step B: submit second profile')
    const profRes2 = await fetchWithRateLimit(profileUrl, {
      method: 'POST',
      headers: { ...auth(log2.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: 'Investigator',
        unitId: kollamStationId,
        fullName: 'Test Officer 2',
        designation: 'Sub Inspector',
        employeeId: 'POL67890',
        email: 'officer2@keralapolice.test',
        phone: '+919876543211',
      }),
    })
    await assertHttpStatus(profRes2, 200, 'POST', profileUrl)
    const profData2 = await profRes2.json()

    // Request on chain with WRONG hash
    const wrongHash = ethersId('wrong-profile-hash')
    setSubstep('Step B: submit second profile request on chain')
    await (await people.connect(randomWallet2).requestProfile(profData2.roleNumber, profData2.unitId, wrongHash)).wait()

    // Check pending list as admin: hashMatches false
    setSubstep('Step B: admin verifies second profile hash mismatch')
    const pendingRes2 = await fetchWithRateLimit(pendingUrl, {
      headers: auth(adminLog.token),
    })
    await assertHttpStatus(pendingRes2, 200, 'GET', pendingUrl)
    const pendingList2 = (await pendingRes2.json()).pending
    const entry2 = pendingList2.find((p) => p.address.toLowerCase() === randomWallet2.address.toLowerCase())
    assert.ok(entry2, 'Applicant 2 not found in pending list')
    assert.equal(entry2.hashMatches, false, 'hashMatches should be false for applicant 2')

    // Admins approve applicant 1 through multisig
    setSubstep('Step B: multisig approves first profile')
    await adminDo(people, 'approveProfile', [randomWallet1.address], adminWallet, admin2Wallet, multisig)
    assert.equal(await registry.getUserRole(randomWallet1.address), 'Investigator')

    // Non-admin calling /api/admin/profiles/pending gets 403
    setSubstep('Step B: non-admin pending-profile access denial')
    const nonAdminPending = await fetchWithRateLimit(pendingUrl, {
      headers: auth(log1.token),
    })
    await assertHttpStatus(nonAdminPending, 403, 'GET', pendingUrl)

    stepBPassed = true
    pass('Step B: Profile flow, pending review, hash matching, and admin approval')
  } catch (err) {
    fail('Step B: Profile flow', `${activeSubstep}: ${err.message}`)
  }
  }

  // Step c: Case creation & Evidence registration
  let caseId = `TVM/${Date.now()}/${randomBytes(4).toString('hex')}/2026`
  let evidenceId = null
  let evidenceFileHash = null
  let memoFileHash = null
  let evidenceBytes = randomBytes(256)
  let memoBytes = randomBytes(128)

  if (!stepBPassed) {
    skip('Step C: Evidence creation and linking', 'depends on Step B')
  } else try {
    setSubstep('Step C: open a fresh case')
    const invLog = await login(investigatorWallet)

    // Open case on chain
    await (await registry.connect(investigatorWallet).openCase(caseId, 'Smoke Test Case')).wait()

    // Upload evidence file
    const formEv = new FormData()
    formEv.set('file', new Blob([evidenceBytes]), 'evidence.bin')
    formEv.set('kind', 'evidence')
    setSubstep('Step C: upload evidence bytes')
    const filesUrl = `${baseUrl}/api/files`
    const upEvRes = await fetchWithRateLimit(filesUrl, {
      method: 'POST',
      headers: auth(invLog.token),
      body: formEv,
    })
    await assertHttpStatus(upEvRes, 201, 'POST', filesUrl)
    evidenceFileHash = (await upEvRes.json()).fileHash
    assert.equal(evidenceFileHash, `0x${createHash('sha256').update(evidenceBytes).digest('hex')}`, 'Evidence file hash must be SHA-256 of uploaded plaintext')

    // Upload seizure memo file
    const formMemo = new FormData()
    formMemo.set('file', new Blob([memoBytes]), 'seizure_memo.bin')
    formMemo.set('kind', 'seizure_memo')
    setSubstep('Step C: upload seizure memo bytes')
    const upMemoRes = await fetchWithRateLimit(filesUrl, {
      method: 'POST',
      headers: auth(invLog.token),
      body: formMemo,
    })
    await assertHttpStatus(upMemoRes, 201, 'POST', filesUrl)
    memoFileHash = (await upMemoRes.json()).fileHash
    assert.equal(memoFileHash, `0x${createHash('sha256').update(memoBytes).digest('hex')}`, 'Seizure memo hash must be SHA-256 of uploaded plaintext')

    // Uploading with wrong role is refused (analyst uploading evidence)
    const anaLog = await login(analystWallet)
    setSubstep('Step C: confirm analyst cannot upload evidence')
    const wrongUploadRes = await fetchWithRateLimit(filesUrl, {
      method: 'POST',
      headers: auth(anaLog.token),
      body: formEv,
    })
    await assertHttpStatus(wrongUploadRes, 403, 'POST', filesUrl)

    // Register evidence on chain
    const nowSec = Math.floor(Date.now() / 1000)
    setSubstep('Step C: register uploaded evidence on chain')
    const registrationReceipt = await (await registry.connect(investigatorWallet).registerEvidence({
      caseId,
      description: 'Smoke test weapon',
      location: 'Thiruvananthapuram Central',
      collectionMethod: 'Seized',
      fileHash: evidenceFileHash,
      docs: {
        seizedAt: BigInt(nowSec),
        isElectronic: false,
        seizureMemoHash: memoFileHash,
        recordingHash: ethersId('no-recording'),
        certificateHash: ethersId('no-cert'),
      },
    })).wait()

    const submittedEvent = registrationReceipt.logs
      .map((log) => {
        try {
          return registry.interface.parseLog(log)
        } catch {
          return null
        }
      })
      .find((event) => event?.name === 'EvidenceSubmittedForReview')
    assert.ok(submittedEvent, 'EvidenceSubmittedForReview event was not emitted')
    evidenceId = submittedEvent.args.id.toString()
    assert.notEqual(evidenceId, '0', 'EvidenceSubmittedForReview must contain a nonzero evidence ID')

    const onChainDocs = await registry.getEvidenceDocs.staticCall(evidenceId, {
      from: investigatorWallet.address,
    })
    const onChainEvidence = await registry.getEvidence.staticCall(evidenceId, {
      from: investigatorWallet.address,
    })
    console.log('Step C registration readback:', JSON.stringify({
      evidenceId,
      memoFileHash,
      getEvidenceDocs: {
        seizedAt: onChainDocs.seizedAt.toString(),
        isElectronic: onChainDocs.isElectronic,
        seizureMemoHash: onChainDocs.seizureMemoHash,
        recordingHash: onChainDocs.recordingHash,
        certificateHash: onChainDocs.certificateHash,
      },
      getEvidence: {
        id: onChainEvidence.id.toString(),
        caseId: onChainEvidence.caseId,
        description: onChainEvidence.description,
        location: onChainEvidence.location,
        collectionMethod: onChainEvidence.collectionMethod,
        fileHash: onChainEvidence.fileHash,
        collector: onChainEvidence.collector,
        currentHolder: onChainEvidence.currentHolder,
        stage: onChainEvidence.stage.toString(),
        status: onChainEvidence.status.toString(),
        review: onChainEvidence.review.toString(),
        createdAt: onChainEvidence.createdAt.toString(),
      },
    }))

    // Link memo file
    setSubstep('Step C: link the registered seizure memo')
    const linkUrl = `${baseUrl}/api/files/${memoFileHash}/link`
    const linkRes = await fetchWithRateLimit(linkUrl, {
      method: 'POST',
      headers: { ...auth(invLog.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ evidenceId }),
    })
    await assertHttpStatus(linkRes, 200, 'POST', linkUrl)

    stepCPassed = true
    pass('Step C: Open case, upload files, on-chain registration, and linking')
  } catch (err) {
    fail('Step C: Evidence creation and linking', `${activeSubstep}: ${err.message}`)
  }

  // Step d: PENDING access
  if (!stepCPassed) {
    skip('Step D: Pending access', 'depends on Step C')
  } else {
  setSubstep('Step D: pending evidence access matrix')
  try {
    const invLog = await login(investigatorWallet)
    const adminLog = await login(adminWallet)
    const tvmLog = await login(courtTvmWallet)
    const anaLog = await login(analystWallet)
    const outLog = await login(outsiderWallet)

    // Investigator downloads -> 200 identical bytes
    const evidenceUrl = `${baseUrl}/api/files/${evidenceFileHash}`
    const invDown = await fetchWithRateLimit(evidenceUrl, { headers: auth(invLog.token) })
    await assertHttpStatus(invDown, 200, 'GET', evidenceUrl)
    assert.deepEqual(Buffer.from(await invDown.arrayBuffer()), evidenceBytes)

    // Admin downloads -> 200 identical bytes (review allowed while pending)
    const adminDown = await fetchWithRateLimit(evidenceUrl, { headers: auth(adminLog.token) })
    await assertHttpStatus(adminDown, 200, 'GET', evidenceUrl)
    assert.deepEqual(Buffer.from(await adminDown.arrayBuffer()), evidenceBytes)

    // Court TVM -> 403
    const tvmDown = await fetchWithRateLimit(evidenceUrl, { headers: auth(tvmLog.token) })
    await assertHttpStatus(tvmDown, 403, 'GET', evidenceUrl)

    // Analyst -> 403
    const anaDown = await fetchWithRateLimit(evidenceUrl, { headers: auth(anaLog.token) })
    await assertHttpStatus(anaDown, 403, 'GET', evidenceUrl)

    // Outsider -> 403
    const outDown = await fetchWithRateLimit(evidenceUrl, { headers: auth(outLog.token) })
    await assertHttpStatus(outDown, 403, 'GET', evidenceUrl)

    stepDPassed = true
    pass('Step D: PENDING access matrix verified (investigator and admin 200; others 403)')
  } catch (err) {
    fail('Step D: Pending access', `${activeSubstep}: ${err.message}`)
  }
  }

  // Step e: Approve evidence and verify APPROVED access matrix
  if (!stepDPassed) {
    skip('Step E: Approved access', 'depends on Step D')
  } else {
  setSubstep('Step E: multisig approves evidence')
  try {
    // Approve through multisig
    await adminDo(registry, 'approveEvidence', [evidenceId], adminWallet, admin2Wallet, multisig)

    setSubstep('Step E: login access-matrix users')
    const invLog = await login(investigatorWallet)
    const adminLog = await login(adminWallet)
    const tvmLog = await login(courtTvmWallet)
    const ekmLog = await login(courtEkmWallet)
    const anaLog = await login(analystWallet)
    const otherInvLog = await login(investigatorOtherWallet)
    const outLog = await login(outsiderWallet)

    // Court TVM -> 200 and identical bytes
    const evidenceUrl = `${baseUrl}/api/files/${evidenceFileHash}`
    setSubstep('Step E: verify Court TVM access')
    const tvmDown = await fetchWithRateLimit(evidenceUrl, { headers: auth(tvmLog.token) })
    await assertHttpStatus(tvmDown, 200, 'GET', evidenceUrl)
    assert.deepEqual(Buffer.from(await tvmDown.arrayBuffer()), evidenceBytes)

    // Court EKM -> 403
    setSubstep('Step E: verify Court EKM denial')
    const ekmDown = await fetchWithRateLimit(evidenceUrl, { headers: auth(ekmLog.token) })
    await assertHttpStatus(ekmDown, 403, 'GET', evidenceUrl)

    // ADMIN -> 403 (Admin cannot read approved evidence)
    setSubstep('Step E: verify admin denial')
    const adminDown = await fetchWithRateLimit(evidenceUrl, { headers: auth(adminLog.token) })
    await assertHttpStatus(adminDown, 403, 'GET', evidenceUrl)

    // Outsider -> 403
    setSubstep('Step E: verify outsider denial')
    const outDown = await fetchWithRateLimit(evidenceUrl, { headers: auth(outLog.token) })
    await assertHttpStatus(outDown, 403, 'GET', evidenceUrl)

    // Unassigned analyst -> 403
    setSubstep('Step E: verify unassigned analyst denial')
    const anaDown = await fetchWithRateLimit(evidenceUrl, { headers: auth(anaLog.token) })
    await assertHttpStatus(anaDown, 403, 'GET', evidenceUrl)

    // Other investigator -> 403
    setSubstep('Step E: verify other-investigator denial')
    const otherDown = await fetchWithRateLimit(evidenceUrl, { headers: auth(otherInvLog.token) })
    await assertHttpStatus(otherDown, 403, 'GET', evidenceUrl)

    stepEPassed = true
    pass('Step E: APPROVED access matrix verified (Court TVM 200; Court EKM, Admin, Outsider, Unassigned Analyst 403)')
  } catch (err) {
    fail('Step E: Approved access', `${activeSubstep}: ${err.message}`)
  }
  }

  // Step f: Analysis request, assignment, report upload, and evidence file list
  let reportFileHash = null
  let reportBytes = randomBytes(200)

  if (!stepEPassed) {
    skip('Step F: Analyst reports and evidence file list', 'depends on Step E')
  } else try {
    setSubstep('Step F: request forensic analysis')
    const invLog = await login(investigatorWallet)
    const anaLog = await login(analystWallet)
    const tvmLog = await login(courtTvmWallet)
    const outLog = await login(outsiderWallet)

    // Request analysis on chain (lab 5 is TVM lab in deploy fixture)
    // Lookup analyst unit via profileOf (unitOf does not exist in PeopleRegistry)
    const analystProfile = await people.profileOf(analystWallet.address)
    const analystUnitId = analystProfile.unitId
    await (await registry.connect(investigatorWallet).requestAnalysis(caseId, analystUnitId, 'Please examine weapon')).wait()

    // Assign analyst through multisig
    setSubstep('Step F: multisig assigns analyst')
    await adminDo(registry, 'assignAnalyst', [caseId, analystWallet.address], adminWallet, admin2Wallet, multisig)

    // Assigned analyst can now download evidence
    const evidenceUrl = `${baseUrl}/api/files/${evidenceFileHash}`
    const anaDown = await fetchWithRateLimit(evidenceUrl, { headers: auth(anaLog.token) })
    await assertHttpStatus(anaDown, 200, 'GET', evidenceUrl)

    // Analyst uploads report
    const formRep = new FormData()
    formRep.set('file', new Blob([reportBytes]), 'ballistics_report.pdf')
    formRep.set('kind', 'report')
    setSubstep('Step F: analyst uploads report')
    const filesUrl = `${baseUrl}/api/files`
    const upRepRes = await fetchWithRateLimit(filesUrl, {
      method: 'POST',
      headers: auth(anaLog.token),
      body: formRep,
    })
    await assertHttpStatus(upRepRes, 201, 'POST', filesUrl)
    reportFileHash = (await upRepRes.json()).fileHash

    // Add report on chain
    setSubstep('Step F: analyst records report hash on chain')
    await (await registry.connect(analystWallet).addAnalysisReport(evidenceId, reportFileHash, 'Ballistics matched test firing')).wait()

    // Link report
    setSubstep('Step F: link the recorded report')
    const linkReportUrl = `${baseUrl}/api/files/${reportFileHash}/link`
    const linkRepRes = await fetchWithRateLimit(linkReportUrl, {
      method: 'POST',
      headers: { ...auth(anaLog.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ evidenceId }),
    })
    await assertHttpStatus(linkRepRes, 200, 'POST', linkReportUrl)

    // Court lists files for evidence
    setSubstep('Step F: court lists evidence documents')
    const evidenceFilesUrl = `${baseUrl}/api/evidence/${evidenceId}/files`
    const listRes = await fetchWithRateLimit(evidenceFilesUrl, { headers: auth(tvmLog.token) })
    await assertHttpStatus(listRes, 200, 'GET', evidenceFilesUrl)
    const { files: evFiles } = await listRes.json()
    assert.ok(evFiles.some((f) => f.fileHash === evidenceFileHash))
    assert.ok(evFiles.some((f) => f.fileHash === memoFileHash))
    assert.ok(evFiles.some((f) => f.fileHash === reportFileHash))

    // Court downloads report
    setSubstep('Step F: court downloads report')
    const reportUrl = `${baseUrl}/api/files/${reportFileHash}`
    const repDown = await fetchWithRateLimit(reportUrl, { headers: auth(tvmLog.token) })
    await assertHttpStatus(repDown, 200, 'GET', reportUrl)
    assert.deepEqual(Buffer.from(await repDown.arrayBuffer()), reportBytes)

    // Verify report
    setSubstep('Step F: verify report hash against chain')
    const verifyReportUrl = `${baseUrl}/api/files/${reportFileHash}/verify`
    const verifyRep = await fetchWithRateLimit(verifyReportUrl, { headers: auth(tvmLog.token) })
    await assertHttpStatus(verifyRep, 200, 'GET', verifyReportUrl)
    const verifyData = await verifyRep.json()
    assert.equal(verifyData.onChain.matches, true)

    // Outsider gets 403 on evidence file list
    const outList = await fetchWithRateLimit(evidenceFilesUrl, { headers: auth(outLog.token) })
    await assertHttpStatus(outList, 403, 'GET', evidenceFilesUrl)

    stepFPassed = true
    pass('Step F: Request analysis, assign analyst, report upload, and evidence files list')
  } catch (err) {
    fail('Step F: Analyst reports and evidence file list', `${activeSubstep}: ${err.message}`)
  }

  // Step g: Custody transfer (sendCustody + acceptCustody)
  if (!stepFPassed) {
    skip('Step G: Custody transfer', 'depends on Step F')
  } else try {
    setSubstep('Step G: investigator offers custody to analyst')
    const invLog = await login(investigatorWallet)
    const anaLog = await login(analystWallet)

    await (await registry.connect(investigatorWallet).sendCustody(evidenceId, analystWallet.address, 'Transfer for test')).wait()
    setSubstep('Step G: analyst accepts custody')
    await (await registry.connect(analystWallet).acceptCustody(evidenceId)).wait()

    // Access remains valid
    const evidenceUrl = `${baseUrl}/api/files/${evidenceFileHash}`
    const anaDown = await fetchWithRateLimit(evidenceUrl, { headers: auth(anaLog.token) })
    await assertHttpStatus(anaDown, 200, 'GET', evidenceUrl)

    stepGPassed = true
    pass('Step G: Two-step custody transfer successfully completed')
  } catch (err) {
    fail('Step G: Custody transfer', `${activeSubstep}: ${err.message}`)
  }

  // Step h: Remove analyst -> gets 403
  if (!stepGPassed) {
    skip('Step H: Analyst removal', 'depends on Step G')
  } else try {
    // Analyst sends custody back to investigator first (so analyst can be removed)
    setSubstep('Step H: analyst offers custody back to investigator')
    await (await registry.connect(analystWallet).sendCustody(evidenceId, investigatorWallet.address, 'Returning weapon')).wait()
    setSubstep('Step H: investigator accepts returned custody')
    await (await registry.connect(investigatorWallet).acceptCustody(evidenceId)).wait()

    // Admins remove analyst through multisig
    setSubstep('Step H: admins remove analyst through multisig')
    await adminDo(registry, 'removeAnalyst', [caseId, analystWallet.address], adminWallet, admin2Wallet, multisig)

    // Analyst now gets 403
    const anaLog = await login(analystWallet)
    const evidenceUrl = `${baseUrl}/api/files/${evidenceFileHash}`
    const anaDown = await fetchWithRateLimit(evidenceUrl, { headers: auth(anaLog.token) })
    await assertHttpStatus(anaDown, 403, 'GET', evidenceUrl)

    stepHPassed = true
    pass('Step H: Analyst removal blocks subsequent evidence access (403)')
  } catch (err) {
    fail('Step H: Analyst removal', `${activeSubstep}: ${err.message}`)
  }

  // Step i: Tamper check (DEMO_MODE)
  if (!stepCPassed) {
    skip('Step I: Tamper detection', 'depends on Step C')
  } else try {
    setSubstep('Step I: demo-mode tamper request')
    const invLog = await login(investigatorWallet)
    const tamperUrl = `${baseUrl}/api/dev/tamper/${evidenceFileHash}`
    const tamperRes = await fetchWithRateLimit(tamperUrl, {
      method: 'POST',
      headers: auth(invLog.token),
    })
    if (tamperRes.status === 200) {
      await assertHttpStatus(tamperRes, 200, 'POST', tamperUrl)
      // Verify returns readable false
      setSubstep('Step I: verify tampered file')
      const verifyUrl = `${baseUrl}/api/files/${evidenceFileHash}/verify`
      const verifyRes = await fetchWithRateLimit(verifyUrl, { headers: auth(invLog.token) })
      await assertHttpStatus(verifyRes, 200, 'GET', verifyUrl)
      const verifyJson = await verifyRes.json()
      assert.equal(verifyJson.readable, false)

      // Download returns 409
      setSubstep('Step I: confirm tampered file download is rejected')
      const evidenceUrl = `${baseUrl}/api/files/${evidenceFileHash}`
      const downRes = await fetchWithRateLimit(evidenceUrl, { headers: auth(invLog.token) })
      await assertHttpStatus(downRes, 409, 'GET', evidenceUrl)

      pass('Step I: Tamper detection, readable=false, and 409 INTEGRITY_FAILURE on download')
    } else {
      await assertHttpStatus(tamperRes, 404, 'POST', tamperUrl)
      skip('Step I: Tamper check', 'DEMO_MODE not enabled or endpoint returned 404')
    }
  } catch (err) {
    fail('Step I: Tamper check', `${activeSubstep}: ${err.message}`)
  }

  console.log(`\nSMOKE TEST SUMMARY: ${passedCount} passed, ${failedCount} failed, ${skippedCount} skipped`)
  if (failedCount > 0) {
    process.exit(1)
  }
}

run().catch((err) => {
  console.error('Smoke test runtime failure:', err)
  process.exit(1)
})
