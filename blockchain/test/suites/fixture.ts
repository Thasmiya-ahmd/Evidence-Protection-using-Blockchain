import { network } from "hardhat";

export const { ethers } = await network.create();

export async function adminDo(
  multisig: any,
  admin1: any,
  admin2: any,
  contract: any,
  functionName: string,
  args: unknown[],
) {
  const id = await multisig.proposalCount();
  const data = contract.interface.encodeFunctionData(functionName, args);
  await multisig.connect(admin1).propose(await contract.getAddress(), data);
  await multisig.connect(admin2).approve(id);
  const execution = await multisig.connect(admin1).execute(id);
  await execution.wait();
  return execution;
}

export async function deployFixture() {
  const [
    admin1,
    admin2,
    admin3,
    officerTvm,
    officerEkm,
    analyst1,
    analyst2,
    courtTvm,
    courtEkm,
    outsider,
  ] = await ethers.getSigners();

  const multisig = await ethers.deployContract("AdminMultisig", [
    [admin1.address, admin2.address, admin3.address],
    2,
  ]);
  await multisig.waitForDeployment();
  const multisigAddress = await multisig.getAddress();

  const people = await ethers.deployContract("PeopleRegistry", [multisigAddress]);
  await people.waitForDeployment();
  const peopleAddress = await people.getAddress();

  const registry = await ethers.deployContract("EvidenceRegistry", [
    multisigAddress,
    peopleAddress,
  ]);
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();

  // Register Courts (Type 3)
  // Unit 1: TVM Court, Unit 2: EKM Court
  await adminDo(multisig, admin1, admin2, people, "registerUnits", [
    3,
    ["Thiruvananthapuram District Court", "Ernakulam District Court"],
    ["Thiruvananthapuram", "Ernakulam"],
  ]);

  // Register Stations (Type 1)
  // Unit 3: TVM Station, Unit 4: EKM Station
  await adminDo(multisig, admin1, admin2, people, "registerUnits", [
    1,
    ["Thiruvananthapuram City Police Station", "Ernakulam Central Police Station"],
    ["Thiruvananthapuram", "Ernakulam"],
  ]);

  // Register Labs (Type 2)
  // Unit 5: TVM Lab, Unit 6: EKM Lab
  await adminDo(multisig, admin1, admin2, people, "registerUnits", [
    2,
    ["Forensic Science Lab TVM", "Regional Forensic Lab EKM"],
    ["Thiruvananthapuram", "Ernakulam"],
  ]);

  // Setup Profiles:
  // officerTvm -> Investigator (1) at TVM Station (unit 3)
  // officerEkm -> Investigator (1) at EKM Station (unit 4)
  // analyst1 -> Analyst (2) at TVM Lab (unit 5)
  // analyst2 -> Analyst (2) at EKM Lab (unit 6)
  // courtTvm -> CourtOfficial (3) at TVM Court (unit 1)
  // courtEkm -> CourtOfficial (3) at EKM Court (unit 2)
  const profilesToSetup = [
    { account: officerTvm, role: 1, unitId: 3 },
    { account: officerEkm, role: 1, unitId: 4 },
    { account: analyst1, role: 2, unitId: 5 },
    { analyst: analyst2, account: analyst2, role: 2, unitId: 6 },
    { account: courtTvm, role: 3, unitId: 1 },
    { account: courtEkm, role: 3, unitId: 2 },
  ];

  for (const p of profilesToSetup) {
    const detailsHash = ethers.id(`details-${p.account.address}`);
    await people.connect(p.account).requestProfile(p.role, p.unitId, detailsHash);
    await adminDo(multisig, admin1, admin2, people, "approveProfile", [p.account.address]);
  }

  return {
    multisig,
    people,
    registry,
    admin1,
    admin2,
    admin3,
    officerTvm,
    officerEkm,
    analyst1,
    analyst2,
    courtTvm,
    courtEkm,
    outsider,
  };
}
