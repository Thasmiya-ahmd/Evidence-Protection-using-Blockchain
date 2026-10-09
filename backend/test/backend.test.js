import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Wallet } from 'ethers'
import { createApp } from '../src/app.js'
import { assertChainReady } from '../src/chain.js'
import { loadConfig } from '../src/config.js'
import { decrypt, encrypt, sha256 } from '../src/crypto.js'
import { openDatabase } from '../src/db.js'

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
    [admin.address.toLowerCase(), 'Admin'],
    [analyst.address.toLowerCase(), 'Forensic Analyst'],
    [courtOfficial.address.toLowerCase(), 'Court Official'],
  ])
  const linkChecks = []
  const chain = {
    provider: { getBlockNumber: async () => 23 },
    registry: {
      officialCourt: async () => `0x${'12'.repeat(32)}`,
    },
    getRole: async (address) => roles.get(address.toLowerCase()) || 'None',
    hashToId: async () => '0',
    canView: async () => true,
    onChainVerify: async (evidenceId) => ({
      registered: true,
      evidenceId: String(evidenceId),
      matches: true,
    }),
    verifyLinkedFile: async (evidenceId, fileHash, address, kind) => {
      linkChecks.push({ evidenceId, fileHash, address, kind })
      return { registered: true, evidenceId: String(evidenceId), matches: true }
    },
  }
  const server = createApp({ config, db, chain }).listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
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
    linkChecks,
    db,
    storageDir,
  }
}

async function login(baseUrl, wallet) {
  const response = await fetch(`${baseUrl}/api/auth/nonce`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: wallet.address }),
  })
  assert.equal(response.status, 200)
  const nonce = await response.json()
  const signature = await wallet.signMessage(nonce.message)
  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: wallet.address, signature }),
  })
  return { response: loginResponse, result: await loginResponse.json(), signature }
}

function auth(token) {
  return { Authorization: `Bearer ${token}` }
}

test('example backend configuration validates and invalid encryption keys fail clearly', async () => {
  const dotenv = await import('dotenv')
  const envFile = await fs.readFile(new URL('../.env.example', import.meta.url), 'utf8')
  const example = dotenv.parse(envFile)
  const config = loadConfig(example)
  assert.equal(config.PORT, 5000)
  assert.equal(config.CHAIN_ID, 31337)
  assert.equal(config.masterKey.length, 32)
  assert.equal(config.DEMO_MODE, false)
  assert.throws(
    () => loadConfig({ ...example, MASTER_KEY: 'invalid' }),
    /MASTER_KEY must be exactly 64 hexadecimal characters/,
  )
})

test('startup chain checks reject a mismatched network and missing contract', async () => {
  const registryAddress = `0x${'12'.repeat(20)}`
  const chain = {
    provider: {
      getNetwork: async () => ({ chainId: 31337n }),
      getBlockNumber: async () => 1,
      getCode: async () => '0x6000',
    },
  }
  await assertChainReady(chain, 31337, registryAddress)
  await assert.rejects(
    assertChainReady({ ...chain, provider: { ...chain.provider, getNetwork: async () => ({ chainId: 1n }) } }, 31337, registryAddress),
    /RPC chain ID 1 does not match configured CHAIN_ID 31337/,
  )
  await assert.rejects(
    assertChainReady({ ...chain, provider: { ...chain.provider, getCode: async () => '0x' } }, 31337, registryAddress),
    /no contract code exists at REGISTRY_ADDRESS/i,
  )
})

test('per-file HKDF and AES-GCM authenticate encrypted bytes', () => {
  const masterKey = Buffer.alloc(32, 9)
  const plaintext = Buffer.from('chain-of-custody evidence')
  const hash = sha256(plaintext)
  const encrypted = encrypt(plaintext, masterKey, hash)
  assert.equal(encrypted[0], 1)
  assert.deepEqual(decrypt(encrypted, masterKey, hash), plaintext)
  encrypted[encrypted.length - 1] ^= 1
  assert.throws(() => decrypt(encrypted, masterKey, hash))
})

