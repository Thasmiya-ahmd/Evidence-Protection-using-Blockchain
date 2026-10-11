import { Router } from 'express'
import { forbidden, unavailable } from '../utils/errors.js'
import { emailSchema, parse } from '../utils/validate.js'

export function createNotificationsRouter({ db, chain }) {
  const router = Router()

  router.put('/me/email', async (request, response) => {
    const email = parse(emailSchema, request.body?.email)
    const role = request.auth.role

    if (role !== 'Court Official' && role !== 'Admin') {
      throw forbidden('Only court officials and admins can register an email address')
    }

    let courtId = '0'
    if (role === 'Court Official') {
      try {
        const id = await chain.registry.officialCourt(request.auth.address)
        courtId = id.toString()
      } catch {
        throw unavailable('Could not look up the official court on blockchain')
      }
      if (courtId === '0') {
        throw forbidden('This wallet is not assigned to an active court')
      }
    } else if (role === 'Admin') {
      courtId = 'admin'
    }

    db.prepare(`
      INSERT INTO court_contacts(address, email, court_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(address) DO UPDATE SET
        email = excluded.email,
        court_id = excluded.court_id,
        updated_at = excluded.updated_at
    `).run(request.auth.address.toLowerCase(), email, courtId, new Date().toISOString())

    response.json({ email, courtId })
  })

  router.get('/notifications', async (request, response) => {
    const role = request.auth.role

    if (role !== 'Court Official' && role !== 'Admin') {
      throw forbidden('Only court officials and admins can view notifications')
    }

    if (role === 'Admin') {
      const notifications = db.prepare(`
        SELECT type, reference, block_number AS blockNumber, tx_hash AS txHash, created_at AS createdAt
        FROM notifications
        WHERE audience = 'admin' OR court_id = 'admin'
        ORDER BY block_number DESC, log_index DESC
        LIMIT 200
      `).all()
      return response.json({ notifications })
    }

    // Court Official
    let courtId = '0'
    try {
      const id = await chain.registry.officialCourt(request.auth.address)
      courtId = id.toString()
    } catch {
      throw unavailable('Could not look up the official court on blockchain')
    }
    if (courtId === '0') {
      throw forbidden('This wallet is not assigned to an active court')
    }

    const notifications = db.prepare(`
      SELECT type, reference, block_number AS blockNumber, tx_hash AS txHash, created_at AS createdAt
      FROM notifications
      WHERE court_id = ?
      ORDER BY block_number DESC, log_index DESC
      LIMIT 200
    `).all(courtId)

    response.json({ notifications })
  })

  return router
}
