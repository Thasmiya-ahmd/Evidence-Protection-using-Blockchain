import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { Wallet } from 'ethers'
import { createApp } from '../src/app.js'
import { assertChainReady, toPlainObject } from '../src/chain.js'
import { loadConfig } from '../src/config.js'
import { decrypt, encrypt, sha256 } from '../src/crypto.js'
import { CURRENT_SCHEMA_VERSION, openDatabase } from '../src/db.js'

async function serve(t, { demo = false, notify = false } = {}) {
  const investigator = Wallet.createRandom()
  const secondInvestigator = Wallet.createRandom()
  const admin = Wallet.createRandom()
  const analyst = Wallet.createRandom()
  const courtOfficial = Wallet.createRandom()
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evidence-api-'))
  const db = openDatabase(':memory:')
  const config = {
    NODE_ENV: 'test',
    FRONTEND_ORIGIN: 'http://localhost:5173',
    JWT_SECRET: 'test-secret-with-at-least-thirty-two-characters',
    JWT_EXPIRES_IN: '1h',
    CHAIN_ID: 31337,
    masterKey: Buffer.alloc(32, 0x45),
    MAX_FILE_MB: 1,
    storageDir,
    DEMO_MODE: demo,
    NOTIFY_ENABLED: notify,
    isProduction: false,
  }
  const roles = new Map([
    [investigator.address.toLowerCase(), 'Investigator'],
    [secondInvestigator.address.toLowerCase(), 'Investigator'],
    [analyst.address.toLowerCase(), 'Forensic Analyst'],
    [courtOfficial.address.toLowerCase(), 'Court Official'],
    [admin.address.toLowerCase(), 'Admin'],
  ])
  const linkChecks = []
  const chain = {
    provider: { getBlockNumber: async () => 23 },
    registry: {
      officialCourt: async () => 1n,
      getUserRole: async (addr) => roles.get(addr.toLowerCase()) || 'None',
      hashToId: async () => 0n,
      verify: {
        staticCall: async () => true,
      },
      people: async () => `0x${'56'.repeat(20)}`,
      admins: async () => `0x${'34'.repeat(20)}`,
    },
    people: {
      profileOf: async () => ({
        status: 2n,
        role: 1n,
        unitId: 1n,
        detailsHash: `0x${'aa'.repeat(32)}`,
        requestedAt: 1000n,
        decidedAt: 1005n,
      }),
      unitInfo: async () => [1n, 'Central Police Station', 'Thiruvananthapuram'],
      getUnits: async () => [[1n], ['Central Police Station'], ['Thiruvananthapuram']],
      getUnitsAt: async () => [[1n], ['Central Police Station'], ['Thiruvananthapuram']],
      pendingProfiles: {
        staticCall: async () => [],
      },
    },
    multisig: {
      isOwner: async (addr) => roles.get(addr.toLowerCase()) === 'Admin',
    },
    resolveUserRole: async (addr) => {
      const role = roles.get(addr.toLowerCase()) || 'None'
      const isOwner = role === 'Admin'
      return { address: addr, role, isMultisigOwner: isOwner }
    },
    getRole: async (addr) => roles.get(addr.toLowerCase()) || 'None',
    getProfile: async () => ({
      status: 'Active',
      role: 'Investigator',
      unitId: '1',
      unitName: 'Central Police Station',
      unitLocation: 'Thiruvananthapuram',
      detailsHash: `0x${'aa'.repeat(32)}`,
      requestedAt: '1000',
      decidedAt: '1005',
    }),
    hashToId: async () => '0',
    canView: async () => true,
    getEvidence: async () => ({
      id: 1n,
      caseId: 'CASE-01',
      fileHash: `0x${'aa'.repeat(32)}`,
      review: 1n,
    }),
    getEvidenceDocs: async () => ({
      seizedAt: 1000n,
      isElectronic: true,
      seizureMemoHash: `0x${'11'.repeat(32)}`,
      recordingHash: `0x${'22'.repeat(32)}`,
      certificateHash: `0x${'bb'.repeat(32)}`,
    }),
    getAnalysisReports: async () => [],
    onChainVerify: async (evidenceId) => ({
      registered: true,
      evidenceId: String(evidenceId),
      matches: true,
      review: 'Approved',
    }),
    verifyLinkedFile: async (evidenceId, fileHash, address, kind) => {
      linkChecks.push({ evidenceId, fileHash, address, kind })
      return true
    },
  }
  const server = createApp({ config, db, chain }).listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    db.close()
    await fs.rm(storageDir, { recursive: true, force: true })
  })
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    investigator,
    secondInvestigator,
    admin,
    analyst,
    courtOfficial,
    roles,
    chain,
    linkChecks,
    db,
    storageDir,
  }
}

