# Evidence Chain backend

Node.js and Express API for wallet-signature login and encrypted evidence
storage. It uses a read-only Ethereum JSON-RPC provider. Users sign all
blockchain transactions in MetaMask; this backend has no transaction signer
and never stores wallet signing keys.

## Requirements

- Node.js 20 or newer
- The local Hardhat chain and deployed `EvidenceRegistry`, `PeopleRegistry`,
  and `AdminMultisig` contracts
- The three compiled artifacts under `../blockchain/artifacts/contracts/`

## Install and configure

From `backend`:

```powershell
npm install
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

If `.env` already exists, update it with the settings below instead of
overwriting local credentials.

Generate independent secrets:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Use the first 64-character hex value for `MASTER_KEY` and the second for
`JWT_SECRET`. The example values are only format-valid examples; replace both.
Set `REGISTRY_ADDRESS`, `MULTISIG_ADDRESS`, and `PEOPLE_ADDRESS` to the
deployed contract addresses. The backend validates the environment at startup,
then checks that the RPC is reachable, the chain ID matches, and contract
bytecode exists at all three addresses.

After compiling or deploying the contracts, refresh all three ABIs:

```powershell
npm run abi
```

This copies each Hardhat artifact ABI into `src/abi/`. After local deployment,
print the addresses to copy into `backend/.env` with:

```powershell
npm run addresses
```

## Run order

1. Start the Hardhat node from `blockchain`:

   ```powershell
   cd ..\blockchain
   npx hardhat node
   ```

2. In a second terminal, deploy the contracts:

   ```powershell
   cd ..\blockchain
   npx hardhat run scripts/deploy.js --network localhost
   cd ..\backend
   npm run abi
   npm run addresses
   ```

3. Put the three printed addresses in `backend/.env`, then start the API:

   ```powershell
   cd ..\backend
   npm start
   ```

4. Configure the frontend contract addresses and start it:

   ```powershell
   cd ..\frontend
   npm run dev
   ```

The default API origin is `http://localhost:5000`; configure
`FRONTEND_ORIGIN` to the frontend's exact origin.

## API

All JSON request bodies use `Content-Type: application/json`. File routes use
the `Authorization: Bearer <token>` header. In the PowerShell examples, set
`$token` after receiving the login response.

### Health

```powershell
Invoke-RestMethod http://localhost:5000/api/health
```

### Wallet login

Get a nonce and its exact message:

```powershell
$nonce = Invoke-RestMethod http://localhost:5000/api/auth/nonce `
  -Method Post -ContentType 'application/json' `
  -Body (@{ address = '0xYourWalletAddress' } | ConvertTo-Json)
$nonce
```

Sign `$nonce.message` using the wallet, then send the returned signature:

```powershell
$login = Invoke-RestMethod http://localhost:5000/api/auth/login `
  -Method Post -ContentType 'application/json' `
  -Body (@{ address = '0xYourWalletAddress'; signature = '0xWalletSignature' } | ConvertTo-Json)
$token = $login.token
Invoke-RestMethod http://localhost:5000/api/auth/me `
  -Headers @{ Authorization = "Bearer $token" }
```

The nonce is 32 random bytes, expires after five minutes, and can be consumed
only once. Login and every authenticated request use the current on-chain role,
so removed or suspended access takes effect without waiting for token expiry.

### Units and profiles

`GET /api/units` is public and returns a JSON array of units. Use
`?type=station|lab|court` and optionally `&location=<location>`.
`GET /api/units/locations` returns distinct court locations as a JSON array.

An applicant may upload an optional identity file as `kind=profile_doc`, then
submit `POST /api/profile`. Profile details are encrypted off-chain; the chain
stores their hash plus the role, unit, and status needed for authorization.
Admins review the queue at
`GET /api/admin/profiles/pending` and inspect a profile at
`GET /api/admin/profiles/:address`. Applicants can read their own profile at
`GET /api/profile/me` and delete off-chain details while the on-chain status is
`None` or `Rejected` using `DELETE /api/profile/me`. The applicant and admins
still submit/approve transactions from their wallets; the backend never signs.

### Upload a file

Upload permissions depend on `kind`: investigators may upload `evidence`,
`seizure_memo`, `recording`, and `certificate`; forensic analysts may upload
`report`; wallets with role `None` may upload `profile_doc`. The default kind
is `evidence`.

```powershell
curl.exe -X POST http://localhost:5000/api/files `
  -H "Authorization: Bearer $token" `
  -F "file=@evidence.pdf" -F "kind=evidence"
```

The response has `fileHash`, `size`, sanitized `name`, and `kind`. If that hash
already exists, only the original uploader can reuse the file record.

### Link registered evidence or documents

After registering the hash on-chain, the uploading wallet links the hash to the
evidence record.

```powershell
$fileHash = '0x' + ('a' * 64)
Invoke-RestMethod "http://localhost:5000/api/files/$fileHash/link" `
  -Method Post -Headers @{ Authorization = "Bearer $token" } `
  -ContentType 'application/json' -Body (@{ evidenceId = '1' } | ConvertTo-Json)
```

