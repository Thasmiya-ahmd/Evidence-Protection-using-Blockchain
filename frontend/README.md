# Evidence Registry frontend

React/Vite dashboard for the `EvidenceRegistry` and `AdminMultisig` contracts.
Every registry/multisig call in the browser uses the connected MetaMask signer,
including access-controlled reads. The backend is used only for wallet login
and encrypted files; it never sends on-chain transactions for users.

## Requirements and configuration

- Node.js 20+
- MetaMask
- The repository's Hardhat 3 blockchain project

Copy `.env.example` to `.env` and set `VITE_REGISTRY_ADDRESS` and
`VITE_MULTISIG_ADDRESS` to the deployed contract addresses. Leave the default
API URL and chain ID for local development. All `VITE_` values are public and
must never contain private keys, JWT secrets, or encryption keys.

Install and run:

```powershell
npm install
npm run dev
```

Open the Vite URL (usually `http://localhost:5173`) and connect MetaMask.
The backend obtains a one-time signed login, then gives the browser a short
lived JWT for protected file operations. Set `VITE_USE_MOCK=true` to demo the
screens without MetaMask, a chain, or the backend. Mock mode lets you switch
between the four application roles on the connect screen.

## Local Hardhat demo

1. In a terminal, start the local chain:

   ```powershell
   cd ..\blockchain
   npm install
   npx hardhat node
   ```

2. In a second terminal, deploy the registry and multisig:

   ```powershell
   cd ..\blockchain
   npx hardhat run scripts/deploy.js --network localhost
   ```

   Save the printed Registry and Admin multisig addresses. The deploy script
   installs demo courts and assigns roles. Its local Hardhat signers are:
   account #0: deployer / multisig owner; account #1: investigator; accounts
   #2 and #3: forensic analysts; accounts #4 and #5: court officials; accounts
   #6 and #7: additional multisig owners.

3. After compiling or redeploying contracts, refresh the frontend ABIs:

   ```powershell
   cd ..\frontend
   npm run copy:abis
   ```

   Set the two contract addresses in `frontend/.env`.

4. Add a Hardhat account to MetaMask using its private key from the local
   `hardhat node` terminal. Use only these local test keys. Add the local
   network if needed: RPC `http://127.0.0.1:8545`, chain ID `31337`, currency
   `ETH`. Import #1 for the investigator, #2 for an analyst, #4 for a court
   official, or #0/#6/#7 for multisig owners. Do not use local development
   keys on a public network.

5. Start the backend in another terminal using its setup instructions in
   `../backend/README.md`. It listens on port 5000 by default. Start Vite and
   connect the desired MetaMask account.

### Demonstration sequence

1. Connect as investigator account #1 and open a case, selecting one of the
   deployed court locations.
2. Assign forensic analyst account #2 to that case.
3. Register an evidence file. The UI computes its SHA-256, uploads it for
   AES-256-GCM encryption, checks the backend hash, then asks MetaMask to
   register the evidence hash on-chain.
4. Switch to court official account #4. Its inbox loads past registry events
   for its court and subscribes to new case/evidence/submission notifications.
5. Switch back to investigator #1 and transfer custody to analyst #2.
6. Switch to analyst #2 and submit the evidence to court.
7. Switch to the court official and open the submission notification. Verify
   the original file; the browser, decrypted backend copy, and on-chain hash
   should match and display **INTACT**.
8. Change one byte in a copy of the original file and choose that tampered
   file on the verification page. It should display **TAMPERING DETECTED**.
   Optionally log the verification on-chain.

## Role-specific UI

- Investigator: open cases, assign/remove analysts, upload and register
  evidence.
- Forensic analyst: view assigned cases and evidence currently held; transfer
  custody or submit held evidence.
- Court official: see cases for their assigned court, review event
  notifications, and take court-only case/evidence actions.
- Admin multisig owner: manage courts and roles through proposals, review
  approvals, and execute threshold-approved proposals. Admin views do not
  display case evidence.

Evidence originals are off-chain and encrypted by the backend. The blockchain
stores their SHA-256 hashes and generic case/evidence descriptions. Do not put
names or personal details into on-chain text fields.

## Checks

```powershell
npm run lint
npm run build
```
