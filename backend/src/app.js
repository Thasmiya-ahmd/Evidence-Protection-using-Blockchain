import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import morgan from 'morgan'
import multer from 'multer'
import { createAuthRouter, requireAuth, requireRole } from './routes/auth.js'
import { createFilesRouter, createEvidenceFilesRouter, createTamperRouter } from './routes/files.js'
import { createProfilesRouter } from './routes/profiles.js'
import { createUnitsRouter } from './routes/units.js'
import { createNotificationsRouter } from './routes/notifications.js'
import { AppError, errorHandler, notFound } from './utils/errors.js'
import { writeAccessLog } from './db.js'

export function createApp({ config, db, chain }) {
  const app = express()
  const authenticate = requireAuth(config, chain)
  app.disable('x-powered-by')
  app.set('trust proxy', false)
  app.use(helmet())
  app.use(
    cors({
      origin: config.FRONTEND_ORIGIN,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      exposedHeaders: ['Content-Disposition'],
      credentials: false,
    }),
  )
  app.use(express.json({ limit: '100kb' }))
  app.use(
    morgan('combined', {
      skip: (request) => config.NODE_ENV === 'test' || request.path.startsWith('/api/files'),
    }),
  )

  app.get('/api/health', async (_request, response) => {
    try {
      const blockNumber = await chain.provider.getBlockNumber()
      response.json({ ok: true, chainId: config.CHAIN_ID, blockNumber: Number(blockNumber) })
    } catch {
      throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Blockchain health check failed')
    }
  })

  // Public Units Router
  app.use('/api/units', createUnitsRouter({ chain }))

  // Auth Router
  app.use('/api/auth', createAuthRouter({ db, chain, config }))

  // /api/auth/me
  app.get('/api/auth/me', authenticate, async (request, response) => {
    const { role, isMultisigOwner } = request.auth
    let profile = { status: 'None', role: 'None', unitId: '0', unitName: '', unitLocation: '' }
    if (typeof chain.getProfile === 'function') {
      const p = await chain.getProfile(request.auth.address)
      if (p) profile = p
    }
    response.json({ address: request.auth.address, role, isMultisigOwner, profile })
  })

  // Profiles Router (authenticated)
  app.use('/api', authenticate, createProfilesRouter({ db, chain, config }))

  // Evidence Files List Router (authenticated)
  app.use('/api/evidence', authenticate, createEvidenceFilesRouter({ db, chain }))

  // Files Router (authenticated)
  app.use('/api/files', authenticate, createFilesRouter({ db, chain, config }))

  // Tamper Router (development / demo)
  if (config.DEMO_MODE && !config.isProduction) {
    app.use(
      '/api/dev/tamper',
      authenticate,
      requireRole(chain, 'Investigator'),
      createTamperRouter({ db, config }),
    )
  } else {
    app.post('/api/dev/tamper/:fileHash', (_request, _response, next) => next(notFound()))
  }

  // Notifications Router (authenticated)
  if (config.NOTIFY_ENABLED) {
    app.use('/api', authenticate, createNotificationsRouter({ db, chain }))
  } else {
    app.put('/api/me/email', (_request, _response, next) => next(notFound()))
    app.get('/api/notifications', (_request, _response, next) => next(notFound()))
  }

  app.use((_request, _response, next) => next(notFound()))

  app.use((error, request, _response, next) => {
    if (error.type === 'entity.parse.failed') {
      return next(new AppError(400, 'BAD_REQUEST', 'Request body contains invalid JSON'))
    }
    if (error.type === 'entity.too.large') {
      return next(new AppError(413, 'BODY_TOO_LARGE', 'JSON request body exceeds 100 KB'))
    }
    if (error instanceof multer.MulterError) {
      if (request.auth?.address) {
        writeAccessLog(db, {
          address: request.auth.address,
          action: 'upload',
          fileHash: null,
          ip: request.ip,
        })
      }
      const tooLarge = error.code === 'LIMIT_FILE_SIZE'
      return next(
        new AppError(
          tooLarge ? 413 : 400,
          tooLarge ? 'FILE_TOO_LARGE' : 'BAD_REQUEST',
          tooLarge ? `File exceeds MAX_FILE_MB (${config.MAX_FILE_MB} MiB)` : error.message,
        ),
      )
    }
    return next(error)
  })

  app.use(errorHandler)
  return app
}
