import assert from "node:assert/strict";
import { network } from "hardhat";

const { ethers } = await network.connect();
const [admin, , , , , , owner2] = await ethers.getSigners();
const registryAddress = process.env.REGISTRY;
const multisigAddress = process.env.MULTISIG;

if (!ethers.isAddress(registryAddress) || !ethers.isAddress(multisigAddress)) {
  throw new Error("Set REGISTRY and MULTISIG to the deployed contract addresses.");
}
if ((await ethers.provider.getCode(registryAddress)) === "0x") {
  throw new Error(`No EvidenceRegistry contract exists at ${registryAddress}.`);
}
if ((await ethers.provider.getCode(multisigAddress)) === "0x") {
  throw new Error(`No AdminMultisig contract exists at ${multisigAddress}.`);
}

const registry = await ethers.getContractAt("EvidenceRegistry", registryAddress);
const multisig = await ethers.getContractAt("AdminMultisig", multisigAddress);
assert.equal(await multisig.isOwner(admin.address), true, "First signer must be a multisig owner");
assert.equal(await multisig.isOwner(owner2.address), true, "Signer #6 must be a multisig owner");
assert.equal(await multisig.threshold(), 2n, "Demo requires a 2-of-N multisig");

const location = "Kochi";
const courtName = "Kochi Special Court";
const [existingCourtId] = await registry.getCourtForLocation(location);
if (existingCourtId !== ethers.ZeroHash) {
  assert.equal(await registry.courtName(existingCourtId), courtName, "Kochi is already registered to a different court");
  console.log("Kochi Special Court is already registered; no new proposal was needed.");
} else {
  const data = registry.interface.encodeFunctionData("registerCourt", [courtName, location]);

  // The proposing owner's vote is the first approval.
  await (await multisig.connect(admin).propose(registryAddress, data)).wait();
  const id = (await multisig.proposalCount()) - 1n;
  console.log("Proposal", id.toString(), "created, 1 of 2 approvals");

  await assert.rejects(
    multisig.connect(admin).execute(id),
    (error) => /not enough approvals/i.test(
      `${error.shortMessage || ""} ${error.reason || ""} ${error.message || ""}`,
    ),
    "Execution must be rejected before the second approval",
  );
  console.log("Execute blocked as expected: not enough approvals");

  await (await multisig.connect(owner2).approve(id)).wait();
  await (await multisig.connect(admin).execute(id)).wait();
}

const [, names, locations] = await registry.getCourts();
const courtIndex = names.findIndex((name, index) => name === courtName && locations[index] === location);
assert.notEqual(courtIndex, -1, "Expected Kochi Special Court to be registered");
console.log("Courts now:", names.length, "| demo court:", names[courtIndex], "in", locations[courtIndex]);
