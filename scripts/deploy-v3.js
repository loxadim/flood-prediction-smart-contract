/**
 * @title OPAL Flood Prediction - V3 Direct Deployment (non-proxy, for testing)
 * @description Quick deploy for local testing without proxy pattern
 */
import hre from "hardhat";

const connection = await hre.network.connect();
const { ethers } = connection;

// A64 fix: this script deploys MockWASDIOracle, whose simulate* functions let an
// authorized submitter set any region's risk score outright. Its header said "for
// testing" but nothing stopped it running against Amoy or mainnet. Local chain IDs
// only: 1337 (hardhat EDR) and 31337 (hardhat node).
const LOCAL_CHAIN_IDS = [1337n, 31337n];
const { chainId } = await ethers.provider.getNetwork();
if (!LOCAL_CHAIN_IDS.includes(chainId)) {
    console.error(`❌ Refusing to run: chainId ${chainId} is not a local network.`);
    console.error("   deploy-v3.js deploys MockWASDIOracle and is for local testing only.");
    console.error("   Use scripts/deploy-upgradeable.js or scripts/deploy-amoy.js instead.");
    process.exit(1);
}

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
