import { network } from "hardhat";
import fs from "fs";

const { ethers } = await network.connect();

const [admin, investigator, analyst1, analyst2, officialA, officialB, owner2, owner3] =
  await ethers.getSigners();

// 1. Deploy the registry (the deployer is Admin for now)
const registry = await ethers.deployContract("EvidenceRegistry");
await registry.waitForDeployment();
const registryAddress = await registry.getAddress();

// 2. Roles
await (await registry.grantRole(await registry.INVESTIGATOR_ROLE(), investigator.address)).wait();
await (await registry.grantRole(await registry.FORENSIC_ROLE(), analyst1.address)).wait();
await (await registry.grantRole(await registry.FORENSIC_ROLE(), analyst2.address)).wait();

// 3. Courts come from data/courts.json (run this script from the blockchain folder)
const courts = JSON.parse(fs.readFileSync("./data/courts.json", "utf8"));
for (const c of courts) {
  await (await registry.registerCourt(c.name, c.location)).wait();
}
console.log(`Registered ${courts.length} courts from data/courts.json`);

// Demo court officials (other courts get officials later, through the multisig)
const demoOfficials = [
  { signer: officialA, location: "Thiruvananthapuram" },
  { signer: officialB, location: "Ernakulam" },
];
for (const d of demoOfficials) {
  const court = courts.find((c) => c.location === d.location);
  if (!court) {
    console.log(`Skipped demo official: no court for ${d.location} in courts.json`);
    continue;
  }
  await (await registry.assignCourtOfficial(d.signer.address, ethers.id(court.name))).wait();
  console.log(`Official ${d.signer.address} -> ${court.name}`);
}

// 4. Hand the Admin role to a 2-of-3 multisig, then the deployer gives up its own admin power
const multisig = await ethers.deployContract("AdminMultisig", [
  [admin.address, owner2.address, owner3.address],
  2,
]);
await multisig.waitForDeployment();
const multisigAddress = await multisig.getAddress();

const ADMIN_ROLE = await registry.DEFAULT_ADMIN_ROLE();
await (await registry.grantRole(ADMIN_ROLE, multisigAddress)).wait();
await (await registry.renounceRole(ADMIN_ROLE, admin.address)).wait();

// 5. Print everything the team needs
console.log("Registry:       ", registryAddress);
console.log("Admin multisig: ", multisigAddress);
console.log("Multisig owners:", admin.address, owner2.address, owner3.address, "(2 of 3 needed)");
console.log("Investigator:   ", investigator.address);
console.log("Analyst 1:      ", analyst1.address);
console.log("Analyst 2:      ", analyst2.address);
console.log("Official A:     ", officialA.address);
console.log("Official B:     ", officialB.address);