async function login(baseUrl, wallet) {
  const nonceRes = await fetch(`${baseUrl}/api/auth/nonce`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: wallet.address }),
  })
  assert.equal(nonceRes.status, 200)
  const { nonce, message } = await nonceRes.json()
  assert.ok(nonce)
  assert.ok(message)
  const signature = await wallet.signMessage(message)
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: wallet.address, signature }),
  })
  const result = await res.json()
  return { response: res, result, signature }
}

function auth(token) {
  return { Authorization: `Bearer ${token}` }
}

test('example backend configuration validates and invalid encryption keys fail clearly', () => {
  const parsed = loadConfig({
    REGISTRY_ADDRESS: `0x${'12'.repeat(20)}`,
    MULTISIG_ADDRESS: `0x${'34'.repeat(20)}`,
    PEOPLE_ADDRESS: `0x${'56'.repeat(20)}`,
    JWT_SECRET: 'a'.repeat(32),
    MASTER_KEY: '0'.repeat(64),
  })

  assert.equal(parsed.MAX_FILE_MB, 50)
  assert.equal(parsed.DEMO_MODE, false)
  assert.equal(parsed.NOTIFY_ENABLED, false)

  assert.throws(
    () =>
      loadConfig({
        REGISTRY_ADDRESS: `0x${'12'.repeat(20)}`,
        MULTISIG_ADDRESS: `0x${'34'.repeat(20)}`,
        PEOPLE_ADDRESS: `0x${'56'.repeat(20)}`,
        JWT_SECRET: 'short',
        MASTER_KEY: '0'.repeat(64),
      }),
    /JWT_SECRET must be at least 32 characters/,
  )
  assert.throws(
    () =>
      loadConfig({
        REGISTRY_ADDRESS: `0x${'12'.repeat(20)}`,
        MULTISIG_ADDRESS: `0x${'34'.repeat(20)}`,
        PEOPLE_ADDRESS: `0x${'56'.repeat(20)}`,
        JWT_SECRET: 'a'.repeat(32),
        MASTER_KEY: '1234',
      }),
    /MASTER_KEY must be exactly 64 hexadecimal characters/,
  )
  assert.throws(
    () =>
      loadConfig({
        REGISTRY_ADDRESS: `0x${'12'.repeat(20)}`,
        MULTISIG_ADDRESS: `0x${'34'.repeat(20)}`,
        PEOPLE_ADDRESS: `0x${'56'.repeat(20)}`,
        JWT_SECRET: 'a'.repeat(32),
        MASTER_KEY: '0'.repeat(64),
        NOTIFY_ENABLED: 'true',
      }),
    /SMTP_HOST is required when NOTIFY_ENABLED=true/,
  )
})

test('database migration preserves legacy files and adds current columns', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evidence-db-migration-'))
  const dbPath = path.join(directory, 'legacy.db')
  const legacy = new Database(dbPath)
  legacy.exec(`
    CREATE TABLE files (
      file_hash TEXT PRIMARY KEY,
      uploader TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      kind TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO files VALUES ('0x${'11'.repeat(32)}', '0xabc', 'memo.pdf', 'application/pdf', 12, 'evidence', '2024-01-01');
    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      court_id TEXT NOT NULL,
      type TEXT NOT NULL,
      reference TEXT NOT NULL,
      block_number INTEGER NOT NULL,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(tx_hash, log_index)
    );
    PRAGMA user_version = 1;
  `)
  legacy.close()
  t.after(async () => fs.rm(directory, { recursive: true, force: true }))

  const db = openDatabase(dbPath)
  assert.equal(db.pragma('user_version', { simple: true }), CURRENT_SCHEMA_VERSION)
  const file = db.prepare('SELECT mime, evidence_id FROM files').get()
  assert.deepEqual(file, { mime: 'application/pdf', evidence_id: null })
  const notificationColumns = db.pragma('table_info(notifications)').map((column) => column.name)
  assert.ok(notificationColumns.includes('contract'))
  assert.ok(notificationColumns.includes('audience'))
  assert.ok(db.pragma('table_info(profiles)').some((column) => column.name === 'details_enc'))
  db.close()
})

