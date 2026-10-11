import nodemailer from 'nodemailer'

const CHUNK_SIZE = 2000

// EvidenceRegistry events:
// Court audience: CaseOpened, EvidenceApproved, EvidenceSubmittedToCourt
// Admin audience: EvidenceSubmittedForReview, AnalysisRequested
const REGISTRY_EVENTS = [
  'CaseOpened',
  'EvidenceApproved',
  'EvidenceSubmittedToCourt',
  'EvidenceSubmittedForReview',
  'AnalysisRequested',
]

// PeopleRegistry events:
// Admin audience: ProfileRequested
const PEOPLE_EVENTS = ['ProfileRequested']

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

  async function notifyOfficials({ courtId, audience, type, reference }) {
    let contacts = []
    if (audience === 'admin') {
      contacts = db.prepare("SELECT address, email FROM court_contacts WHERE court_id = 'admin'").all()
    } else {
      contacts = db.prepare('SELECT address, email FROM court_contacts WHERE court_id = ?').all(courtId)
    }

    const subject = `Evidence Chain notification: ${type}`
    const text = `${type} notification for reference ${reference}. Sign in to Evidence Chain to review the record.`

    const results = await Promise.allSettled(
      contacts.map(async ({ address, email }) => {
        const userRole = await chain.getRole(address)
        if (audience === 'admin' && userRole !== 'Admin') return
        if (audience === 'court') {
          if (userRole !== 'Court Official') return
          const assignedCourt = (await chain.registry.officialCourt(address)).toString()
          if (assignedCourt !== courtId) return
        }

        await transporter.sendMail({
          from: config.MAIL_FROM,
          to: email,
          subject,
          text,
        })
      }),
    )

    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('Notification email delivery failed:', result.reason?.code || 'SMTP_ERROR')
      }
    }
  }

  async function processRegistryLog(eventName, event) {
    const args = event.args
    let courtId = '0'
    let audience = 'court'
    let reference = ''

    if (eventName === 'CaseOpened') {
      courtId = args.courtId.toString()
      audience = 'court'
      reference = String(args.caseId)
    } else if (eventName === 'EvidenceApproved') {
      courtId = args.courtId.toString()
      audience = 'court'
      reference = args.id.toString()
    } else if (eventName === 'EvidenceSubmittedToCourt') {
      courtId = args.courtId.toString()
      audience = 'court'
      reference = args.id.toString()
    } else if (eventName === 'EvidenceSubmittedForReview') {
      courtId = 'admin'
      audience = 'admin'
      reference = args.id.toString()
    } else if (eventName === 'AnalysisRequested') {
      courtId = 'admin'
      audience = 'admin'
      reference = String(args.caseKey)
    }

    const insertion = db.prepare(`
      INSERT OR IGNORE INTO notifications(
        court_id, type, reference, block_number, tx_hash, log_index, created_at, contract, audience
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      courtId,
      eventName,
      reference,
      Number(event.blockNumber),
      event.transactionHash,
      Number(event.index ?? event.logIndex),
      new Date().toISOString(),
      'EvidenceRegistry',
      audience,
    )

    if (insertion.changes) {
      try {
        await notifyOfficials({ courtId, audience, type: eventName, reference })
      } catch (error) {
        console.error('Notification delivery failed:', eventName, error.code || 'UNKNOWN')
      }
    }
  }

  async function processPeopleLog(eventName, event) {
    const args = event.args
    const courtId = 'admin'
    const audience = 'admin'
    const reference = String(args.who)

    const insertion = db.prepare(`
      INSERT OR IGNORE INTO notifications(
        court_id, type, reference, block_number, tx_hash, log_index, created_at, contract, audience
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      courtId,
      eventName,
      reference,
      Number(event.blockNumber),
      event.transactionHash,
      Number(event.index ?? event.logIndex),
      new Date().toISOString(),
      'PeopleRegistry',
      audience,
    )

    if (insertion.changes) {
      try {
        await notifyOfficials({ courtId, audience, type: eventName, reference })
      } catch (error) {
        console.error('Notification delivery failed:', eventName, error.code || 'UNKNOWN')
      }
    }
  }

  async function catchUpContract(contract, eventNames, processFn, stateKey) {
    const latest = await chain.provider.getBlockNumber()
    let fromBlock = Number(db.prepare('SELECT value FROM app_state WHERE key = ?').get(stateKey)?.value || 0) + 1

    while (!stopped && fromBlock <= latest) {
      const toBlock = Math.min(fromBlock + CHUNK_SIZE - 1, latest)
      const logs = []
      for (const eventName of eventNames) {
        if (!contract.filters[eventName]) continue
        const events = await contract.queryFilter(contract.filters[eventName](), fromBlock, toBlock)
        logs.push(...events.map((event) => ({ eventName, event })))
      }
      logs.sort((a, b) =>
        Number(a.event.blockNumber) - Number(b.event.blockNumber) ||
        Number(a.event.index ?? a.event.logIndex) - Number(b.event.index ?? b.event.logIndex),
      )
      for (const { eventName, event } of logs) {
        await processFn(eventName, event)
      }
      db.prepare(`
        INSERT INTO app_state(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(stateKey, String(toBlock))
      fromBlock = toBlock + 1
    }
  }

  async function catchUp() {
    if (catchUpActive) return
    catchUpActive = true
    try {
      await catchUpContract(chain.registry, REGISTRY_EVENTS, processRegistryLog, 'notifier_last_block_registry')
      if (chain.people) {
        await catchUpContract(chain.people, PEOPLE_EVENTS, processPeopleLog, 'notifier_last_block_people')
      }
    } finally {
      catchUpActive = false
    }
  }

  async function start() {
    // Listeners for EvidenceRegistry
    for (const eventName of REGISTRY_EVENTS) {
      if (!chain.registry.filters[eventName]) continue
      const filter = chain.registry.filters[eventName]()
      const listener = (...args) => {
        void processRegistryLog(eventName, args.at(-1)).catch((error) => {
          console.error('EvidenceRegistry event processing failed:', error.code || 'UNKNOWN')
        })
      }
      await chain.registry.on(filter, listener)
      listeners.push([chain.registry, filter, listener])
    }

    // Listeners for PeopleRegistry
    if (chain.people) {
      for (const eventName of PEOPLE_EVENTS) {
        if (!chain.people.filters[eventName]) continue
        const filter = chain.people.filters[eventName]()
        const listener = (...args) => {
          void processPeopleLog(eventName, args.at(-1)).catch((error) => {
            console.error('PeopleRegistry event processing failed:', error.code || 'UNKNOWN')
          })
        }
        await chain.people.on(filter, listener)
        listeners.push([chain.people, filter, listener])
      }
    }

    timer = setInterval(() => {
      void catchUp().catch((error) => console.error('Notification catch-up failed:', error.code || 'UNKNOWN'))
    }, 10_000)
    timer.unref?.()

    try {
      await catchUp()
    } catch (error) {
      console.error('Notification catch-up failed; retrying in background:', error.code || 'UNKNOWN')
    }
  }

  async function stop() {
    stopped = true
    if (timer) clearInterval(timer)
    await Promise.all(listeners.map(([contract, filter, listener]) => contract.off(filter, listener)))
    if (typeof transporter.close === 'function') transporter.close()
  }

  return { start, stop }
}
