import { expect } from "chai";
import fs from "fs";
import { ethers } from "./fixture.js";

describe("Deployment Script & System Integration Tests (Task 3)", function () {
  it("verifies 14 courts, 28 stations, 3 labs, and 6 active demo profiles", async function () {
    const [
      owner1, investigator1, analyst1, analyst2, officialTvm, officialEkm,
      owner2, owner3, investigator2,
    ] = await ethers.getSigners();

    const readJson = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));
    const courts = readJson("./data/courts.json");
    const stations = readJson("./data/stations.json");
    const labs = readJson("./data/labs.json");

    expect(courts.length).to.equal(14);
    expect(stations.length).to.equal(28);
    expect(labs.length).to.equal(3);

    // 1. Deploy AdminMultisig
    const multisig = await ethers.deployContract("AdminMultisig", [
      [owner1.address, owner2.address, owner3.address],
      2,
    ]);
    await multisig.waitForDeployment();
    const multisigAddress = await multisig.getAddress();

    // 2. Deploy PeopleRegistry & EvidenceRegistry
    const people = await ethers.deployContract("PeopleRegistry", [multisigAddress]);
    await people.waitForDeployment();
    const peopleAddress = await people.getAddress();

    const registry = await ethers.deployContract("EvidenceRegistry", [multisigAddress, peopleAddress]);
    await registry.waitForDeployment();
    const registryAddress = await registry.getAddress();

    async function adminDo(contract: any, fn: string, args: unknown[]) {
      const data = contract.interface.encodeFunctionData(fn, args);
      const target = await contract.getAddress();
      const id = await multisig.proposalCount();
      await (await multisig.connect(owner1).propose(target, data)).wait();
      await (await multisig.connect(owner2).approve(id)).wait();
      await (await multisig.connect(owner1).execute(id)).wait();
    }

    // 3. Register Units
    async function registerUnits(type: number, list: any[], chunk = 25) {
      for (let i = 0; i < list.length; i += chunk) {
        const part = list.slice(i, i + chunk);
        await adminDo(people, "registerUnits", [type, part.map((x) => x.name), part.map((x) => x.location)]);
      }
    }
    await registerUnits(3, courts);
    await registerUnits(1, stations);
    await registerUnits(2, labs);

    // Verify registered counts
    const [cIds] = await people.getUnits(3);
    expect(cIds.length).to.equal(14);

    const [sIds] = await people.getUnits(1);
    expect(sIds.length).to.equal(28);

    const [lIds] = await people.getUnits(2);
    expect(lIds.length).to.equal(3);

    // 4. Setup demo profiles
    async function firstUnitAt(type: number, location: string) {
      const [ids] = await people.getUnitsAt(type, location);
      if (ids.length === 0) throw new Error(`No unit of type ${type} at ${location}`);
      return ids[0];
    }

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
      const detailsHash = ethers.id("demo-profile-" + d.who.address);
      await (await people.connect(d.who).requestProfile(d.role, unitId, detailsHash)).wait();
      await adminDo(people, "approveProfile", [d.who.address]);
    }

    // 5. Verify the 6 demo profiles are active with expected roles
    expect(await people.roleName(investigator1.address)).to.equal("Investigator");
    expect(await people.roleName(investigator2.address)).to.equal("Investigator");
    expect(await people.roleName(analyst1.address)).to.equal("Forensic Analyst");
    expect(await people.roleName(analyst2.address)).to.equal("Forensic Analyst");
    expect(await people.roleName(officialTvm.address)).to.equal("Court Official");
    expect(await people.roleName(officialEkm.address)).to.equal("Court Official");

    expect(await people.activeRole(investigator1.address)).to.equal(1n);
    expect(await people.activeRole(investigator2.address)).to.equal(1n);
    expect(await people.activeRole(analyst1.address)).to.equal(2n);
    expect(await people.activeRole(analyst2.address)).to.equal(2n);
    expect(await people.activeRole(officialTvm.address)).to.equal(3n);
    expect(await people.activeRole(officialEkm.address)).to.equal(3n);

    // Verify official court assignment
    expect(await registry.officialCourt(officialTvm.address)).to.not.equal(0n);
    expect(await registry.officialCourt(officialEkm.address)).to.not.equal(0n);

    // Write deployments/localhost.json to verify it saves properly
    const out = {
      chainId: "31337",
      multisig: multisigAddress,
      people: peopleAddress,
      registry: registryAddress,
      accounts: {
        admin1: owner1.address,
        admin2: owner2.address,
        admin3: owner3.address,
        investigatorTvm: investigator1.address,
        investigatorEkm: investigator2.address,
        analyst1: analyst1.address,
        analyst2: analyst2.address,
        courtOfficialTvm: officialTvm.address,
        courtOfficialEkm: officialEkm.address,
      },
    };
    fs.mkdirSync("./deployments", { recursive: true });
    fs.writeFileSync("./deployments/localhost.json", JSON.stringify(out, null, 2));

    expect(fs.existsSync("./deployments/localhost.json")).to.be.true;
  });
});