test('wallet login is signature-bound, role-specific endpoints are enforced, and nonces are single-use', async (t) => {
  const context = await serve(t, { notify: true })
  const { baseUrl, investigator, admin, courtOfficial } = context
  const loggedIn = await login(baseUrl, investigator)
  assert.equal(loggedIn.response.status, 200)
  assert.equal(loggedIn.result.role, 'Investigator')
  assert.ok(loggedIn.result.token)

  const replay = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: investigator.address, signature: loggedIn.signature }),
  })
  assert.equal(replay.status, 401)
  const investigatorToken = loggedIn.result.token
  const adminLogin = await login(baseUrl, admin)
  assert.equal(adminLogin.response.status, 200)
  const unassignedWallet = Wallet.createRandom()
  const unassignedLogin = await login(baseUrl, unassignedWallet)
  assert.equal(unassignedLogin.response.status, 200)
  assert.equal(unassignedLogin.result.role, 'None')
  const courtLogin = await login(baseUrl, courtOfficial)
  assert.equal(courtLogin.response.status, 200)
  assert.equal(courtLogin.result.role, 'Court Official')

  const health = await fetch(`${baseUrl}/api/health`)
  assert.deepEqual(await health.json(), { ok: true, chainId: 31337, blockNumber: 23 })
  const me = await fetch(`${baseUrl}/api/auth/me`, { headers: auth(investigatorToken) })
  assert.equal(me.status, 200)
  assert.equal((await me.json()).role, 'Investigator')
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
  const disabledTamper = await fetch(`${baseUrl}/api/dev/tamper/${'0'.repeat(64)}`, { method: 'POST' })
  assert.equal(disabledTamper.status, 404)
})

test('optional notification endpoints are absent when notifications are disabled', async (t) => {
  const { baseUrl } = await serve(t)
  assert.equal((await fetch(`${baseUrl}/api/me/email`, { method: 'PUT' })).status, 404)
  assert.equal((await fetch(`${baseUrl}/api/notifications`)).status, 404)
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

  const duplicateBody = new FormData()
  duplicateBody.set('file', new Blob([payload]), 'duplicate.txt')
  const duplicateUpload = await fetch(`${baseUrl}/api/files`, {
    method: 'POST',
    headers: auth(token),
    body: duplicateBody,
  })
  assert.equal(duplicateUpload.status, 200)
  assert.equal((await duplicateUpload.json()).fileHash, metadata.fileHash)
  const otherUploaderBody = new FormData()
  otherUploaderBody.set('file', new Blob([payload]), 'same-content.txt')
  const otherUploaderUpload = await fetch(`${baseUrl}/api/files`, {
    method: 'POST',
    headers: auth(secondInvestigatorLogin.result.token),
    body: otherUploaderBody,
  })
  assert.equal(otherUploaderUpload.status, 409)

  const diskPath = path.join(storageDir, `${metadata.fileHash}.enc`)
  const encryptedOnDisk = await fs.readFile(diskPath)
  assert.equal(encryptedOnDisk.includes(payload), false)
  assert.notDeepEqual(encryptedOnDisk, payload)

  const verifyUrl = `${baseUrl}/api/files/${metadata.fileHash}/verify`
  const analystUploadBody = new FormData()
  analystUploadBody.set(
    'file',
    new Blob([new Uint8Array(1024 * 1024 + 1)]),
    'oversized-analyst-upload.txt',
  )
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
  assert.equal(verification.onChain.registered, false)

  const download = await fetch(`${baseUrl}/api/files/${metadata.fileHash}`, { headers: auth(token) })
  assert.equal(download.status, 200)
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), payload)

  const denied = await fetch(verifyUrl, { headers: auth(adminToken) })
  assert.equal(denied.status, 403, await denied.clone().text())
  assert.equal((await denied.json()).error, 'FORBIDDEN')

  roles.set(investigator.address.toLowerCase(), 'None')
  const removedRoleDenied = await fetch(verifyUrl, { headers: auth(token) })
  assert.equal(removedRoleDenied.status, 403)
  roles.set(investigator.address.toLowerCase(), 'Investigator')

  const tamper = await fetch(`${baseUrl}/api/dev/tamper/${metadata.fileHash}`, {
    method: 'POST',
    headers: auth(token),
  })
  assert.equal(tamper.status, 200)
  const tamperedVerify = await fetch(verifyUrl, { headers: auth(token) })
  assert.equal(tamperedVerify.status, 200)
  const tamperedResult = await tamperedVerify.json()
  assert.equal(tamperedResult.readable, false)
  assert.equal(tamperedResult.matchesStoredHash, false)
  assert.deepEqual(tamperedResult.onChain, { registered: false, evidenceId: null, matches: false })
  assert.equal(tamperedResult.message, 'stored file altered or corrupted')

  const tamperedDownload = await fetch(`${baseUrl}/api/files/${metadata.fileHash}`, { headers: auth(token) })
  assert.equal(tamperedDownload.status, 409)
  assert.equal((await tamperedDownload.json()).error, 'INTEGRITY_FAILURE')
  const actions = db.prepare('SELECT action FROM access_log ORDER BY id').all().map((row) => row.action)
  assert.deepEqual(actions, [
    'upload',
    'upload',
    'upload',
    'upload',
    'verify',
    'download',
    'verify',
    'verify',
    'tamper',
    'verify',
    'download',
  ])
})

