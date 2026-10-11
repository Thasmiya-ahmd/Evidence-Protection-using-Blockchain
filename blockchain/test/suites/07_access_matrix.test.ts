import { expect } from "chai";
import { deployFixture, adminDo, ethers } from "./fixture.js";

describe("Access Matrix & Helper Functions (R5, R10, R11, R12)", function () {
  async function setupMatrix() {
    const fixture = await deployFixture();
    const {
      multisig,
      admin1,
      admin2,
      registry,
      officerTvm,
      analyst1,
    } = fixture;

    await registry.connect(officerTvm).openCase("TVM/40/2026", "Matrix Case");
    await registry.connect(officerTvm).requestAnalysis("TVM/40/2026", 5, "Note");
    await adminDo(multisig, admin1, admin2, registry, "assignAnalyst", ["TVM/40/2026", analyst1.address]);

    // 1. Pending evidence
    const pendingHash = ethers.id("matrix-pending-file");
    await registry.connect(officerTvm).registerEvidence({
      caseId: "TVM/40/2026",
      description: "Pending Item",
      location: "TVM",
      collectionMethod: "Seized",
      fileHash: pendingHash,
      docs: {
        seizedAt: 1000n,
        isElectronic: false,
        seizureMemoHash: ethers.id("pending-memo"),
        recordingHash: ethers.ZeroHash,
        certificateHash: ethers.ZeroHash,
      },
    });
    const pendingId = await registry.count();

    // 2. Approved evidence
    const approvedHash = ethers.id("matrix-approved-file");
    await registry.connect(officerTvm).registerEvidence({
      caseId: "TVM/40/2026",
      description: "Approved Item",
      location: "TVM",
      collectionMethod: "Seized",
      fileHash: approvedHash,
      docs: {
        seizedAt: 1000n,
        isElectronic: false,
        seizureMemoHash: ethers.id("approved-memo"),
        recordingHash: ethers.ZeroHash,
        certificateHash: ethers.ZeroHash,
      },
    });
    const approvedId = await registry.count();
    await adminDo(multisig, admin1, admin2, registry, "approveEvidence", [approvedId]);

    return { ...fixture, pendingId, approvedId, pendingHash, approvedHash };
  }

  it("R5.1 access matrix for APPROVED evidence across all personas", async function () {
    const {
      multisig,
      admin1,
      admin2,
      people,
      registry,
      officerTvm,
      officerEkm,
      analyst1,
      analyst2,
      courtTvm,
      courtEkm,
      outsider,
      approvedId,
      approvedHash,
    } = await setupMatrix();

    // 1. Lead investigator (officerTvm) -> ALLOWED
    expect((await registry.connect(officerTvm).getEvidence(approvedId)).id).to.equal(approvedId);
    expect((await registry.connect(officerTvm).getEvidenceDocs(approvedId)).seizedAt).to.equal(1000n);
    expect(await registry.connect(officerTvm).getCustodyHistory(approvedId)).to.be.an("array");
    expect(await registry.connect(officerTvm).getStatusHistory(approvedId)).to.be.an("array");
    expect(await registry.connect(officerTvm).getAnalysisReports(approvedId)).to.be.an("array");
    expect((await registry.connect(officerTvm).getCase("TVM/40/2026")).caseId).to.equal("TVM/40/2026");
    expect(await registry.connect(officerTvm).getAnalysts("TVM/40/2026")).to.deep.equal([analyst1.address]);
    expect((await registry.connect(officerTvm).getCaseEvidence("TVM/40/2026")).length).to.equal(2); // sees both pending and approved
    expect(await registry.connect(officerTvm).verify(approvedId, approvedHash)).to.be.true;

    // 2. Assigned analyst (analyst1) -> ALLOWED
    expect((await registry.connect(analyst1).getEvidence(approvedId)).id).to.equal(approvedId);
    expect((await registry.connect(analyst1).getEvidenceDocs(approvedId)).seizedAt).to.equal(1000n);
    expect(await registry.connect(analyst1).getCustodyHistory(approvedId)).to.be.an("array");
    expect(await registry.connect(analyst1).getStatusHistory(approvedId)).to.be.an("array");
    expect(await registry.connect(analyst1).getAnalysisReports(approvedId)).to.be.an("array");
    expect((await registry.connect(analyst1).getCase("TVM/40/2026")).caseId).to.equal("TVM/40/2026");
    expect(await registry.connect(analyst1).getAnalysts("TVM/40/2026")).to.deep.equal([analyst1.address]);
    expect((await registry.connect(analyst1).getCaseEvidence("TVM/40/2026")).length).to.equal(1); // sees only approved
    expect(await registry.connect(analyst1).verify(approvedId, approvedHash)).to.be.true;

    // 3. Court of this case (courtTvm) -> ALLOWED
    expect((await registry.connect(courtTvm).getEvidence(approvedId)).id).to.equal(approvedId);
    expect((await registry.connect(courtTvm).getEvidenceDocs(approvedId)).seizedAt).to.equal(1000n);
    expect(await registry.connect(courtTvm).getCustodyHistory(approvedId)).to.be.an("array");
    expect(await registry.connect(courtTvm).getStatusHistory(approvedId)).to.be.an("array");
    expect(await registry.connect(courtTvm).getAnalysisReports(approvedId)).to.be.an("array");
    expect((await registry.connect(courtTvm).getCase("TVM/40/2026")).caseId).to.equal("TVM/40/2026");
    expect(await registry.connect(courtTvm).getAnalysts("TVM/40/2026")).to.deep.equal([analyst1.address]);
    expect((await registry.connect(courtTvm).getCaseEvidence("TVM/40/2026")).length).to.equal(1); // sees only approved
    expect(await registry.connect(courtTvm).verify(approvedId, approvedHash)).to.be.true;

    // 4. Investigator of another station (officerEkm) -> DENIED
    await expect(registry.connect(officerEkm).getEvidence(approvedId)).to.be.revertedWith("Not authorized for this case");
    await expect(registry.connect(officerEkm).getEvidenceDocs(approvedId)).to.be.revertedWith("Not authorized for this case");
    await expect(registry.connect(officerEkm).getCase("TVM/40/2026")).to.be.revertedWith("Not authorized for this case");
    await expect(registry.connect(officerEkm).verify(approvedId, approvedHash)).to.be.revertedWith("Not authorized for this case");

    // 5. Unassigned analyst (analyst2) -> DENIED
    await expect(registry.connect(analyst2).getEvidence(approvedId)).to.be.revertedWith("Not authorized for this case");
    await expect(registry.connect(analyst2).getCase("TVM/40/2026")).to.be.revertedWith("Not authorized for this case");

    // 6. Court of another district (courtEkm) -> DENIED
    await expect(registry.connect(courtEkm).getEvidence(approvedId)).to.be.revertedWith("Not authorized for this case");
    await expect(registry.connect(courtEkm).getCase("TVM/40/2026")).to.be.revertedWith("Not authorized for this case");

    // 7. System Admin (admin1) -> DENIED for approved evidence (R11)
    await expect(registry.connect(admin1).getEvidence(approvedId)).to.be.revertedWith("Not authorized for this case");
    await expect(registry.connect(admin1).getEvidenceDocs(approvedId)).to.be.revertedWith("Not authorized for this case");
    await expect(registry.connect(admin1).verify(approvedId, approvedHash)).to.be.revertedWith("Not authorized for this case");

    // 8. Outsider -> DENIED
    await expect(registry.connect(outsider).getEvidence(approvedId)).to.be.revertedWith("Not authorized for this case");
    await expect(registry.connect(outsider).getCase("TVM/40/2026")).to.be.revertedWith("Not authorized for this case");

    // 9. Suspended Lead -> DENIED immediately
    await adminDo(multisig, admin1, admin2, people, "suspendProfile", [officerTvm.address, "Suspended"]);
    await expect(registry.connect(officerTvm).getEvidence(approvedId)).to.be.revertedWith("Not authorized for this case");
    await expect(registry.connect(officerTvm).getCase("TVM/40/2026")).to.be.revertedWith("Not authorized for this case");
  });

  it("R5.2 access matrix for PENDING evidence across all personas", async function () {
    const {
      registry,
      officerTvm,
      officerEkm,
      analyst1,
      courtTvm,
      courtEkm,
      admin1,
      outsider,
      pendingId,
      pendingHash,
    } = await setupMatrix();

    // Lead -> ALLOWED
    expect((await registry.connect(officerTvm).getEvidence(pendingId)).id).to.equal(pendingId);
    expect(await registry.connect(officerTvm).verify(pendingId, pendingHash)).to.be.true;

    // Admin -> ALLOWED
    expect((await registry.connect(admin1).getEvidence(pendingId)).id).to.equal(pendingId);
    expect(await registry.connect(admin1).verify(pendingId, pendingHash)).to.be.true;

    // Assigned analyst -> DENIED for pending evidence
    await expect(registry.connect(analyst1).getEvidence(pendingId)).to.be.revertedWith("Not authorized for this case");

    // Case court -> DENIED for pending evidence
    await expect(registry.connect(courtTvm).getEvidence(pendingId)).to.be.revertedWith("Not authorized for this case");

    // Other court -> DENIED
    await expect(registry.connect(courtEkm).getEvidence(pendingId)).to.be.revertedWith("Not authorized for this case");

    // Other officer -> DENIED
    await expect(registry.connect(officerEkm).getEvidence(pendingId)).to.be.revertedWith("Not authorized for this case");

    // Outsider -> DENIED
    await expect(registry.connect(outsider).getEvidence(pendingId)).to.be.revertedWith("Not authorized for this case");
  });

  it("R11.2 helper queries: getUserRole, officialCourt, courtName, getMyCases, getMyHeldEvidence", async function () {
    const {
      multisig,
      admin1,
      admin2,
      people,
      registry,
      officerTvm,
      analyst1,
      courtTvm,
      outsider,
      approvedId,
    } = await setupMatrix();

    // getUserRole strings
    expect(await registry.getUserRole(admin1.address)).to.equal("Admin");
    expect(await registry.getUserRole(officerTvm.address)).to.equal("Investigator");
    expect(await registry.getUserRole(analyst1.address)).to.equal("Forensic Analyst");
    expect(await registry.getUserRole(courtTvm.address)).to.equal("Court Official");
    expect(await registry.getUserRole(outsider.address)).to.equal("None");

    // Pending role string
    await people.connect(outsider).requestProfile(1, 3, ethers.id("p-out"));
    expect(await registry.getUserRole(outsider.address)).to.equal("Pending");

    // Suspended role string
    await adminDo(multisig, admin1, admin2, people, "suspendProfile", [courtTvm.address, "Suspended"]);
    expect(await registry.getUserRole(courtTvm.address)).to.equal("Suspended");

    // officialCourt and courtName
    // Since courtTvm is suspended, officialCourt returns 0
    expect(await registry.officialCourt(courtTvm.address)).to.equal(0n);
    // Reinstate courtTvm
    await adminDo(multisig, admin1, admin2, people, "reinstateProfile", [courtTvm.address]);
    expect(await registry.officialCourt(courtTvm.address)).to.equal(1n); // unit 1
    expect(await registry.courtName(1)).to.equal("Thiruvananthapuram District Court");

    // getMyCases
    const officerCases = await registry.connect(officerTvm).getMyCases();
    expect(officerCases.length).to.equal(1);
    expect(officerCases[0].caseId).to.equal("TVM/40/2026");

    const courtCases = await registry.connect(courtTvm).getMyCases();
    expect(courtCases.length).to.equal(1);
    expect(courtCases[0].caseId).to.equal("TVM/40/2026");

    // getMyHeldEvidence
    const held = await registry.connect(officerTvm).getMyHeldEvidence();
    expect(held).to.deep.equal([approvedId]);
  });
});
