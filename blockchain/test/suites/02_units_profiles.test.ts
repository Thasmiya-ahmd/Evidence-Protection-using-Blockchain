import { expect } from "chai";
import { deployFixture, adminDo, ethers } from "./fixture.js";

describe("Units and Profiles Tests (R1, R11)", function () {
  it("R1.1 batch registration, bad inputs, and one court per location", async function () {
    const { multisig, admin1, admin2, people } = await deployFixture();

    // Bad unit type (UnitType.None = 0)
    await expect(
      adminDo(multisig, admin1, admin2, people, "registerUnits", [0, ["Name"], ["Loc"]]),
    ).to.be.revertedWith("Bad unit type");

    // Mismatched length
    await expect(
      adminDo(multisig, admin1, admin2, people, "registerUnits", [1, ["Name 1", "Name 2"], ["Loc 1"]]),
    ).to.be.revertedWith("Bad input");

    // Empty name
    await expect(
      adminDo(multisig, admin1, admin2, people, "registerUnits", [1, [""], ["Loc"]]),
    ).to.be.revertedWith("Name and location required");

    // One court per location check
    await expect(
      adminDo(multisig, admin1, admin2, people, "registerUnits", [3, ["New Court"], ["Thiruvananthapuram"]]),
    ).to.be.revertedWith("Location already has a court");
  });

  it("R1.2 getUnits, getUnitsAt, courtOfUnit and courtForLocation", async function () {
    const { people } = await deployFixture();

    const [courtIds, courtNames, courtLocs] = await people.getUnits(3);
    expect(courtIds.length).to.equal(2);
    expect(courtNames[0]).to.equal("Thiruvananthapuram District Court");
    expect(courtLocs[0]).to.equal("Thiruvananthapuram");

    const [tvmStations, tvmStationNames] = await people.getUnitsAt(1, "Thiruvananthapuram");
    expect(tvmStations.length).to.equal(1);
    expect(tvmStationNames[0]).to.equal("Thiruvananthapuram City Police Station");

    // Unit 3 is TVM Station, its court should be Unit 1 (TVM Court)
    expect(await people.courtOfUnit(3)).to.equal(1n);

    // courtForLocation
    const [cId, cName] = await people.courtForLocation("Ernakulam");
    expect(cId).to.equal(2n);
    expect(cName).to.equal("Ernakulam District Court");
  });

  it("R1.3 profile request validates unit type against role", async function () {
    const { people, outsider } = await deployFixture();

    // Investigator (role 1) applying for Court (unit 1) -> Wrong unit for this role
    await expect(
      people.connect(outsider).requestProfile(1, 1, ethers.id("doc")),
    ).to.be.revertedWith("Wrong unit for this role");

    // Analyst (role 2) applying for Station (unit 3) -> Wrong unit for this role
    await expect(
      people.connect(outsider).requestProfile(2, 3, ethers.id("doc")),
    ).to.be.revertedWith("Wrong unit for this role");

    // CourtOfficial (role 3) applying for Lab (unit 5) -> Wrong unit for this role
    await expect(
      people.connect(outsider).requestProfile(3, 5, ethers.id("doc")),
    ).to.be.revertedWith("Wrong unit for this role");
  });

  it("R1.4 duplicate request reverts with Profile already submitted", async function () {
    const { people, outsider } = await deployFixture();
    await people.connect(outsider).requestProfile(1, 3, ethers.id("doc"));
    await expect(
      people.connect(outsider).requestProfile(1, 3, ethers.id("doc2")),
    ).to.be.revertedWith("Profile already submitted");
  });

  it("R1.5 a rejected applicant can re-apply", async function () {
    const { multisig, admin1, admin2, people, outsider } = await deployFixture();
    await people.connect(outsider).requestProfile(1, 3, ethers.id("doc"));
    await adminDo(multisig, admin1, admin2, people, "rejectProfile", [outsider.address, "Invalid ID"]);
    
    // Status is Rejected; now re-apply succeeds
    await expect(
      people.connect(outsider).requestProfile(1, 3, ethers.id("doc-fixed")),
    ).to.emit(people, "ProfileRequested");
  });

  it("R1.6 pending profile returns Pending role; suspension immediately revokes and reinstatement restores", async function () {
    const { multisig, admin1, admin2, people, registry, officerTvm, outsider } = await deployFixture();

    // Pending check
    await people.connect(outsider).requestProfile(1, 3, ethers.id("doc"));
    expect(await people.roleName(outsider.address)).to.equal("Pending");
    expect(await people.activeRole(outsider.address)).to.equal(0n);
    expect(await registry.getUserRole(outsider.address)).to.equal("Pending");

    // Active officerTvm
    expect(await people.roleName(officerTvm.address)).to.equal("Investigator");
    expect(await people.activeRole(officerTvm.address)).to.equal(1n);

    // Suspend officerTvm
    await expect(
      adminDo(multisig, admin1, admin2, people, "suspendProfile", [officerTvm.address, "Misconduct"]),
    ).to.emit(people, "ProfileDecided").withArgs(officerTvm.address, 4n, "Misconduct");

    expect(await people.roleName(officerTvm.address)).to.equal("Suspended");
    expect(await people.activeRole(officerTvm.address)).to.equal(0n);
    expect(await registry.getUserRole(officerTvm.address)).to.equal("Suspended");

    // Reinstate
    await expect(
      adminDo(multisig, admin1, admin2, people, "reinstateProfile", [officerTvm.address]),
    ).to.emit(people, "ProfileDecided").withArgs(officerTvm.address, 2n, "Reinstated");

    expect(await people.roleName(officerTvm.address)).to.equal("Investigator");
    expect(await people.activeRole(officerTvm.address)).to.equal(1n);
  });

  it("R1.7 pendingProfiles list is accessible only by admins", async function () {
    const { people, admin1, outsider } = await deployFixture();
    await people.connect(outsider).requestProfile(1, 3, ethers.id("doc"));

    await expect(people.connect(outsider).pendingProfiles()).to.be.revertedWith("Admins only");

    const pending = await people.connect(admin1).pendingProfiles();
    expect(pending).to.deep.equal([outsider.address]);
  });

  it("R11.1 admin cannot request profile and cannot hold operational roles", async function () {
    const { people, admin1 } = await deployFixture();
    await expect(
      people.connect(admin1).requestProfile(1, 3, ethers.id("doc")),
    ).to.be.revertedWith("Admins cannot hold operational roles");
  });
});
