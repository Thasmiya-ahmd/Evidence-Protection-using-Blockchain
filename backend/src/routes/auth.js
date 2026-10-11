import { randomBytes } from 'node:crypto'
import { Router } from 'express'
import { getAddress, verifyMessage } from 'ethers'
import jwt from 'jsonwebtoken'
import { rateLimit } from 'express-rate-limit'
import { z } from 'zod'
import { forbidden, unauthorized } from '../utils/errors.js'
import { addressSchema, parse } from '../utils/validate.js'

const nonceRequestSchema = z.object({ address: addressSchema })
const loginRequestSchema = z.object({
  address: addressSchema,
  signature: z.string().regex(/^0x(?:[a-fA-F0-9]{2})+$/, 'A valid wallet signature is required'),
})

async function resolveUser(chain, address) {
  const { role, isMultisigOwner } = await chain.resolveUserRole(address)
  let profile = { status: 'None', role: 'None', unitId: '0', unitName: '', unitLocation: '' }
  if (typeof chain.getProfile === 'function') {
    const p = await chain.getProfile(address)
    if (p) profile = p
  }
  return { address: getAddress(address), role, isMultisigOwner, profile }
}

export function createAuthRouter({ db, chain, config }) {
  const router = Router()
  const createAuthLimiter = () =>
    rateLimit({
      windowMs: 60_000,
      limit: 10,
      standardHeaders: true,
      legacyHeaders: false,
      handler: (_request, response) =>
        response.status(429).json({
          error: 'RATE_LIMITED',
          message: 'Too many authentication requests; try again later',
        }),
    })

  const nonceLimiter = createAuthLimiter()
  const loginLimiter = createAuthLimiter()

  const insertNonce = db.prepare(`
    INSERT INTO nonces(address, nonce, message, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      nonce = excluded.nonce,
      message = excluded.message,
      expires_at = excluded.expires_at,
      created_at = excluded.created_at
  `)
  const findNonce = db.prepare('SELECT nonce, message, expires_at FROM nonces WHERE address = ?')
  const consumeNonce = db.prepare('DELETE FROM nonces WHERE address = ?')

  router.post('/nonce', nonceLimiter, (request, response) => {
    const { address: requestedAddress } = parse(nonceRequestSchema, request.body)
    const address = getAddress(requestedAddress)
    const nonce = randomBytes(32).toString('hex')
    const issued = new Date()
    const expiresAt = issued.getTime() + 5 * 60 * 1000
    const message = [
      'Sign in to Evidence Chain',
      `Address: ${address}`,
      `Nonce: ${nonce}`,
      `Issued: ${issued.toISOString()}`,
    ].join('\n')

    db.prepare('DELETE FROM nonces WHERE expires_at <= ?').run(Date.now())
    insertNonce.run(address.toLowerCase(), nonce, message, expiresAt, issued.toISOString())
    response.json({ nonce, message, expiresAt: new Date(expiresAt).toISOString() })
  })

  router.post('/login', loginLimiter, async (request, response) => {
    const { address: requestedAddress, signature } = parse(loginRequestSchema, request.body)
    const address = getAddress(requestedAddress)
    const key = address.toLowerCase()
    const pending = findNonce.get(key)

    if (!pending) {
      throw unauthorized('Login nonce is missing or expired; request a new nonce')
    }

    // Always consume the nonce even on failure
    consumeNonce.run(key)

    if (pending.expires_at <= Date.now()) {
      throw unauthorized('Login nonce is missing or expired; request a new nonce')
    }

    let recovered
    try {
      recovered = getAddress(verifyMessage(pending.message, signature))
    } catch {
      throw unauthorized('Wallet signature could not be verified')
    }

    if (recovered.toLowerCase() !== key) {
      throw unauthorized('Wallet signature does not match the requested address')
    }

    const { role, isMultisigOwner, profile } = await resolveUser(chain, address)
    const token = jwt.sign({ sub: address }, config.JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: config.JWT_EXPIRES_IN,
    })

    response.json({ token, address, role, isMultisigOwner, profile })
  })

  return router
}

export function requireAuth(config, chain) {
  return (request, _response, next) => {
    const [scheme, token, ...extra] = String(request.get('authorization') || '').split(' ')
    if (scheme !== 'Bearer' || !token || extra.length) {
      return next(unauthorized('Bearer token is required'))
    }
    try {
      const payload = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] })
      if (!payload || typeof payload !== 'object' || typeof payload.sub !== 'string') {
        return next(unauthorized('Login token is invalid'))
      }
      request.auth = { address: getAddress(payload.sub) }
      Promise.resolve()
        .then(() => chain.resolveUserRole(request.auth.address))
        .then(({ role, isMultisigOwner }) => {
          request.auth.role = role
          request.auth.isMultisigOwner = isMultisigOwner
          next()
        })
        .catch(next)
    } catch {
      return next(unauthorized('Login token is invalid or expired'))
    }
  }
}

export function requireRole(chain, ...allowedRoles) {
  return async (request, _response, next) => {
    try {
      const { role, isMultisigOwner } = await chain.resolveUserRole(request.auth.address)
      request.auth.role = role
      request.auth.isMultisigOwner = isMultisigOwner
      if (!allowedRoles.includes(role)) {
        throw forbidden('Your current wallet role cannot perform this action')
      }
      next()
    } catch (error) {
      next(error)
    }
  }
}
