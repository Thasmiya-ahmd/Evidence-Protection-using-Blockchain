import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { Router } from 'express'
import multer from 'multer'
import { rateLimit } from 'express-rate-limit'
import { z } from 'zod'
import { getAddress } from 'ethers'
import { decrypt, encrypt, sha256 } from '../crypto.js'
import { writeAccessLog } from '../db.js'
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  notFound,
  unavailable,
} from '../utils/errors.js'
import {
  evidenceIdInputSchema,
  fileHashSchema,
  parse,
  sanitizeFilename,
} from '../utils/validate.js'

async function resolveUserRole(chain, address) {
  if (typeof chain.resolveUserRole === 'function') {
    const info = await chain.resolveUserRole(address)
    return info.role
  }
  return chain.getRole(address)
}

const ALLOWED_KINDS = ['evidence', 'seizure_memo', 'recording', 'certificate', 'report', 'profile_doc']

export function createFilesRouter({ db, chain, config }) {
  const router = Router()
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.MAX_FILE_MB * 1024 * 1024, files: 1, fields: 2 },
  })

  const uploadLimiter = rateLimit({
    windowMs: 60_000,
    limit: 20,
    keyGenerator: (request) => request.auth.address.toLowerCase(),
    standardHeaders: true,
    legacyHeaders: false,
    handler: (request, response) => {
      writeAccessLog(db, {
        address: request.auth.address,
        action: 'upload',
        fileHash: null,
        ip: request.ip,
      })
      response.status(429).json({
        error: 'RATE_LIMITED',
        message: 'Too many uploads; try again later',
      })
    },
  })

  const getFile = db.prepare('SELECT * FROM files WHERE file_hash = ?')

  router.post(
    '/',
    uploadLimiter,
    upload.single('file'),
    async (request, _response, next) => {
      try {
        const role = await resolveUserRole(chain, request.auth.address)
        request.auth.role = role

        const kind = parse(
          z.enum(ALLOWED_KINDS),
          request.body?.kind === undefined ? 'evidence' : request.body.kind,
        )
        request.uploadKind = kind

        // Upload permissions check:
        // evidence, seizure_memo, recording, certificate -> role Investigator only
        // report -> role Forensic Analyst only
        // profile_doc -> role None only
        if (['evidence', 'seizure_memo', 'recording', 'certificate'].includes(kind)) {
          if (role !== 'Investigator') {
            writeAccessLog(db, {
              address: request.auth.address,
              action: 'upload',
              fileHash: null,
              ip: request.ip,
            })
            throw forbidden('Only investigators can upload evidence files')
          }
        } else if (kind === 'report') {
          if (role !== 'Forensic Analyst') {
            writeAccessLog(db, {
              address: request.auth.address,
              action: 'upload',
              fileHash: null,
              ip: request.ip,
            })
            throw forbidden('Only forensic analysts can upload reports')
          }
        } else if (kind === 'profile_doc') {
          if (role !== 'None') {
            writeAccessLog(db, {
              address: request.auth.address,
              action: 'upload',
              fileHash: null,
              ip: request.ip,
            })
            throw forbidden('Only applicants without an active profile can upload profile documents')
          }
        }

        const fileHash = request.file ? sha256(request.file.buffer).toLowerCase() : null
        request.uploadFileHash = fileHash
        writeAccessLog(db, {
          address: request.auth.address,
          action: 'upload',
          fileHash,
          ip: request.ip,
        })
        next()
      } catch (error) {
        next(error)
      }
    },
    async (request, response) => {
      if (!request.file) {
        throw new AppError(400, 'BAD_REQUEST', "Multipart field 'file' is required")
      }
      const kind = request.uploadKind
      const address = request.auth.address
      const fileHash = request.uploadFileHash
      const existing = getFile.get(fileHash)

      if (existing) {
        if (existing.uploader.toLowerCase() !== address.toLowerCase()) {
          throw new AppError(409, 'FILE_EXISTS', 'A file with this hash was uploaded by another wallet')
        }
        return response.status(200).json(fileResponse(existing))
      }

      const metadata = {
        file_hash: fileHash,
        uploader: address,
        original_name: sanitizeFilename(request.file.originalname),
        mime: request.file.mimetype || 'application/octet-stream',
        size: request.file.size,
        kind,
        evidence_id: null,
        created_at: new Date().toISOString(),
      }

      await fs.mkdir(config.storageDir, { recursive: true })
      const finalPath = storagePath(config.storageDir, fileHash)
      const temporaryPath = `${finalPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`

      try {
        await fs.writeFile(temporaryPath, encrypt(request.file.buffer, config.masterKey, fileHash), {
          flag: 'wx',
          mode: 0o600,
        })
        await fs.rename(temporaryPath, finalPath)
      } catch (error) {
        await fs.rm(temporaryPath, { force: true }).catch((cleanupError) => {
          console.error('Temporary encrypted file cleanup failed:', cleanupError.code || 'UNKNOWN')
        })
        throw error
      }

      try {
        db.prepare(`
          INSERT INTO files(file_hash, uploader, original_name, mime, size, kind, evidence_id, created_at)
          VALUES (@file_hash, @uploader, @original_name, @mime, @size, @kind, @evidence_id, @created_at)
        `).run(metadata)
      } catch (error) {
        const raced = getFile.get(fileHash)
        if (!raced) throw error
        if (raced.uploader.toLowerCase() !== address.toLowerCase()) {
          throw new AppError(409, 'FILE_EXISTS', 'A file with this hash was uploaded by another wallet')
        }
        return response.status(200).json(fileResponse(raced))
      }

      response.status(201).json(fileResponse(metadata))
    },
  )

  router.post('/:fileHash/link', async (request, response) => {
    const fileHash = normalizedHash(request.params.fileHash)
    const evidenceId = parse(evidenceIdInputSchema, request.body?.evidenceId)
    const file = getFile.get(fileHash)

    if (!file) throw notFound('Uploaded file was not found')
    if (file.uploader.toLowerCase() !== request.auth.address.toLowerCase()) {
      throw forbidden('Only the wallet that uploaded this file can link it')
    }

    const matches = await chain.verifyLinkedFile(evidenceId, fileHash, request.auth.address, file.kind)
    if (!matches) {
      throw badRequest('HASH_MISMATCH: The hash does not match the on-chain evidence record for this document kind')
    }

    db.prepare('UPDATE files SET evidence_id = ? WHERE file_hash = ?').run(String(evidenceId), fileHash)
    db.prepare(`
      INSERT INTO file_links(file_hash, evidence_id, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(file_hash) DO UPDATE SET evidence_id = excluded.evidence_id
    `).run(fileHash, String(evidenceId), new Date().toISOString())

    response.json({ fileHash, evidenceId: String(evidenceId), linked: true })
  })

  router.get('/:fileHash/verify', async (request, response) => {
    const fileHash = normalizedHash(request.params.fileHash)
    writeAccessLog(db, { address: request.auth.address, action: 'verify', fileHash, ip: request.ip })
    const access = await canAccess({ db, chain, fileHash, address: request.auth.address, ip: request.ip })
    const file = access.file

    let plaintext
    try {
      plaintext = await decryptFromDisk(config.storageDir, config.masterKey, fileHash)
    } catch (error) {
      if (!isIntegrityError(error)) {
        if (error.code === 'ENOENT') throw notFound('Encrypted file was not found')
        throw unavailable(`Could not read encrypted evidence: ${error.message}`)
      }
      const onChain = access.evidenceId
        ? await chain.onChainVerify(access.evidenceId, null, request.auth.address, file.kind)
        : { registered: false, evidenceId: null, matches: false, review: null }
      return response.json({
        fileHash,
        recomputedHash: null,
        readable: false,
        matchesStoredHash: false,
        onChain,
        message: 'stored file altered or corrupted',
      })
    }

    const recomputedHash = sha256(plaintext).toLowerCase()
    const matchesStoredHash = recomputedHash === fileHash
    const onChain = access.evidenceId
      ? await chain.onChainVerify(access.evidenceId, recomputedHash, request.auth.address, file.kind)
      : { registered: false, evidenceId: null, matches: false, review: null }

    response.json({ fileHash, recomputedHash, readable: true, matchesStoredHash, onChain })
  })

  router.get('/:fileHash', async (request, response) => {
    const fileHash = normalizedHash(request.params.fileHash)
    const { file, role } = await canAccess({ db, chain, fileHash, address: request.auth.address, ip: request.ip })
    if (role !== 'Admin') {
      writeAccessLog(db, { address: request.auth.address, action: 'download', fileHash, ip: request.ip })
    }

    let plaintext
    try {
      plaintext = await decryptFromDisk(config.storageDir, config.masterKey, fileHash)
    } catch (error) {
      if (isIntegrityError(error)) {
        return response.status(409).json({
          error: 'INTEGRITY_FAILURE',
          message: 'The stored encrypted file failed its integrity check',
        })
      }
      if (error.code === 'ENOENT') throw notFound('Encrypted file was not found')
      throw unavailable(`Could not read encrypted evidence: ${error.message}`)
    }

    response
      .set('X-Content-Type-Options', 'nosniff')
      .set('Cache-Control', 'no-store')
      .type(file.mime || 'application/octet-stream')
      .attachment(file.original_name)
      .send(plaintext)
  })

  return router
}

