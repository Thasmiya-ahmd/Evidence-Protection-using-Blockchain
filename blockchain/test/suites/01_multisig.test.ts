import { expect } from "chai";
import { deployFixture, adminDo, ethers } from "./fixture.js";

describe("Multisig & Governance Tests (R2)", function () {
  it("R2.1 non-owner cannot propose with exact revert message", async function () {
    const { multisig, outsider } = await deployFixture();
    await expect(
      multisig.connect(outsider).propose(ethers.ZeroAddress, "0x"),
    ).to.be.revertedWith("Not an admin");
  });

  it("R2.2 execute with only 1 approval fails with Not enough approvals", async function () {
    const { multisig, admin1, people } = await deployFixture();
    const data = people.interface.encodeFunctionData("approveProfile", [admin1.address]);
    await multisig.connect(admin1).propose(await people.getAddress(), data);
    const id = (await multisig.proposalCount()) - 1n;
    await expect(multisig.connect(admin1).execute(id)).to.be.revertedWith(
      "Not enough approvals",
    );
  });

  it("R2.3 execution succeeds with two approvals", async function () {
    const { multisig, admin1, admin2, people, outsider } = await deployFixture();
    // Request a profile for outsider
    await people.connect(outsider).requestProfile(1, 3, ethers.id("profile-outsider"));
    const data = people.interface.encodeFunctionData("approveProfile", [outsider.address]);
    await multisig.connect(admin1).propose(await people.getAddress(), data);
    const id = (await multisig.proposalCount()) - 1n;
    await multisig.connect(admin2).approve(id);
    await expect(multisig.connect(admin1).execute(id))
      .to.emit(multisig, "Executed")
      .withArgs(id, admin1.address);
    expect(await people.activeRole(outsider.address)).to.equal(1n);
  });

  it("R2.4 double approve reverts with Already approved", async function () {
    const { multisig, admin1, admin2, people } = await deployFixture();
    const data = people.interface.encodeFunctionData("approveProfile", [admin1.address]);
    await multisig.connect(admin1).propose(await people.getAddress(), data);
    const id = (await multisig.proposalCount()) - 1n;
    // admin1 already approved upon proposing
    await expect(multisig.connect(admin1).approve(id)).to.be.revertedWith(
      "Already approved",
    );
    // admin2 approves once
    await multisig.connect(admin2).approve(id);
    // admin2 approves second time
    await expect(multisig.connect(admin2).approve(id)).to.be.revertedWith(
      "Already approved",
    );
  });

  it("R2.5 revokeApproval lowers count and blocks execution", async function () {
    const { multisig, admin1, admin2, people } = await deployFixture();
    const data = people.interface.encodeFunctionData("approveProfile", [admin1.address]);
    await multisig.connect(admin1).propose(await people.getAddress(), data);
    const id = (await multisig.proposalCount()) - 1n;
    await multisig.connect(admin2).approve(id);
    expect(await multisig.approvalsOf(id)).to.equal(2n);

    await expect(multisig.connect(admin2).revokeApproval(id))
      .to.emit(multisig, "ApprovalRevoked")
      .withArgs(id, admin2.address);
    expect(await multisig.approvalsOf(id)).to.equal(1n);

    await expect(multisig.connect(admin1).execute(id)).to.be.revertedWith(
      "Not enough approvals",
    );
  });

  it("R2.6 executed proposal cannot be approved or executed again", async function () {
    const { multisig, admin1, admin2, admin3, people, outsider } = await deployFixture();
    await people.connect(outsider).requestProfile(1, 3, ethers.id("profile-outsider-2"));
    const data = people.interface.encodeFunctionData("approveProfile", [outsider.address]);
    await multisig.connect(admin1).propose(await people.getAddress(), data);
    const id = (await multisig.proposalCount()) - 1n;
    await multisig.connect(admin2).approve(id);
    await multisig.connect(admin1).execute(id);

    await expect(multisig.connect(admin3).approve(id)).to.be.revertedWith(
      "Already executed",
    );
    await expect(multisig.connect(admin1).execute(id)).to.be.revertedWith(
      "Already executed",
    );
  });

  it("R2.7 failing proposal execution bubbles the exact target revert message", async function () {
    const { multisig, admin1, admin2, people } = await deployFixture();
    // Registering duplicate court in Thiruvananthapuram will revert with 'Location already has a court'
    const data = people.interface.encodeFunctionData("registerUnits", [
      3,
      ["Duplicate Court"],
      ["Thiruvananthapuram"],
    ]);
    await multisig.connect(admin1).propose(await people.getAddress(), data);
    const id = (await multisig.proposalCount()) - 1n;
    await multisig.connect(admin2).approve(id);

    await expect(multisig.connect(admin1).execute(id)).to.be.revertedWith(
      "Location already has a court",
    );
  });

  it("R2.8 addOwner, removeOwner, changeThreshold revert directly but work via proposal", async function () {
    const { multisig, admin1, admin2, outsider } = await deployFixture();
    await expect(multisig.connect(admin1).addOwner(outsider.address)).to.be.revertedWith(
      "Only through an approved proposal",
    );
    await expect(multisig.connect(admin1).removeOwner(admin2.address)).to.be.revertedWith(
      "Only through an approved proposal",
    );
    await expect(multisig.connect(admin1).changeThreshold(3)).to.be.revertedWith(
      "Only through an approved proposal",
    );

    // Add owner via proposal
    await expect(adminDo(multisig, admin1, admin2, multisig, "addOwner", [outsider.address]))
      .to.emit(multisig, "OwnerAdded")
      .withArgs(outsider.address);
    expect(await multisig.isOwner(outsider.address)).to.be.true;

    // Change threshold via proposal
    await expect(adminDo(multisig, admin1, admin2, multisig, "changeThreshold", [3]))
      .to.emit(multisig, "ThresholdChanged")
      .withArgs(3);
    expect(await multisig.threshold()).to.equal(3n);
  });

  it("R2.9 removeOwner cannot break the threshold", async function () {
    const { multisig, admin1, admin2, admin3 } = await deployFixture();
    // owners count = 3, threshold = 2. Removing one leaves 2, which equals threshold.
    // First remove admin3 leaving 2 owners with threshold 2
    await adminDo(multisig, admin1, admin2, multisig, "removeOwner", [admin3.address]);
    expect(await multisig.isOwner(admin3.address)).to.be.false;

    // Now trying to remove admin2 would leave 1 owner, breaking threshold 2
    const data = multisig.interface.encodeFunctionData("removeOwner", [admin2.address]);
    await multisig.connect(admin1).propose(await multisig.getAddress(), data);
    const id = (await multisig.proposalCount()) - 1n;
    await multisig.connect(admin2).approve(id);

    await expect(multisig.connect(admin1).execute(id)).to.be.revertedWith(
      "Would break the approval threshold",
    );
  });

  it("R2.10 approvals from a removed admin no longer count", async function () {
    const { multisig, admin1, admin2, admin3, people } = await deployFixture();
    // Create a proposal proposed by admin3
    const data = people.interface.encodeFunctionData("approveProfile", [admin1.address]);
    await multisig.connect(admin3).propose(await people.getAddress(), data);
    const targetProposalId = (await multisig.proposalCount()) - 1n;
    expect(await multisig.approvalsOf(targetProposalId)).to.equal(1n);

    // Remove admin3
    await adminDo(multisig, admin1, admin2, multisig, "removeOwner", [admin3.address]);
    expect(await multisig.isOwner(admin3.address)).to.be.false;

    // Check approvals on the pending proposal: admin3's vote no longer counts!
    expect(await multisig.approvalsOf(targetProposalId)).to.equal(0n);

    // If only admin1 approves now, total = 1, execution fails
    await multisig.connect(admin1).approve(targetProposalId);
    expect(await multisig.approvalsOf(targetProposalId)).to.equal(1n);
    await expect(multisig.connect(admin1).execute(targetProposalId)).to.be.revertedWith(
      "Not enough approvals",
    );

    // When admin2 also approves, total = 2, succeeds
    await multisig.connect(admin2).approve(targetProposalId);
    expect(await multisig.approvalsOf(targetProposalId)).to.equal(2n);
  });

  it("R2.11 every admin-only function in PeopleRegistry and EvidenceRegistry reverts 'Only the admin multisig' when called directly", async function () {
    const { people, registry, admin1, outsider } = await deployFixture();

    for (const caller of [outsider, admin1]) {
      await expect(
        people.connect(caller).registerUnits(1, ["X"], ["Y"]),
      ).to.be.revertedWith("Only the admin multisig");

      await expect(
        people.connect(caller).approveProfile(outsider.address),
      ).to.be.revertedWith("Only the admin multisig");

      await expect(
        people.connect(caller).rejectProfile(outsider.address, "Reason"),
      ).to.be.revertedWith("Only the admin multisig");

      await expect(
        people.connect(caller).suspendProfile(outsider.address, "Reason"),
      ).to.be.revertedWith("Only the admin multisig");

      await expect(
        people.connect(caller).reinstateProfile(outsider.address),
      ).to.be.revertedWith("Only the admin multisig");

      await expect(
        registry.connect(caller).assignAnalyst("CASE-1", outsider.address),
      ).to.be.revertedWith("Only the admin multisig");

      await expect(
        registry.connect(caller).removeAnalyst("CASE-1", outsider.address),
      ).to.be.revertedWith("Only the admin multisig");

      await expect(
        registry.connect(caller).approveEvidence(1),
      ).to.be.revertedWith("Only the admin multisig");

      await expect(
        registry.connect(caller).rejectEvidence(1, "Reason"),
      ).to.be.revertedWith("Only the admin multisig");

      await expect(
        registry.connect(caller).forceReassign(1, outsider.address, "Reason"),
      ).to.be.revertedWith("Only the admin multisig");
    }
  });
});
