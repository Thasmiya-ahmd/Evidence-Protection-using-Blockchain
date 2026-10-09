import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { Router } from 'express'
import multer from 'multer'
import { rateLimit } from 'express-rate-limit'
import { z } from 'zod'
import { decrypt, encrypt, sha256 } from '../crypto.js'
import { writeAccessLog } from '../db.js'
import {
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
  const getLink = db.prepare('SELECT evidence_id FROM file_links WHERE file_hash = ?')
  const requireInvestigator = async (request, _response, next) => {
    try {
      const role = await chain.getRole(request.auth.address)
      request.auth.role = role
      if (role !== 'Investigator') {
        writeAccessLog(db, {
          address: request.auth.address,
          action: 'upload',
          fileHash: null,
          ip: request.ip,
        })
        throw forbidden('Your current wallet role cannot perform this action')
      }
      next()
    } catch (error) {
      next(error)
    }
  }

  router.post(
    '/',
    uploadLimiter,
    requireInvestigator,
    upload.single('file'),
    (request, _response, next) => {
      const fileHash = request.file ? sha256(request.file.buffer).toLowerCase() : null
      request.uploadFileHash = fileHash
      writeAccessLog(db, {
        address: request.auth.address,
        action: 'upload',
        fileHash,
        ip: request.ip,
      })
      next()
    },
    async (request, response) => {
      if (!request.file) {
        const error = new Error("Multipart field 'file' is required")
        error.status = 400
        error.code = 'BAD_REQUEST'
        throw error
      }
      const kind = parse(
        z.enum(['evidence', 'certificate']),
        request.body?.kind === undefined ? 'evidence' : request.body.kind,
      )
      const address = request.auth.address
      const fileHash = request.uploadFileHash
      const existing = getFile.get(fileHash)
      if (existing) {
        if (existing.uploader.toLowerCase() !== address.toLowerCase()) {
          throw conflict('A file with this hash was uploaded by another wallet')
        }
        return response.status(200).json(fileResponse(existing))
      }
      const metadata = {
        file_hash: fileHash,
        uploader: address,
        original_name: sanitizeFilename(request.file.originalname),
        mime_type: request.file.mimetype || 'application/octet-stream',
        size: request.file.size,
        kind,
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
        await fs.rm(temporaryPath, { force: true }).catch(() => {})
        throw error
      }
      try {
        db.prepare(`
          INSERT INTO files(file_hash, uploader, original_name, mime_type, size, kind, created_at)
          VALUES (@file_hash, @uploader, @original_name, @mime_type, @size, @kind, @created_at)
        `).run(metadata)
      } catch (error) {
        const raced = getFile.get(fileHash)
        if (!raced) throw error
        if (raced.uploader.toLowerCase() !== address.toLowerCase()) {
          throw conflict('A file with this hash was uploaded by another wallet')
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
    await chain.verifyLinkedFile(evidenceId, fileHash, request.auth.address, file.kind)
    const existing = getLink.get(fileHash)
    if (existing && existing.evidence_id !== evidenceId) {
      throw conflict('This file is already linked to another evidence record')
    }
    db.prepare(`
      INSERT INTO file_links(file_hash, evidence_id, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(file_hash) DO NOTHING
    `).run(fileHash, evidenceId, new Date().toISOString())
    response.json({ fileHash, evidenceId, linked: true })
  })

  router.get('/:fileHash/verify', async (request, response) => {
    const fileHash = normalizedHash(request.params.fileHash)
    writeAccessLog(db, { address: request.auth.address, action: 'verify', fileHash, ip: request.ip })
    const access = await canAccess({ db, chain, fileHash, address: request.auth.address })
    const file = access.file
    let plaintext
    try {
      plaintext = await decryptFromDisk(config.storageDir, config.masterKey, fileHash)
    } catch (error) {
      if (!isIntegrityError(error)) throw unavailable(`Could not read encrypted evidence: ${error.message}`)
      const onChain = access.evidenceId
        ? await chain.onChainVerify(access.evidenceId, fileHash, request.auth.address)
        : { registered: false, evidenceId: null, matches: false }
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
      ? await chain.onChainVerify(access.evidenceId, fileHash, request.auth.address)
      : { registered: false, evidenceId: null, matches: false }
    response.json({ fileHash, recomputedHash, readable: true, matchesStoredHash, onChain })
  })

  router.get('/:fileHash', async (request, response) => {
    const fileHash = normalizedHash(request.params.fileHash)
    writeAccessLog(db, { address: request.auth.address, action: 'download', fileHash, ip: request.ip })
    const { file } = await canAccess({ db, chain, fileHash, address: request.auth.address })
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
      .type(file.mime_type || 'application/octet-stream')
      .attachment(file.original_name)
      .send(plaintext)
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
      await fs.writeFile(tempPath, bytes, { flag: 'wx', mode: 0o600 })
      await fs.rename(tempPath, encryptedPath)
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => {})
    }
    writeAccessLog(db, { address: request.auth.address, action: 'tamper', fileHash, ip: request.ip })
    response.json({ fileHash, tampered: true })
  })
  return router
}

export async function canAccess({ db, chain, fileHash, address }) {
  const file = db.prepare('SELECT * FROM files WHERE file_hash = ?').get(fileHash)
  if (!file) throw notFound('File metadata was not found')
  const role = await chain.getRole(address)
  if (role === 'Admin' || role === 'None') throw forbidden('This wallet cannot access evidence files')
  const directId = await chain.hashToId(fileHash)
  const linkedId = db.prepare('SELECT evidence_id FROM file_links WHERE file_hash = ?').get(fileHash)?.evidence_id
  const evidenceId = directId !== '0' ? directId : linkedId || null
  if (!evidenceId) {
    if (file.uploader.toLowerCase() !== address.toLowerCase()) throw forbidden()
    return { file, evidenceId: null }
  }
  if (!(await chain.canView(evidenceId, address))) throw forbidden()
  return { file, evidenceId }
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
  return error instanceof Error && (
    error.message === 'Unsupported or truncated encrypted file' ||
    error.code === 'ERR_OSSL_EVP_BAD_DECRYPT' ||
    error.code === 'ERR_CRYPTO_INVALID_AUTH_TAG' ||
    error.message.toLowerCase().includes('authenticate')
  )
}
