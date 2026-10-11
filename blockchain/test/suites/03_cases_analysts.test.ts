import { expect } from "chai";
import { deployFixture, adminDo, ethers } from "./fixture.js";

describe("Cases & Case Lifecycle Tests (R3, R6)", function () {
  it("R3.1 only active investigator opens a case; court is found automatically; CaseOpened carries courtId", async function () {
    const { registry, officerTvm, courtTvm, outsider } = await deployFixture();

    await expect(
      registry.connect(outsider).openCase("TVM/01/2026", "Theft case"),
    ).to.be.revertedWith("Only an approved investigator");

    await expect(
      registry.connect(courtTvm).openCase("TVM/01/2026", "Theft case"),
    ).to.be.revertedWith("Only an approved investigator");

    // Successful open by officerTvm (station 3 in TVM -> court 1 in TVM)
    const tx = await registry.connect(officerTvm).openCase("TVM/01/2026", "Theft case");
    const rc = await tx.wait();
    const block = await ethers.provider.getBlock(rc!.blockNumber);

    await expect(tx)
      .to.emit(registry, "CaseOpened")
      .withArgs(
        1n,
        ethers.keccak256(ethers.toUtf8Bytes("TVM/01/2026")),
        officerTvm.address,
        "TVM/01/2026",
        BigInt(block!.timestamp),
      );

    const c = await registry.connect(officerTvm).getCase("TVM/01/2026");
    expect(c.caseId).to.equal("TVM/01/2026");
    expect(c.stationId).to.equal(3n);
    expect(c.courtId).to.equal(1n);
    expect(c.leadInvestigator).to.equal(officerTvm.address);
    expect(c.status).to.equal(1n); // Open
  });

  it("R3.2 station without registered court fails with exact revert message", async function () {
    const { multisig, admin1, admin2, people, registry, outsider } = await deployFixture();
    // Register station in Wayanad (no court in Wayanad registered in fixture)
    await adminDo(multisig, admin1, admin2, people, "registerUnits", [1, ["Wayanad Station"], ["Wayanad"]]);
    const stationId = await people.unitCount();

    // Register officer at Wayanad Station
    await people.connect(outsider).requestProfile(1, stationId, ethers.id("profile-wayanad"));
    await adminDo(multisig, admin1, admin2, people, "approveProfile", [outsider.address]);

    await expect(
      registry.connect(outsider).openCase("WAY/01/2026", "Forest case"),
    ).to.be.revertedWith("No court registered for this station's location");
  });

  it("R3.3 duplicate caseId fails with Case ID already used", async function () {
    const { registry, officerTvm } = await deployFixture();
    await registry.connect(officerTvm).openCase("TVM/02/2026", "Case 2");
    await expect(
      registry.connect(officerTvm).openCase("TVM/02/2026", "Case 2 duplicate"),
    ).to.be.revertedWith("Case ID already used");
  });

  it("R3.4 case reject and close can be called via multisig, and fail for non-admins", async function () {
    const { multisig, admin1, admin2, registry, officerTvm, courtTvm, outsider } = await deployFixture();
    await registry.connect(officerTvm).openCase("TVM/03/2026", "Case 3");

    // Normal users and courts revert "Only the admin multisig"
    await expect(
      registry.connect(courtTvm).rejectCase("TVM/03/2026", "Not jurisdiction"),
    ).to.be.revertedWith("Only the admin multisig");

    await expect(
      registry.connect(outsider).closeCase("TVM/03/2026", "Close"),
    ).to.be.revertedWith("Only the admin multisig");

    // Close through multisig succeeds
    await expect(
      adminDo(multisig, admin1, admin2, registry, "closeCase", ["TVM/03/2026", "Completed"]),
    ).to.emit(registry, "CaseDecision");

    const c = await registry.connect(courtTvm).getCase("TVM/03/2026");
    expect(c.status).to.equal(3n); // Closed
  });

  it("R3.5 after case is closed or rejected, registering evidence fails with Case is not open", async function () {
    const { multisig, admin1, admin2, registry, officerTvm } = await deployFixture();
    await registry.connect(officerTvm).openCase("TVM/04/2026", "Case 4");
    await adminDo(multisig, admin1, admin2, registry, "rejectCase", ["TVM/04/2026", "Dismissed"]);

    const fileHash = ethers.id("file-case-closed");
    await expect(
      registry.connect(officerTvm).registerEvidence({
        caseId: "TVM/04/2026",
        description: "Phone",
        location: "TVM",
        collectionMethod: "Seized",
        fileHash,
        docs: {
          seizedAt: 1000n,
          isElectronic: false,
          seizureMemoHash: ethers.id("memo"),
          recordingHash: ethers.ZeroHash,
          certificateHash: ethers.ZeroHash,
        },
      }),
    ).to.be.revertedWith("Case is not open");
  });

  it("R6.1 requestAnalysis must be from lead and for a lab; assignAnalyst must match requested lab", async function () {
    const {
      multisig,
      admin1,
      admin2,
      registry,
      officerTvm,
      officerEkm,
      analyst1,
      analyst2,
      outsider,
    } = await deployFixture();

    await registry.connect(officerTvm).openCase("TVM/05/2026", "Case 5");

    // Non-lead cannot request analysis
    await expect(
      registry.connect(officerEkm).requestAnalysis("TVM/05/2026", 5, "Check DNA"),
    ).to.be.revertedWith("Only lead investigator");

    // Request for a station (unit 3) reverts 'Not a forensic lab'
    await expect(
      registry.connect(officerTvm).requestAnalysis("TVM/05/2026", 3, "Check DNA"),
    ).to.be.revertedWith("Not a forensic lab");

    // Request for TVM Lab (unit 5) succeeds
    await expect(
      registry.connect(officerTvm).requestAnalysis("TVM/05/2026", 5, "Check fingerprints"),
    ).to.emit(registry, "AnalysisRequested");

    // Assigning analyst not from requested lab reverts 'Analyst is not from requested lab'
    // analyst2 is at EKM lab (unit 6)
    await expect(
      adminDo(multisig, admin1, admin2, registry, "assignAnalyst", ["TVM/05/2026", analyst2.address]),
    ).to.be.revertedWith("Analyst is not from requested lab");

    // Assigning unapproved analyst reverts 'Not an approved forensic analyst'
    await expect(
      adminDo(multisig, admin1, admin2, registry, "assignAnalyst", ["TVM/05/2026", outsider.address]),
    ).to.be.revertedWith("Not an approved forensic analyst");

    // Assigning analyst1 (from TVM Lab unit 5) succeeds
    await expect(
      adminDo(multisig, admin1, admin2, registry, "assignAnalyst", ["TVM/05/2026", analyst1.address]),
    ).to.emit(registry, "AnalystAssigned");

    // Double assign reverts 'Analysis was not requested' (since requestedLabForCase resets to 0)
    await expect(
      adminDo(multisig, admin1, admin2, registry, "assignAnalyst", ["TVM/05/2026", analyst1.address]),
    ).to.be.revertedWith("Analysis was not requested");
  });

  it("R6.2 analyst removal and access revocation", async function () {
    const { multisig, admin1, admin2, registry, officerTvm, analyst1 } = await deployFixture();
    await registry.connect(officerTvm).openCase("TVM/06/2026", "Case 6");
    await registry.connect(officerTvm).requestAnalysis("TVM/06/2026", 5, "Note");
    await adminDo(multisig, admin1, admin2, registry, "assignAnalyst", ["TVM/06/2026", analyst1.address]);

    // Analyst sees the case
    expect((await registry.connect(analyst1).getCase("TVM/06/2026")).caseId).to.equal("TVM/06/2026");

    // Remove analyst
    await expect(
      adminDo(multisig, admin1, admin2, registry, "removeAnalyst", ["TVM/06/2026", analyst1.address]),
    ).to.emit(registry, "AnalystRemoved");

    // Removed analyst immediately loses access
    await expect(
      registry.connect(analyst1).getCase("TVM/06/2026"),
    ).to.be.revertedWith("Not authorized for this case");
  });
});
