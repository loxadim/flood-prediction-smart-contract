/**
 * @title OPAL Flood Prediction - Interactive Test Script
 * @description Run through end-to-end flow: deploy → configure → trigger → pay
 */
import hre from "hardhat";
import { upgrades as makeUpgrades } from "@openzeppelin/hardhat-upgrades";
import { MerkleTree } from "merkletreejs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const keccak256 = require("keccak256");

const connection = await hre.network.connect();
const { ethers } = connection;
const ozUpgrades = await makeUpgrades(hre, connection);

const [admin, operator, upgrader, pauser, beneficiary1, beneficiary2] = await ethers.getSigners();
console.log("=== OPAL Interactive E2E Test ===\n");

// 1. Deploy all contracts
console.log("--- Step 1: Deploying Contracts ---");

const MultiOracle = await ethers.getContractFactory("MultiOracle");
const multiOracle = await MultiOracle.deploy();
await multiOracle.waitForDeployment();
console.log(`  MultiOracle: ${await multiOracle.getAddress()}`);

const OpalGovernance = await ethers.getContractFactory("OpalGovernanceUpgradeable");
const governance = await ozUpgrades.deployProxy(
    OpalGovernance,
    [admin.address, 2],
    { kind: "uups" }
);
await governance.waitForDeployment();
console.log(`  Governance: ${await governance.getAddress()}`);

const JokalanteTargeting = await ethers.getContractFactory("JokalanteTargeting");
const targeting = await JokalanteTargeting.deploy();
await targeting.waitForDeployment();
console.log(`  Targeting: ${await targeting.getAddress()}`);

const MobileMoney = await ethers.getContractFactory("MobileMoneyProvider");
const mobileMoney = await MobileMoney.deploy();
await mobileMoney.waitForDeployment();
console.log(`  MobileMoney: ${await mobileMoney.getAddress()}`);

const FloodPrediction = await ethers.getContractFactory("FloodPredictionContract");
const floodPrediction = await ozUpgrades.deployProxy(
    FloodPrediction,
    [admin.address, operator.address, upgrader.address, pauser.address],
    { kind: "uups" }
);
await floodPrediction.waitForDeployment();
console.log(`  FloodPrediction: ${await floodPrediction.getAddress()}`);

// 2. Configure
console.log("\n--- Step 2: Configuration ---");
await floodPrediction.setContractAddresses(
    await multiOracle.getAddress(),
    await governance.getAddress(),
    await targeting.getAddress(),
    await mobileMoney.getAddress(),
    ethers.ZeroAddress
);
console.log("  Contract addresses wired ✓");

// Allocate budget for Thiès
await floodPrediction.allocateBudget("SN-TH", 50_000_000); // 50M FCFA
console.log("  Budget allocated: 50M FCFA for SN-TH ✓");

// 3. Create Merkle tree for beneficiaries
console.log("\n--- Step 3: Merkle Tree Setup ---");
const beneficiaries = [
    { hash: ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address"], [beneficiary1.address])), amount: 25000 },
    { hash: ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address"], [beneficiary2.address])), amount: 25000 }
];

// A31 fix: leaves must use the OpenZeppelin double-hash format the contracts verify against:
// keccak256(bytes.concat(keccak256(abi.encode(beneficiaryHash, amount)))). A single hash
// produces a root that fails on-chain MerkleProof.verify (matches scripts/interact-amoy.js).
const leaves = beneficiaries.map(b =>
    ethers.keccak256(
        ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [b.hash, b.amount]))
    )
);
const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
const merkleRoot = tree.getHexRoot();
console.log(`  Merkle Root: ${merkleRoot}`);

// 4. Create flood trigger
console.log("\n--- Step 4: Flood Trigger ---");
// eventId is an indexed string in FloodTriggerCreated, so ethers can only
// decode it as a hash from the log; read the real value via a static call.
const eventId = await floodPrediction.connect(operator).createFloodTrigger.staticCall(
    "SN-TH",    // region
    85,          // riskScore (CRITICAL)
    merkleRoot,  // merkleRoot
    50000,       // totalAmount (50K FCFA)
    2            // beneficiaryCount
);
const tx = await floodPrediction.connect(operator).createFloodTrigger(
    "SN-TH",    // region
    85,          // riskScore (CRITICAL)
    merkleRoot,  // merkleRoot
    50000,       // totalAmount (50K FCFA)
    2            // beneficiaryCount
);
const receipt = await tx.wait();
const event = receipt.logs.find(l => l.fragment?.name === "FloodTriggerCreated");
if (event) {
    console.log(`  Trigger created: eventId=${eventId}`);
    console.log(`  Risk score: ${event.args[2]}, Region: ${event.args[1]}`);
}

// 5. Get stats
console.log("\n--- Step 5: System Stats ---");
const stats = await floodPrediction.getSystemStats();
console.log(`  Triggers: ${stats[0]}`);
console.log(`  Total Budget: ${stats[3]} FCFA`);
console.log(`  Version: V${stats[5]}`);

console.log("\n=== Interactive Test Complete ===");
