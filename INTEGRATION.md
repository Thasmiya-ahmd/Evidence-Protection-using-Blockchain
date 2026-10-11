# Evidence Blockchain Integration Guide

This guide covers how to run the end-to-end integration between the Hardhat local node, the Express backend, and the React frontend. 

## 1. Mismatch Report and API Table
Before integration, several mismatches existed between the frontend calls and the backend:
- **Upload API:** Frontend sent `caseId` which backend didn't use (fixed to match backend).
- **Download API:** Frontend stripped headers and forced a hardcoded filename. Backend provided `Content-Disposition`. (Fixed: Frontend parses headers and downloads correctly).
- **Verify API:** Frontend manually downloaded the full encrypted file instead of using `GET /api/files/:fileHash/verify` on the backend. (Fixed: Frontend now correctly calls the endpoint and supports rendering "corrupted" messages).
- **Error Handling:** Frontend failed to map backend error shapes accurately. (Fixed: `errors.js` maps statuses 401, 403, 409, 413, 429, 503).
- **Auth Storage:** Frontend used `sessionStorage` against requirements. (Fixed to `localStorage`).

### Final Agreed API Table

| Action | Frontend Method | Backend Endpoint | HTTP | Auth | Payload | Response |
|--------|----------------|------------------|------|------|---------|----------|
| Request Nonce | `POST /api/auth/nonce` | `/api/auth/nonce` | POST | None | `{ address }` | `{ nonce, message, expiresAt }` |
| Login | `POST /api/auth/login` | `/api/auth/login` | POST | None | `{ address, signature }` | `{ token, address, role }` |
| Check Auth | `N/A` | `/api/auth/me` | GET | Bearer | `N/A` | `{ address, role }` |
| Upload File | `POST /api/files` | `/api/files` | POST | Bearer | `FormData(file, kind)` | `{ fileHash, size, name, kind }` |
| Link Evidence | `POST /api/files/:fileHash/link` | `/api/files/:fileHash/link` | POST | Bearer | `{ evidenceId }` | `{ fileHash, evidenceId, linked }` |
| Download | `GET /api/files/:fileHash` | `/api/files/:fileHash` | GET | Bearer | `N/A` | Binary blob + Content-Disposition |
| Verify File | `GET /api/files/:fileHash/verify`| `/api/files/:fileHash/verify`| GET | Bearer | `N/A` | `{ fileHash, recomputedHash, readable, matchesStoredHash, onChain, message }` |
| Demo Tamper | `POST /api/dev/tamper/:hash` | `/api/dev/tamper/:fileHash` | POST | Bearer | `N/A` | `{ fileHash, tampered }` |

## 2. Run Order

Follow this exact sequence to start the system:

1. **Start Hardhat Node:** From the repository root, change to the blockchain project folder and start the node:

   ```powershell
   Set-Location .\blockchain
   npx hardhat node
   ```

2. **Deploy Contracts:** In a second terminal, from the repository root, run:

   ```powershell
   Set-Location .\blockchain
   npx hardhat run scripts/deploy.js --network localhost
   ```

   Hardhat must be run from `blockchain\`, where `hardhat.config.ts` and the local Hardhat installation are located. Running the command from the repository root causes `HHE3` because there is no root-level Hardhat config.
3. **Copy Addresses:** Note the `EvidenceRegistry` and `AdminMultisig` contract addresses output by the deploy script. Paste them into BOTH `.env` files:
   - `frontend/.env` -> `VITE_REGISTRY_ADDRESS` and `VITE_MULTISIG_ADDRESS`
   - `backend/.env` -> `REGISTRY_ADDRESS`
4. **Sync ABIs:** Run `node scripts/sync-abi.mjs` from the repository root to copy ABI definitions.
5. **Start Backend:** `cd backend && npm run dev`
6. **Start Frontend:** `cd frontend && npm run dev`

## 3. MetaMask Network and Account Setup

- **Network:** Add a local network to MetaMask:
  - RPC URL: `http://127.0.0.1:8545`
  - Chain ID: `31337`
  - Currency: `ETH`
- **Accounts:** Import the first 4 private keys provided by Hardhat into MetaMask. These correspond to:
  - Account #1: Admin/Owner
  - Account #2: Investigator
  - Account #3: Forensic Analyst
  - Account #4: Court Official

## 4. Manual Test Checklist

- [ ] **Login as Investigator:** Connect MetaMask with Account #2. Verify role badge says "Investigator".
- [ ] **Open Case:** Go to "Open Case", fill details, submit. Confirm redirect to Case Detail page.
- [ ] **Assign Analyst:** Assign Account #3 (Forensic Analyst).
- [ ] **Upload & Register Evidence:** Select an evidence file and register it. Wait for progress steps to complete.
- [ ] **Custody Transfer:** Transfer custody to the Analyst.
- [ ] **Submit to Court:** Transfer custody back or directly submit to court.
- [ ] **Court Official Notification:** Switch to Account #4 (Court Official). Check the Notifications page for the evidence submission.
- [ ] **Download:** Download the original file as the Court Official. Verify it downloads with its original name.
- [ ] **Verify INTACT:** Click "Verify file integrity". Choose the same local file. Ensure UI says "INTACT" with green hashes.
- [ ] **Tamper:** Click the hidden "Demo: tamper stored file" button at the bottom of the evidence actions.
- [ ] **Verify TAMPERING DETECTED:** Verify the file again. It should flag "TAMPERING DETECTED" due to a mismatch between backend and chain.
- [ ] **Admin Block:** Switch to Account #1 (Admin). Ensure you get a `403 Forbidden` when attempting to access/download evidence files.

## 5. Troubleshooting

| Issue | Cause / Fix |
|-------|-------------|
| **CORS errors** | Ensure `FRONTEND_ORIGIN` exactly matches your frontend URL without trailing slashes. |
| **401 Unauthorized** | The JWT token expired or MetaMask switched accounts. The UI should prompt to sign in again. |
| **403 Forbidden** | Wallet role cannot perform action, or you are trying to access a case not assigned to you. |
| **Stale ABI** | Contracts were recompiled but ABIs not synced. Run `node scripts/sync-abi.mjs`. |
| **Stale contract address** | Hardhat node was restarted. Re-deploy contracts and update BOTH `.env` files. |
| **MetaMask nonce reset / TX fails** | After restarting the Hardhat node, clear activity tab data in MetaMask (Settings -> Advanced -> Clear activity tab data). |