test('certificate links require the original uploader and stay tied to the on-chain evidence ID', async (t) => {
  const { baseUrl, investigator, secondInvestigator, linkChecks } = await serve(t, { demo: true })
  const ownerLogin = await login(baseUrl, investigator)
  const otherLogin = await login(baseUrl, secondInvestigator)
  const content = Buffer.from('electronic evidence certificate')
  const form = new FormData()
  form.set('file', new Blob([content]), 'certificate.pdf')
  form.set('kind', 'certificate')
  const uploaded = await fetch(`${baseUrl}/api/files`, {
    method: 'POST',
    headers: auth(ownerLogin.result.token),
    body: form,
  })
  assert.equal(uploaded.status, 201)
  const { fileHash } = await uploaded.json()

  const linkUrl = `${baseUrl}/api/files/${fileHash}/link`
  const body = JSON.stringify({ evidenceId: 1 })
  const denied = await fetch(linkUrl, {
    method: 'POST',
    headers: { ...auth(otherLogin.result.token), 'Content-Type': 'application/json' },
    body,
  })
  assert.equal(denied.status, 403, await denied.clone().text())
  assert.equal(linkChecks.length, 0)

  const linked = await fetch(linkUrl, {
    method: 'POST',
    headers: { ...auth(ownerLogin.result.token), 'Content-Type': 'application/json' },
    body,
  })
  assert.equal(linked.status, 200)
  assert.deepEqual(linkChecks, [{
    evidenceId: '1',
    fileHash,
    address: investigator.address,
    kind: 'certificate',
  }])
  const verification = await fetch(`${baseUrl}/api/files/${fileHash}/verify`, {
    headers: auth(ownerLogin.result.token),
  })
  assert.equal(verification.status, 200)
  const result = await verification.json()
  assert.deepEqual(result.onChain, { registered: true, evidenceId: '1', matches: true })

  const tampered = await fetch(`${baseUrl}/api/dev/tamper/${fileHash}`, {
    method: 'POST',
    headers: auth(ownerLogin.result.token),
  })
  assert.equal(tampered.status, 200)
  const corruptedVerification = await fetch(`${baseUrl}/api/files/${fileHash}/verify`, {
    headers: auth(ownerLogin.result.token),
  })
  assert.equal(corruptedVerification.status, 200)
  const corrupted = await corruptedVerification.json()
  assert.equal(corrupted.readable, false)
  assert.deepEqual(corrupted.onChain, { registered: true, evidenceId: '1', matches: true })
})
