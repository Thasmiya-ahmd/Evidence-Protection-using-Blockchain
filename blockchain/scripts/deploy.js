import { network } from "hardhat";
import fs from "fs";

const { ethers } = await network.getOrCreate();
const { chainId } = await ethers.provider.getNetwork();

if (chainId !== 31337n) {
  throw new Error(`Demo deployment is restricted to local chain ID 31337, got ${chainId}`);
}

const [
  owner1, investigator1, analyst1, analyst2, officialTvm, officialEkm,
  owner2, owner3, investigator2,
] = await ethers.getSigners();

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const courts = readJson("./data/courts.json");
const stations = readJson("./data/stations.json");
const labs = readJson("./data/labs.json");

function validateUnits(label, units) {
  if (!Array.isArray(units) || units.length === 0) {
    throw new Error(`${label} data must be a non-empty array`);
  }
  for (const unit of units) {
    if (
      typeof unit.name !== "string" ||
      !unit.name.trim() ||
      typeof unit.location !== "string" ||
      !unit.location.trim()
    ) {
      throw new Error(`${label} data entries need a name and location`);
    }
  }
}

validateUnits("Court", courts);
validateUnits("Police station", stations);
validateUnits("Forensic lab", labs);

const courtLocations = new Set(courts.map((court) => court.location));
for (const station of stations) {
  if (!courtLocations.has(station.location)) {
    throw new Error(`No court configured for police station location "${station.location}"`);
  }
}

// 1. The admins: a 2-of-3 multisig whose owners are the admins
const multisig = await ethers.deployContract("AdminMultisig", [
  [owner1.address, owner2.address, owner3.address],
  2,
]);
await multisig.waitForDeployment();
const multisigAddress = await multisig.getAddress();

// 2. The registries. Only the multisig can run admin actions on them.
const people = await ethers.deployContract("PeopleRegistry", [multisigAddress]);
await people.waitForDeployment();
const peopleAddress = await people.getAddress();

const registry = await ethers.deployContract("EvidenceRegistry", [multisigAddress, peopleAddress]);
await registry.waitForDeployment();
const registryAddress = await registry.getAddress();

// Helper: one admin proposes, a second approves, then it is executed
async function adminDo(contract, fn, args) {
  const data = contract.interface.encodeFunctionData(fn, args);
  const target = await contract.getAddress();
  await (await multisig.connect(owner1).propose(target, data)).wait();
  const id = (await multisig.proposalCount()) - 1n;
  await (await multisig.connect(owner2).approve(id)).wait();
  await (await multisig.connect(owner1).execute(id)).wait();
}

// 3. Courts, police stations and labs come from the data files (unit types: Station 1, Lab 2, Court 3)
async function registerUnits(type, list, chunk = 25) {
  for (let i = 0; i < list.length; i += chunk) {
    const part = list.slice(i, i + chunk);
    await adminDo(people, "registerUnits", [type, part.map((x) => x.name), part.map((x) => x.location)]);
  }
}
await registerUnits(3, courts);
await registerUnits(1, stations);
await registerUnits(2, labs);
console.log(`Registered ${courts.length} courts, ${stations.length} stations, ${labs.length} labs`);

async function firstUnitAt(type, location) {
  const [ids] = await people.getUnitsAt(type, location);
  if (ids.length === 0) throw new Error(`No unit of type ${type} at ${location}`);
  return ids[0];
}

// 4. Demo people: each requests a profile, then two admins approve it (roles: Investigator 1, Analyst 2, CourtOfficial 3)
const demo = [
  { who: investigator1, role: 1, type: 1, location: "Thiruvananthapuram" },
  { who: investigator2, role: 1, type: 1, location: "Ernakulam" },
  { who: analyst1, role: 2, type: 2, location: "Thiruvananthapuram" },
  { who: analyst2, role: 2, type: 2, location: "Thiruvananthapuram" },
  { who: officialTvm, role: 3, type: 3, location: "Thiruvananthapuram" },
  { who: officialEkm, role: 3, type: 3, location: "Ernakulam" },
];
for (const d of demo) {
  const unitId = await firstUnitAt(d.type, d.location);
  const detailsHash = ethers.id("demo-profile-" + d.who.address); // in the real app: hash of the details stored in the backend
  await (await people.connect(d.who).requestProfile(d.role, unitId, detailsHash)).wait();
  await adminDo(people, "approveProfile", [d.who.address]);
}

// 5. Save the addresses for the backend and frontend
const out = {
  chainId: chainId.toString(),
  multisig: multisigAddress,
  people: peopleAddress,
  registry: registryAddress,
  accounts: {
    admin1: owner1.address, admin2: owner2.address, admin3: owner3.address,
    investigatorTvm: investigator1.address, investigatorEkm: investigator2.address,
    analyst1: analyst1.address, analyst2: analyst2.address,
    courtOfficialTvm: officialTvm.address, courtOfficialEkm: officialEkm.address,
  },
};
fs.mkdirSync("./deployments", { recursive: true });
fs.writeFileSync("./deployments/localhost.json", JSON.stringify(out, null, 2));

console.log("Admin multisig:", multisigAddress);
console.log("PeopleRegistry:", peopleAddress);
console.log("EvidenceRegistry:", registryAddress);
console.log(out.accounts);