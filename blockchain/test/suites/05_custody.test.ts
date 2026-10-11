import { expect } from "chai";
import { deployFixture, adminDo, ethers } from "./fixture.js";

describe("Chain of Custody Tests (R7, R10)", function () {
  async function setupApprovedEvidence() {
    const fixture = await deployFixture();
    const {
      multisig,
      admin1,
      admin2,
      registry,
      officerTvm,
      analyst1,
    } = fixture;

    await registry.connect(officerTvm).openCase("TVM/20/2026", "Custody Case");
    await registry.connect(officerTvm).requestAnalysis("TVM/20/2026", 5, "Examine item");
    await adminDo(multisig, admin1, admin2, registry, "assignAnalyst", ["TVM/20/2026", analyst1.address]);

    const fileHash = ethers.id("file-custody");
    await registry.connect(officerTvm).registerEvidence({
      caseId: "TVM/20/2026",
      description: "Firearm",
      location: "TVM",
      collectionMethod: "Seized",
      fileHash,
      docs: {
        seizedAt: 1000n,
        isElectronic: false,
        seizureMemoHash: ethers.id("memo-custody"),
        recordingHash: ethers.ZeroHash,
        certificateHash: ethers.ZeroHash,
      },
    });

    const evidenceId = await registry.count();
    await adminDo(multisig, admin1, admin2, registry, "approveEvidence", [evidenceId]);

    return { ...fixture, evidenceId, fileHash };
  }

  it("R7.1 two-step custody: sendCustody and acceptCustody", async function () {
    const {
      registry,
      officerTvm,
      officerEkm,
      analyst1,
      evidenceId,
    } = await setupApprovedEvidence();

    // Only current holder can transfer
    await expect(
      registry.connect(analyst1).sendCustody(evidenceId, analyst1.address, "Reason"),
    ).to.be.revertedWith("Only current holder can transfer");

    // Cannot transfer to self
    await expect(
      registry.connect(officerTvm).sendCustody(evidenceId, officerTvm.address, "Self"),
    ).to.be.revertedWith("Invalid recipient");

    // Cannot transfer to zero address
    await expect(
      registry.connect(officerTvm).sendCustody(evidenceId, ethers.ZeroAddress, "Zero"),
    ).to.be.revertedWith("Invalid recipient");

    // Cannot transfer to someone not on this case (officerEkm is not on case)
    await expect(
      registry.connect(officerTvm).sendCustody(evidenceId, officerEkm.address, "Other officer"),
    ).to.be.revertedWith("Recipient not on this case");

    // Valid offer to analyst1
    const txOffer = await registry.connect(officerTvm).sendCustody(evidenceId, analyst1.address, "Send for ballistics");
    await expect(txOffer).to.emit(registry, "CustodyOffered");
    const rcOffer = await txOffer.wait();
    const filterOffer = registry.filters.CustodyOffered();
    const eventsOffer = await registry.queryFilter(filterOffer, rcOffer!.blockNumber, rcOffer!.blockNumber);
    expect(eventsOffer.length).to.equal(1);
    expect(eventsOffer[0].args.id).to.equal(evidenceId);
    expect(eventsOffer[0].args.from).to.equal(officerTvm.address);
    expect(eventsOffer[0].args.to).to.equal(analyst1.address);
    expect(eventsOffer[0].args.reason).to.equal("Send for ballistics");

    expect(await registry.pendingTo(evidenceId)).to.equal(analyst1.address);

    // Cannot offer twice while pending
    await expect(
      registry.connect(officerTvm).sendCustody(evidenceId, analyst1.address, "Again"),
    ).to.be.revertedWith("Transfer already pending");

    // Only recipient can accept
    await expect(
      registry.connect(officerTvm).acceptCustody(evidenceId),
    ).to.be.revertedWith("No transfer pending for you");

    // Recipient accepts
    const txAccept = await registry.connect(analyst1).acceptCustody(evidenceId);
    await expect(txAccept).to.emit(registry, "CustodyTransferred");
    const rcAccept = await txAccept.wait();
    const filterAccept = registry.filters.CustodyTransferred();
    const eventsAccept = await registry.queryFilter(filterAccept, rcAccept!.blockNumber, rcAccept!.blockNumber);
    expect(eventsAccept.length).to.equal(1);
    expect(eventsAccept[0].args.id).to.equal(evidenceId);
    expect(eventsAccept[0].args.from).to.equal(officerTvm.address);
    expect(eventsAccept[0].args.to).to.equal(analyst1.address);
    expect(eventsAccept[0].args.stage).to.equal(1n); // Stage.ForensicAnalysis

    const ev = await registry.connect(analyst1).getEvidence(evidenceId);
    expect(ev.currentHolder).to.equal(analyst1.address);
    expect(ev.stage).to.equal(1n); // ForensicAnalysis
    expect(await registry.pendingTo(evidenceId)).to.equal(ethers.ZeroAddress);
  });

  it("R7.2 cancelCustodyOffer works for holder and clears pendingTo", async function () {
    const {
      registry,
      officerTvm,
      analyst1,
      evidenceId,
    } = await setupApprovedEvidence();

    await registry.connect(officerTvm).sendCustody(evidenceId, analyst1.address, "Offer");
    expect(await registry.pendingTo(evidenceId)).to.equal(analyst1.address);

    // Cancel offer
    const txCancel = await registry.connect(officerTvm).cancelCustodyOffer(evidenceId);
    await expect(txCancel).to.emit(registry, "CustodyOfferCancelled");
    const rcCancel = await txCancel.wait();
    const filterCancel = registry.filters.CustodyOfferCancelled();
    const eventsCancel = await registry.queryFilter(filterCancel, rcCancel!.blockNumber, rcCancel!.blockNumber);
    expect(eventsCancel.length).to.equal(1);
    expect(eventsCancel[0].args.id).to.equal(evidenceId);
    expect(eventsCancel[0].args.by).to.equal(officerTvm.address);

    expect(await registry.pendingTo(evidenceId)).to.equal(ethers.ZeroAddress);

    // Cancel with no pending offer fails
    await expect(
      registry.connect(officerTvm).cancelCustodyOffer(evidenceId),
    ).to.be.revertedWith("No transfer pending");
  });

  it("R7.3 full custody history records all actions in order", async function () {
    const {
      registry,
      officerTvm,
      analyst1,
      evidenceId,
    } = await setupApprovedEvidence();

    await registry.connect(officerTvm).sendCustody(evidenceId, analyst1.address, "First offer");
    await registry.connect(officerTvm).cancelCustodyOffer(evidenceId);
    await registry.connect(officerTvm).sendCustody(evidenceId, analyst1.address, "Second offer");
    await registry.connect(analyst1).acceptCustody(evidenceId);

    const history = await registry.connect(officerTvm).getCustodyHistory(evidenceId);
    expect(history.length).to.equal(6);
    expect(history[0].action).to.equal(0n);
    expect(history[1].action).to.equal(1n);
    expect(history[2].action).to.equal(3n);
    expect(history[3].action).to.equal(5n);
    expect(history[4].action).to.equal(3n);
    expect(history[5].action).to.equal(4n);
  });

  it("R7.4 submitToCourt moves stage to SubmittedToCourt and notifies court", async function () {
    const {
      registry,
      officerTvm,
      analyst1,
      evidenceId,
    } = await setupApprovedEvidence();

    // Cannot submit if transfer is pending
    await registry.connect(officerTvm).sendCustody(evidenceId, analyst1.address, "Offer");
    await expect(
      registry.connect(officerTvm).submitToCourt(evidenceId, "Submit note"),
    ).to.be.revertedWith("Transfer pending");

    await registry.connect(officerTvm).cancelCustodyOffer(evidenceId);

    // Submit to court
    const txSubmit = await registry.connect(officerTvm).submitToCourt(evidenceId, "Formal submission");
    await expect(txSubmit).to.emit(registry, "EvidenceSubmittedToCourt");
    const rcSubmit = await txSubmit.wait();
    const filterSubmit = registry.filters.EvidenceSubmittedToCourt();
    const eventsSubmit = await registry.queryFilter(filterSubmit, rcSubmit!.blockNumber, rcSubmit!.blockNumber);
    expect(eventsSubmit.length).to.equal(1);
    expect(eventsSubmit[0].args.id).to.equal(evidenceId);
    expect(eventsSubmit[0].args.courtId).to.equal(1n);
    expect(eventsSubmit[0].args.by).to.equal(officerTvm.address);

    const ev = await registry.connect(officerTvm).getEvidence(evidenceId);
    expect(ev.stage).to.equal(2n); // SubmittedToCourt

    // Nothing can move afterwards
    await expect(
      registry.connect(officerTvm).sendCustody(evidenceId, analyst1.address, "Move"),
    ).to.be.revertedWith("Already submitted to court");
  });

  it("R7.5 forceReassign works via multisig when holder is no longer participant", async function () {
    const {
      multisig,
      admin1,
      admin2,
      people,
      registry,
      officerTvm,
      analyst1,
      evidenceId,
    } = await setupApprovedEvidence();

    // First transfer custody to analyst1
    await registry.connect(officerTvm).sendCustody(evidenceId, analyst1.address, "Analyze");
    await registry.connect(analyst1).acceptCustody(evidenceId);

    // Trying to forceReassign while analyst1 is still active participant fails
    await expect(
      adminDo(multisig, admin1, admin2, registry, "forceReassign", [
        evidenceId,
        officerTvm.address,
        "Override",
      ]),
    ).to.be.revertedWith("Current holder is still active on the case");

    // Suspend analyst1's profile
    await adminDo(multisig, admin1, admin2, people, "suspendProfile", [analyst1.address, "Suspended"]);

    // Now analyst1 is no longer active participant -> forceReassign succeeds
    const txForce = await adminDo(multisig, admin1, admin2, registry, "forceReassign", [
      evidenceId,
      officerTvm.address,
      "Analyst suspended",
    ]);
    await expect(txForce).to.emit(registry, "CustodyTransferred");
    const rcForce = await txForce.wait();
    const filterForce = registry.filters.CustodyTransferred();
    const eventsForce = await registry.queryFilter(filterForce, rcForce!.blockNumber, rcForce!.blockNumber);
    expect(eventsForce.length).to.equal(1);
    expect(eventsForce[0].args.id).to.equal(evidenceId);
    expect(eventsForce[0].args.from).to.equal(analyst1.address);
    expect(eventsForce[0].args.to).to.equal(officerTvm.address);
    expect(eventsForce[0].args.stage).to.equal(0n); // Stage.Collected because recipient is lead

    expect((await registry.connect(officerTvm).getEvidence(evidenceId)).currentHolder).to.equal(
      officerTvm.address,
    );
  });
});
