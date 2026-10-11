import { Router } from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import { getAddress } from 'ethers'
import { rateLimit } from 'express-rate-limit'
import { z } from 'zod'
import { isConnectionError } from '../chain.js'
import { decryptProfileDetails, encryptProfileDetails, sha256 } from '../crypto.js'
import { writeAccessLog } from '../db.js'
import { badRequest, forbidden, notFound, unavailable } from '../utils/errors.js'
import { addressSchema, fileHashSchema, parse } from '../utils/validate.js'

function stripControlCharacters(str) {
  return String(str || '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
}

const profileSubmitSchema = z.object({
  role: z.enum(['Investigator', 'Analyst', 'CourtOfficial']),
  unitId: z.union([z.string(), z.number()]).transform((v) => String(v)),
  fullName: z.string().min(1).max(100).transform(stripControlCharacters),
  designation: z.string().min(1).max(100).transform(stripControlCharacters),
  employeeId: z.string().min(1).max(50).regex(/^[a-zA-Z0-9_-]+$/, 'employeeId must be alphanumeric').transform(stripControlCharacters),
  email: z.string().email().max(254).transform((v) => v.toLowerCase().trim()),
  phone: z.string().min(5).max(20).regex(/^[0-9+() -]+$/, 'phone contains invalid characters').transform(stripControlCharacters),
  idDocumentHash: z.preprocess(
    (v) => (v === undefined || v === null || v === '' ? '' : String(v).toLowerCase()),
    z.union([z.literal(''), fileHashSchema]),
  ),
})

function buildCanonicalProfile(data) {
  // Exact order: address (checksum), role, unitId (decimal string), fullName, designation, employeeId, email, phone, idDocumentHash
  return {
    address: data.address,
    role: data.role,
    unitId: String(data.unitId),
    fullName: data.fullName,
    designation: data.designation,
    employeeId: data.employeeId,
    email: data.email,
    phone: data.phone,
    idDocumentHash: data.idDocumentHash || '',
  }
}

export function computeDetailsHash(canonicalObj) {
  return sha256(Buffer.from(JSON.stringify(canonicalObj), 'utf8'))
}

export function createProfilesRouter({ db, chain, config }) {
  const router = Router()

  const profileLimiter = rateLimit({
    windowMs: 60_000,
    limit: 5,
    keyGenerator: (request) => request.auth.address.toLowerCase(),
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_request, response) =>
      response.status(429).json({
        error: 'RATE_LIMITED',
        message: 'Too many profile requests; try again later',
      }),
  })

  // POST /api/profile
  router.post('/profile', profileLimiter, async (request, response) => {
    const address = request.auth.address
    const role = await chain.getRole(address)

    if (role === 'Admin') {
      throw forbidden('Admins cannot hold operational roles or request profiles')
    }
    if (role !== 'None') {
      throw forbidden('Only wallets with role None can submit a profile request')
    }

    const onChainProfile = await chain.getProfile(address)
    if (onChainProfile && !['None', 'Rejected'].includes(onChainProfile.status)) {
      throw forbidden('A profile request is already pending or active for this address')
    }

    const body = parse(profileSubmitSchema, request.body)

    // Check optional idDocumentHash
    if (body.idDocumentHash) {
      const doc = db.prepare('SELECT * FROM files WHERE file_hash = ?').get(body.idDocumentHash.toLowerCase())
      if (!doc) {
        throw badRequest('idDocumentHash does not reference an uploaded file')
      }
      if (doc.kind !== 'profile_doc') {
        throw badRequest('idDocumentHash must be a profile_doc file')
      }
      if (doc.uploader.toLowerCase() !== address.toLowerCase()) {
        throw forbidden('idDocumentHash must be uploaded by this wallet')
      }
    }

    // Verify unit exists and unit type matches role
    let unitType, unitName, unitLocation
    try {
      const u = await chain.people.unitInfo(body.unitId)
      unitType = Number(u[0])
      unitName = u[1]
      unitLocation = u[2]
    } catch (error) {
      if (isConnectionError(error)) {
        throw unavailable('Blockchain service is unavailable')
      }
      throw badRequest('Invalid unitId')
    }

    const roleNumberMap = {
      Investigator: 1,
      Analyst: 2,
      CourtOfficial: 3,
    }
    const roleNumber = roleNumberMap[body.role]
    if (unitType !== roleNumber) {
      throw badRequest(`Unit type (${unitType}) does not match requested role (${body.role})`)
    }

    const canonical = buildCanonicalProfile({
      address: getAddress(address),
      role: body.role,
      unitId: body.unitId,
      fullName: body.fullName,
      designation: body.designation,
      employeeId: body.employeeId,
      email: body.email,
      phone: body.phone,
      idDocumentHash: body.idDocumentHash,
    })

    const detailsHash = computeDetailsHash(canonical)
    const encryptedDetails = encryptProfileDetails(canonical, config.masterKey)

    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO profiles(address, role, unit_id, details_enc, details_hash, doc_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(address) DO UPDATE SET
        role = excluded.role,
        unit_id = excluded.unit_id,
        details_enc = excluded.details_enc,
        details_hash = excluded.details_hash,
        doc_hash = excluded.doc_hash,
        updated_at = excluded.updated_at
    `).run(
      address.toLowerCase(),
      body.role,
      body.unitId,
      encryptedDetails,
      detailsHash,
      body.idDocumentHash || null,
      now,
      now,
    )

    response.json({
      detailsHash,
      roleNumber,
      unitId: body.unitId,
      unitName,
      unitLocation,
    })
  })

  // GET /api/profile/me
  router.get('/profile/me', async (request, response) => {
    const address = request.auth.address
    const onChainProfile = await chain.getProfile(address)

    const row = db.prepare('SELECT * FROM profiles WHERE address = ?').get(address.toLowerCase())
    let details = null
    if (row?.details_enc) {
      try {
        details = decryptProfileDetails(row.details_enc, config.masterKey)
      } catch {
        throw unavailable('Could not decrypt stored profile details')
      }
    }

    response.json({
      onChain: onChainProfile,
      details,
    })
  })

  // DELETE /api/profile/me
  router.delete('/profile/me', async (request, response) => {
    const address = request.auth.address
    const onChainProfile = await chain.getProfile(address)

    if (onChainProfile && !['None', 'Rejected'].includes(onChainProfile.status)) {
      throw forbidden('Cannot delete profile when status is not None or Rejected')
    }

    const row = db.prepare('SELECT doc_hash FROM profiles WHERE address = ?').get(address.toLowerCase())
    if (row?.doc_hash) {
      try {
        await fs.rm(path.join(config.storageDir, `${row.doc_hash}.enc`), { force: true })
      } catch {
        throw unavailable('Could not remove the stored profile document')
      }
    }

    db.transaction(() => {
      if (row?.doc_hash) {
        db.prepare('DELETE FROM file_links WHERE file_hash = ?').run(row.doc_hash)
        db.prepare('DELETE FROM files WHERE file_hash = ? AND uploader = ?').run(row.doc_hash, address)
      }
      db.prepare('DELETE FROM profiles WHERE address = ?').run(address.toLowerCase())
    })()

    response.json({ success: true })
  })

  // GET /api/admin/profiles/pending
  router.get('/admin/profiles/pending', async (request, response) => {
    const role = await chain.getRole(request.auth.address)
    if (role !== 'Admin') {
      throw forbidden('Only admins can view pending profiles')
    }

    let pendingAddresses = []
    try {
      pendingAddresses = await chain.people.pendingProfiles.staticCall({ from: request.auth.address })
    } catch (err) {
      throw unavailable(`Could not fetch pending profiles from chain: ${err.message}`)
    }

    const results = []
    for (const applicant of pendingAddresses) {
      const checksum = getAddress(applicant)
      const onChain = await chain.getProfile(checksum)
      const row = db.prepare('SELECT * FROM profiles WHERE address = ?').get(checksum.toLowerCase())

      let details = null
      let hashMatches = false
      let detailsMissing = true

      if (row?.details_enc) {
        try {
          details = decryptProfileDetails(row.details_enc, config.masterKey)
          detailsMissing = false
          const computed = computeDetailsHash(details)
          hashMatches = onChain?.detailsHash && computed.toLowerCase() === String(onChain.detailsHash).toLowerCase()
        } catch {
          throw unavailable('Could not decrypt pending profile details')
        }
      }

      results.push({
        address: checksum,
        role: onChain?.role || 'None',
        unitId: onChain?.unitId || '0',
        unitName: onChain?.unitName || '',
        unitLocation: onChain?.unitLocation || '',
        requestedAt: onChain?.requestedAt || '0',
        details,
        detailsMissing,
        hashMatches,
      })
    }

    response.json({ pending: results })
  })

  // GET /api/admin/profiles/:address
  router.get('/admin/profiles/:address', async (request, response) => {
    const role = await chain.getRole(request.auth.address)
    if (role !== 'Admin') {
      throw forbidden('Only admins can view profile details')
    }

    const targetAddress = parse(addressSchema, request.params.address)
    const checksum = getAddress(targetAddress)

    writeAccessLog(db, {
      address: request.auth.address,
      action: 'profile_view',
      fileHash: null,
      ip: request.ip,
    })

    const onChain = await chain.getProfile(checksum)
    const row = db.prepare('SELECT * FROM profiles WHERE address = ?').get(checksum.toLowerCase())

    let details = null
    let hashMatches = false
    let detailsMissing = true
    let docAvailable = false

    if (row?.details_enc) {
      try {
        details = decryptProfileDetails(row.details_enc, config.masterKey)
        detailsMissing = false
        const computed = computeDetailsHash(details)
        hashMatches = onChain?.detailsHash && computed.toLowerCase() === String(onChain.detailsHash).toLowerCase()
      } catch {
        throw unavailable('Could not decrypt stored profile details')
      }
    }

    if (row?.doc_hash) {
      const doc = db.prepare('SELECT file_hash FROM files WHERE file_hash = ?').get(row.doc_hash)
      docAvailable = Boolean(doc)
    }

    response.json({
      address: checksum,
      role: onChain?.role || 'None',
      unitId: onChain?.unitId || '0',
      unitName: onChain?.unitName || '',
      unitLocation: onChain?.unitLocation || '',
      requestedAt: onChain?.requestedAt || '0',
      decidedAt: onChain?.decidedAt || '0',
      status: onChain?.status || 'None',
      details,
      detailsMissing,
      hashMatches,
      docHash: row?.doc_hash || null,
      docAvailable,
    })
  })

  return router
}