The backend confirms on-chain, as the authenticated user, that the evidence
record contains the hash for that document kind before storing the link.

### Verify and download

```powershell
Invoke-RestMethod "http://localhost:5000/api/files/$fileHash/verify" `
  -Headers @{ Authorization = "Bearer $token" }
Invoke-WebRequest "http://localhost:5000/api/files/$fileHash" `
  -Headers @{ Authorization = "Bearer $token" } -OutFile '.\downloaded-evidence.bin'
```

An unregistered file is available only to its uploader (profile documents are
available to their uploader and admins). Registered evidence access is checked
through `getEvidence.staticCall` with the authenticated address as `from`:
admins can review pending or rejected evidence; approved evidence is limited to
its lead investigator, assigned active analyst, and the court official for its
location. Courts are read-only. Each admin file review is recorded in the
access log. Tampered encrypted data returns a successful verify response with
`readable: false`; downloads return HTTP 409 with `INTEGRITY_FAILURE`.

### Court email and notifications

When `NOTIFY_ENABLED=true`, these endpoints are accessible to current court
officials assigned to a court and current admins. Court officials receive
notifications for their court; admins receive profile and evidence-review
notifications.

```powershell
Invoke-RestMethod http://localhost:5000/api/me/email `
  -Method Put -Headers @{ Authorization = "Bearer $token" } `
  -ContentType 'application/json' -Body (@{ email = 'court@example.org' } | ConvertTo-Json)
Invoke-RestMethod http://localhost:5000/api/notifications `
  -Headers @{ Authorization = "Bearer $token" }
```

Set `NOTIFY_ENABLED=true` and SMTP settings in `.env` to catch up on and listen
for court events and send email. Event handling is deduplicated by transaction
hash and log index; email delivery failures are logged and do not stop the API.

### Demo-only tampering route

Only available when `DEMO_MODE=true` and `NODE_ENV` is not `production`. Only
the uploader can use it:

```powershell
Invoke-RestMethod "http://localhost:5000/api/dev/tamper/$fileHash" `
  -Method Post -Headers @{ Authorization = "Bearer $token" }
```

It flips a byte in the stored encrypted payload so the next verification
reports corruption.

## Smoke test

For a local Hardhat deployment, set the corresponding local-only wallet keys
in the current PowerShell process. The smoke script requires
`TEST_KEY_ADMIN`, `TEST_KEY_ADMIN2`, `TEST_KEY_INVESTIGATOR`, `TEST_KEY_ANALYST`,
`TEST_KEY_COURT_TVM`, `TEST_KEY_COURT_EKM`, `TEST_KEY_INVESTIGATOR_OTHER`, and
`TEST_KEY_OUTSIDER`. It contains no default private keys; these variables are
used only by the smoke script, never by the server:

```powershell
$env:TEST_KEY_ADMIN = '<local-admin-key>'
$env:TEST_KEY_ADMIN2 = '<second-local-admin-key>'
$env:TEST_KEY_INVESTIGATOR = '<local-investigator-key>'
$env:TEST_KEY_ANALYST = '<local-analyst-key>'
$env:TEST_KEY_COURT_TVM = '<local-tvm-court-key>'
$env:TEST_KEY_COURT_EKM = '<local-ekm-court-key>'
$env:TEST_KEY_INVESTIGATOR_OTHER = '<other-station-investigator-key>'
$env:TEST_KEY_OUTSIDER = '<unapproved-wallet-key>'
npm run smoke
```

If a required key or contract address is missing, smoke steps are reported as
`SKIPPED`; no key is printed. The script exercises profile review, pending and
approved evidence access, analyst assignment and reports, custody transfer,
analyst removal, and (when `DEMO_MODE=true`) tamper detection. Do not use local
development wallet keys on a public network.

## Data protection design

Plaintext exists only in memory during the multipart upload and authorized
download. Files are hashed with SHA-256 and encrypted before disk write using
AES-256-GCM. Each file gets a 32-byte key derived by HKDF-SHA256 from `MASTER_KEY`
with the file hash bytes as salt and `evidence-file` as info. A random 12-byte
IV and the GCM authentication tag are stored with a one-byte format version;
only hash-named encrypted files are stored. SQLite holds metadata, uploader,
links, nonces, append-only access records, and optional notification state.
Never lose `MASTER_KEY`: encrypted files cannot be recovered without it.

## Limitations

- `MASTER_KEY` is supplied as an environment secret; production needs managed
  key storage, rotation/versioning, backups, and recovery procedures.
- Multipart buffers and decrypted downloads are held in memory up to
  `MAX_FILE_MB`; large files require a streaming design.
- The implementation is intended for a single backend node and local SQLite
  database. Multi-node deployments need shared nonce and notification state,
  coordinated file storage, and production-grade rate-limit storage.
- Blockchain reads depend on one configured JSON-RPC endpoint. A production
  service should monitor and configure resilient providers.
- SMTP and event email delivery are optional and depend on the configured
  provider's availability and sending limits.
