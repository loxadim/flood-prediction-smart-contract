/**
 * @title OPAL Flood Prediction — Interact with Amoy Deployment
 * @description Read state and execute a test flood trigger on the deployed contracts
 * 
 * Usage:
 *   npx hardhat run scripts/interact-amoy.js --network amoy
 */
import hre from "hardhat";
import fs from "fs";
import path from "path";
import { MerkleTree } from "merkletreejs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const keccak256 = require("keccak256");

const { ethers } = await hre.network.connect();

// ========================================
// Load deployment manifest
// ========================================
const manifestDir = path.join(import.meta.dirname, "..");
const files = fs.readdirSync(manifestDir).filter(f => f.startsWith("deployment-amoy-") && f.endsWith(".json"));
if (files.length === 0) {
    console.error("❌ No deployment manifest found. Run deploy:amoy first.");
    process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(path.join(manifestDir, files[files.length - 1]), "utf8"));
const addrs = manifest.contracts;

console.log("╔══════════════════════════════════════════════════════════╗");
console.log("║  OPAL Platform — Amoy Testnet Interaction              ║");
console.log("╚══════════════════════════════════════════════════════════╝\n");

const [signer] = await ethers.getSigners();
const balance = await ethers.provider.getBalance(signer.address);
console.log(`  Signer:  ${signer.address}`);
console.log(`  Balance: ${ethers.formatEther(balance)} MATIC\n`);

// ========================================
// Connect to deployed contracts
// ========================================
console.log("── Connecting to deployed contracts ──\n");

const floodPrediction = await ethers.getContractAt("FloodPredictionContract", addrs.FloodPredictionProxy);
const multiOracle = await ethers.getContractAt("MultiOracle", addrs.MultiOracle);
const jokalante = await ethers.getContractAt("JokalanteTargeting", addrs.JokalanteTargeting);
const governance = await ethers.getContractAt("OpalGovernanceUpgradeable", addrs.OpalGovernanceProxy);

console.log(`  FloodPrediction: ${addrs.FloodPredictionProxy}`);
console.log(`  MultiOracle:     ${addrs.MultiOracle}`);
console.log(`  JokalanteTarget: ${addrs.JokalanteTargeting}`);
console.log(`  Governance:      ${addrs.OpalGovernanceProxy}`);

// ========================================
// 1. Read System Stats
// ========================================
console.log("\n── 1. System Stats ──\n");

try {
    const stats = await floodPrediction.getSystemStats();
    console.log(`  Total Triggers:    ${stats[0]}`);
    console.log(`  Total Payments:    ${stats[1]}`);
    console.log(`  Total Disbursed:   ${stats[2]} FCFA`);
    console.log(`  Total Budget:      ${stats[3]} FCFA`);
    console.log(`  Active Regions:    ${stats[4]}`);
    console.log(`  Contract Version:  V${stats[5]}`);
} catch (e) {
    console.log(`  ⚠️  getSystemStats failed: ${e.message}`);
}

// ========================================
// 2. Check Regional Budgets
// ========================================
console.log("\n── 2. Regional Budgets ──\n");

const regions = ["SN-TH", "SN-DK", "SN-SL", "SN-ZG", "SN-KL", "SN-TC"];
for (const region of regions) {
    try {
        const budget = await floodPrediction.regionBudgets(region);
        console.log(`  ${region}: ${ethers.formatEther(budget)} FCFA`);
    } catch (e) {
        console.log(`  ${region}: ⚠️ ${e.message}`);
    }
}

// ========================================
// 3. Check Risk Threshold
// ========================================
console.log("\n── 3. Configuration ──\n");

try {
    const threshold = await floodPrediction.riskThreshold();
    console.log(`  Risk Threshold: ${threshold}`);
} catch (e) {
    console.log(`  ⚠️  ${e.message}`);
}

try {
    const paused = await floodPrediction.paused();
    console.log(`  Contract Paused: ${paused}`);
} catch (e) {
    console.log(`  ⚠️  ${e.message}`);
}

// ========================================
// 4. Check Oracle Status
// ========================================
console.log("\n── 4. Oracle Status ──\n");

try {
    const oracleCount = await multiOracle.getActiveOracleCount();
    console.log(`  Active Oracles: ${oracleCount}`);
} catch (e) {
    console.log(`  ⚠️  ${e.message}`);
}

// ========================================
// 5. Create a Test Flood Trigger
// ========================================
console.log("\n── 5. Creating Test Flood Trigger ──\n");

try {
    // Create 2 test beneficiaries
    const benef1Hash = ethers.keccak256(ethers.toUtf8Bytes("beneficiary-test-001"));
    const benef2Hash = ethers.keccak256(ethers.toUtf8Bytes("beneficiary-test-002"));
    const amount1 = 25000;
    const amount2 = 25000;

    // Build Merkle tree (double-hash leaves per OpenZeppelin standard)
    const leaf1 = ethers.keccak256(ethers.solidityPacked(
        ["bytes32"],
        [ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [benef1Hash, amount1]))]
    ));
    const leaf2 = ethers.keccak256(ethers.solidityPacked(
        ["bytes32"],
        [ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [benef2Hash, amount2]))]
    ));

    const tree = new MerkleTree([leaf1, leaf2], keccak256, { sortPairs: true });
    const merkleRoot = tree.getHexRoot();
    console.log(`  Merkle Root: ${merkleRoot}`);
    console.log(`  Beneficiary 1: ${benef1Hash}`);
    console.log(`  Beneficiary 2: ${benef2Hash}`);

    // Create flood trigger for Thiès region
    console.log("\n  Submitting flood trigger for SN-TH (riskScore=85)...");
    const tx = await floodPrediction.createFloodTrigger(
        "SN-TH",       // region
        85,             // riskScore (CRITICAL)
        merkleRoot,     // merkleRoot
        50000,          // totalAmount (50K FCFA)
        2               // beneficiaryCount
    );
    console.log(`  Tx hash: ${tx.hash}`);
    
    const receipt = await tx.wait();
    console.log(`  ✅ Trigger created! Gas used: ${receipt.gasUsed}`);

    // Try to find the event
    for (const log of receipt.logs) {
        try {
            const parsed = floodPrediction.interface.parseLog({ topics: log.topics, data: log.data });
            if (parsed && parsed.name === "FloodTriggerCreated") {
                console.log(`  Event ID: ${parsed.args[0]}`);
                console.log(`  Region:   ${parsed.args[1]}`);
                console.log(`  Risk:     ${parsed.args[2]}`);
            }
        } catch {}
    }

} catch (e) {
    console.log(`  ⚠️  Trigger creation failed: ${e.message}`);
}

// ========================================
// 6. Final Stats
// ========================================
console.log("\n── 6. Updated Stats ──\n");

try {
    const stats = await floodPrediction.getSystemStats();
    console.log(`  Total Triggers:  ${stats[0]}`);
    console.log(`  Total Payments:  ${stats[1]}`);
    console.log(`  Total Disbursed: ${stats[2]} FCFA`);
} catch (e) {
    console.log(`  ⚠️  ${e.message}`);
}

console.log("\n╔══════════════════════════════════════════════════════════╗");
console.log("║  Interaction Complete                                    ║");
console.log("╚══════════════════════════════════════════════════════════╝");
console.log(`\n  Explorer: https://amoy.polygonscan.com/address/${addrs.FloodPredictionProxy}\n`);
