/**
 * BatchBeneficiaries1000.test.js — Large Batch Performance Test
 * DPA Foundation — OPAL Platform
 * 
 * Tests batch payment processing at scale to ensure
 * gas limits and data structures hold up to real-world usage.
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

describe("Batch Beneficiaries — Scale Tests", function () {
    let floodPrediction, multiOracle, jokalante, mobileMoney, opalGov;
    let admin, operator, upgrader, pauser;
    let beneficiaries, leaves, tree, merkleRoot;

    const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE"));

    // Generate N beneficiaries with proper Merkle leaf format:
    // leaf = keccak256(abi.encode(bytes32 hash, uint256 amount))
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

    beforeEach(async function () {
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
            ethers.ZeroAddress
        );

        await floodPrediction.grantRole(OPERATOR_ROLE, operator.address);
        await floodPrediction.allocateBudget("SN-TH", ethers.parseEther("500000000"));

        // Register FloodPrediction as relayer on MobileMoneyProvider
        await mobileMoney.addRelayer(await floodPrediction.getAddress());

        // Generate 1000 beneficiaries with correct leaf format
        beneficiaries = generateBeneficiaries(1000);
        const mt = buildMerkleTree(beneficiaries);
        tree = mt.tree;
        leaves = mt.leaves;
        merkleRoot = mt.root;

        // Activate region in JokalanteTargeting
        await jokalante.updateMerkleRoot("SN-TH", merkleRoot, 1000);
        await jokalante.addAuthorizedCaller(await floodPrediction.getAddress());
    });

    describe("Merkle Tree — 1000 Beneficiaries", function () {
        it("should generate valid Merkle root from 1000 leaves", function () {
            expect(merkleRoot).to.not.equal(ethers.ZeroHash);
            expect(tree.getLeafCount()).to.equal(1000);
        });

        it("should verify Merkle proofs for random beneficiaries", function () {
            const indices = [0, 99, 250, 499, 500, 750, 999, 42, 888, 137];
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
    });

    describe("Batch Payment — MAX_BATCH_SIZE (50)", function () {
        let eventId;

        beforeEach(async function () {
            const tx = await floodPrediction.connect(operator).createFloodTrigger(
                "SN-TH", 85, merkleRoot, 250000, 50  // 50 beneficiaries × 5000 FCFA each
            );
            await tx.wait();
            eventId = (await floodPrediction.getTriggerIds())[0];
            await floodPrediction.connect(operator).validateTrigger(eventId);
        });

        it("should process a full batch of 50 beneficiaries", async function () {
            const hashes = [];
            const amounts = [];
            const proofs = [];
            const phoneNumbers = [];

            for (let i = 0; i < 50; i++) {
                hashes.push(beneficiaries[i].hash);
                amounts.push(beneficiaries[i].amount);
                proofs.push(
                    tree.getProof(leaves[i]).map(p => "0x" + p.data.toString("hex"))
                );
                phoneNumbers.push(ethers.keccak256(ethers.toUtf8Bytes(`+22177000${String(i).padStart(4, "0")}`)));
            }

            await expect(
                floodPrediction.connect(operator).processBatchPayment(
                    eventId, hashes, amounts, proofs, phoneNumbers, hashes.map(() => 0)
                )
            ).to.not.revert(ethers);

            for (let i = 0; i < 50; i++) {
                expect(await floodPrediction.isBeneficiaryPaid(eventId, hashes[i])).to.be.true;
            }
        });

        it("should reject batch exceeding MAX_BATCH_SIZE", async function () {
            const hashes = [];
            const amounts = [];
            const proofs = [];
            const phoneNumbers = [];

            for (let i = 0; i < 51; i++) {
                hashes.push(beneficiaries[i].hash);
                amounts.push(beneficiaries[i].amount);
                proofs.push([]);
                phoneNumbers.push(ethers.keccak256(ethers.toUtf8Bytes(`+22177000${String(i).padStart(4, "0")}`)));
            }

            await expect(
                floodPrediction.connect(operator).processBatchPayment(
                    eventId, hashes, amounts, proofs, phoneNumbers, hashes.map(() => 0)
                )
            ).to.be.revertedWithCustomError(floodPrediction, "InvalidBatchSize");
        });

        it("should process sequential batches across 4 regions covering 200 beneficiaries", async function () {
            const regions = ["SN-DK", "SN-SL", "SN-ZG", "SN-KL"];
            let totalPaid = 0;

            for (let batch = 0; batch < 4; batch++) {
                await floodPrediction.allocateBudget(regions[batch], ethers.parseEther("500000000"));
                await jokalante.updateMerkleRoot(regions[batch], merkleRoot, 1000);

                await floodPrediction.connect(operator).createFloodTrigger(
                    regions[batch], 85, merkleRoot, 250000, 50
                );
                const ids = await floodPrediction.getTriggerIds();
                const batchEventId = ids[ids.length - 1];
                await floodPrediction.connect(operator).validateTrigger(batchEventId);

                const hashes = [];
                const amounts = [];
                const proofs = [];
                const phoneNumbers = [];

                for (let i = 0; i < 50; i++) {
                    const idx = batch * 50 + i;
                    hashes.push(beneficiaries[idx].hash);
                    amounts.push(beneficiaries[idx].amount);
                    proofs.push(
                        tree.getProof(leaves[idx]).map(p => "0x" + p.data.toString("hex"))
                    );
                    phoneNumbers.push(ethers.keccak256(ethers.toUtf8Bytes(`+22177000${String(idx).padStart(4, "0")}`)));
                }

                await floodPrediction.connect(operator).processBatchPayment(
                    batchEventId, hashes, amounts, proofs, phoneNumbers, hashes.map(() => 0)
                );
                totalPaid += 50;
            }

            expect(totalPaid).to.equal(200);
            const stats = await floodPrediction.getSystemStats();
            expect(stats[1]).to.be.gte(200);
        });
    });

    describe("Duplicate Payment Prevention at Scale", function () {
        let eventId;

        beforeEach(async function () {
            const tx = await floodPrediction.connect(operator).createFloodTrigger(
                "SN-TH", 85, merkleRoot, 50000, 2
            );
            await tx.wait();
            eventId = (await floodPrediction.getTriggerIds())[0];
            await floodPrediction.connect(operator).validateTrigger(eventId);
        });

        it("should prevent re-processing the same beneficiary", async function () {
            const hash = beneficiaries[0].hash;
            const amount = beneficiaries[0].amount;
            const proof = tree.getProof(leaves[0]).map(p => "0x" + p.data.toString("hex"));

            await floodPrediction.connect(operator).processBatchPayment(
                eventId, [hash], [amount], [proof], [ethers.keccak256(ethers.toUtf8Bytes("+221770000001"))], [0]
            );
            expect(await floodPrediction.isBeneficiaryPaid(eventId, hash)).to.be.true;

            await expect(
                floodPrediction.connect(operator).processBatchPayment(
                    eventId, [hash], [amount], [proof], [ethers.keccak256(ethers.toUtf8Bytes("+221770000001"))], [0]
                )
            ).to.be.revertedWithCustomError(floodPrediction, "BeneficiaryAlreadyPaid");
        });
    });
});
