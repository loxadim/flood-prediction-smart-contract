/**
 * @title OPAL Flood Prediction - UUPS Proxy Deployment
 * @description Deploy all contracts via UUPS proxy pattern
 * @network Hardhat local / Polygon Amoy / Polygon Mainnet
 */
import hre from "hardhat";
import fs from "fs";
import { upgrades as makeUpgrades } from "@openzeppelin/hardhat-upgrades";

const connection = await hre.network.connect();
const { ethers } = connection;
const ozUpgrades = await makeUpgrades(hre, connection);

const [deployer] = await ethers.getSigners();
console.log("=== OPAL Flood Prediction - Upgradeable Deployment ===");
console.log(`Deployer: ${deployer.address}`);
console.log(`Balance: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);
console.log(`Network: ${(await ethers.provider.getNetwork()).name} (chainId: ${(await ethers.provider.getNetwork()).chainId})`);
console.log("");

// 1. Deploy MultiOracle
console.log("1/5 Deploying MultiOracle...");
const MultiOracle = await ethers.getContractFactory("MultiOracle");
const multiOracle = await MultiOracle.deploy();
await multiOracle.waitForDeployment();
const multiOracleAddr = await multiOracle.getAddress();
console.log(`   MultiOracle: ${multiOracleAddr}`);

// 2. Deploy OpalGovernance (UUPS Proxy)
console.log("2/5 Deploying OpalGovernance (UUPS Proxy)...");
const OpalGovernance = await ethers.getContractFactory("OpalGovernanceUpgradeable");
const governance = await ozUpgrades.deployProxy(
    OpalGovernance,
    [deployer.address, 2], // initialOwner, initialQuorum=2
    { kind: "uups", timeout: 60000, pollingInterval: 500 }
);
await governance.waitForDeployment();
const governanceAddr = await governance.getAddress();
console.log(`   OpalGovernance: ${governanceAddr}`);

// 3. Deploy JokalanteTargeting
console.log("3/5 Deploying JokalanteTargeting...");
const JokalanteTargeting = await ethers.getContractFactory("JokalanteTargeting");
const targeting = await JokalanteTargeting.deploy();
await targeting.waitForDeployment();
const targetingAddr = await targeting.getAddress();
console.log(`   JokalanteTargeting: ${targetingAddr}`);

// 4. Deploy MobileMoneyProvider
console.log("4/5 Deploying MobileMoneyProvider...");
const MobileMoney = await ethers.getContractFactory("MobileMoneyProvider");
const mobileMoney = await MobileMoney.deploy();
await mobileMoney.waitForDeployment();
const mobileMoneyAddr = await mobileMoney.getAddress();
console.log(`   MobileMoney: ${mobileMoneyAddr}`);

// 5. Deploy FloodPredictionContractV3 (UUPS Proxy)
console.log("5/5 Deploying FloodPredictionContractV3 (UUPS Proxy)...");
const FloodPrediction = await ethers.getContractFactory("FloodPredictionContract");
const floodPrediction = await ozUpgrades.deployProxy(
    FloodPrediction,
    [deployer.address],
    { kind: "uups", timeout: 60000, pollingInterval: 500 }
);
await floodPrediction.waitForDeployment();
const floodPredictionAddr = await floodPrediction.getAddress();
console.log(`   FloodPrediction: ${floodPredictionAddr}`);

// 6. Wire contracts together
console.log("\nWiring contracts together...");
const tx = await floodPrediction.setContractAddresses(
    multiOracleAddr,
    governanceAddr,
    targetingAddr,
    mobileMoneyAddr,
    ethers.ZeroAddress // KYC placeholder
);
await tx.wait();
console.log("   Contract addresses set on FloodPrediction ✓");

// Summary
console.log("\n=== Deployment Summary ===");
const addresses = {
    MultiOracle: multiOracleAddr,
    OpalGovernance: governanceAddr,
    JokalanteTargeting: targetingAddr,
    MobileMoneyProvider: mobileMoneyAddr,
    FloodPredictionContractV3: floodPredictionAddr
};

for (const [name, addr] of Object.entries(addresses)) {
    console.log(`  ${name}: ${addr}`);
}

// Save deployment info
const deploymentInfo = {
    network: (await ethers.provider.getNetwork()).name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    timestamp: Date.now(),
    contracts: addresses
};
const filename = `deployment-hardhat-${Date.now()}.json`;
fs.writeFileSync(filename, JSON.stringify(deploymentInfo, null, 2));
console.log(`\nDeployment saved to ${filename}`);
