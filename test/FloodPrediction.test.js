/**
 * @title FloodPredictionContractV3 - Comprehensive Test Suite
 * @description Tests for the core orchestrator contract covering:
 * - Deployment & initialization
 * - RBAC access control
 * - Budget management
 * - Flood trigger creation & lifecycle
 * - Merkle-based batch payments
 * - Emergency management
 * - Pause/unpause
 * - Upgrade path (UUPS)
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

describe("FloodPredictionContract", function () {
    let floodPrediction;
    let multiOracle;
    let governance;
    let targeting;
    let mobileMoney;
    let admin, operator, upgrader, pauser, user;
    let merkleRoot, merkleTree, beneficiaries, leaves;

    const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
    const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE"));
    const UPGRADER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("UPGRADER_ROLE"));
    const PAUSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE"));

    // Phone hash constants (V-04: PII off-chain)
    const PHONE_HASH_1 = ethers.keccak256(ethers.toUtf8Bytes("+221770000001"));
    const PHONE_HASH_2 = ethers.keccak256(ethers.toUtf8Bytes("+221770000002"));

    // Helper: build Merkle tree from beneficiary data
    function buildMerkleTree(beneficiaryData) {
        const leavesArr = beneficiaryData.map(b =>
            ethers.keccak256(
                ethers.keccak256(
                    ethers.AbiCoder.defaultAbiCoder().encode(
                        ["bytes32", "uint256"],
                        [b.hash, b.amount]
                    )
                )
            )
        );
        const tree = new MerkleTree(leavesArr, keccak256, { sortPairs: true });
        return { tree, leaves: leavesArr, root: tree.getHexRoot() };
    }

    beforeEach(async function () {
        [admin, operator, upgrader, pauser, user] = await ethers.getSigners();

        // Deploy MultiOracle
        const MultiOracle = await ethers.getContractFactory("MultiOracle");
        multiOracle = await MultiOracle.deploy();
        await multiOracle.waitForDeployment();

        // Deploy Governance (UUPS)
        const OpalGov = await ethers.getContractFactory("OpalGovernanceUpgradeable");
        governance = await ozUpgrades.deployProxy(OpalGov, [admin.address, 2], { kind: "uups" });
        await governance.waitForDeployment();

        // Deploy JokalanteTargeting
        const Targeting = await ethers.getContractFactory("JokalanteTargeting");
        targeting = await Targeting.deploy();
        await targeting.waitForDeployment();

        // Deploy MobileMoney
        const MobileMoney = await ethers.getContractFactory("MobileMoneyProvider");
        mobileMoney = await MobileMoney.deploy();
        await mobileMoney.waitForDeployment();

        // Deploy FloodPrediction (UUPS)
        const FloodPrediction = await ethers.getContractFactory("FloodPredictionContract");
        floodPrediction = await ozUpgrades.deployProxy(FloodPrediction, [admin.address, operator.address, upgrader.address, pauser.address], { kind: "uups" });
        await floodPrediction.waitForDeployment();

        // Wire contracts
        await floodPrediction.setContractAddresses(
            await multiOracle.getAddress(),
            await governance.getAddress(),
            await targeting.getAddress(),
            await mobileMoney.getAddress(),
            ethers.ZeroAddress
        );

        // Grant roles
        await floodPrediction.grantRole(OPERATOR_ROLE, operator.address);
        await floodPrediction.grantRole(UPGRADER_ROLE, upgrader.address);
        await floodPrediction.grantRole(PAUSER_ROLE, pauser.address);

        // Register FloodPrediction as relayer on MobileMoneyProvider
        await mobileMoney.addRelayer(await floodPrediction.getAddress());

        // Setup Merkle tree
        beneficiaries = [
            {
                hash: ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address"], [user.address])),
                amount: 25000
            },
            {
                hash: ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address"], [operator.address])),
                amount: 30000
            }
        ];
        const mt = buildMerkleTree(beneficiaries);
        merkleTree = mt.tree;
        merkleRoot = mt.root;
        leaves = mt.leaves;

        // Allocate budget
        await floodPrediction.allocateBudget("SN-TH", 100_000_000);

        // Activate region in JokalanteTargeting and authorize FloodPrediction
        await targeting.updateMerkleRoot("SN-TH", merkleRoot, 2);
        await targeting.addAuthorizedCaller(await floodPrediction.getAddress());
    });

    // ===================================
    // Deployment & Initialization
    // ===================================
    describe("Deployment", function () {
        it("should initialize with correct version", async function () {
            expect(await floodPrediction.getVersion()).to.equal(3);
        });

        it("should assign DEFAULT_ADMIN_ROLE to admin", async function () {
            const DEFAULT_ADMIN = await floodPrediction.DEFAULT_ADMIN_ROLE();
            expect(await floodPrediction.hasRole(DEFAULT_ADMIN, admin.address)).to.be.true;
        });

        it("should assign ADMIN_ROLE to admin", async function () {
            expect(await floodPrediction.hasRole(ADMIN_ROLE, admin.address)).to.be.true;
        });

        it("should set default risk threshold to 70", async function () {
            expect(await floodPrediction.riskThreshold()).to.equal(70);
        });

        it("should have correct connected contract addresses", async function () {
            expect(await floodPrediction.multiOracle()).to.equal(await multiOracle.getAddress());
            expect(await floodPrediction.governance()).to.equal(await governance.getAddress());
        });

        it("should not allow re-initialization", async function () {
            await expect(
                floodPrediction.initialize(user.address, user.address, user.address, user.address)
            ).to.revert(ethers);
        });
    });

    // ===================================
    // Budget Management
    // ===================================
    describe("Budget Management", function () {
        it("should allocate budget to a region", async function () {
            const budget = await floodPrediction.getRegionBudget("SN-TH");
            expect(budget.allocatedAmount).to.equal(100_000_000);
            expect(budget.isActive).to.be.true;
        });

        it("should accumulate budget on multiple allocations", async function () {
            await floodPrediction.allocateBudget("SN-TH", 50_000_000);
            const budget = await floodPrediction.getRegionBudget("SN-TH");
            expect(budget.allocatedAmount).to.equal(150_000_000);
        });

        it("should return remaining budget", async function () {
            const remaining = await floodPrediction.getRegionBudgetRemaining("SN-TH");
            expect(remaining).to.equal(100_000_000);
        });

        it("should only allow ADMIN to allocate budget", async function () {
            await expect(
                floodPrediction.connect(user).allocateBudget("SN-DK", 1000)
            ).to.revert(ethers);
        });

        it("should deactivate a budget", async function () {
            await floodPrediction.deactivateBudget("SN-TH");
            const budget = await floodPrediction.getRegionBudget("SN-TH");
            expect(budget.isActive).to.be.false;
        });
    });

    // ===================================
    // Flood Trigger Creation
    // ===================================
    describe("Flood Triggers", function () {
        it("should create a trigger when risk >= threshold", async function () {
            const tx = await floodPrediction.connect(operator).createFloodTrigger(
                "SN-TH", 85, merkleRoot, 55000, 2
            );
            const receipt = await tx.wait();
            
            expect(await floodPrediction.triggerCount()).to.equal(1);
        });

        it("should emit FloodTriggerCreated on trigger", async function () {
            await expect(
                floodPrediction.connect(operator).createFloodTrigger(
                    "SN-TH", 75, merkleRoot, 55000, 2
                )
            ).to.emit(floodPrediction, "FloodTriggerCreated");
        });

        it("should revert when risk < threshold", async function () {
            await expect(
                floodPrediction.connect(operator).createFloodTrigger(
                    "SN-TH", 50, merkleRoot, 55000, 2
                )
            ).to.be.revertedWithCustomError(floodPrediction, "BelowRiskThreshold");
        });

        it("should revert when risk > 100", async function () {
            await expect(
                floodPrediction.connect(operator).createFloodTrigger(
                    "SN-TH", 101, merkleRoot, 55000, 2
                )
            ).to.be.revertedWithCustomError(floodPrediction, "InvalidRiskScore");
        });

        it("should revert when budget is insufficient", async function () {
            await expect(
                floodPrediction.connect(operator).createFloodTrigger(
                    "SN-TH", 85, merkleRoot, 200_000_000, 2
                )
            ).to.be.revertedWithCustomError(floodPrediction, "InsufficientBudget");
        });

        it("should enforce cooldown between triggers", async function () {
            // First trigger
            await floodPrediction.connect(operator).createFloodTrigger(
                "SN-TH", 85, merkleRoot, 55000, 2
            );

            // Second trigger should fail (cooldown)
            await expect(
                floodPrediction.connect(operator).createFloodTrigger(
                    "SN-TH", 85, merkleRoot, 55000, 2
                )
            ).to.be.revertedWithCustomError(floodPrediction, "CooldownNotElapsed");
        });

        it("should only allow OPERATOR to create triggers", async function () {
            await expect(
                floodPrediction.connect(user).createFloodTrigger(
                    "SN-TH", 85, merkleRoot, 55000, 2
                )
            ).to.revert(ethers);
        });

        it("should revert for inactive budget region", async function () {
            await expect(
                floodPrediction.connect(operator).createFloodTrigger(
                    "SN-ZZ", 85, merkleRoot, 55000, 2
                )
            ).to.be.revertedWithCustomError(floodPrediction, "InsufficientBudget");
        });
    });

    // ===================================
    // Trigger Validation
    // ===================================
    describe("Trigger Validation", function () {
        let eventId;

        beforeEach(async function () {
            const tx = await floodPrediction.connect(operator).createFloodTrigger(
                "SN-TH", 85, merkleRoot, 55000, 2
            );
            const receipt = await tx.wait();
            eventId = (await floodPrediction.getTriggerIds())[0];
        });

        it("should validate an active trigger", async function () {
            await floodPrediction.connect(operator).validateTrigger(eventId);
            const trigger = await floodPrediction.getFloodTrigger(eventId);
            expect(trigger.status).to.equal(3); // VALIDATED
        });

        it("should not validate a non-existent trigger", async function () {
            await expect(
                floodPrediction.connect(operator).validateTrigger("bad-id")
            ).to.be.revertedWithCustomError(floodPrediction, "TriggerNotFound");
        });

        it("should allow admin to cancel a trigger", async function () {
            await floodPrediction.cancelTrigger(eventId, "Test cancel");
            const trigger = await floodPrediction.getFloodTrigger(eventId);
            expect(trigger.status).to.equal(6); // CANCELLED
        });
    });

    // ===================================
    // Batch Payments
    // ===================================
    describe("Batch Payments", function () {
        let eventId;

        beforeEach(async function () {
            // Create and validate trigger
            await floodPrediction.connect(operator).createFloodTrigger(
                "SN-TH", 85, merkleRoot, 55000, 2
            );
            eventId = (await floodPrediction.getTriggerIds())[0];
            await floodPrediction.connect(operator).validateTrigger(eventId);
        });

        it("should process batch payment with valid Merkle proofs", async function () {
            const hashes = beneficiaries.map(b => b.hash);
            const amounts = beneficiaries.map(b => b.amount);
            const proofs = leaves.map(leaf => merkleTree.getHexProof(leaf));
            const phoneHashes = [PHONE_HASH_1, PHONE_HASH_2];

            await expect(
                floodPrediction.connect(operator).processBatchPayment(
                    eventId, hashes, amounts, proofs, phoneHashes, [0, 0]
                )
            ).to.emit(floodPrediction, "BatchPaymentProcessed");

            // Check stats updated
            const stats = await floodPrediction.getSystemStats();
            expect(stats[1]).to.equal(2); // totalPayments = 2
            expect(stats[2]).to.equal(55000); // totalDisbursed = 55000
        });

        it("should prevent double payment", async function () {
            const hashes = beneficiaries.map(b => b.hash);
            const amounts = beneficiaries.map(b => b.amount);
            const proofs = leaves.map(leaf => merkleTree.getHexProof(leaf));
            const phoneHashes = [PHONE_HASH_1, PHONE_HASH_2];

            await floodPrediction.connect(operator).processBatchPayment(
                eventId, hashes, amounts, proofs, phoneHashes, [0, 0]
            );

            // Second attempt should revert (trigger marked as PAID)
            await expect(
                floodPrediction.connect(operator).processBatchPayment(
                    eventId, hashes, amounts, proofs, phoneHashes, [0, 0]
                )
            ).to.revert(ethers);
        });

        it("should reject empty batch", async function () {
            await expect(
                floodPrediction.connect(operator).processBatchPayment(
                    eventId, [], [], [], [], []
                )
            ).to.be.revertedWithCustomError(floodPrediction, "InvalidBatchSize");
        });

        it("should reject array length mismatch", async function () {
            await expect(
                floodPrediction.connect(operator).processBatchPayment(
                    eventId,
                    [beneficiaries[0].hash],
                    [25000, 30000],
                    [merkleTree.getHexProof(leaves[0])],
                    [PHONE_HASH_1],
                    [0]
                )
            ).to.be.revertedWithCustomError(floodPrediction, "ArrayLengthMismatch");
        });

        it("should reject payment below minimum", async function () {
            // Build new tree with invalid amount
            const badBen = [{ hash: beneficiaries[0].hash, amount: 100 }]; // below 500 min
            const mt2 = buildMerkleTree(badBen);

            await expect(
                floodPrediction.connect(operator).processBatchPayment(
                    eventId,
                    [badBen[0].hash],
                    [100],
                    [mt2.tree.getHexProof(mt2.leaves[0])],
                    [PHONE_HASH_1],
                    [0]
                )
            ).to.be.revertedWithCustomError(floodPrediction, "InvalidPaymentAmount");
        });

        it("should track individual payment records", async function () {
            const hashes = beneficiaries.map(b => b.hash);
            const amounts = beneficiaries.map(b => b.amount);
            const proofs = leaves.map(leaf => merkleTree.getHexProof(leaf));
            const phoneHashes = [PHONE_HASH_1, PHONE_HASH_2];

            await floodPrediction.connect(operator).processBatchPayment(
                eventId, hashes, amounts, proofs, phoneHashes, [0, 0]
            );

            const record = await floodPrediction.getPaymentRecord(eventId, beneficiaries[0].hash);
            expect(record.amount).to.equal(25000);
            expect(record.verified).to.be.true;
        });

        it("should report beneficiary as paid", async function () {
            const hashes = beneficiaries.map(b => b.hash);
            const amounts = beneficiaries.map(b => b.amount);
            const proofs = leaves.map(leaf => merkleTree.getHexProof(leaf));
            const phoneHashes = [PHONE_HASH_1, PHONE_HASH_2];

            await floodPrediction.connect(operator).processBatchPayment(
                eventId, hashes, amounts, proofs, phoneHashes, [0, 0]
            );

            expect(await floodPrediction.isBeneficiaryPaid(eventId, beneficiaries[0].hash)).to.be.true;
            expect(await floodPrediction.isBeneficiaryPaid(eventId, ethers.ZeroHash)).to.be.false;
        });
    });

    // ===================================
    // Validate & Process (One-Step Flow)
    // ===================================
    describe("Validate and Process Payments (One-Step)", function () {
        let eventId;

        beforeEach(async function () {
            // Create trigger (ACTIVE, not validated yet)
            await floodPrediction.connect(operator).createFloodTrigger(
                "SN-TH", 85, merkleRoot, 55000, 2
            );
            eventId = (await floodPrediction.getTriggerIds())[0];
        });

        it("should validate + process payments in one step", async function () {
            const hashes = beneficiaries.map(b => b.hash);
            const amounts = beneficiaries.map(b => b.amount);
            const proofs = leaves.map(leaf => merkleTree.getHexProof(leaf));
            const phoneHashes = [PHONE_HASH_1, PHONE_HASH_2];

            // H-03 fix: MobileMoney call is wrapped in try/catch, so we check
            // for on-chain events (TriggerValidated + BatchPaymentProcessed)
            // MobileMoneyPaymentsInitiated OR MobileMoneyPaymentsFailed may be emitted
            await expect(
                floodPrediction.connect(operator).validateAndProcessPayments(
                    eventId, hashes, amounts, proofs, phoneHashes, [0, 0]
                )
            ).to.emit(floodPrediction, "TriggerValidated")
             .and.to.emit(floodPrediction, "BatchPaymentProcessed");

            // Trigger should be PAID (2/2 beneficiaries processed)
            const trigger = await floodPrediction.getFloodTrigger(eventId);
            expect(trigger.status).to.equal(4); // PAID

            // Beneficiaries should be paid
            expect(await floodPrediction.isBeneficiaryPaid(eventId, beneficiaries[0].hash)).to.be.true;
            expect(await floodPrediction.isBeneficiaryPaid(eventId, beneficiaries[1].hash)).to.be.true;
        });

        it("should revert if trigger is not ACTIVE", async function () {
            // Validate first (changes to VALIDATED)
            await floodPrediction.connect(operator).validateTrigger(eventId);

            const hashes = beneficiaries.map(b => b.hash);
            const amounts = beneficiaries.map(b => b.amount);
            const proofs = leaves.map(leaf => merkleTree.getHexProof(leaf));
            const phoneHashes = [PHONE_HASH_1, PHONE_HASH_2];

            await expect(
                floodPrediction.connect(operator).validateAndProcessPayments(
                    eventId, hashes, amounts, proofs, phoneHashes, [0, 0]
                )
            ).to.be.revertedWithCustomError(floodPrediction, "TriggerNotActive");
        });

        it("should emit Mobile Money event (initiated or failed) with correct context", async function () {
            const hashes = beneficiaries.map(b => b.hash);
            const amounts = beneficiaries.map(b => b.amount);
            const proofs = leaves.map(leaf => merkleTree.getHexProof(leaf));
            const phoneHashes = [PHONE_HASH_1, PHONE_HASH_2];

            // H-03 fix: MobileMoney is wrapped in try/catch
            // Either MobileMoneyPaymentsInitiated or MobileMoneyPaymentsFailed will be emitted
            const tx = await floodPrediction.connect(operator).validateAndProcessPayments(
                eventId, hashes, amounts, proofs, phoneHashes, [0, 0]
            );
            const receipt = await tx.wait();
            const hasInitiated = receipt.logs.some(log => {
                try { return floodPrediction.interface.parseLog(log)?.name === "MobileMoneyPaymentsInitiated"; } catch { return false; }
            });
            const hasFailed = receipt.logs.some(log => {
                try { return floodPrediction.interface.parseLog(log)?.name === "MobileMoneyPaymentsFailed"; } catch { return false; }
            });
            expect(hasInitiated || hasFailed).to.be.true;
        });

        it("should update system stats after one-step flow", async function () {
            const hashes = beneficiaries.map(b => b.hash);
            const amounts = beneficiaries.map(b => b.amount);
            const proofs = leaves.map(leaf => merkleTree.getHexProof(leaf));
            const phoneHashes = [PHONE_HASH_1, PHONE_HASH_2];

            await floodPrediction.connect(operator).validateAndProcessPayments(
                eventId, hashes, amounts, proofs, phoneHashes, [0, 0]
            );

            const stats = await floodPrediction.getSystemStats();
            expect(stats[1]).to.equal(2); // totalPayments
            expect(stats[2]).to.equal(55000); // totalDisbursed
        });
    });

    // ===================================
    // Governance Override
    // ===================================
    describe("Governance Override", function () {
        it("should create a governance override trigger", async function () {
            await expect(
                floodPrediction.createGovernanceOverrideTrigger(
                    "SN-TH", 50, merkleRoot, 20000, 2, "Emergency flood"
                )
            ).to.emit(floodPrediction, "GovernanceOverride");

            const eventId = (await floodPrediction.getTriggerIds())[0];
            const trigger = await floodPrediction.getFloodTrigger(eventId);
            expect(trigger.isGovernanceOverride).to.be.true;
            expect(trigger.status).to.equal(3); // VALIDATED (auto)
        });

        it("should only allow ADMIN for governance override", async function () {
            await expect(
                floodPrediction.connect(user).createGovernanceOverrideTrigger(
                    "SN-TH", 50, merkleRoot, 20000, 2, "Hack attempt"
                )
            ).to.revert(ethers);
        });
    });

    // ===================================
    // Emergency Mode
    // ===================================
    describe("Emergency Mode", function () {
        it("should activate emergency mode", async function () {
            await expect(
                floodPrediction.activateEmergencyMode("Major incident")
            ).to.emit(floodPrediction, "EmergencyModeActivated");
            expect(await floodPrediction.emergencyMode()).to.be.true;
        });

        it("should block triggers in emergency mode", async function () {
            await floodPrediction.activateEmergencyMode("Test");
            await expect(
                floodPrediction.connect(operator).createFloodTrigger(
                    "SN-TH", 85, merkleRoot, 55000, 2
                )
            ).to.be.revertedWithCustomError(floodPrediction, "EmergencyModeActive");
        });

        it("should deactivate emergency mode", async function () {
            await floodPrediction.activateEmergencyMode("Test");
            await floodPrediction.deactivateEmergencyMode();
            expect(await floodPrediction.emergencyMode()).to.be.false;
        });

        it("should revert deactivation when not in emergency", async function () {
            await expect(
                floodPrediction.deactivateEmergencyMode()
            ).to.be.revertedWithCustomError(floodPrediction, "NotInEmergencyMode");
        });

        it("should set region-level emergency", async function () {
            await floodPrediction.setRegionEmergency("SN-TH", true);
            expect(await floodPrediction.regionEmergency("SN-TH")).to.be.true;
        });
    });

    // ===================================
    // Pause/Unpause
    // ===================================
    describe("Pause Control", function () {
        it("should pause the contract", async function () {
            await floodPrediction.connect(pauser).pause();
            expect(await floodPrediction.paused()).to.be.true;
        });

        it("should block triggers when paused", async function () {
            await floodPrediction.connect(pauser).pause();
            await expect(
                floodPrediction.connect(operator).createFloodTrigger(
                    "SN-TH", 85, merkleRoot, 55000, 2
                )
            ).to.revert(ethers);
        });

        it("should unpause the contract", async function () {
            await floodPrediction.connect(pauser).pause();
            await floodPrediction.connect(pauser).unpause();
            expect(await floodPrediction.paused()).to.be.false;
        });

        it("should only allow PAUSER_ROLE", async function () {
            await expect(
                floodPrediction.connect(user).pause()
            ).to.revert(ethers);
        });
    });

    // ===================================
    // Configuration
    // ===================================
    describe("Configuration", function () {
        it("should update risk threshold", async function () {
            await floodPrediction.updateRiskThreshold(80);
            expect(await floodPrediction.riskThreshold()).to.equal(80);
        });

        it("should reject invalid threshold (0)", async function () {
            await expect(
                floodPrediction.updateRiskThreshold(0)
            ).to.revert(ethers);
        });

        it("should reject threshold > 100", async function () {
            await expect(
                floodPrediction.updateRiskThreshold(101)
            ).to.revert(ethers);
        });

        it("should emit RiskThresholdUpdated", async function () {
            await expect(
                floodPrediction.updateRiskThreshold(80)
            ).to.emit(floodPrediction, "RiskThresholdUpdated")
                .withArgs(70, 80);
        });
    });

    // ===================================
    // View Functions
    // ===================================
    describe("View Functions", function () {
        it("should return system stats", async function () {
            const stats = await floodPrediction.getSystemStats();
            expect(stats._triggerCount).to.equal(0);
            expect(stats._version).to.equal(3);
        });

        it("should return empty trigger IDs initially", async function () {
            const ids = await floodPrediction.getTriggerIds();
            expect(ids.length).to.equal(0);
        });

        it("should return cooldown remaining (0 for fresh region)", async function () {
            expect(await floodPrediction.getCooldownRemaining("SN-TH", 85)).to.equal(0);
        });

        it("should return cooldown remaining after trigger", async function () {
            await floodPrediction.connect(operator).createFloodTrigger(
                "SN-TH", 85, merkleRoot, 55000, 2
            );
            const remaining = await floodPrediction.getCooldownRemaining("SN-TH", 85);
            expect(remaining).to.be.greaterThan(0);
        });
    });

    // ===================================
    // UUPS Upgrade
    // ===================================
    describe("UUPS Upgrade", function () {
        it("should allow UPGRADER to upgrade", async function () {
            const FloodPredictionV3 = await ethers.getContractFactory("FloodPredictionContract");
            const upgraded = await ozUpgrades.upgradeProxy(
                await floodPrediction.getAddress(),
                FloodPredictionV3.connect(upgrader),
                { kind: "uups" }
            );
            expect(await upgraded.getVersion()).to.equal(3);
        });

        it("should not allow random user to upgrade", async function () {
            const FloodPredictionV3 = await ethers.getContractFactory("FloodPredictionContract", user);
            await expect(
                ozUpgrades.upgradeProxy(
                    await floodPrediction.getAddress(),
                    FloodPredictionV3,
                    { kind: "uups" }
                )
            ).to.revert(ethers);
        });

        it("should preserve state after upgrade", async function () {
            // Create some state
            await floodPrediction.connect(operator).createFloodTrigger(
                "SN-TH", 85, merkleRoot, 55000, 2
            );

            // Upgrade
            const FloodPredictionV3 = await ethers.getContractFactory("FloodPredictionContract");
            const upgraded = await ozUpgrades.upgradeProxy(
                await floodPrediction.getAddress(),
                FloodPredictionV3.connect(upgrader),
                { kind: "uups" }
            );

            // State should persist
            expect(await upgraded.triggerCount()).to.equal(1);
            expect(await upgraded.totalBudgetAllocated()).to.equal(100_000_000);
        });
    });
});
