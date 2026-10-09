import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from 'node:crypto'

const VERSION = 1
const IV_LENGTH = 12
const TAG_LENGTH = 16
const HEADER_LENGTH = 1 + IV_LENGTH + TAG_LENGTH

export function sha256(buffer) {
  return `0x${createHash('sha256').update(buffer).digest('hex')}`
}

export function deriveFileKey(masterKey, fileHash) {
  const salt = Buffer.from(fileHash.slice(2), 'hex')
  return Buffer.from(hkdfSync('sha256', masterKey, salt, Buffer.from('evidence-file'), 32))
}

export function encrypt(buffer, masterKey, fileHash) {
  const key = deriveFileKey(masterKey, fileHash)
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()])
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext])
}

export function decrypt(encrypted, masterKey, fileHash) {
  if (!Buffer.isBuffer(encrypted) || encrypted.length < HEADER_LENGTH || encrypted[0] !== VERSION) {
    throw new Error('Unsupported or truncated encrypted file')
  }
  const key = deriveFileKey(masterKey, fileHash)
  const iv = encrypted.subarray(1, 1 + IV_LENGTH)
  const tag = encrypted.subarray(1 + IV_LENGTH, HEADER_LENGTH)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted.subarray(HEADER_LENGTH)), decipher.final()])
}
