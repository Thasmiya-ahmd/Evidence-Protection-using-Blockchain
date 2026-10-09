import 'dotenv/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAddress } from 'ethers'
import { z } from 'zod'

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const emptyToUndefined = (value) => value === '' ? undefined : value
const optionalString = z.preprocess(emptyToUndefined, z.string().optional())

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(5000),
  FRONTEND_ORIGIN: z.string().url().default('http://localhost:5173'),
  RPC_URL: z.string().url().default('http://127.0.0.1:8545'),
  CHAIN_ID: z.coerce.number().int().positive().default(31337),
  REGISTRY_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().regex(/^[1-9]\d*(?:s|m|h|d|w|y)$/i).default('2h'),
  MASTER_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/, 'MASTER_KEY must be exactly 64 hexadecimal characters'),
  MAX_FILE_MB: z.coerce.number().int().min(1).max(1024).default(50),
  STORAGE_DIR: z.string().default('./storage'),
  DB_PATH: z.string().default('./data/app.db'),
  DEMO_MODE: z.string().default('false').transform((value, ctx) => {
    if (!['true', 'false'].includes(value.toLowerCase())) {
      ctx.addIssue({ code: 'custom', message: 'DEMO_MODE must be true or false' })
      return z.NEVER
    }
    return value.toLowerCase() === 'true'
  }),
  NOTIFY_ENABLED: z.string().default('false').transform((value, ctx) => {
    if (!['true', 'false'].includes(value.toLowerCase())) {
      ctx.addIssue({ code: 'custom', message: 'NOTIFY_ENABLED must be true or false' })
      return z.NEVER
    }
    return value.toLowerCase() === 'true'
  }),
  SMTP_HOST: optionalString,
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_USER: optionalString,
  SMTP_PASS: optionalString,
  MAIL_FROM: optionalString,
}).superRefine((env, ctx) => {
  if (env.NOTIFY_ENABLED) {
    for (const key of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM']) {
      if (!env[key]) {
        ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required when NOTIFY_ENABLED=true` })
      }
    }
  }
})

export function loadConfig(environment = process.env) {
  const result = envSchema.safeParse(environment)
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
      .join('; ')
    throw new Error(`Invalid backend configuration: ${details}`)
  }
  const value = result.data
  return {
    ...value,
    registryAddress: getAddress(value.REGISTRY_ADDRESS.toLowerCase()),
    masterKey: Buffer.from(value.MASTER_KEY, 'hex'),
    storageDir: path.resolve(backendDir, value.STORAGE_DIR),
    dbPath: path.resolve(backendDir, value.DB_PATH),
    backendDir,
    isProduction: value.NODE_ENV === 'production',
  }
}
