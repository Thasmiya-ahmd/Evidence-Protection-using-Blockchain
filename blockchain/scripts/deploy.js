import { network } from "hardhat";

const { ethers } = await network.connect();

const registry = await ethers.deployContract("EvidenceRegistry");
await registry.waitForDeployment();

console.log("Deployed to:", await registry.getAddress());