export function createEvidenceFilesRouter({ db, chain }) {
  const router = Router()
  router.get('/:id/files', async (request, response) => {
    const evidenceId = parse(evidenceIdInputSchema, request.params.id)
    const user = request.auth.address
    if (request.auth.role === 'Admin') {
      writeAccessLog(db, {
        address: user,
        action: 'admin_review',
        fileHash: null,
        ip: request.ip,
      })
    }

    // First call getEvidence.staticCall(id, { from: user })
    const ev = await chain.getEvidence(evidenceId, user)
    if (!ev) {
      throw notFound('Evidence not found')
    }

    // Return the main evidence file plus all files linked to this evidence id
    const mainHash = String(ev.fileHash).toLowerCase()
    const linkedFiles = db.prepare('SELECT * FROM files WHERE evidence_id = ? OR file_hash = ?').all(String(evidenceId), mainHash)

    const result = linkedFiles.map((f) => ({
      fileHash: f.file_hash,
      kind: f.kind,
      name: f.original_name,
      size: f.size,
      uploader: f.uploader,
    }))
    if (request.auth.role === 'Admin') {
      for (const file of result) {
        writeAccessLog(db, {
          address: user,
          action: 'admin_review',
          fileHash: file.fileHash,
          ip: request.ip,
        })
      }
    }

    response.json({ evidenceId: String(evidenceId), files: result })
  })
  return router
}

