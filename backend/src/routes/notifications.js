import { Router } from 'express'
import { forbidden, unavailable } from '../utils/errors.js'
import { emailSchema, parse } from '../utils/validate.js'

export function createNotificationsRouter({ db, chain }) {
  const router = Router()

  router.put('/me/email', async (request, response) => {
    const email = parse(emailSchema, request.body?.email)
    const role = await chain.getRole(request.auth.address)
    if (role !== 'Court Official') throw forbidden('Only court officials can register an email address')
    let courtId
    try {
      courtId = String(await chain.registry.officialCourt(request.auth.address)).toLowerCase()
    } catch {
      throw unavailable('Could not look up the official court on blockchain')
    }
    if (/^0x0{64}$/.test(courtId)) throw forbidden('This wallet is not assigned to a court')
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
    const role = await chain.getRole(request.auth.address)
    if (role !== 'Court Official') throw forbidden('Only court officials can view notifications')
    let courtId
    try {
      courtId = String(await chain.registry.officialCourt(request.auth.address)).toLowerCase()
    } catch {
      throw unavailable('Could not look up the official court on blockchain')
    }
    if (/^0x0{64}$/.test(courtId)) throw forbidden('This wallet is not assigned to a court')
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
