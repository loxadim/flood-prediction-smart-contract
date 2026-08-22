/**
 * BatchBeneficiaries2000.test.js — 2000 Beneficiary Scale Test
 * DPA Foundation — OPAL Platform
 *
 * Tests batch payment processing with 2000 beneficiaries to validate
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

describe("Batch Beneficiaries — 2000 Scale Tests", function () {
    let floodPrediction, multiOracle, jokalante, mobileMoney, opalGov;
    let admin, operator, upgrader, pauser;
    let beneficiaries, leaves, tree, merkleRoot;
    // A8-13 fix: KYC compliance and the ARCH-01 ledger binding were both absent, so every
    // gas figure this file produced described a configuration nobody deploys.
    // batchCheckCompliance() and the per-item getPaymentRecord() callback together add
    // roughly 16 % to the cost of a batch. The registry is deployed once and reused: the
    // beneficiary hashes are deterministic, so attestations approved here survive each
    // redeployment of the hub, and per-test isolation is untouched.
    let kyc, kycAddress;

    const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE"));
    const TOTAL_BENEFICIARIES = 2000;
    const BATCH_SIZE = 50;

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
                amount: 5000
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

    // A8-13 fix: one KYC deployment, one approval pass, reused by every test below.
    before(async function () {
        this.timeout(600000);
        const signers = await ethers.getSigners();
        const [officerA, officerB] = [signers[4], signers[5]];

        const KYC = await ethers.getContractFactory("KYCAMLCompliance");
        kyc = await KYC.deploy();
        await kyc.waitForDeployment();
        kycAddress = await kyc.getAddress();

        // Two officers: approveAttestation enforces the four-eyes rule, so the approver
        // must differ from the submitter (H-04).
        await kyc.addComplianceOfficer(officerA.address);
        await kyc.addComplianceOfficer(officerB.address);

        for (const b of generateBeneficiaries(2000)) {
            await kyc.connect(officerA).submitAttestation(
                b.hash,
                ethers.keccak256(ethers.toUtf8Bytes("identity" + b.hash)),
                ethers.keccak256(ethers.toUtf8Bytes("documents")),
                "SN-TH"
            );
            await kyc.connect(officerB).approveAttestation(b.hash, 0, 0);
        }
    });

    beforeEach(async function () {
        this.timeout(60000);
        [admin, operator, upgrader, pauser] = await ethers.getSigners();

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
            kycAddress   // A8-13 fix: batchCheckCompliance() now runs on every batch
        );

        await floodPrediction.grantRole(OPERATOR_ROLE, operator.address);
        await floodPrediction.allocateBudget("SN-TH", 100_000_000n);

        await mobileMoney.addRelayer(await floodPrediction.getAddress());
        // A8-13 fix: bind the payment rail to the ledger (ARCH-01), so each item costs the
        // extra getPaymentRecord() callback the deployment scripts always incur.
        await mobileMoney.setFloodPredictionContract(await floodPrediction.getAddress());
        await mobileMoney.setDailyLimit("SN-TH", 100_000_000n);
        await kyc.authorizeContract(await floodPrediction.getAddress());

        beneficiaries = generateBeneficiaries(TOTAL_BENEFICIARIES);
        const mt = buildMerkleTree(beneficiaries);
        tree = mt.tree;
        leaves = mt.leaves;
        merkleRoot = mt.root;

        // Activate region in JokalanteTargeting
        await jokalante.updateMerkleRoot("SN-TH", merkleRoot, TOTAL_BENEFICIARIES);
        await jokalante.addAuthorizedCaller(await floodPrediction.getAddress());
    });

    describe("Merkle Tree — 2000 Beneficiaries", function () {
        it("should generate valid Merkle root from 2000 leaves", function () {
            expect(merkleRoot).to.not.equal(ethers.ZeroHash);
            expect(tree.getLeafCount()).to.equal(TOTAL_BENEFICIARIES);
        });

        it("should verify Merkle proofs for sampled beneficiaries across the range", function () {
            const indices = [0, 100, 250, 500, 750, 999, 1000, 1250, 1500, 1750, 1999];
            for (const idx of indices) {
                const proof = tree.getProof(leaves[idx]);
                expect(tree.verify(proof, leaves[idx], tree.getRoot())).to.be.true;
            }
        });

        it("should reject invalid proofs", function () {
            const fakeLeaf = ethers.keccak256(
                ethers.AbiCoder.defaultAbiCoder().encode(
                    ["bytes32", "uint256"],
                    [ethers.keccak256(ethers.toUtf8Bytes("fake")), 99999]
                )
            );
            const proof = tree.getProof(leaves[0]);
            expect(tree.verify(proof, fakeLeaf, tree.getRoot())).to.be.false;
        });

        it("should have consistent tree depth for 2000 leaves (depth = 11)", function () {
            const depth = Math.ceil(Math.log2(TOTAL_BENEFICIARIES));
            expect(depth).to.equal(11);
            // Each proof should have at most 11 elements
            const proof = tree.getProof(leaves[0]);
            expect(proof.length).to.be.lte(11);
        });
    });

    describe("Batch Payment — 2000 Beneficiaries in 40 Batches of 50", function () {
        let eventId;

        beforeEach(async function () {
            this.timeout(30000);
            const tx = await floodPrediction.connect(operator).createFloodTrigger(
                "SN-TH", 85, merkleRoot, 2000 * 5000, TOTAL_BENEFICIARIES
            );
            await tx.wait();
            eventId = (await floodPrediction.getTriggerIds())[0];
            await floodPrediction.connect(operator).validateTrigger(eventId);
        });

        it("should process all 2000 beneficiaries in 40 sequential batches", async function () {
            this.timeout(120000);
            const totalBatches = TOTAL_BENEFICIARIES / BATCH_SIZE; // 40

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
            }

            // Verify all 2000 beneficiaries are paid
            const sampleIndices = [0, 49, 500, 999, 1500, 1999];
            for (const idx of sampleIndices) {
                expect(await floodPrediction.isBeneficiaryPaid(eventId, beneficiaries[idx].hash)).to.be.true;
            }

            const stats = await floodPrediction.getSystemStats();
            expect(stats[1]).to.be.gte(TOTAL_BENEFICIARIES);
        });

        it("should prevent double-payment for any beneficiary across batches", async function () {
            this.timeout(60000);

            // Process first batch
            const hashes = [];
            const amounts = [];
            const proofs = [];
            const phoneNumbers = [];

            for (let i = 0; i < BATCH_SIZE; i++) {
                hashes.push(beneficiaries[i].hash);
                amounts.push(beneficiaries[i].amount);
                proofs.push(
                    tree.getProof(leaves[i]).map(p => "0x" + p.data.toString("hex"))
                );
                phoneNumbers.push(ethers.keccak256(ethers.toUtf8Bytes(`+22177${String(i).padStart(7, "0")}`)));
            }

            await floodPrediction.connect(operator).processBatchPayment(
                eventId, hashes, amounts, proofs, phoneNumbers, hashes.map(() => 0)
            );

            // Attempt to re-process the same batch — should skip already-paid
            await expect(
                floodPrediction.connect(operator).processBatchPayment(
                    eventId, [hashes[0]], [amounts[0]], [proofs[0]], [phoneNumbers[0]], [0]
                )
            ).to.be.revertedWithCustomError(floodPrediction, "BeneficiaryAlreadyPaid");
        });
    });

    describe("Multi-Region — 2000 Beneficiaries across 4 Regions", function () {
        it("should process 500 beneficiaries per region across 4 regions", async function () {
            this.timeout(120000);
            const regions = ["SN-DK", "SN-SL", "SN-ZG", "SN-KL"];
            const perRegion = 500;
            let totalPaid = 0;

            for (let r = 0; r < regions.length; r++) {
                await floodPrediction.allocateBudget(regions[r], 100_000_000n);
                await jokalante.updateMerkleRoot(regions[r], merkleRoot, TOTAL_BENEFICIARIES);

                await floodPrediction.connect(operator).createFloodTrigger(
                    regions[r], 85, merkleRoot, perRegion * 5000, perRegion
                );
                const ids = await floodPrediction.getTriggerIds();
                const regionEventId = ids[ids.length - 1];
                await floodPrediction.connect(operator).validateTrigger(regionEventId);

                const batchCount = perRegion / BATCH_SIZE; // 10 batches per region
                for (let batch = 0; batch < batchCount; batch++) {
                    const hashes = [];
                    const amounts = [];
                    const proofs = [];
                    const phoneNumbers = [];

                    for (let i = 0; i < BATCH_SIZE; i++) {
                        const idx = r * perRegion + batch * BATCH_SIZE + i;
                        hashes.push(beneficiaries[idx].hash);
                        amounts.push(beneficiaries[idx].amount);
                        proofs.push(
                            tree.getProof(leaves[idx]).map(p => "0x" + p.data.toString("hex"))
                        );
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

    describe("Gas Analysis — 2000 Beneficiaries", function () {
        let eventId;

        beforeEach(async function () {
            this.timeout(30000);
            const tx = await floodPrediction.connect(operator).createFloodTrigger(
                "SN-TH", 85, merkleRoot, 2000 * 5000, TOTAL_BENEFICIARIES
            );
            await tx.wait();
            eventId = (await floodPrediction.getTriggerIds())[0];
            await floodPrediction.connect(operator).validateTrigger(eventId);
        });

        it("should measure gas usage per batch across all 40 batches", async function () {
            this.timeout(120000);
            const gasUsages = [];
            const totalBatches = TOTAL_BENEFICIARIES / BATCH_SIZE;

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

                const tx = await floodPrediction.connect(operator).processBatchPayment(
                    eventId, hashes, amounts, proofs, phoneNumbers, hashes.map(() => 0)
                );
                const receipt = await tx.wait();
                gasUsages.push(Number(receipt.gasUsed));
            }

            const avgGas = gasUsages.reduce((a, b) => a + b, 0) / gasUsages.length;
            const maxGas = Math.max(...gasUsages);
            const minGas = Math.min(...gasUsages);

            console.log(`\n    📊 Gas Analysis — 2000 Beneficiaries (40 batches of 50):`);
            console.log(`       Average gas/batch:  ${avgGas.toLocaleString()}`);
            console.log(`       Min gas/batch:      ${minGas.toLocaleString()}`);
            console.log(`       Max gas/batch:      ${maxGas.toLocaleString()}`);
            console.log(`       Total gas:          ${gasUsages.reduce((a, b) => a + b, 0).toLocaleString()}`);
            console.log(`       Avg gas/beneficiary: ${Math.round(avgGas / BATCH_SIZE).toLocaleString()}`);
            console.log(`       Coût @ 50 gwei: ${(gasUsages.reduce((a, b) => a + b, 0) * 50e-9).toFixed(4)} POL\n`);

            // ARCH-04 : plafond homogène avec les tests 5000/10000 — 24M laisse ~20 %
            // de marge sous la limite réelle de 30M de Polygon PoS.
            expect(maxGas).to.be.lt(24_000_000);
            // Gas should be relatively stable across batches
            expect(maxGas - minGas).to.be.lt(avgGas * 0.5);
        });
    });
});
