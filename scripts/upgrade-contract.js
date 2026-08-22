/**
 * @title OPAL Flood Prediction - Upgrade Contract via UUPS
 * @description Upgrade FloodPredictionContract to a new implementation.
 *
 * A66 fix: this script used to take `const [deployer] = await ethers.getSigners()` and
 * call upgradeProxy with it. That could never work: _authorizeUpgrade requires
 * UPGRADER_ROLE, and initialize() rejects a deployment where admin and upgrader share
 * an address (RolesNotDistinct) — so the deployer can never hold UPGRADER_ROLE. The
 * only documented upgrade path reverted every time, with an opaque
 * AccessControlUnauthorizedAccount.
 *
 * The signer is now resolved from UPGRADER_ADDRESS, and hasRole is checked up front so
 * a misconfiguration produces an actionable message instead of a revert.
 *
 * Usage:
 *   PROXY_ADDRESS=0x... UPGRADER_ADDRESS=0x... npx hardhat run scripts/upgrade-contract.js --network <network>
 */
import hre from "hardhat";
import { upgrades as makeUpgrades } from "@openzeppelin/hardhat-upgrades";

// A66 fix: pass the connection through, matching the deploy scripts. The bare
// makeUpgrades(hre) form does not share this script's network connection.
const connection = await hre.network.connect();
const { ethers } = connection;
const ozUpgrades = await makeUpgrades(hre, connection);

const PROXY_ADDRESS = process.env.PROXY_ADDRESS;
if (!PROXY_ADDRESS || !ethers.isAddress(PROXY_ADDRESS)) {
    console.error("❌ PROXY_ADDRESS must be set to the FloodPrediction proxy address.");
    console.error("   Usage: PROXY_ADDRESS=0x... UPGRADER_ADDRESS=0x... npx hardhat run scripts/upgrade-contract.js --network <network>");
    process.exit(1);
}

console.log("=== OPAL Contract Upgrade ===");
console.log(`Proxy: ${PROXY_ADDRESS}`);

const signers = await ethers.getSigners();
const proxy = await ethers.getContractAt("FloodPredictionContract", PROXY_ADDRESS);
const UPGRADER_ROLE = await proxy.UPGRADER_ROLE();

// Resolve the signer that actually holds UPGRADER_ROLE: the configured
// UPGRADER_ADDRESS when available, otherwise scan the configured signers.
const wanted = process.env.UPGRADER_ADDRESS;
let upgrader = null;
if (wanted) {
    if (!ethers.isAddress(wanted)) {
        console.error(`❌ UPGRADER_ADDRESS="${wanted}" is not a valid address.`);
        process.exit(1);
    }
    upgrader = signers.find((s) => s.address.toLowerCase() === wanted.toLowerCase()) ?? null;
    if (!upgrader) {
        console.error(`❌ UPGRADER_ADDRESS ${wanted} is not among this network's configured signers.`);
        console.error("   Add its private key to the network accounts, or run from a host that holds it.");
        process.exit(1);
    }
} else {
    for (const s of signers) {
        if (await proxy.hasRole(UPGRADER_ROLE, s.address)) { upgrader = s; break; }
    }
    if (!upgrader) {
        console.error("❌ No configured signer holds UPGRADER_ROLE on this proxy.");
        console.error("   Set UPGRADER_ADDRESS to the upgrader account and make its key available.");
        console.error("   Note: the deployer never holds UPGRADER_ROLE — initialize() enforces");
        console.error("   four distinct role addresses (RolesNotDistinct).");
        process.exit(1);
    }
}

if (!(await proxy.hasRole(UPGRADER_ROLE, upgrader.address))) {
    console.error(`❌ ${upgrader.address} does not hold UPGRADER_ROLE — the upgrade would revert.`);
    console.error("   Grant it first, or point UPGRADER_ADDRESS at the account that holds it.");
    process.exit(1);
}

console.log(`Upgrader: ${upgrader.address} (holds UPGRADER_ROLE ✓)`);
console.log(`Version before: ${await proxy.getVersion()}`);

const FloodPrediction = await ethers.getContractFactory("FloodPredictionContract", upgrader);
const upgraded = await ozUpgrades.upgradeProxy(PROXY_ADDRESS, FloodPrediction, { kind: "uups" });
await upgraded.waitForDeployment();

const implAddr = await ozUpgrades.erc1967.getImplementationAddress(PROXY_ADDRESS);
console.log(`Version after:  ${await upgraded.getVersion()}`);
console.log(`New implementation: ${implAddr}`);
console.log(`Proxy address (unchanged): ${await upgraded.getAddress()}`);
console.log("=== Upgrade Complete ===");
