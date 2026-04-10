/**
 * BatchBeneficiaries3000.test.js — 3000 Beneficiary Scale Test
 * DPA Foundation — OPAL Platform
 *
 * Tests batch payment processing with 3000 beneficiaries to validate
 * Merkle tree scalability, multi-batch orchestration, and gas behavior.
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

describe("Batch Beneficiaries — 3000 Scale Tests", function () {
    let floodPrediction, multiOracle, jokalante, mobileMoney, opalGov;
    let admin, operator;
    let beneficiaries, leaves, tree, merkleRoot;

    const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE"));
    const TOTAL_BENEFICIARIES = 3000;
    const BATCH_SIZE = 50;
    const AMOUNT_PER_BEN = 5000; // FCFA

    function generateBeneficiaries(count) {
        const bens = [];
        for (let i = 0; i < count; i++) {
            bens.push({
                hash: ethers.keccak256(
                    ethers.AbiCoder.defaultAbiCoder().encode(
                        ["string", "uint256"],
                        [`beneficiary_3k_${i}`, i]
                    )
                ),
                amount: AMOUNT_PER_BEN
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

    before(function () {
        console.log("\n  ╔══════════════════════════════════════════════════╗");
        console.log("  ║  OPAL Platform — 3000 Beneficiaries Scale Test   ║");
        console.log("  ╚══════════════════════════════════════════════════╝");
    });

    beforeEach(async function () {
        this.timeout(60000);
        [admin, operator] = await ethers.getSigners();

        console.log("\n  [1/3] Deploying contracts...");
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
        floodPrediction = await ozUpgrades.deployProxy(FloodPred, [admin.address, operator.address, operator.address, operator.address], { kind: "uups" });
        await floodPrediction.waitForDeployment();

        await floodPrediction.setContractAddresses(
            await multiOracle.getAddress(),
            await opalGov.getAddress(),
            await jokalante.getAddress(),
            await mobileMoney.getAddress(),
            ethers.ZeroAddress
        );

        await floodPrediction.grantRole(OPERATOR_ROLE, operator.address);
        await floodPrediction.allocateBudget("SN-TH", ethers.parseEther("500000000"));
        await mobileMoney.addRelayer(await floodPrediction.getAddress());
        console.log("  ✅ All contracts deployed and configured");

        console.log("\n  [2/3] Generating 3000 beneficiaries & Merkle tree...");
        const t0 = Date.now();
        beneficiaries = generateBeneficiaries(TOTAL_BENEFICIARIES);
        const mt = buildMerkleTree(beneficiaries);
        tree = mt.tree;
        leaves = mt.leaves;
        merkleRoot = mt.root;
        const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
        console.log(`  ✅ ${TOTAL_BENEFICIARIES} beneficiaries generated in ${elapsed}s`);
        console.log(`     Merkle root: ${mt.root}`);
        console.log(`     Tree depth:  ${Math.ceil(Math.log2(TOTAL_BENEFICIARIES))}`);

        // Activate region in JokalanteTargeting
        await jokalante.updateMerkleRoot("SN-TH", merkleRoot, TOTAL_BENEFICIARIES);
        await jokalante.addAuthorizedCaller(await floodPrediction.getAddress());
    });

    // ============================================================
    // SECTION 1 — Merkle Tree Integrity
    // ============================================================
    describe("Merkle Tree — 3000 Beneficiaries", function () {
        it("should generate valid Merkle root from 3000 leaves", function () {
            expect(merkleRoot).to.not.equal(ethers.ZeroHash);
            expect(tree.getLeafCount()).to.equal(TOTAL_BENEFICIARIES);
        });

        it("should verify Merkle proofs for sampled beneficiaries across the range", function () {
            const indices = [0, 150, 499, 750, 1000, 1499, 1500, 2000, 2499, 2750, 2999];
            for (const idx of indices) {
                const proof = tree.getProof(leaves[idx]);
                expect(tree.verify(proof, leaves[idx], tree.getRoot())).to.be.true;
            }
        });

        it("should reject invalid proofs", function () {
            const fakeLeaf = ethers.keccak256(
                ethers.AbiCoder.defaultAbiCoder().encode(
                    ["bytes32", "uint256"],
                    [ethers.keccak256(ethers.toUtf8Bytes("fake_3k")), 99999]
                )
            );
            const proof = tree.getProof(leaves[0]);
            expect(tree.verify(proof, fakeLeaf, tree.getRoot())).to.be.false;
        });

        it("should have correct tree depth for 3000 leaves (depth = 12)", function () {
            const depth = Math.ceil(Math.log2(TOTAL_BENEFICIARIES));
            expect(depth).to.equal(12);
            const proof = tree.getProof(leaves[0]);
            expect(proof.length).to.be.lte(12);
        });
    });

    // ============================================================
    // SECTION 2 — Full Sequential Batch Processing
    // ============================================================
    describe("Batch Payment — 3000 Beneficiaries in 60 Batches of 50", function () {
        let eventId;

        beforeEach(async function () {
            this.timeout(30000);
            const tx = await floodPrediction.connect(operator).createFloodTrigger(
                "SN-TH", 85, merkleRoot, TOTAL_BENEFICIARIES * AMOUNT_PER_BEN, TOTAL_BENEFICIARIES
            );
            await tx.wait();
            eventId = (await floodPrediction.getTriggerIds())[0];
            await floodPrediction.connect(operator).validateTrigger(eventId);
        });

        it("should process all 3000 beneficiaries in 60 sequential batches", async function () {
            this.timeout(180000);
            console.log("\n  [3/3] Processing 3000 beneficiaries in 60 batches...");
            const totalBatches = TOTAL_BENEFICIARIES / BATCH_SIZE; // 60
            const t0 = Date.now();

            for (let batch = 0; batch < totalBatches; batch++) {
                const hashes = [];
                const amounts = [];
                const proofs = [];
                const phoneNumbers = [];

                for (let i = 0; i < BATCH_SIZE; i++) {
                    const idx = batch * BATCH_SIZE + i;
                    hashes.push(beneficiaries[idx].hash);
                    amounts.push(beneficiaries[idx].amount);
                    proofs.push(
                        tree.getProof(leaves[idx]).map(p => "0x" + p.data.toString("hex"))
                    );
                    phoneNumbers.push(ethers.keccak256(ethers.toUtf8Bytes(`+22177${String(idx).padStart(7, "0")}`)));
                }

                await floodPrediction.connect(operator).processBatchPayment(
                    eventId, hashes, amounts, proofs, phoneNumbers, hashes.map(() => 0)
                );

                if ((batch + 1) % 20 === 0) {
                    const pct = Math.round(((batch + 1) / totalBatches) * 100);
                    console.log(`     Progress: ${batch + 1}/${totalBatches} batches (${pct}%)`);
                }
            }

            const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
            const throughput = Math.round(TOTAL_BENEFICIARIES / (Date.now() - t0) * 1000);
            console.log(`  ✅ All 3000 beneficiaries processed in ${elapsed}s (${throughput} ben/s)`);

            // Verify sampled beneficiaries are paid
            const sampleIndices = [0, 49, 500, 999, 1500, 1999, 2499, 2999];
            for (const idx of sampleIndices) {
                expect(await floodPrediction.isBeneficiaryPaid(eventId, beneficiaries[idx].hash)).to.be.true;
            }

            const stats = await floodPrediction.getSystemStats();
            expect(stats[1]).to.be.gte(TOTAL_BENEFICIARIES);
            expect(stats[2]).to.equal(BigInt(TOTAL_BENEFICIARIES * AMOUNT_PER_BEN));
        });

        it("should prevent double-payment for any beneficiary across batches", async function () {
            this.timeout(60000);

            // Process first batch
            const hashes = [], amounts = [], proofs = [], phoneNumbers = [];
            for (let i = 0; i < BATCH_SIZE; i++) {
                hashes.push(beneficiaries[i].hash);
                amounts.push(beneficiaries[i].amount);
                proofs.push(tree.getProof(leaves[i]).map(p => "0x" + p.data.toString("hex")));
                phoneNumbers.push(ethers.keccak256(ethers.toUtf8Bytes(`+22177${String(i).padStart(7, "0")}`)));
            }

            await floodPrediction.connect(operator).processBatchPayment(
                eventId, hashes, amounts, proofs, phoneNumbers, hashes.map(() => 0)
            );

            // Attempt re-processing a single already-paid beneficiary
            await expect(
                floodPrediction.connect(operator).processBatchPayment(
                    eventId, [hashes[0]], [amounts[0]], [proofs[0]], [phoneNumbers[0]], [0]
                )
            ).to.be.revertedWithCustomError(floodPrediction, "BeneficiaryAlreadyPaid");
        });
    });

    // ============================================================
    // SECTION 3 — Multi-Region (4 × 750)
    // ============================================================
    describe("Multi-Region — 3000 Beneficiaries across 4 Regions (750 each)", function () {
        it("should process 750 beneficiaries per region across 4 regions", async function () {
            this.timeout(180000);
            const regions = ["SN-DK", "SN-SL", "SN-ZG", "SN-KL"];
            const perRegion = 750;
            let totalPaid = 0;

            for (let r = 0; r < regions.length; r++) {
                await floodPrediction.allocateBudget(regions[r], ethers.parseEther("500000000"));
                await jokalante.updateMerkleRoot(regions[r], merkleRoot, TOTAL_BENEFICIARIES);
                await floodPrediction.connect(operator).createFloodTrigger(
                    regions[r], 85, merkleRoot, perRegion * AMOUNT_PER_BEN, perRegion
                );
                const ids = await floodPrediction.getTriggerIds();
                const regionEventId = ids[ids.length - 1];
                await floodPrediction.connect(operator).validateTrigger(regionEventId);

                const batchCount = perRegion / BATCH_SIZE; // 15 batches per region
                for (let batch = 0; batch < batchCount; batch++) {
                    const hashes = [], amounts = [], proofs = [], phoneNumbers = [];
                    for (let i = 0; i < BATCH_SIZE; i++) {
                        const idx = r * perRegion + batch * BATCH_SIZE + i;
                        hashes.push(beneficiaries[idx].hash);
                        amounts.push(beneficiaries[idx].amount);
                        proofs.push(tree.getProof(leaves[idx]).map(p => "0x" + p.data.toString("hex")));
                        phoneNumbers.push(ethers.keccak256(ethers.toUtf8Bytes(`+22177${String(idx).padStart(7, "0")}`)));
                    }
                    await floodPrediction.connect(operator).processBatchPayment(
                        regionEventId, hashes, amounts, proofs, phoneNumbers, hashes.map(() => 0)
                    );
                    totalPaid += BATCH_SIZE;
                }
            }

            expect(totalPaid).to.equal(TOTAL_BENEFICIARIES);
            const stats = await floodPrediction.getSystemStats();
            expect(stats[1]).to.be.gte(TOTAL_BENEFICIARIES);
        });
    });

    // ============================================================
    // SECTION 4 — Gas Analysis
    // ============================================================
    describe("Gas Analysis — 3000 Beneficiaries", function () {
        let eventId;

        beforeEach(async function () {
            this.timeout(30000);
            const tx = await floodPrediction.connect(operator).createFloodTrigger(
                "SN-TH", 85, merkleRoot, TOTAL_BENEFICIARIES * AMOUNT_PER_BEN, TOTAL_BENEFICIARIES
            );
            await tx.wait();
            eventId = (await floodPrediction.getTriggerIds())[0];
            await floodPrediction.connect(operator).validateTrigger(eventId);
        });

        it("should measure gas usage per batch across all 60 batches", async function () {
            this.timeout(180000);
            const gasUsages = [];
            const totalBatches = TOTAL_BENEFICIARIES / BATCH_SIZE;

            for (let batch = 0; batch < totalBatches; batch++) {
                const hashes = [], amounts = [], proofs = [], phoneNumbers = [];
                for (let i = 0; i < BATCH_SIZE; i++) {
                    const idx = batch * BATCH_SIZE + i;
                    hashes.push(beneficiaries[idx].hash);
                    amounts.push(beneficiaries[idx].amount);
                    proofs.push(tree.getProof(leaves[idx]).map(p => "0x" + p.data.toString("hex")));
                    phoneNumbers.push(ethers.keccak256(ethers.toUtf8Bytes(`+22177${String(idx).padStart(7, "0")}`)));
                }

                const tx = await floodPrediction.connect(operator).processBatchPayment(
                    eventId, hashes, amounts, proofs, phoneNumbers, hashes.map(() => 0)
                );
                const receipt = await tx.wait();
                gasUsages.push(Number(receipt.gasUsed));
            }

            const avgGas = gasUsages.reduce((a, b) => a + b, 0) / gasUsages.length;
            const maxGas = Math.max(...gasUsages);
            const minGas = Math.min(...gasUsages);
            const totalGas = gasUsages.reduce((a, b) => a + b, 0);
            const costUSD = (totalGas * 50e-9 * 0.5).toFixed(4);

            console.log(`\n    📊 Gas Analysis — 3000 Beneficiaries (60 batches of 50):`);
            console.log(`       Average gas/batch:   ${Math.round(avgGas).toLocaleString()}`);
            console.log(`       Min gas/batch:       ${minGas.toLocaleString()}`);
            console.log(`       Max gas/batch:       ${maxGas.toLocaleString()}`);
            console.log(`       Total gas:           ${totalGas.toLocaleString()}`);
            console.log(`       Avg gas/beneficiary: ${Math.round(avgGas / BATCH_SIZE).toLocaleString()}`);
            console.log(`       Est. cost @ 50gwei:  $${costUSD} (MATIC price ~$0.50)\n`);

            // Every batch must fit within Polygon block gas limit (30M)
            expect(maxGas).to.be.lt(30_000_000);
            // Gas variance should be less than 50% of average
            expect(maxGas - minGas).to.be.lt(avgGas * 0.5);
        });
    });
});
