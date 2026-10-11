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

function parseFileHashBytes(fileHash) {
  const hex = typeof fileHash === 'string' && fileHash.startsWith('0x') ? fileHash.slice(2) : fileHash
  return Buffer.from(hex, 'hex')
}

export function deriveFileKey(masterKey, fileHash) {
  const salt = parseFileHashBytes(fileHash)
  return Buffer.from(hkdfSync('sha256', masterKey, salt, Buffer.from('evidence-file'), 32))
}

export function encrypt(buffer, masterKey, fileHash) {
  const key = deriveFileKey(masterKey, fileHash)
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const aad = Buffer.concat([Buffer.from([VERSION]), parseFileHashBytes(fileHash)])
  cipher.setAAD(aad)
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
  const ciphertext = encrypted.subarray(HEADER_LENGTH)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  const aad = Buffer.concat([Buffer.from([VERSION]), parseFileHashBytes(fileHash)])
  decipher.setAAD(aad)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

export function deriveProfileKey(masterKey) {
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), Buffer.from('profile-details'), 32))
}

export function encryptProfileDetails(detailsObj, masterKey) {
  const key = deriveProfileKey(masterKey)
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const plaintext = Buffer.from(JSON.stringify(detailsObj), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([Buffer.from([VERSION]), iv, tag, ciphertext])
}

export function decryptProfileDetails(encryptedBuffer, masterKey) {
  if (!Buffer.isBuffer(encryptedBuffer) || encryptedBuffer.length < HEADER_LENGTH || encryptedBuffer[0] !== VERSION) {
    throw new Error('Unsupported or truncated profile details')
  }
  const key = deriveProfileKey(masterKey)
  const iv = encryptedBuffer.subarray(1, 1 + IV_LENGTH)
  const tag = encryptedBuffer.subarray(1 + IV_LENGTH, HEADER_LENGTH)
  const ciphertext = encryptedBuffer.subarray(HEADER_LENGTH)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return JSON.parse(plaintext.toString('utf8'))
}
