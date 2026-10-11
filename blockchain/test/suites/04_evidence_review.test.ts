import { expect } from "chai";
import { deployFixture, adminDo, ethers } from "./fixture.js";

describe("Evidence Registration & Review Tests (R4, R8, R9, R11)", function () {
  it("R8.1 legal fields validation on registerEvidence", async function () {
    const { registry, officerTvm, officerEkm } = await deployFixture();
    await registry.connect(officerTvm).openCase("TVM/10/2026", "Evidence Validation Case");

    const validHash = ethers.id("file-valid");
    const validMemo = ethers.id("memo-valid");
    const validCert = ethers.id("cert-valid");

    // Only lead investigator can register
    await expect(
      registry.connect(officerEkm).registerEvidence({
        caseId: "TVM/10/2026",
        description: "Bag",
        location: "TVM",
        collectionMethod: "Seized",
        fileHash: validHash,
        docs: {
          seizedAt: 1000n,
          isElectronic: false,
          seizureMemoHash: validMemo,
          recordingHash: ethers.ZeroHash,
          certificateHash: ethers.ZeroHash,
        },
      }),
    ).to.be.revertedWith("Not lead investigator");

    // Empty fileHash
    await expect(
      registry.connect(officerTvm).registerEvidence({
        caseId: "TVM/10/2026",
        description: "Bag",
        location: "TVM",
        collectionMethod: "Seized",
        fileHash: ethers.ZeroHash,
        docs: {
          seizedAt: 1000n,
          isElectronic: false,
          seizureMemoHash: validMemo,
          recordingHash: ethers.ZeroHash,
          certificateHash: ethers.ZeroHash,
        },
      }),
    ).to.be.revertedWith("Empty hash");

    // Missing seizureMemoHash
    await expect(
      registry.connect(officerTvm).registerEvidence({
        caseId: "TVM/10/2026",
        description: "Bag",
        location: "TVM",
        collectionMethod: "Seized",
        fileHash: validHash,
        docs: {
          seizedAt: 1000n,
          isElectronic: false,
          seizureMemoHash: ethers.ZeroHash,
          recordingHash: ethers.ZeroHash,
          certificateHash: ethers.ZeroHash,
        },
      }),
    ).to.be.revertedWith("Seizure memo hash required");

    // Electronic evidence without certificateHash
    await expect(
      registry.connect(officerTvm).registerEvidence({
        caseId: "TVM/10/2026",
        description: "Laptop",
        location: "TVM",
        collectionMethod: "Seized",
        fileHash: validHash,
        docs: {
          seizedAt: 1000n,
          isElectronic: true,
          seizureMemoHash: validMemo,
          recordingHash: ethers.ZeroHash,
          certificateHash: ethers.ZeroHash,
        },
      }),
    ).to.be.revertedWith("Electronic evidence needs its certificate hash");

    // Invalid seizure time: seizedAt = 0
    await expect(
      registry.connect(officerTvm).registerEvidence({
        caseId: "TVM/10/2026",
        description: "Bag",
        location: "TVM",
        collectionMethod: "Seized",
        fileHash: validHash,
        docs: {
          seizedAt: 0n,
          isElectronic: false,
          seizureMemoHash: validMemo,
          recordingHash: ethers.ZeroHash,
          certificateHash: ethers.ZeroHash,
        },
      }),
    ).to.be.revertedWith("Invalid seizure time");

    // Future seizure time
    const futureTime = BigInt(Math.floor(Date.now() / 1000) + 100000);
    await expect(
      registry.connect(officerTvm).registerEvidence({
        caseId: "TVM/10/2026",
        description: "Bag",
        location: "TVM",
        collectionMethod: "Seized",
        fileHash: validHash,
        docs: {
          seizedAt: futureTime,
          isElectronic: false,
          seizureMemoHash: validMemo,
          recordingHash: ethers.ZeroHash,
          certificateHash: ethers.ZeroHash,
        },
      }),
    ).to.be.revertedWith("Invalid seizure time");
  });

  it("R4.1 new evidence stays Pending; lead and admin can see it; court and analyst cannot", async function () {
    const {
      registry,
      officerTvm,
      courtTvm,
      analyst1,
      admin1,
      outsider,
    } = await deployFixture();

    await registry.connect(officerTvm).openCase("TVM/11/2026", "Pending Case");
    const fileHash = ethers.id("evidence-file-pending");

    const tx = await registry.connect(officerTvm).registerEvidence({
      caseId: "TVM/11/2026",
      description: "Mobile Phone",
      location: "TVM Central",
      collectionMethod: "Imaged",
      fileHash,
      docs: {
        seizedAt: 1000n,
        isElectronic: true,
        seizureMemoHash: ethers.id("memo-pending"),
        recordingHash: ethers.id("video-pending"),
        certificateHash: ethers.id("cert-pending"),
      },
    });

    await expect(tx).to.emit(registry, "EvidenceSubmittedForReview");
    const evidenceId = await registry.count();

    // Check states: Review.Pending (0), Stage.Collected (0), Status.Active (0)
    const ev = await registry.connect(officerTvm).getEvidence(evidenceId);
    expect(ev.review).to.equal(0n);
    expect(ev.stage).to.equal(0n);
    expect(ev.status).to.equal(0n);

    // Lead can view
    expect((await registry.connect(officerTvm).getEvidence(evidenceId)).fileHash).to.equal(fileHash);

    // Admin can view pending evidence
    expect((await registry.connect(admin1).getEvidence(evidenceId)).fileHash).to.equal(fileHash);
    expect(await registry.connect(admin1).getPendingEvidence()).to.deep.equal([evidenceId]);

    // Court cannot view pending evidence
    await expect(registry.connect(courtTvm).getEvidence(evidenceId)).to.be.revertedWith(
      "Not authorized for this case",
    );

    // Analyst cannot view pending evidence
    await expect(registry.connect(analyst1).getEvidence(evidenceId)).to.be.revertedWith(
      "Not authorized for this case",
    );

    // Outsider cannot view
    await expect(registry.connect(outsider).getEvidence(evidenceId)).to.be.revertedWith(
      "Not authorized for this case",
    );
  });

  it("R9.1 duplicate file hash is rejected", async function () {
    const { registry, officerTvm } = await deployFixture();
    await registry.connect(officerTvm).openCase("TVM/12/2026", "Dup Hash Case");
    const fileHash = ethers.id("file-hash-dup");

    await registry.connect(officerTvm).registerEvidence({
      caseId: "TVM/12/2026",
      description: "Item 1",
      location: "TVM",
      collectionMethod: "Seized",
      fileHash,
      docs: {
        seizedAt: 1000n,
        isElectronic: false,
        seizureMemoHash: ethers.id("memo-1"),
        recordingHash: ethers.ZeroHash,
        certificateHash: ethers.ZeroHash,
      },
    });

    await expect(
      registry.connect(officerTvm).registerEvidence({
        caseId: "TVM/12/2026",
        description: "Item 2 duplicate",
        location: "TVM",
        collectionMethod: "Seized",
        fileHash,
        docs: {
          seizedAt: 1000n,
          isElectronic: false,
          seizureMemoHash: ethers.id("memo-2"),
          recordingHash: ethers.ZeroHash,
          certificateHash: ethers.ZeroHash,
        },
      }),
    ).to.be.revertedWith("Evidence already registered");
  });

  it("R4.2 approval notifies court; court can view; admins can no longer view approved evidence", async function () {
    const {
      multisig,
      admin1,
      admin2,
      registry,
      officerTvm,
      courtTvm,
      courtEkm,
    } = await deployFixture();

    await registry.connect(officerTvm).openCase("TVM/13/2026", "Approval Case");
    const fileHash = ethers.id("file-approval");

    await registry.connect(officerTvm).registerEvidence({
      caseId: "TVM/13/2026",
      description: "Hard Drive",
      location: "TVM",
      collectionMethod: "Seized",
      fileHash,
      docs: {
        seizedAt: 1000n,
        isElectronic: true,
        seizureMemoHash: ethers.id("memo-app"),
        recordingHash: ethers.ZeroHash,
        certificateHash: ethers.id("cert-app"),
      },
    });

    const evidenceId = await registry.count();

    // Approve evidence via multisig
    const tx = await adminDo(multisig, admin1, admin2, registry, "approveEvidence", [evidenceId]);
    await expect(tx).to.emit(registry, "EvidenceApproved");

    const receipt = await tx.wait();
    const filter = registry.filters.EvidenceApproved();
    const events = await registry.queryFilter(filter, receipt!.blockNumber, receipt!.blockNumber);
    expect(events.length).to.equal(1);
    expect(events[0].args.id).to.equal(evidenceId);
    expect(events[0].args.courtId).to.equal(1n);
    expect(events[0].args.collector).to.equal(officerTvm.address);
    expect(events[0].args.fileHash).to.equal(fileHash);

    // Court of that case (courtTvm) can view
    const ev = await registry.connect(courtTvm).getEvidence(evidenceId);
    expect(ev.review).to.equal(1n); // Approved

    // Court of another district (courtEkm) CANNOT view
    await expect(registry.connect(courtEkm).getEvidence(evidenceId)).to.be.revertedWith(
      "Not authorized for this case",
    );

    // Admins can NO LONGER view approved evidence (R11)
    await expect(registry.connect(admin1).getEvidence(evidenceId)).to.be.revertedWith(
      "Not authorized for this case",
    );
  });

  it("R9.2 rejected evidence clears hash allowing re-registration", async function () {
    const {
      multisig,
      admin1,
      admin2,
      registry,
      officerTvm,
      courtTvm,
    } = await deployFixture();

    await registry.connect(officerTvm).openCase("TVM/14/2026", "Rejection Case");
    const fileHash = ethers.id("file-rejection");

    await registry.connect(officerTvm).registerEvidence({
      caseId: "TVM/14/2026",
      description: "USB Stick",
      location: "TVM",
      collectionMethod: "Seized",
      fileHash,
      docs: {
        seizedAt: 1000n,
        isElectronic: false,
        seizureMemoHash: ethers.id("memo-rej"),
        recordingHash: ethers.ZeroHash,
        certificateHash: ethers.ZeroHash,
      },
    });

    const evidenceId = await registry.count();

    // Reject evidence
    const tx = await adminDo(multisig, admin1, admin2, registry, "rejectEvidence", [evidenceId, "Blurry panchnama"]);
    await expect(tx).to.emit(registry, "EvidenceRejected");

    const receipt = await tx.wait();
    const filter = registry.filters.EvidenceRejected();
    const events = await registry.queryFilter(filter, receipt!.blockNumber, receipt!.blockNumber);
    expect(events.length).to.equal(1);
    expect(events[0].args.id).to.equal(evidenceId);
    expect(events[0].args.collector).to.equal(officerTvm.address);
    expect(events[0].args.reason).to.equal("Blurry panchnama");

    // Court never sees it
    await expect(registry.connect(courtTvm).getEvidence(evidenceId)).to.be.revertedWith(
      "Not authorized for this case",
    );

    // hashToId is cleared: officer can register the exact same fileHash again
    await expect(
      registry.connect(officerTvm).registerEvidence({
        caseId: "TVM/14/2026",
        description: "USB Stick (Resubmitted)",
        location: "TVM",
        collectionMethod: "Seized",
        fileHash,
        docs: {
          seizedAt: 1000n,
          isElectronic: false,
          seizureMemoHash: ethers.id("memo-rej-corrected"),
          recordingHash: ethers.ZeroHash,
          certificateHash: ethers.ZeroHash,
        },
      }),
    ).to.emit(registry, "EvidenceSubmittedForReview");
  });
});
