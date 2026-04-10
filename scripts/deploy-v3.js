/**
 * @title OPAL Flood Prediction - V3 Direct Deployment (non-proxy, for testing)
 * @description Quick deploy for local testing without proxy pattern
 */
import hre from "hardhat";

const { ethers } = await hre.network.connect();

const [deployer] = await ethers.getSigners();
console.log("=== OPAL V3 Direct Deploy (Testing) ===");
console.log(`Deployer: ${deployer.address}`);

// Deploy MultiOracle
console.log("Deploying MultiOracle...");
const MultiOracle = await ethers.getContractFactory("MultiOracle");
const multiOracle = await MultiOracle.deploy();
await multiOracle.waitForDeployment();
console.log(`  MultiOracle: ${await multiOracle.getAddress()}`);

// Deploy MockWASDIOracle
console.log("Deploying MockWASDIOracle...");
const MockWASDI = await ethers.getContractFactory("MockWASDIOracle");
const mockWasdi = await MockWASDI.deploy();
await mockWasdi.waitForDeployment();
console.log(`  MockWASDIOracle: ${await mockWasdi.getAddress()}`);

// Deploy JokalanteTargeting
console.log("Deploying JokalanteTargeting...");
const Targeting = await ethers.getContractFactory("JokalanteTargeting");
const targeting = await Targeting.deploy();
await targeting.waitForDeployment();
console.log(`  JokalanteTargeting: ${await targeting.getAddress()}`);

// Deploy MobileMoney
console.log("Deploying MobileMoneyProvider...");
const MobileMoney = await ethers.getContractFactory("MobileMoneyProvider");
const mobileMoney = await MobileMoney.deploy();
await mobileMoney.waitForDeployment();
console.log(`  MobileMoney: ${await mobileMoney.getAddress()}`);

console.log("\n=== V3 Deploy Complete ===");
