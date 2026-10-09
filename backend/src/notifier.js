import nodemailer from 'nodemailer'

const EVENTS = ['CaseOpened', 'EvidenceRegistered', 'EvidenceSubmittedToCourt']
const CHUNK_SIZE = 2000

export function createNotifier({ db, chain, config }) {
  let stopped = false
  let catchUpActive = false
  let timer
  const listeners = []
  const transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
  })

  async function notifyOfficials({ courtId, type, reference }) {
    const contacts = db.prepare('SELECT address, email FROM court_contacts WHERE court_id = ?').all(courtId)
    const subject = `Evidence Chain notification: ${type}`
    const text = `${type} notification for reference ${reference}. Sign in to Evidence Chain to review the record.`
    const results = await Promise.allSettled(contacts.map(async ({ address, email }) => {
      if (await chain.getRole(address) !== 'Court Official') return
      const assignedCourt = String(await chain.registry.officialCourt(address)).toLowerCase()
      if (assignedCourt !== courtId) return
      await transporter.sendMail({
        from: config.MAIL_FROM,
        to: email,
        subject,
        text,
      })
    }))
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('Court notification email delivery failed:', result.reason?.code || 'SMTP_ERROR')
      }
    }
  }

  async function processLog(eventName, event) {
    const args = event.args
    const courtId = String(args.courtId).toLowerCase()
    const reference = eventName === 'CaseOpened' ? String(args.caseId) : String(args.id)
    const insertion = db.prepare(`
      INSERT OR IGNORE INTO notifications(
        court_id, type, reference, block_number, tx_hash, log_index, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      courtId,
      eventName,
      reference,
      Number(event.blockNumber),
      event.transactionHash,
      Number(event.index ?? event.logIndex),
      new Date().toISOString(),
    )
    if (insertion.changes) await notifyOfficials({ courtId, type: eventName, reference })
  }

  async function catchUp() {
    if (catchUpActive) return
    catchUpActive = true
    try {
      const latest = await chain.provider.getBlockNumber()
      let fromBlock = Number(db.prepare("SELECT value FROM app_state WHERE key = 'notifier_last_block'").get()?.value || 0) + 1
      while (!stopped && fromBlock <= latest) {
        const toBlock = Math.min(fromBlock + CHUNK_SIZE - 1, latest)
        const logs = []
        for (const eventName of EVENTS) {
          const events = await chain.registry.queryFilter(chain.registry.filters[eventName](), fromBlock, toBlock)
          logs.push(...events.map((event) => ({ eventName, event })))
        }
        logs.sort((a, b) =>
          Number(a.event.blockNumber) - Number(b.event.blockNumber) ||
          Number(a.event.index) - Number(b.event.index),
        )
        for (const { eventName, event } of logs) await processLog(eventName, event)
        db.prepare(`
          INSERT INTO app_state(key, value) VALUES ('notifier_last_block', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(String(toBlock))
        fromBlock = toBlock + 1
      }
    } finally {
      catchUpActive = false
    }
  }

  async function start() {
    for (const eventName of EVENTS) {
      const filter = chain.registry.filters[eventName]()
      const listener = (...args) => {
        void processLog(eventName, args.at(-1)).catch((error) => {
          console.error('Court notification event processing failed:', error.code || 'UNKNOWN')
        })
      }
      await chain.registry.on(filter, listener)
      listeners.push([filter, listener])
    }
    timer = setInterval(() => {
      void catchUp().catch((error) => console.error('Court notification catch-up failed:', error.code || 'UNKNOWN'))
    }, 10_000)
    timer.unref?.()
    try {
      await catchUp()
    } catch (error) {
      console.error('Court notification catch-up failed; retrying in the background:', error.code || 'UNKNOWN')
    }
  }

  async function stop() {
    stopped = true
    if (timer) clearInterval(timer)
    await Promise.all(listeners.map(([filter, listener]) => chain.registry.off(filter, listener)))
    if (typeof transporter.close === 'function') transporter.close()
  }

  return { start, stop }
}
