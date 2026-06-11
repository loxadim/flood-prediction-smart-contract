/**
 * stress-test-1000.js - Local stress test for trigger, payment, budget, and view flows.
 *
 * Usage:
 *   npx hardhat run scripts/stress-test-1000.js
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
const abi = ethers.AbiCoder.defaultAbiCoder();

const PAYMENT_REGION = "SN-PAY";
const BENEFICIARY_COUNT = 1000;
const PAYMENT_AMOUNT = 5000n;
const BATCH_SIZE = 50;

function buildLeaf(beneficiaryHash, amount) {
    const inner = ethers.keccak256(abi.encode(["bytes32", "uint256"], [beneficiaryHash, amount]));
    return ethers.keccak256(inner);
}

console.log("\n=== OPAL Platform - Stress Test (1000 beneficiaries) ===\n");

const [admin, operator] = await ethers.getSigners();

console.log("[1/6] Deploying contracts...");
const MultiOracle = await ethers.getContractFactory("MultiOracle");
const multiOracle = await MultiOracle.deploy();
await multiOracle.waitForDeployment();

const Jokalante = await ethers.getContractFactory("JokalanteTargeting");
const jokalante = await Jokalante.deploy();
await jokalante.waitForDeployment();

const MobileMoney = await ethers.getContractFactory("MobileMoneyProvider");
const mobileMoney = await MobileMoney.deploy();
await mobileMoney.waitForDeployment();

const OpalGov = await ethers.getContractFactory("OpalGovernanceUpgradeable");
const opalGov = await ozUpgrades.deployProxy(OpalGov, [admin.address, 2], { kind: "uups" });
await opalGov.waitForDeployment();

const FloodPred = await ethers.getContractFactory("FloodPredictionContract");
const flood = await ozUpgrades.deployProxy(FloodPred, [
    admin.address,
    operator.address,
    operator.address,
    operator.address,
], { kind: "uups" });
await flood.waitForDeployment();

await (await flood.setContractAddresses(
    await multiOracle.getAddress(),
    await opalGov.getAddress(),
    await jokalante.getAddress(),
    await mobileMoney.getAddress(),
    ethers.ZeroAddress
)).wait();
await (await mobileMoney.addRelayer(await flood.getAddress())).wait();
await (await jokalante.addAuthorizedCaller(await flood.getAddress())).wait();
console.log("  Contracts deployed and wired\n");

console.log("[2/6] Configuring roles, budgets, and Merkle root...");
const regions = ["SN-TH", "SN-DK", "SN-SL", "SN-ZG", "SN-KL"];
for (const region of [...regions, PAYMENT_REGION]) {
    await (await flood.allocateBudget(region, 50_000_000n)).wait();
}

const beneficiaries = [];
const leaves = [];
for (let i = 0; i < BENEFICIARY_COUNT; i++) {
    const beneficiaryHash = ethers.keccak256(abi.encode(["string", "string"], [`user_${i}`, PAYMENT_REGION]));
    beneficiaries.push({
        hash: beneficiaryHash,
        amount: PAYMENT_AMOUNT,
        phoneHash: ethers.keccak256(ethers.toUtf8Bytes(`+2217700${String(i).padStart(5, "0")}`)),
        provider: 0,
    });
    leaves.push(buildLeaf(beneficiaryHash, PAYMENT_AMOUNT));
}
const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
const merkleRoot = tree.getHexRoot();

await (await jokalante.updateMerkleRoot(PAYMENT_REGION, merkleRoot, BENEFICIARY_COUNT)).wait();
console.log("  Budgets and targeting configured\n");

console.log("[3/6] Stress Test: 200 flood trigger attempts across 5 regions...");
let triggerCount = 0;
const triggerStart = Date.now();
for (let i = 0; i < 200; i++) {
    const region = regions[i % regions.length];
    const risk = 70 + (i % 31);
    try {
        await (await flood.connect(operator).createFloodTrigger(
            region,
            Math.min(risk, 100),
            merkleRoot,
            100_000n + BigInt(i),
            1
        )).wait();
        triggerCount++;
    } catch {
        // Cooldown prevents repeated triggers in the same region during this loop.
    }
}
const triggerDuration = (Date.now() - triggerStart) / 1000;
console.log(`  Created ${triggerCount} triggers in ${triggerDuration.toFixed(1)}s`);
console.log(`  Throughput: ${(triggerCount / triggerDuration).toFixed(1)} triggers/sec\n`);

console.log("[4/6] Stress Test: 1000 valid batch payments (20 x 50)...");
const totalPaymentAmount = BigInt(BENEFICIARY_COUNT) * PAYMENT_AMOUNT;
const triggerTx = await flood.connect(operator).createFloodTrigger(
    PAYMENT_REGION,
    90,
    merkleRoot,
    totalPaymentAmount,
    BENEFICIARY_COUNT
);
const triggerReceipt = await triggerTx.wait();
const createdEvent = triggerReceipt.logs
    .map((log) => {
        try { return flood.interface.parseLog(log); } catch { return null; }
    })
    .find((event) => event?.name === "FloodTriggerCreated");
const eventId = createdEvent.args.eventId;
await (await flood.connect(operator).validateTrigger(eventId)).wait();

let paymentCount = 0;
const paymentStart = Date.now();
for (let batch = 0; batch < BENEFICIARY_COUNT / BATCH_SIZE; batch++) {
    const start = batch * BATCH_SIZE;
    const batchBeneficiaries = beneficiaries.slice(start, start + BATCH_SIZE);
    const batchHashes = batchBeneficiaries.map((b) => b.hash);
    const batchAmounts = batchBeneficiaries.map((b) => b.amount);
    const batchProofs = batchBeneficiaries.map((b) => tree.getHexProof(buildLeaf(b.hash, b.amount)));
    const batchPhones = batchBeneficiaries.map((b) => b.phoneHash);
    const batchProviders = batchBeneficiaries.map((b) => b.provider);

    await (await flood.connect(operator).processBatchPayment(
        eventId,
        batchHashes,
        batchAmounts,
        batchProofs,
        batchPhones,
        batchProviders
    )).wait();
    paymentCount += batchBeneficiaries.length;
}
const paymentDuration = (Date.now() - paymentStart) / 1000;
console.log(`  Processed ${paymentCount} payments in ${paymentDuration.toFixed(1)}s`);
console.log(`  Throughput: ${(paymentCount / paymentDuration).toFixed(1)} payments/sec\n`);

console.log("[5/6] Stress Test: 500 budget operations...");
const budgetStart = Date.now();
for (let i = 0; i < 500; i++) {
    const region = regions[i % regions.length];
    await (await flood.allocateBudget(region, 10_000n)).wait();
}
const budgetDuration = (Date.now() - budgetStart) / 1000;
console.log(`  500 budget allocations in ${budgetDuration.toFixed(1)}s`);
console.log(`  Throughput: ${(500 / budgetDuration).toFixed(1)} ops/sec\n`);

console.log("[6/6] Stress Test: 300 view function calls...");
const viewStart = Date.now();
for (let i = 0; i < 100; i++) {
    await flood.getSystemStats();
    await flood.getRegionBudgetRemaining(regions[i % regions.length]);
    await flood.getCooldownRemaining(regions[i % regions.length], 80);
}
const viewDuration = (Date.now() - viewStart) / 1000;
console.log(`  300 view calls in ${viewDuration.toFixed(1)}s`);
console.log(`  Throughput: ${(300 / viewDuration).toFixed(1)} calls/sec\n`);

const totalOps = triggerCount + paymentCount + 500 + 300;
const totalDuration = (Date.now() - triggerStart) / 1000;
console.log("=== Stress Test Summary ===");
console.log(`Triggers: ${triggerCount}`);
console.log(`Payments: ${paymentCount}`);
console.log("Budgets: 500");
console.log("Views: 300");
console.log(`Total: ${totalOps}`);
console.log(`Duration: ${totalDuration.toFixed(1)}s`);
console.log(`Average: ${(totalOps / totalDuration).toFixed(1)} ops/sec`);
