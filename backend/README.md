# Evidence Chain backend

Node.js and Express API for wallet-signature login and encrypted evidence
storage. It uses a read-only Ethereum JSON-RPC provider. Users sign all
blockchain transactions in MetaMask; this backend has no transaction signer
and never stores wallet signing keys.

## Requirements

- Node.js 20 or newer
- The local Hardhat chain and deployed `EvidenceRegistry` contract
- The project contract artifact at
  `../blockchain/artifacts/contracts/EvidenceRegistry.sol/EvidenceRegistry.json`

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
Set `REGISTRY_ADDRESS` to the deployed contract address. The backend validates
the environment at startup, then checks that the RPC is reachable, the chain ID
matches, and contract bytecode exists at that address.

After recompiling the contract, refresh its ABI:

```powershell
npm run copy:abi
```

This copies the `abi` field from the Hardhat artifact into
`src/abi/EvidenceRegistry.json`.

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
   ```

3. Put the deployed registry address in `backend/.env`, then start the API:

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
only once. Login returns the current on-chain role.

### Upload a file

Uploads require the current `Investigator` role. `kind` can be `evidence` or
`certificate`; it defaults to `evidence`.

```powershell
curl.exe -X POST http://localhost:5000/api/files `
  -H "Authorization: Bearer $token" `
  -F "file=@evidence.pdf" -F "kind=evidence"
```

The response has `fileHash`, `size`, sanitized `name`, and `kind`. If that hash
already exists, only the original uploader can reuse the file record.

### Link registered evidence or certificate

After registering the hash on-chain, the uploading wallet links the hash to the
evidence record. Certificate links are required for certificate authorization.

```powershell
$fileHash = '0x' + ('a' * 64)
Invoke-RestMethod "http://localhost:5000/api/files/$fileHash/link" `
  -Method Post -Headers @{ Authorization = "Bearer $token" } `
  -ContentType 'application/json' -Body (@{ evidenceId = '1' } | ConvertTo-Json)
```

The backend confirms on-chain, as the authenticated user, that the evidence
record contains the file or certificate hash before storing the link.

### Verify and download

```powershell
Invoke-RestMethod "http://localhost:5000/api/files/$fileHash/verify" `
  -Headers @{ Authorization = "Bearer $token" }
Invoke-WebRequest "http://localhost:5000/api/files/$fileHash" `
  -Headers @{ Authorization = "Bearer $token" } -OutFile '.\downloaded-evidence.bin'
```

An unregistered file is available only to its uploader. Once registered or
linked, access is checked through `getEvidence.staticCall` with the authenticated
address as `from`, preserving the contract's lead-investigator/assigned-analyst/
court-official permissions. Admin wallets are denied. Tampered encrypted data
returns a successful verify response with `readable: false`; downloads return
HTTP 409 with `INTEGRITY_FAILURE`.

### Court email and notifications

When `NOTIFY_ENABLED=true`, these endpoints are accessible only to a current
Court Official assigned to a court:

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

For a local Hardhat deployment, set `TEST_KEY_INVESTIGATOR` and `TEST_KEY_ADMIN`
to the corresponding local-only wallet keys in the current PowerShell process.
These variables are used only by the smoke script, never by the server:

```powershell
$env:TEST_KEY_INVESTIGATOR = 'local-investigator-test-key'
$env:TEST_KEY_ADMIN = 'local-admin-test-key'
npm run smoke
```

The script logs in both wallets, uploads, verifies and downloads as the
investigator, and confirms that the admin is denied. With `DEMO_MODE=true`, it
also tampers with the uploaded file and confirms integrity failure; set
`DEMO_MODE=true` in the backend `.env` before starting the server and in the
smoke-test shell. Do not use local development wallet keys on a public network.

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
