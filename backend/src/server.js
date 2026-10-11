import fs from 'node:fs/promises'
import { createApp } from './app.js'
import { assertChainReady, createChain } from './chain.js'
import { loadConfig } from './config.js'
import { openDatabase } from './db.js'
import { createNotifier } from './notifier.js'

async function start() {
  const config = loadConfig()
  await fs.mkdir(config.storageDir, { recursive: true })
  const db = openDatabase(config.dbPath)
  const chain = createChain({
    rpcUrl: config.RPC_URL,
    registryAddress: config.registryAddress,
    multisigAddress: config.multisigAddress,
    peopleAddress: config.peopleAddress,
  })
  try {
    await assertChainReady(
      chain,
      config.CHAIN_ID,
      config.registryAddress,
      config.multisigAddress,
      config.peopleAddress,
    )
  } catch (error) {
    chain.provider.destroy()
    db.close()
    throw error
  }
  const app = createApp({ config, db, chain })
  const server = app.listen(config.PORT, () => {
    console.log(`Evidence Chain API listening on port ${config.PORT}`)
    console.log(`Read-only registry: ${config.registryAddress}`)
    console.log(`Read-only multisig: ${config.multisigAddress}`)
    console.log(`Read-only people:   ${config.peopleAddress}`)
    console.log(`Configured chain ID: ${config.CHAIN_ID}`)
  })
  let notifier
  if (config.NOTIFY_ENABLED) {
    notifier = createNotifier({ db, chain, config })
    notifier.start().catch((error) => {
      console.error('Court event notifier failed to start; API remains available:', error.code || 'UNKNOWN')
    })
  }

  let closing = false
  const shutdown = (signal) => {
    if (closing) return
    closing = true
    console.log(`Received ${signal}; shutting down`)
    server.close(async (error) => {
      if (error) console.error('HTTP server shutdown failed:', error.code || 'UNKNOWN')
      try {
        await notifier?.stop()
      } catch (stopError) {
        console.error('Notifier shutdown failed:', stopError.code || 'UNKNOWN')
      }
      chain.provider.destroy()
      db.close()
      process.exitCode = error ? 1 : 0
    })
  }
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
}

start().catch((error) => {
  console.error('Backend startup failed:', error.message)
  process.exitCode = 1
})
