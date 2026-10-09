import { z } from 'zod'
import { badRequest } from './errors.js'

export const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'address must be a 20-byte Ethereum address')
export const fileHashSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'fileHash must be a 32-byte hexadecimal hash')
export const evidenceIdSchema = z
  .string()
  .regex(/^[1-9]\d{0,77}$/, 'evidenceId must be a positive uint256')
  .refine((value) => BigInt(value) <= (1n << 256n) - 1n, 'evidenceId exceeds uint256')
export const evidenceIdInputSchema = z
  .union([z.string(), z.number().int().positive().safe()])
  .transform(String)
  .pipe(evidenceIdSchema)
export const emailSchema = z.string().email().max(254)

export function parse(schema, value) {
  const result = schema.safeParse(value)
  if (!result.success) {
    const message = result.error.issues.map((issue) => issue.message).join('; ')
    throw badRequest(message)
  }
  return result.data
}

export function sanitizeFilename(filename) {
  const sanitized = String(filename || '')
    .replace(/[\\/]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .trim()
    .slice(0, 120)
  return sanitized || 'evidence.bin'
}
