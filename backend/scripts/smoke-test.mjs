import assert from 'node:assert/strict'
import { Wallet } from 'ethers'

const baseUrl = process.env.SMOKE_BASE_URL || 'http://localhost:5000'
const investigatorKey = process.env.TEST_KEY_INVESTIGATOR
const adminKey = process.env.TEST_KEY_ADMIN

if (!investigatorKey || !adminKey) {
  console.error('FAIL configuration: set TEST_KEY_INVESTIGATOR and TEST_KEY_ADMIN to local test wallet keys')
  process.exitCode = 1
} else {
  const investigator = new Wallet(investigatorKey)
  const admin = new Wallet(adminKey)
  let uploadedHash

  async function run(name, action) {
    try {
      await action()
      console.log(`PASS ${name}`)
    } catch (error) {
      console.error(`FAIL ${name}: ${error.message}`)
      process.exitCode = 1
    }
  }

  async function login(wallet) {
    const nonceResponse = await fetch(`${baseUrl}/api/auth/nonce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: wallet.address }),
    })
    assert.equal(nonceResponse.status, 200)
    const nonce = await nonceResponse.json()
    const signature = await wallet.signMessage(nonce.message)
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: wallet.address, signature }),
    })
    assert.equal(response.status, 200)
    return response.json()
  }

  let investigatorToken
  let adminToken
  await run('investigator wallet login', async () => {
    const result = await login(investigator)
    assert.equal(result.address.toLowerCase(), investigator.address.toLowerCase())
    assert.equal(result.role, 'Investigator')
    investigatorToken = result.token
  })
  await run('admin wallet login', async () => {
    const result = await login(admin)
    assert.equal(result.role, 'Admin')
    adminToken = result.token
  })

  if (investigatorToken) {
    await run('authenticated /me', async () => {
      const response = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${investigatorToken}` },
      })
      assert.equal(response.status, 200)
      assert.equal((await response.json()).address.toLowerCase(), investigator.address.toLowerCase())
    })
    await run('upload evidence', async () => {
      const body = new FormData()
      body.set('file', new Blob([`Evidence smoke test ${Date.now()}`]), 'smoke-evidence.txt')
      body.set('kind', 'evidence')
      const response = await fetch(`${baseUrl}/api/files`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${investigatorToken}` },
        body,
      })
      assert.equal(response.status, 201)
      const result = await response.json()
      assert.match(result.fileHash, /^0x[a-fA-F0-9]{64}$/)
      uploadedHash = result.fileHash
    })
    if (uploadedHash) {
      await run('verify uploaded file', async () => {
        const response = await fetch(`${baseUrl}/api/files/${uploadedHash}/verify`, {
          headers: { Authorization: `Bearer ${investigatorToken}` },
        })
        assert.equal(response.status, 200)
        const result = await response.json()
        assert.equal(result.readable, true)
        assert.equal(result.matchesStoredHash, true)
      })
      await run('download uploaded file', async () => {
        const response = await fetch(`${baseUrl}/api/files/${uploadedHash}`, {
          headers: { Authorization: `Bearer ${investigatorToken}` },
        })
        assert.equal(response.status, 200)
        assert.match(response.headers.get('content-disposition') || '', /smoke-evidence\.txt/)
        assert.ok((await response.arrayBuffer()).byteLength > 0)
      })
      if (adminToken) {
        await run('admin denied evidence access', async () => {
          const response = await fetch(`${baseUrl}/api/files/${uploadedHash}/verify`, {
            headers: { Authorization: `Bearer ${adminToken}` },
          })
          assert.equal(response.status, 403)
          assert.equal((await response.json()).error, 'FORBIDDEN')
        })
      }
      if (process.env.DEMO_MODE?.toLowerCase() === 'true') {
        await run('demo tampering detected', async () => {
          const tamper = await fetch(`${baseUrl}/api/dev/tamper/${uploadedHash}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${investigatorToken}` },
          })
          assert.equal(tamper.status, 200)
          const verify = await fetch(`${baseUrl}/api/files/${uploadedHash}/verify`, {
            headers: { Authorization: `Bearer ${investigatorToken}` },
          })
          assert.equal(verify.status, 200)
          const result = await verify.json()
          assert.equal(result.readable, false)
          assert.equal(result.matchesStoredHash, false)
        })
      }
    }
  }
}