test('startup chain checks reject a mismatched network and missing contract', async () => {
  const registryAddress = `0x${'12'.repeat(20)}`
  const multisigAddress = `0x${'34'.repeat(20)}`
  const peopleAddress = `0x${'56'.repeat(20)}`
  const chain = {
    provider: {
      getNetwork: async () => ({ chainId: 31337n }),
      getBlockNumber: async () => 1,
      getCode: async () => '0x6000',
    },
    registry: {
      people: async () => peopleAddress,
      admins: async () => multisigAddress,
    },
  }
  await assertChainReady(chain, 31337, registryAddress, multisigAddress, peopleAddress)
  await assert.rejects(
    assertChainReady(
      { ...chain, provider: { ...chain.provider, getNetwork: async () => ({ chainId: 1n }) } },
      31337,
      registryAddress,
      multisigAddress,
      peopleAddress,
    ),
    /RPC chain ID 1 does not match configured CHAIN_ID 31337/,
  )
  await assert.rejects(
    assertChainReady(
      { ...chain, provider: { ...chain.provider, getCode: async () => '0x' } },
      31337,
      registryAddress,
      multisigAddress,
      peopleAddress,
    ),
    /no contract code exists at REGISTRY_ADDRESS/,
  )
})

test('per-file HKDF and AES-GCM authenticate encrypted bytes and enforce AAD binding', () => {
  const masterKey = Buffer.alloc(32, 0x11)
  const plaintext = Buffer.from('chain-of-custody test record')
  const hash = `0x${'44'.repeat(32)}`
  const encrypted = encrypt(plaintext, masterKey, hash)

  assert.equal(encrypted[0], 1)
  assert.equal(encrypted.length, 1 + 12 + 16 + plaintext.length)
  assert.deepEqual(decrypt(encrypted, masterKey, hash), plaintext)

  // Bit flip in tag fails GCM auth
  const corruptedTag = Buffer.from(encrypted)
  corruptedTag[1 + 12] ^= 0x01
  assert.throws(() => decrypt(corruptedTag, masterKey, hash))

  // Swapping ciphertext between different file hashes fails due to AAD
  const otherHash = `0x${'ab'.repeat(32)}`
  const validEncrypted = encrypt(plaintext, masterKey, hash)
  assert.throws(() => decrypt(validEncrypted, masterKey, otherHash))
})

