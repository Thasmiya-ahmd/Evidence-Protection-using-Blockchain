import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

export const CURRENT_SCHEMA_VERSION = 3

export function openDatabase(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  const version = db.pragma('user_version', { simple: true })
  if (version > CURRENT_SCHEMA_VERSION) {
    db.close()
    throw new Error(`Database schema version ${version} is newer than supported version ${CURRENT_SCHEMA_VERSION}`)
  }

  db.exec(`
      CREATE TABLE IF NOT EXISTS nonces (
        address TEXT PRIMARY KEY,
        nonce TEXT NOT NULL,
        message TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS nonces_expiry_idx ON nonces(expires_at);

      CREATE TABLE IF NOT EXISTS files (
        file_hash TEXT PRIMARY KEY,
        uploader TEXT NOT NULL,
        original_name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL CHECK(size >= 0),
        kind TEXT NOT NULL,
        evidence_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS file_links (
        file_hash TEXT PRIMARY KEY REFERENCES files(file_hash),
        evidence_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS access_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT NOT NULL,
        action TEXT NOT NULL,
        file_hash TEXT,
        time TEXT NOT NULL,
        ip TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS access_log_file_idx ON access_log(file_hash, time);

      CREATE TABLE IF NOT EXISTS court_contacts (
        address TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        court_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        court_id TEXT NOT NULL,
        type TEXT NOT NULL,
        reference TEXT NOT NULL,
        block_number INTEGER NOT NULL,
        tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        contract TEXT,
        audience TEXT,
        UNIQUE(tx_hash, log_index)
      );
      CREATE INDEX IF NOT EXISTS notifications_court_idx ON notifications(court_id, block_number);

      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS profiles (
        address TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        unit_id TEXT NOT NULL,
        details_enc BLOB NOT NULL,
        details_hash TEXT NOT NULL,
        doc_hash TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
  `)

  const columns = (table) => new Set(db.pragma(`table_info(${table})`).map((column) => column.name))
  const addColumn = (table, name, definition) => {
    if (!columns(table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
  }

  addColumn('files', 'evidence_id', 'TEXT')
  const fileColumns = columns('files')
  if (!fileColumns.has('mime')) {
    if (fileColumns.has('mime_type')) {
      addColumn('files', 'mime', 'TEXT')
      db.exec("UPDATE files SET mime = mime_type WHERE mime IS NULL")
    } else {
      addColumn('files', 'mime', "TEXT NOT NULL DEFAULT 'application/octet-stream'")
    }
  }
  addColumn('notifications', 'contract', 'TEXT')
  addColumn('notifications', 'audience', 'TEXT')
  addColumn('profiles', 'role', "TEXT NOT NULL DEFAULT 'Investigator'")
  addColumn('profiles', 'unit_id', "TEXT NOT NULL DEFAULT '0'")
  addColumn('profiles', 'details_enc', 'BLOB')
  addColumn('profiles', 'details_hash', 'TEXT')
  addColumn('profiles', 'doc_hash', 'TEXT')
  addColumn('profiles', 'created_at', "TEXT NOT NULL DEFAULT ''")
  addColumn('profiles', 'updated_at', "TEXT NOT NULL DEFAULT ''")

  db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`)

  return db
}

export function writeAccessLog(db, { address, action, fileHash = null, ip }) {
  db.prepare(`
    INSERT INTO access_log(address, action, file_hash, time, ip)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    (address || 'anonymous').toLowerCase(),
    action,
    fileHash ? fileHash.toLowerCase() : null,
    new Date().toISOString(),
    ip || 'unknown',
  )
}
