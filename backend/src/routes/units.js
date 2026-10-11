import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { unavailable } from '../utils/errors.js'

const typeMap = {
  station: 1,
  lab: 2,
  court: 3,
}

// In-memory cache for 60 seconds
let unitsCache = new Map()
let locationsCache = null
let cacheExpiresAt = 0

function isCacheValid() {
  return Date.now() < cacheExpiresAt
}

export function createUnitsRouter({ chain }) {
  const router = Router()

  const unitsLimiter = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_request, response) =>
      response.status(429).json({
        error: 'RATE_LIMITED',
        message: 'Too many requests for units list; try again later',
      }),
  })

  router.use(unitsLimiter)

  // GET /api/units/locations
  router.get('/locations', async (_request, response) => {
    if (isCacheValid() && locationsCache) {
      return response.json(locationsCache)
    }

    try {
      // Courts are unit type 3
      const [ids, names, locs] = await chain.people.getUnits(3)
      const uniqueLocs = [...new Set(locs)]
      locationsCache = uniqueLocs
      cacheExpiresAt = Date.now() + 60_000
      response.json(uniqueLocs)
    } catch {
      throw unavailable('Could not fetch locations from blockchain')
    }
  })

  // GET /api/units?type=station|lab|court&location=<optional>
  router.get('/', async (request, response) => {
    const rawType = String(request.query.type || 'station').toLowerCase()
    const location = request.query.location ? String(request.query.location).trim() : null

    if (!typeMap[rawType]) {
      return response.status(400).json({ error: 'BAD_REQUEST', message: "type must be 'station', 'lab', or 'court'" })
    }

    const typeNum = typeMap[rawType]
    const cacheKey = `${typeNum}:${location || 'all'}`

    if (isCacheValid() && unitsCache.has(cacheKey)) {
      return response.json(unitsCache.get(cacheKey))
    }

    try {
      let ids, names, locs
      if (location) {
        ;[ids, names, locs] = await chain.people.getUnitsAt(typeNum, location)
      } else {
        ;[ids, names, locs] = await chain.people.getUnits(typeNum)
      }

      const units = ids.map((id, index) => ({
        id: id.toString(),
        name: names[index],
        location: locs[index],
      }))

      unitsCache.set(cacheKey, units)
      if (!cacheExpiresAt || Date.now() >= cacheExpiresAt) {
        cacheExpiresAt = Date.now() + 60_000
      }

      response.json(units)
    } catch {
      throw unavailable('Could not fetch units from blockchain')
    }
  })

  return router
}