test('wallet login is signature-bound, role-specific endpoints are enforced, and nonces are single-use', async (t) => {
  const context = await serve(t, { notify: true })
  const { baseUrl, investigator, admin, courtOfficial, roles } = context
  const loggedIn = await login(baseUrl, investigator)
  assert.equal(loggedIn.response.status, 200)
  assert.equal(loggedIn.result.role, 'Investigator')
  assert.equal(loggedIn.result.isMultisigOwner, false)
  assert.ok(loggedIn.result.token)

  // Replay fails because nonce was consumed
  const replay = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: investigator.address, signature: loggedIn.signature }),
  })
  assert.equal(replay.status, 401)

  const investigatorToken = loggedIn.result.token

  // AdminMultisig owner resolves to Admin and isMultisigOwner: true
  const adminLogin = await login(baseUrl, admin)
  assert.equal(adminLogin.response.status, 200)
  assert.equal(adminLogin.result.role, 'Admin')
  assert.equal(adminLogin.result.isMultisigOwner, true)

  const unassignedWallet = Wallet.createRandom()
  const unassignedLogin = await login(baseUrl, unassignedWallet)
  assert.equal(unassignedLogin.response.status, 200)
  assert.equal(unassignedLogin.result.role, 'None')
  assert.equal(unassignedLogin.result.isMultisigOwner, false)

  const courtLogin = await login(baseUrl, courtOfficial)
  assert.equal(courtLogin.response.status, 200)
  assert.equal(courtLogin.result.role, 'Court Official')
  assert.equal(courtLogin.result.isMultisigOwner, false)

  const health = await fetch(`${baseUrl}/api/health`)
  assert.deepEqual(await health.json(), { ok: true, chainId: 31337, blockNumber: 23 })

  const unauthenticated = await fetch(`${baseUrl}/api/profile/me`)
  assert.equal(unauthenticated.status, 401)
  const units = await fetch(`${baseUrl}/api/units`)
  assert.equal(units.status, 200)
  assert.ok(Array.isArray(await units.json()))
  const locations = await fetch(`${baseUrl}/api/units/locations`)
  assert.equal(locations.status, 200)
  assert.ok(Array.isArray(await locations.json()))

  const me = await fetch(`${baseUrl}/api/auth/me`, { headers: auth(investigatorToken) })
  assert.equal(me.status, 200)
  const meData = await me.json()
  assert.equal(meData.role, 'Investigator')
  assert.equal(meData.isMultisigOwner, false)

  const adminMe = await fetch(`${baseUrl}/api/auth/me`, { headers: auth(adminLogin.result.token) })
  assert.equal(adminMe.status, 200)
  const adminMeData = await adminMe.json()
  assert.equal(adminMeData.role, 'Admin')
  assert.equal(adminMeData.isMultisigOwner, true)

  roles.set(investigator.address.toLowerCase(), 'None')
  const refreshedMe = await fetch(`${baseUrl}/api/auth/me`, { headers: auth(investigatorToken) })
  assert.equal(refreshedMe.status, 200)
  assert.equal((await refreshedMe.json()).role, 'None')

  const emailUpdate = await fetch(`${baseUrl}/api/me/email`, {
    method: 'PUT',
    headers: { ...auth(courtLogin.result.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'official@example.org' }),
  })
  assert.equal(emailUpdate.status, 200)

  const notificationList = await fetch(`${baseUrl}/api/notifications`, {
    headers: auth(courtLogin.result.token),
  })
  assert.equal(notificationList.status, 200)
  assert.deepEqual((await notificationList.json()).notifications, [])

  const disabledTamper = await fetch(`${baseUrl}/api/dev/tamper/${'0'.repeat(64)}`, {
    method: 'POST',
    headers: auth(investigatorToken),
  })
  assert.equal(disabledTamper.status, 404)
})

test('login nonce is consumed even when signature verification fails', async (t) => {
  const { baseUrl, investigator } = await serve(t)
  const nonceRes = await fetch(`${baseUrl}/api/auth/nonce`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: investigator.address }),
  })

  assert.equal(nonceRes.status, 200)

  // Send invalid signature
  const badLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: investigator.address, signature: `0x${'00'.repeat(65)}` }),
  })
  assert.equal(badLogin.status, 401)

  // Try again with valid signature -> must fail because nonce was already consumed
  const validSig = await investigator.signMessage('Sign in to Evidence Chain')
  const secondAttempt = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: investigator.address, signature: validSig }),
  })
  assert.equal(secondAttempt.status, 401)
})