export function createTamperRouter({ db, config }) {
  const router = Router()
  router.post('/:fileHash', async (request, response) => {
    const fileHash = normalizedHash(request.params.fileHash)
    const file = db.prepare('SELECT uploader FROM files WHERE file_hash = ?').get(fileHash)
    if (!file) throw notFound('Uploaded file was not found')
    if (file.uploader.toLowerCase() !== request.auth.address.toLowerCase()) {
      throw forbidden('Only the wallet that uploaded this file can tamper with it')
    }
    const encryptedPath = storagePath(config.storageDir, fileHash)
    let bytes
    try {
      bytes = await fs.readFile(encryptedPath)
    } catch (error) {
      if (error.code === 'ENOENT') throw notFound('Encrypted file was not found')
      throw error
    }
    if (bytes.length <= 29) throw conflict('Encrypted file is too short to tamper with')
    bytes[bytes.length - 1] ^= 0x01
    const tempPath = `${encryptedPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    try {
      await fs.writeFile(tempPath, bytes, { flag: 'wx' })
      await fs.rename(tempPath, encryptedPath)
    } finally {
      await fs.rm(tempPath, { force: true }).catch((error) => {
        console.error('Temporary encrypted file cleanup failed:', error.code || 'UNKNOWN')
      })
    }
    writeAccessLog(db, { address: request.auth.address, action: 'tamper', fileHash, ip: request.ip })
    response.json({ fileHash, tampered: true })
  })
  return router
}

export async function canAccess({ db, chain, fileHash, address, ip }) {
  const checksumAddress = getAddress(address)
  const role = await resolveUserRole(chain, checksumAddress)

  // Look up file
  const file = db.prepare('SELECT * FROM files WHERE file_hash = ?').get(fileHash.toLowerCase())
  if (!file) {
    throw notFound('File metadata was not found')
  }
  if (role === 'Admin') {
    writeAccessLog(db, { address: checksumAddress, action: 'admin_review', fileHash, ip })
  }

  // Rule a: kind "profile_doc"
  if (file.kind === 'profile_doc') {
    if (file.uploader.toLowerCase() === checksumAddress.toLowerCase() || role === 'Admin') {
      return { file, evidenceId: null, evidence: null, role }
    }
    throw forbidden('Only the uploader or an admin can access profile documents')
  }

  // Rule b: Otherwise role must be Investigator, Forensic Analyst, Court Official, or Admin
  if (!['Investigator', 'Forensic Analyst', 'Court Official', 'Admin'].includes(role)) {
    throw forbidden('Your current role cannot access evidence files')
  }

  // Rule c: Find evidence id
  let evidenceId = null
  if (file.kind === 'evidence') {
    const directId = await chain.hashToId(fileHash)
    if (directId && directId !== '0') evidenceId = directId
  }
  if (!evidenceId && file.evidence_id) {
    evidenceId = file.evidence_id
  }
  if (!evidenceId) {
    const link = db.prepare('SELECT evidence_id FROM file_links WHERE file_hash = ?').get(fileHash.toLowerCase())
    if (link?.evidence_id) evidenceId = link.evidence_id
  }

  if (evidenceId && evidenceId !== '0') {
    const evidence = await chain.getEvidence(evidenceId, checksumAddress)
    if (evidence) {
      return { file, evidenceId: String(evidenceId), evidence, role }
    }
    // Revert "Evidence not found" -> treat as not registered
  }

  // Rule d: If not registered on-chain yet: only uploader may access
  if (file.uploader.toLowerCase() !== checksumAddress.toLowerCase()) {
    throw forbidden('Only the uploader can access unlinked files')
  }

  return { file, evidenceId: null, evidence: null, role }
}

async function decryptFromDisk(storageDir, masterKey, fileHash) {
  const encrypted = await fs.readFile(storagePath(storageDir, fileHash))
  return decrypt(encrypted, masterKey, fileHash)
}

function storagePath(storageDir, fileHash) {
  return path.join(storageDir, `${fileHash}.enc`)
}

function normalizedHash(value) {
  return parse(fileHashSchema, value).toLowerCase()
}

function fileResponse(file) {
  return {
    fileHash: file.file_hash || file.fileHash,
    size: file.size,
    name: file.original_name || file.name || file.originalName,
    kind: file.kind,
  }
}

function isIntegrityError(error) {
  return (
    error instanceof Error &&
    (error.message === 'Unsupported or truncated encrypted file' ||
      error.code === 'ERR_OSSL_EVP_BAD_DECRYPT' ||
      error.code === 'ERR_CRYPTO_INVALID_AUTH_TAG' ||
      error.message.toLowerCase().includes('authenticate') ||
      error.message.toLowerCase().includes('auth tag'))
  )
}
