import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

async function adminDo(
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

async function setup() {
  const [admin1, admin2, admin3, officer, analystAtRequestedLab, analystAtOtherLab, court] =
    await ethers.getSigners();

  const multisig = await ethers.deployContract("AdminMultisig", [
    [admin1.address, admin2.address, admin3.address],
    2,
  ]);
  const people = await ethers.deployContract("PeopleRegistry", [
    await multisig.getAddress(),
  ]);
  const registry = await ethers.deployContract("EvidenceRegistry", [
    await multisig.getAddress(),
    await people.getAddress(),
  ]);

  await adminDo(multisig, admin1, admin2, people, "registerUnits", [
    3,
    ["District Court"],
    ["Thiruvananthapuram"],
  ]);
  await adminDo(multisig, admin1, admin2, people, "registerUnits", [
    1,
    ["Central Police Station"],
    ["Thiruvananthapuram"],
  ]);
  await adminDo(multisig, admin1, admin2, people, "registerUnits", [
    2,
    ["Regional Forensic Lab", "Other Forensic Lab"],
    ["Thiruvananthapuram", "Ernakulam"],
  ]);

  const profiles = [
    [officer, 1, 2],
    [analystAtRequestedLab, 2, 3],
    [analystAtOtherLab, 2, 4],
    [court, 3, 1],
  ] as const;
  for (const [account, role, unitId] of profiles) {
    await people.connect(account).requestProfile(
      role,
      unitId,
      ethers.id(`profile-${account.address}`),
    );
    await adminDo(multisig, admin1, admin2, people, "approveProfile", [
      account.address,
    ]);
  }

  await registry.connect(officer).openCase("TVM/1/2026", "Evidence case");
  return {
    admin1,
    admin2,
    multisig,
    people,
    registry,
    officer,
    analystAtRequestedLab,
    analystAtOtherLab,
    court,
  };
}

describe("EvidenceRegistry workflow", function () {
  it("keeps new evidence pending until multisig approval, then exposes it to its court", async function () {
    const { admin1, admin2, multisig, registry, officer, court } = await setup();
    const fileHash = ethers.id("evidence-file");
    const registration = await registry.connect(officer).registerEvidence({
      caseId: "TVM/1/2026",
      description: "Seized laptop",
      location: "Central Police Station",
      collectionMethod: "Seized",
      fileHash,
      docs: {
        seizedAt: BigInt(Math.floor(Date.now() / 1000)),
        isElectronic: true,
        seizureMemoHash: ethers.id("seizure-memo"),
        recordingHash: ethers.id("recording"),
        certificateHash: ethers.id("electronic-evidence-certificate"),
      },
    });
    await registration.wait();
    const evidenceId = await registry.count();

    expect((await registry.connect(officer).getEvidence(evidenceId)).review).to.equal(0n);
    await expect(registry.connect(court).getEvidence(evidenceId)).to.be.revertedWith(
      "Not authorized for this case",
    );
    expect(await registry.connect(admin1).getPendingEvidence()).to.deep.equal([
      evidenceId,
    ]);

    await expect(
      adminDo(multisig, admin1, admin2, registry, "approveEvidence", [evidenceId]),
    ).to.emit(registry, "EvidenceApproved");

    const approvedEvidence = await registry.connect(court).getEvidence(evidenceId);
    expect(approvedEvidence.review).to.equal(1n);
    expect(approvedEvidence.fileHash).to.equal(fileHash);

    await expect(
      registry.connect(court).flagEvidence(evidenceId, "Court review note"),
    ).to.be.revertedWith("Only case participants can flag");
    await expect(
      registry.connect(court).resolveFlag(evidenceId, "Resolved"),
    ).to.be.revertedWith("Only the admin multisig");
    await expect(
      registry.connect(court).revokeEvidence(evidenceId, "Revoked"),
    ).to.be.revertedWith("Only the admin multisig");

    await registry.connect(officer).flagEvidence(evidenceId, "Integrity concern");
    await adminDo(multisig, admin1, admin2, registry, "resolveFlag", [
      evidenceId,
      "Integrity rechecked",
    ]);
    expect((await registry.connect(court).getEvidence(evidenceId)).status).to.equal(0n);

    await expect(
      registry.connect(court).rejectCase("TVM/1/2026", "Court decision"),
    ).to.be.revertedWith("Only the admin multisig");
    await expect(
      registry.connect(court).closeCase("TVM/1/2026", "Court decision"),
    ).to.be.revertedWith("Only the admin multisig");
    await adminDo(multisig, admin1, admin2, registry, "closeCase", [
      "TVM/1/2026",
      "Case complete",
    ]);
    expect((await registry.connect(court).getCase("TVM/1/2026")).status).to.equal(
      3n,
    );
  });

  it("allows admins to assign an analyst only from the lab requested by the officer", async function () {
    const {
      admin1,
      admin2,
      multisig,
      registry,
      officer,
      analystAtRequestedLab,
      analystAtOtherLab,
    } = await setup();

    await registry
      .connect(officer)
      .requestAnalysis("TVM/1/2026", 3, "Examine the seized device");

    await expect(
      adminDo(multisig, admin1, admin2, registry, "assignAnalyst", [
        "TVM/1/2026",
        analystAtOtherLab.address,
      ]),
    ).to.be.revertedWith("Analyst is not from requested lab");

    await adminDo(multisig, admin1, admin2, registry, "assignAnalyst", [
      "TVM/1/2026",
      analystAtRequestedLab.address,
    ]);
    expect(await registry.requestedLabForCase(
      ethers.keccak256(ethers.toUtf8Bytes("TVM/1/2026")),
    )).to.equal(0n);
    expect(await registry.connect(officer).getAnalysts("TVM/1/2026")).to.deep.equal([
      analystAtRequestedLab.address,
    ]);
  });
});