test('profile details and optional profile document are encrypted and deleted off-chain', async (t) => {
  const context = await serve(t)
  const { baseUrl, roles, chain, db, storageDir } = context
  const applicant = Wallet.createRandom()
  roles.set(applicant.address.toLowerCase(), 'None')
  chain.getProfile = async () => null
  const loginResult = await login(baseUrl, applicant)
  const token = loginResult.result.token

  const document = new FormData()
  document.set('file', new Blob([Buffer.from('identity document')]), 'identity.pdf')
  document.set('kind', 'profile_doc')
  const upload = await fetch(`${baseUrl}/api/files`, {
    method: 'POST',
    headers: auth(token),
    body: document,
  })
  assert.equal(upload.status, 201)
  const { fileHash } = await upload.json()

  const profileBody = {
    role: 'Investigator',
    unitId: '1',
    fullName: 'Test Officer',
    designation: 'Sub Inspector',
    employeeId: 'POL12345',
    email: 'officer@example.org',
    phone: '+919876543210',
    idDocumentHash: fileHash,
  }
  const submission = await fetch(`${baseUrl}/api/profile`, {
    method: 'POST',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(profileBody),
  })
  assert.equal(submission.status, 200)
  const submitted = await submission.json()
  assert.equal(submitted.roleNumber, 1)
  assert.equal(submitted.unitId, '1')

  const storedProfile = db.prepare('SELECT details_enc, details_hash FROM profiles').get()
  assert.equal(storedProfile.details_hash, submitted.detailsHash)
  assert.equal(storedProfile.details_enc.includes(Buffer.from('Test Officer')), false)
  assert.equal(db.prepare('SELECT kind FROM files WHERE file_hash = ?').get(fileHash).kind, 'profile_doc')

  const deletion = await fetch(`${baseUrl}/api/profile/me`, {
    method: 'DELETE',
    headers: auth(token),
  })
  assert.equal(deletion.status, 200)
  assert.equal(db.prepare('SELECT 1 FROM profiles').get(), undefined)
  assert.equal(db.prepare('SELECT 1 FROM files WHERE file_hash = ?').get(fileHash), undefined)
  await assert.rejects(fs.stat(path.join(storageDir, `${fileHash}.enc`)), { code: 'ENOENT' })
})

test('optional notification endpoints are absent when notifications are disabled', async (t) => {
  const context = await serve(t)
  const { baseUrl, courtOfficial } = context
  const courtLogin = await login(baseUrl, courtOfficial)

  assert.equal((await fetch(`${baseUrl}/api/me/email`, { method: 'PUT', headers: auth(courtLogin.result.token) })).status, 404)
  assert.equal((await fetch(`${baseUrl}/api/notifications`, { headers: auth(courtLogin.result.token) })).status, 404)
})

test('uploaded file is encrypted at rest, downloadable by uploader, and tampering is reported', async (t) => {
  const context = await serve(t, { demo: true })
  const { baseUrl, investigator, secondInvestigator, admin, analyst, roles, db, storageDir } = context
  const investigatorLogin = await login(baseUrl, investigator)
  const secondInvestigatorLogin = await login(baseUrl, secondInvestigator)
  const adminLogin = await login(baseUrl, admin)
  const analystLogin = await login(baseUrl, analyst)
  const token = investigatorLogin.result.token
  const adminToken = adminLogin.result.token
  const analystToken = analystLogin.result.token
  const payload = Buffer.from('confidential evidence file payload')

  const body = new FormData()
  body.set('file', new Blob([payload], { type: 'text/plain' }), '..\\private\\evidence.txt')
  body.set('kind', 'evidence')
  const upload = await fetch(`${baseUrl}/api/files`, {
    method: 'POST',
    headers: auth(token),
    body,
  })

  assert.equal(upload.status, 201)
  const metadata = await upload.json()
  assert.equal(metadata.fileHash, sha256(payload))
  assert.equal(metadata.name, 'evidence.txt')
  assert.equal(metadata.kind, 'evidence')

  const deniedAdminDownload = await fetch(`${baseUrl}/api/files/${metadata.fileHash}`, {
    headers: auth(adminToken),
  })
  assert.equal(deniedAdminDownload.status, 403)
  const adminAudit = db.prepare(`
    SELECT action FROM access_log WHERE address = ? AND file_hash = ?
  `).all(admin.address.toLowerCase(), metadata.fileHash.toLowerCase())
  assert.deepEqual(adminAudit.map((entry) => entry.action), ['admin_review'])

  // Duplicate upload by same uploader returns 200
  const duplicateBody = new FormData()
  duplicateBody.set('file', new Blob([payload]), 'duplicate.txt')
  const duplicateUpload = await fetch(`${baseUrl}/api/files`, {
    method: 'POST',
    headers: auth(token),
    body: duplicateBody,
  })
  assert.equal(duplicateUpload.status, 200)
  assert.equal((await duplicateUpload.json()).fileHash, metadata.fileHash)

  // Duplicate upload by different uploader returns 409 FILE_EXISTS
  const otherUploaderBody = new FormData()
  otherUploaderBody.set('file', new Blob([payload]), 'same-content.txt')
  const otherUploaderUpload = await fetch(`${baseUrl}/api/files`, {
    method: 'POST',
    headers: auth(secondInvestigatorLogin.result.token),
    body: otherUploaderBody,
  })
  assert.equal(otherUploaderUpload.status, 409)
  const conflictJson = await otherUploaderUpload.json()
  assert.equal(conflictJson.error, 'FILE_EXISTS')

  const diskPath = path.join(storageDir, `${metadata.fileHash}.enc`)
  const encryptedOnDisk = await fs.readFile(diskPath)
  assert.equal(encryptedOnDisk.includes(payload), false)
  assert.notDeepEqual(encryptedOnDisk, payload)

  const verifyUrl = `${baseUrl}/api/files/${metadata.fileHash}/verify`
  const analystUploadBody = new FormData()
  analystUploadBody.set(
    'file',
    new Blob([Buffer.from('small report payload')]),
    'report.txt',
  )
  analystUploadBody.set('kind', 'evidence')
  const deniedUpload = await fetch(`${baseUrl}/api/files`, {
    method: 'POST',
    headers: auth(analystToken),
    body: analystUploadBody,
  })
  assert.equal(deniedUpload.status, 403)

  const verified = await fetch(verifyUrl, { headers: auth(token) })
  assert.equal(verified.status, 200)
  const verification = await verified.json()
  assert.equal(verification.readable, true)
  assert.equal(verification.matchesStoredHash, true)

  const download = await fetch(`${baseUrl}/api/files/${metadata.fileHash}`, { headers: auth(token) })
  assert.equal(download.status, 200)
  assert.equal(download.headers.get('content-disposition'), 'attachment; filename="evidence.txt"')
  assert.equal(download.headers.get('cache-control'), 'no-store')
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), payload)

  const tamperRes = await fetch(`${baseUrl}/api/dev/tamper/${metadata.fileHash}`, {
    method: 'POST',
    headers: auth(token),
  })
  assert.equal(tamperRes.status, 200)

  const verifiedAfterTamper = await fetch(verifyUrl, { headers: auth(token) })
  assert.equal(verifiedAfterTamper.status, 200)
  const tamperedJson = await verifiedAfterTamper.json()
  assert.equal(tamperedJson.readable, false)
  assert.equal(tamperedJson.matchesStoredHash, false)
  assert.equal(tamperedJson.message, 'stored file altered or corrupted')

  const failedDownload = await fetch(`${baseUrl}/api/files/${metadata.fileHash}`, { headers: auth(token) })
  assert.equal(failedDownload.status, 409)
  assert.equal((await failedDownload.json()).error, 'INTEGRITY_FAILURE')
})

