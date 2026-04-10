/**
 * @title OPAL Flood Prediction - Upgrade Contract via UUPS
 * @description Upgrade FloodPredictionContractV3 to a new version
 */
import hre from "hardhat";
import { upgrades as makeUpgrades } from "@openzeppelin/hardhat-upgrades";

const { ethers } = await hre.network.connect();
const ozUpgrades = await makeUpgrades(hre);

const [deployer] = await ethers.getSigners();
console.log("=== OPAL Contract Upgrade ===");
console.log(`Upgrader: ${deployer.address}`);

// Address of the existing proxy (update this after deployment)
const PROXY_ADDRESS = process.env.PROXY_ADDRESS || "0x...";

if (PROXY_ADDRESS === "0x...") {
    console.error("Please set PROXY_ADDRESS environment variable");
    console.error("Usage: PROXY_ADDRESS=0x... npx hardhat run scripts/upgrade-contract.js --network <network>");
    process.exit(1);
}

console.log(`Upgrading proxy at: ${PROXY_ADDRESS}`);

// Deploy new implementation
const FloodPredictionV3 = await ethers.getContractFactory("FloodPredictionContract");
const upgraded = await ozUpgrades.upgradeProxy(PROXY_ADDRESS, FloodPredictionV3, {
    kind: "uups"
});

await upgraded.waitForDeployment();
const version = await upgraded.getVersion();
console.log(`Upgraded to version: ${version}`);
console.log(`Proxy address (unchanged): ${await upgraded.getAddress()}`);
console.log("=== Upgrade Complete ===");
