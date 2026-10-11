# Evidence registry contracts

## Local setup

Install dependencies from this directory, then compile and test:

```shell
npm install
npm run compile
npm test
```

For a local end-to-end deployment, start a Hardhat node in one terminal:

```shell
npx hardhat node
```

Then deploy in another terminal:

```shell
npm run deploy:local
```

The demo script is intentionally limited to chain ID `31337`. It deploys a 2-of-3
admin multisig, registers the configured courts, stations, and labs, and creates
sample profiles for local testing. It writes addresses to
`deployments/localhost.json`.

## Deployment data

The JSON files in `data/` are demonstration fixtures, not a complete or verified
list of Kerala police stations, courts, or forensic laboratories. Replace and
validate them against authoritative, current sources before using a deployment
for anything beyond local testing. Each station location must match exactly one
court location because the registry uses that value to choose the court notified
for a case.

Do not use the demo script for a public or operational deployment: its admin
signers, sample units, and sample profiles are not production identities. A
production deployment needs a separately reviewed deployment process and
verified administrative keys.

## Workflow

1. An officer requests an investigator profile for a registered station.
2. Admins review the off-chain identity details and approve the profile through
   the multisig.
3. The approved officer opens a case; its court is resolved from the station's
   location.
4. The officer registers evidence, which remains pending until multisig admins
   approve or reject it. Approval emits `EvidenceApproved` for the case's court.
5. The officer may request forensic analysis from a registered lab. Admins assign
   an approved analyst from that requested lab through the multisig.
6. Each custody offer and acceptance is recorded; the assigned court can read
   approved evidence and its history but cannot change evidence or case status.
   Case participants may flag evidence, while resolving a flag, revoking
   evidence, or recording a case decision requires the admin multisig.

Only hashes and generic metadata should be stored on-chain. Keep personal
information and evidence files off-chain. The contract is an audit mechanism,
not legal advice or a substitute for required statutory procedures; obtain
qualified legal and security review before operational use.
