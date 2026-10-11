import { expect } from "chai";
import { deployFixture, adminDo, ethers } from "./fixture.js";

describe("Forensic Reports, Verification, Flags & Integrity (R6, R9, R12)", function () {
  async function setupCaseAndApprovedEvidence() {
    const fixture = await deployFixture();
    const {
      multisig,
      admin1,
      admin2,
      registry,
      officerTvm,
      analyst1,
      analyst2,
    } = fixture;

    await registry.connect(officerTvm).openCase("TVM/30/2026", "Integrity Case");
    await registry.connect(officerTvm).requestAnalysis("TVM/30/2026", 5, "Request test");
    await adminDo(multisig, admin1, admin2, registry, "assignAnalyst", ["TVM/30/2026", analyst1.address]);

    const fileHash = ethers.id("file-integrity");
    await registry.connect(officerTvm).registerEvidence({
      caseId: "TVM/30/2026",
      description: "Memory Card",
      location: "TVM",
      collectionMethod: "Seized",
      fileHash,
      docs: {
        seizedAt: 1000n,
        isElectronic: true,
        seizureMemoHash: ethers.id("memo-integrity"),
        recordingHash: ethers.ZeroHash,
        certificateHash: ethers.id("cert-integrity"),
      },
    });

    const evidenceId = await registry.count();
    await adminDo(multisig, admin1, admin2, registry, "approveEvidence", [evidenceId]);

    return { ...fixture, evidenceId, fileHash };
  }

  it("R6.3 addAnalysisReport: only assigned active analyst can add report", async function () {
    const {
      registry,
      officerTvm,
      analyst1,
      analyst2,
      evidenceId,
    } = await setupCaseAndApprovedEvidence();

    const reportHash = ethers.id("report-ballistics");

    // Officer is on case but not an analyst -> _viewable passes, but _isAnalystOf fails with "Only an assigned analyst"
    await expect(
      registry.connect(officerTvm).addAnalysisReport(evidenceId, reportHash, "Note"),
    ).to.be.revertedWith("Only an assigned analyst");

    // Unassigned analyst is not on case -> fails at _viewable with "Not authorized for this case"
    await expect(
      registry.connect(analyst2).addAnalysisReport(evidenceId, reportHash, "Note"),
    ).to.be.revertedWith("Not authorized for this case");

    // Empty report hash reverts
    await expect(
      registry.connect(analyst1).addAnalysisReport(evidenceId, ethers.ZeroHash, "Note"),
    ).to.be.revertedWith("Empty hash");

    // Assigned analyst succeeds
    const tx = await registry.connect(analyst1).addAnalysisReport(evidenceId, reportHash, "Fingerprint match confirmed");
    await expect(tx).to.emit(registry, "AnalysisReportAdded");
    const rc = await tx.wait();
    const filter = registry.filters.AnalysisReportAdded();
    const events = await registry.queryFilter(filter, rc!.blockNumber, rc!.blockNumber);
    expect(events.length).to.equal(1);
    expect(events[0].args.id).to.equal(evidenceId);
    expect(events[0].args.analyst).to.equal(analyst1.address);
    expect(events[0].args.reportHash).to.equal(reportHash);

    const reports = await registry.connect(officerTvm).getAnalysisReports(evidenceId);
    expect(reports.length).to.equal(1);
    expect(reports[0].reportHash).to.equal(reportHash);
    expect(reports[0].analyst).to.equal(analyst1.address);
  });

  it("R9.3 verify returns true for correct hash and false for tampered hash", async function () {
    const {
      registry,
      officerTvm,
      evidenceId,
      fileHash,
    } = await setupCaseAndApprovedEvidence();

    const wrongHash = ethers.id("tampered-hash");
    expect(await registry.connect(officerTvm).verify(evidenceId, fileHash)).to.be.true;
    expect(await registry.connect(officerTvm).verify(evidenceId, wrongHash)).to.be.false;
  });

  it("R9.4 recordVerification emits EvidenceVerified with intact flag", async function () {
    const {
      registry,
      officerTvm,
      evidenceId,
      fileHash,
    } = await setupCaseAndApprovedEvidence();

    const wrongHash = ethers.id("tampered-hash");

    // Intact verification
    const txIntact = await registry.connect(officerTvm).recordVerification(evidenceId, fileHash);
    await expect(txIntact).to.emit(registry, "EvidenceVerified");
    const rcIntact = await txIntact.wait();
    const filter = registry.filters.EvidenceVerified();
    const eventsIntact = await registry.queryFilter(filter, rcIntact!.blockNumber, rcIntact!.blockNumber);
    expect(eventsIntact.length).to.equal(1);
    expect(eventsIntact[0].args.id).to.equal(evidenceId);
    expect(eventsIntact[0].args.verifier).to.equal(officerTvm.address);
    expect(eventsIntact[0].args.intact).to.be.true;

    // Tampered verification
    const txTampered = await registry.connect(officerTvm).recordVerification(evidenceId, wrongHash);
    await expect(txTampered).to.emit(registry, "EvidenceVerified");
    const rcTampered = await txTampered.wait();
    const eventsTampered = await registry.queryFilter(filter, rcTampered!.blockNumber, rcTampered!.blockNumber);
    expect(eventsTampered.length).to.equal(1);
    expect(eventsTampered[0].args.id).to.equal(evidenceId);
    expect(eventsTampered[0].args.verifier).to.equal(officerTvm.address);
    expect(eventsTampered[0].args.intact).to.be.false;
  });

  it("R12.1 logAccess emits EvidenceAccessed", async function () {
    const {
      registry,
      officerTvm,
      evidenceId,
    } = await setupCaseAndApprovedEvidence();

    const txAccess = await registry.connect(officerTvm).logAccess(evidenceId, "Download for court exhibit preparation");
    await expect(txAccess).to.emit(registry, "EvidenceAccessed");
    const rcAccess = await txAccess.wait();
    const filter = registry.filters.EvidenceAccessed();
    const events = await registry.queryFilter(filter, rcAccess!.blockNumber, rcAccess!.blockNumber);
    expect(events.length).to.equal(1);
    expect(events[0].args.id).to.equal(evidenceId);
    expect(events[0].args.accessor).to.equal(officerTvm.address);
    expect(events[0].args.purpose).to.equal("Download for court exhibit preparation");
  });

  it("R7.6 flagging, resolving and revoking evidence", async function () {
    const {
      multisig,
      admin1,
      admin2,
      registry,
      officerTvm,
      analyst1,
      evidenceId,
    } = await setupCaseAndApprovedEvidence();

    // Resolve flag when not flagged reverts
    await expect(
      adminDo(multisig, admin1, admin2, registry, "resolveFlag", [evidenceId, "Note"]),
    ).to.be.revertedWith("Evidence is not flagged");

    // Flag evidence
    const txFlag = await registry.connect(officerTvm).flagEvidence(evidenceId, "Tamper detected");
    await expect(txFlag).to.emit(registry, "EvidenceStatusChanged");
    const rcFlag = await txFlag.wait();
    const filter = registry.filters.EvidenceStatusChanged();
    const eventsFlag = await registry.queryFilter(filter, rcFlag!.blockNumber, rcFlag!.blockNumber);
    expect(eventsFlag.length).to.equal(1);
    expect(eventsFlag[0].args.id).to.equal(evidenceId);
    expect(eventsFlag[0].args.status).to.equal(1n); // Status.Flagged
    expect(eventsFlag[0].args.by).to.equal(officerTvm.address);
    expect(eventsFlag[0].args.reason).to.equal("Tamper detected");

    // Flagged evidence cannot move (sendCustody fails with 'Evidence is flagged or revoked')
    await expect(
      registry.connect(officerTvm).sendCustody(evidenceId, analyst1.address, "Move"),
    ).to.be.revertedWith("Evidence is flagged or revoked");

    // Resolve flag via multisig
    await expect(
      adminDo(multisig, admin1, admin2, registry, "resolveFlag", [evidenceId, "Cleaned and verified"]),
    ).to.emit(registry, "EvidenceStatusChanged");

    expect((await registry.connect(officerTvm).getEvidence(evidenceId)).status).to.equal(0n); // Active

    // Revoke evidence via multisig
    const txRevoke = await adminDo(multisig, admin1, admin2, registry, "revokeEvidence", [evidenceId, "Court order - inadmissible"]);
    await expect(txRevoke).to.emit(registry, "EvidenceStatusChanged");
    const rcRevoke = await txRevoke.wait();
    const eventsRevoke = await registry.queryFilter(filter, rcRevoke!.blockNumber, rcRevoke!.blockNumber);
    expect(eventsRevoke.length).to.equal(1);
    expect(eventsRevoke[0].args.id).to.equal(evidenceId);
    expect(eventsRevoke[0].args.status).to.equal(2n); // Status.Revoked
    expect(eventsRevoke[0].args.by).to.equal(await multisig.getAddress());
    expect(eventsRevoke[0].args.reason).to.equal("Court order - inadmissible");

    expect((await registry.connect(officerTvm).getEvidence(evidenceId)).status).to.equal(2n);

    // Revoked evidence cannot move
    await expect(
      registry.connect(officerTvm).sendCustody(evidenceId, analyst1.address, "Move"),
    ).to.be.revertedWith("Evidence is flagged or revoked");
  });
});