test('certificate links require the original uploader and stay tied to the on-chain evidence ID', async (t) => {
  const context = await serve(t)
  const { baseUrl, investigator, secondInvestigator, linkChecks } = context
  const loginOne = await login(baseUrl, investigator)
  const loginTwo = await login(baseUrl, secondInvestigator)
  const payload = Buffer.from('electronic certificate data')

  const body = new FormData()
  body.set('file', new Blob([payload]), 'cert.bin')
  body.set('kind', 'certificate')
  const upload = await fetch(`${baseUrl}/api/files`, {
    method: 'POST',
    headers: auth(loginOne.result.token),
    body,
  })
  assert.equal(upload.status, 201)
  const { fileHash } = await upload.json()

  // Different user cannot link
  const denied = await fetch(`${baseUrl}/api/files/${fileHash}/link`, {
    method: 'POST',
    headers: { ...auth(loginTwo.result.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ evidenceId: '1' }),
  })
  assert.equal(denied.status, 403)

  // Uploader can link
  const linked = await fetch(`${baseUrl}/api/files/${fileHash}/link`, {
    method: 'POST',
    headers: { ...auth(loginOne.result.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ evidenceId: '1' }),
  })
  assert.equal(linked.status, 200)
  assert.equal(linkChecks.length, 1)
})

test('toPlainObject serializes BigInt and nested Result structures to JSON-safe values', () => {
  const input = {
    id: 42n,
    details: ['foo', 123n, { nested: 999n }],
  }
  const plain = toPlainObject(input)
  assert.strictEqual(plain.id, '42')
  assert.strictEqual(plain.details[1], '123')
  assert.strictEqual(plain.details[2].nested, '999')
  assert.doesNotThrow(() => JSON.stringify(plain))
})
