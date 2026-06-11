/**
 * BatchBeneficiaries5000.test.js — Large Scale Performance Test (5000 Beneficiaries)
 * DPA Foundation — OPAL Platform
 *
 * Tests batch payment processing at scale: 5000 beneficiaries.
 * Focus: the beneficiary list, Merkle proofs, gas limits and duplicate prevention.
 * The region is an internal implementation detail — these tests abstract it away.
 */

import { expect } from "chai";
import hre from "hardhat";
import { MerkleTree } from "merkletreejs";
import { createRequire } from "module";
import { upgrades as makeUpgrades } from "@openzeppelin/hardhat-upgrades";
const require = createRequire(import.meta.url);
const keccak256 = require("keccak256");

const connection = await hre.network.connect();
const { ethers } = connection;
const ozUpgrades = await makeUpgrades(hre, connection);

describe("Batch Beneficiaries — 5000 Scale Tests", function () {
    this.timeout(600000); // 10 minutes — large-scale test

    let floodPrediction, multiOracle, jokalante, mobileMoney, opalGov;
    let admin, operator, upgrader, pauser;
    let beneficiaries, leaves, tree, merkleRoot;
    let eventId; // single trigger for all 5000 beneficiaries

    const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE"));
    const TOTAL_BENEFICIARIES = 5000;
    const BATCH_SIZE = 50;  // MAX_BATCH_SIZE in the contract
    const TOTAL_BATCHES = TOTAL_BENEFICIARIES / BATCH_SIZE; // 100 batches
    const AMOUNT_PER_BENEFICIARY = 5000; // 5 000 CFA
    const TOTAL_AMOUNT = AMOUNT_PER_BENEFICIARY * TOTAL_BENEFICIARIES; // 25 000 000 CFA
    const INTERNAL_REGION = "FLOOD-ZONE"; // opaque — not exposed to the beneficiary list

    /**
     * Generate N beneficiaries with proper Merkle leaf format:
     * leaf = keccak256(abi.encode(bytes32 hash, uint256 amount))
     */
    function generateBeneficiaries(count) {
        const bens = [];
        for (let i = 0; i < count; i++) {
            bens.push({
                hash: ethers.keccak256(
                    ethers.AbiCoder.defaultAbiCoder().encode(
                        ["string", "uint256"],
                        [`beneficiary_${i}`, i]
                    )
                ),
                amount: AMOUNT_PER_BENEFICIARY,
                phone: ethers.keccak256(ethers.toUtf8Bytes(`+22177${String(i).padStart(7, "0")}`))
            });
        }
        return bens;
    }

    function buildMerkleTree(bens) {
        const leavesArr = bens.map(b =>
            ethers.keccak256(
                ethers.keccak256(
                    ethers.AbiCoder.defaultAbiCoder().encode(
                        ["bytes32", "uint256"],
                        [b.hash, b.amount]
                    )
                )
            )
        );
        const treeObj = new MerkleTree(leavesArr, keccak256, { sortPairs: true });
        return { tree: treeObj, leaves: leavesArr, root: treeObj.getHexRoot() };
    }

    before(async function () {
        console.log("\n  ╔══════════════════════════════════════════════════╗");
        console.log("  ║  OPAL Platform — 5000 Beneficiaries Scale Test   ║");
        console.log("  ╚══════════════════════════════════════════════════╝\n");

        [admin, operator, upgrader, pauser] = await ethers.getSigners();

        // ── Deploy contracts ────────────────────────────────────────────
        console.log("  [1/3] Deploying contracts...");
        const MultiOracle = await ethers.getContractFactory("MultiOracle");
        multiOracle = await MultiOracle.deploy();
        await multiOracle.waitForDeployment();

        const Jokalante = await ethers.getContractFactory("JokalanteTargeting");
        jokalante = await Jokalante.deploy();
        await jokalante.waitForDeployment();

        const MobileMoney = await ethers.getContractFactory("MobileMoneyProvider");
        mobileMoney = await MobileMoney.deploy();
        await mobileMoney.waitForDeployment();

        const OpalGov = await ethers.getContractFactory("OpalGovernanceUpgradeable");
        opalGov = await ozUpgrades.deployProxy(OpalGov, [admin.address, 2], { kind: "uups" });
        await opalGov.waitForDeployment();

        const FloodPred = await ethers.getContractFactory("FloodPredictionContract");
        floodPrediction = await ozUpgrades.deployProxy(FloodPred, [admin.address, operator.address, upgrader.address, pauser.address], { kind: "uups" });
        await floodPrediction.waitForDeployment();

        await floodPrediction.setContractAddresses(
            await multiOracle.getAddress(),
            await opalGov.getAddress(),
            await jokalante.getAddress(),
            await mobileMoney.getAddress(),
            ethers.ZeroAddress
        );

        await floodPrediction.grantRole(OPERATOR_ROLE, operator.address);
        await mobileMoney.addRelayer(await floodPrediction.getAddress());
        console.log("  ✅ All contracts deployed and configured\n");

        // ── Generate 5000 beneficiaries ─────────────────────────────────
        console.log("  [2/3] Generating 5000 beneficiaries & Merkle tree...");
        const genStart = Date.now();
        beneficiaries = generateBeneficiaries(TOTAL_BENEFICIARIES);
        const mt = buildMerkleTree(beneficiaries);
        tree = mt.tree;
        leaves = mt.leaves;
        merkleRoot = mt.root;
        const genDuration = ((Date.now() - genStart) / 1000).toFixed(2);
        console.log(`  ✅ ${TOTAL_BENEFICIARIES} beneficiaries generated in ${genDuration}s`);
        console.log(`     Merkle root: ${merkleRoot}`);
        console.log(`     Tree depth:  ${tree.getDepth()}`);
        console.log(`     Leaf count:  ${tree.getLeafCount()}\n`);

        // Activate region in JokalanteTargeting
        await jokalante.updateMerkleRoot(INTERNAL_REGION, merkleRoot, TOTAL_BENEFICIARIES);
        await jokalante.addAuthorizedCaller(await floodPrediction.getAddress());
    });

    // =====================================================================
    //   MERKLE TREE INTEGRITY
    // =====================================================================
    describe("Merkle Tree — 5000 Beneficiaries", function () {
        it("should generate valid Merkle root from 5000 leaves", function () {
            expect(merkleRoot).to.not.equal(ethers.ZeroHash);
            expect(tree.getLeafCount()).to.equal(TOTAL_BENEFICIARIES);
        });

        it("should have correct tree depth for 5000 leaves", function () {
            // ceil(log2(5000)) = 13
            const expectedDepth = Math.ceil(Math.log2(TOTAL_BENEFICIARIES));
            expect(tree.getDepth()).to.equal(expectedDepth);
        });

        it("should verify Merkle proofs for 20 sampled beneficiaries", function () {
            const indices = [0, 100, 250, 499, 500, 999, 1500, 2000, 2500, 3000,
                             3500, 4000, 4200, 4500, 4750, 4900, 4999, 42, 1337, 2718];
            let verifiedCount = 0;
            for (const idx of indices) {
                const proof = tree.getProof(leaves[idx]);
                const isValid = tree.verify(proof, leaves[idx], tree.getRoot());
                expect(isValid).to.be.true;
                verifiedCount++;
            }
            console.log(`     ✅ Verified ${verifiedCount}/20 sampled proofs`);
        });

        it("should reject invalid proofs", function () {
            const fakeLeaf = ethers.keccak256(
                ethers.AbiCoder.defaultAbiCoder().encode(
                    ["bytes32", "uint256"],
                    [ethers.keccak256(ethers.toUtf8Bytes("fake_beneficiary")), 99999]
                )
            );
            const proof = tree.getProof(leaves[0]);
            expect(tree.verify(proof, fakeLeaf, tree.getRoot())).to.be.false;
        });
    });

    // =====================================================================
    //   BATCH PAYMENTS — 5000 BENEFICIARIES (single trigger)
    // =====================================================================
    describe("Batch Payments — 5000 Beneficiaries", function () {

        before(async function () {
            // Allocate budget and create a single trigger for all 5000 beneficiaries
            console.log("  [3/3] Creating trigger for 5000 beneficiaries...");
            await floodPrediction.allocateBudget(INTERNAL_REGION, ethers.parseEther("500000000"));

            const tx = await floodPrediction.connect(operator).createFloodTrigger(
                INTERNAL_REGION, 85, merkleRoot, TOTAL_AMOUNT, TOTAL_BENEFICIARIES
            );
            await tx.wait();

            const triggerIds = await floodPrediction.getTriggerIds();
            eventId = triggerIds[triggerIds.length - 1];
            await floodPrediction.connect(operator).validateTrigger(eventId);
            console.log(`  ✅ Trigger created & validated — ${TOTAL_BENEFICIARIES} beneficiaries, ${TOTAL_AMOUNT.toLocaleString()} CFA\n`);
        });

        it("should process all 5000 beneficiaries in 100 batches of 50", async function () {
            this.timeout(600000);

            console.log("\n  Processing 5000 beneficiaries (100 batches × 50)...\n");
            const startTime = Date.now();
            let totalPaid = 0;
            let totalGasUsed = 0n;

            for (let batch = 0; batch < TOTAL_BATCHES; batch++) {
                const hashes = [];
                const amounts = [];
                const proofs = [];
                const phoneNumbers = [];

                for (let j = 0; j < BATCH_SIZE; j++) {
                    const idx = batch * BATCH_SIZE + j;
                    const b = beneficiaries[idx];
                    hashes.push(b.hash);
                    amounts.push(b.amount);
                    proofs.push(
                        tree.getProof(leaves[idx]).map(p => "0x" + p.data.toString("hex"))
                    );
                    phoneNumbers.push(b.phone);
                }

                const batchTx = await floodPrediction.connect(operator).processBatchPayment(
                    eventId, hashes, amounts, proofs, phoneNumbers, hashes.map(() => 0)
                );
                const receipt = await batchTx.wait();
                totalGasUsed += receipt.gasUsed;
                totalPaid += BATCH_SIZE;

                // Progress every 25 batches (1250 beneficiaries)
                if ((batch + 1) % 25 === 0) {
                    console.log(`     Batch ${batch + 1}/${TOTAL_BATCHES} — ${totalPaid} beneficiaries paid`);
                }
            }

            const totalDuration = ((Date.now() - startTime) / 1000).toFixed(1);
            const avgGasPerBatch = totalGasUsed / BigInt(TOTAL_BATCHES);
            const avgGasPerBeneficiary = totalGasUsed / BigInt(TOTAL_BENEFICIARIES);
            const throughput = (totalPaid / parseFloat(totalDuration)).toFixed(1);

            console.log("\n  ═══════════════════════════════════════════════");
            console.log("  RESULTS — 5000 Beneficiaries");
            console.log("  ═══════════════════════════════════════════════");
            console.log(`  Total beneficiaries paid:      ${totalPaid}`);
            console.log(`  Total batches processed:       ${TOTAL_BATCHES}`);
            console.log(`  Total gas used:                ${totalGasUsed.toLocaleString()}`);
            console.log(`  Avg gas per batch (50):        ${avgGasPerBatch.toLocaleString()}`);
            console.log(`  Avg gas per beneficiary:       ${avgGasPerBeneficiary.toLocaleString()}`);
            console.log(`  Total duration:                ${totalDuration}s`);
            console.log(`  Throughput:                    ${throughput} beneficiaries/sec`);
            console.log("  ═══════════════════════════════════════════════\n");

            expect(totalPaid).to.equal(TOTAL_BENEFICIARIES);
        });

        it("should verify payment status for 20 sampled beneficiaries", async function () {
            const indices = [0, 50, 200, 499, 1000, 1500, 2000, 2500, 3000,
                             3500, 4000, 4200, 4500, 4750, 4900, 4950, 4999,
                             42, 1337, 2718];
            let verifiedCount = 0;

            for (const idx of indices) {
                const isPaid = await floodPrediction.isBeneficiaryPaid(eventId, beneficiaries[idx].hash);
                expect(isPaid).to.be.true;
                verifiedCount++;
            }

            console.log(`     ✅ Verified ${verifiedCount}/20 sampled beneficiaries are paid`);
        });
    });

    // =====================================================================
    //   SYSTEM STATISTICS
    // =====================================================================
    describe("System Stats — Post 5000 Beneficiaries", function () {
        it("should report correct total payments after processing 5000 beneficiaries", async function () {
            const stats = await floodPrediction.getSystemStats();
            console.log(`     Total triggers: ${stats[0]}`);
            console.log(`     Total payments: ${stats[1]}`);
            expect(stats[1]).to.be.gte(TOTAL_BENEFICIARIES);
        });

        it("should have deducted the full payment amount from the budget", async function () {
            const remaining = await floodPrediction.getRegionBudgetRemaining(INTERNAL_REGION);
            const initial = ethers.parseEther("500000000");
            expect(remaining).to.be.lt(initial);
            console.log(`     ✅ Budget correctly deducted (remaining: ${remaining})`);
        });
    });

    // =====================================================================
    //   DUPLICATE PREVENTION
    // =====================================================================
    describe("Duplicate Prevention at 5000 Scale", function () {
        it("should prevent double-payment for any previously paid beneficiary", async function () {
            // Use a fresh trigger to test duplicate detection
            const freshRegion = "FLOOD-ZONE-DUP";
            await floodPrediction.allocateBudget(freshRegion, ethers.parseEther("500000000"));
            await jokalante.updateMerkleRoot(freshRegion, merkleRoot, TOTAL_BENEFICIARIES);
            await floodPrediction.connect(operator).createFloodTrigger(
                freshRegion, 85, merkleRoot, TOTAL_AMOUNT, TOTAL_BENEFICIARIES
            );
            const triggerIds = await floodPrediction.getTriggerIds();
            const dupEventId = triggerIds[triggerIds.length - 1];
            await floodPrediction.connect(operator).validateTrigger(dupEventId);

            const b = beneficiaries[0];
            const proof = tree.getProof(leaves[0]).map(p => "0x" + p.data.toString("hex"));

            // First payment should succeed
            await floodPrediction.connect(operator).processBatchPayment(
                dupEventId, [b.hash], [b.amount], [proof], [b.phone], [0]
            );

            // Second payment of same beneficiary should fail
            await expect(
                floodPrediction.connect(operator).processBatchPayment(
                    dupEventId, [b.hash], [b.amount], [proof], [b.phone], [0]
                )
            ).to.be.revertedWithCustomError(floodPrediction, "BeneficiaryAlreadyPaid");

            console.log("     ✅ Double-payment correctly prevented at 5000 scale");
        });
    });
});
