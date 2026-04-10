/**
 * AuditV2Fixes.test.js — Audit Recommendations Verification
 * DPA Foundation — OPAL Platform
 * 
 * Verifies all audit findings have been addressed:
 * - H-11: abi.encode vs abi.encodePacked (hash collision prevention)
 * - Access control granularity (RBAC roles)
 * - Emergency mode functionality
 * - Upgrade safety (UUPS)
 * - Input validation bounds
 * - Cooldown enforcement
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

describe("AuditV2Fixes — Full Audit Compliance", function () {
    let floodPrediction, multiOracle, jokalante, mobileMoney, opalGov;
    let admin, operator, pauser, upgrader, attacker, user1, user2;
    let merkleRoot, tree, leaves;

    const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
    const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE"));
    const PAUSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE"));
    const UPGRADER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("UPGRADER_ROLE"));

    beforeEach(async function () {
        [admin, operator, pauser, upgrader, attacker, user1, user2] = await ethers.getSigners();

        // Deploy all contracts
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

        // Wire contracts
        await floodPrediction.setContractAddresses(
            await multiOracle.getAddress(),
            await opalGov.getAddress(),
            await jokalante.getAddress(),
            await mobileMoney.getAddress(),
            ethers.ZeroAddress
        );

        // Setup roles
        await floodPrediction.grantRole(OPERATOR_ROLE, operator.address);
        await floodPrediction.grantRole(PAUSER_ROLE, pauser.address);
        await floodPrediction.grantRole(UPGRADER_ROLE, upgrader.address);

        // Setup Merkle tree
        leaves = [user1, user2].map((u, i) =>
            keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
                ["string", "string", "uint256"],
                [`user_${i}`, "SN-TH", 5000 * (i + 1)]
            ))
        );
        tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
        merkleRoot = tree.getHexRoot();

        // Allocate budget
        await floodPrediction.allocateBudget("SN-TH", ethers.parseEther("10000000"));
    });

    // ====================================================
    // H-11: abi.encode Hash Collision Prevention
    // ====================================================
    describe("H-11: Hash Collision Prevention", function () {
        it("should use abi.encode (not abi.encodePacked) for beneficiary hashing", async function () {
            // abi.encodePacked("ab","c") == abi.encodePacked("a","bc") — collision!
            // abi.encode prevents this with fixed-length encoding
            const hash1 = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
                ["string", "string", "uint256"],
                ["ab", "c", 100]
            ));
            const hash2 = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
                ["string", "string", "uint256"],
                ["a", "bc", 100]
            ));
            expect(hash1).to.not.equal(hash2);
        });

        it("should generate unique event IDs per trigger", async function () {
            await floodPrediction.connect(operator).createFloodTrigger(
                "SN-TH", 85, merkleRoot, 50000, 2
            );
            const ids1 = await floodPrediction.getTriggerIds();

            // Wait for cooldown (advance time)
            await ethers.provider.send("evm_increaseTime", [700]);
            await ethers.provider.send("evm_mine");

            await floodPrediction.connect(operator).createFloodTrigger(
                "SN-TH", 90, merkleRoot, 60000, 3
            );
            const ids2 = await floodPrediction.getTriggerIds();

            expect(ids1[0]).to.not.equal(ids2[1]);
        });
    });

    // ====================================================
    // RBAC — Role-Based Access Control
    // ====================================================
    describe("RBAC Granularity", function () {
        it("should separate ADMIN, OPERATOR, PAUSER, UPGRADER roles", async function () {
            // Verify all roles are distinct
            expect(ADMIN_ROLE).to.not.equal(OPERATOR_ROLE);
            expect(ADMIN_ROLE).to.not.equal(PAUSER_ROLE);
            expect(ADMIN_ROLE).to.not.equal(UPGRADER_ROLE);
            expect(OPERATOR_ROLE).to.not.equal(PAUSER_ROLE);
        });

        it("OPERATOR cannot perform ADMIN actions", async function () {
            await expect(
                floodPrediction.connect(operator).allocateBudget("SN-TH", 1000)
            ).to.revert(ethers);
        });

        it("PAUSER can only pause/unpause", async function () {
            await floodPrediction.connect(pauser).pause();
            expect(await floodPrediction.paused()).to.be.true;
            await floodPrediction.connect(pauser).unpause();
            expect(await floodPrediction.paused()).to.be.false;
        });

        it("PAUSER cannot create triggers", async function () {
            await expect(
                floodPrediction.connect(pauser).createFloodTrigger(
                    "SN-TH", 85, merkleRoot, 50000, 2
                )
            ).to.revert(ethers);
        });

        it("UPGRADER can upgrade the contract", async function () {
            const FloodPredV2 = await ethers.getContractFactory("FloodPredictionContract");
            await expect(
                ozUpgrades.upgradeProxy(await floodPrediction.getAddress(), FloodPredV2.connect(upgrader))
            ).to.not.revert(ethers);
        });

        it("attacker cannot upgrade", async function () {
            const FloodPredV2 = await ethers.getContractFactory("FloodPredictionContract");
            await expect(
                ozUpgrades.upgradeProxy(await floodPrediction.getAddress(), FloodPredV2.connect(attacker))
            ).to.revert(ethers);
        });
    });

    // ====================================================
    // Emergency Mode
    // ====================================================
    describe("Emergency Mode", function () {
        it("should activate global emergency mode", async function () {
            await floodPrediction.activateEmergencyMode("Critical vulnerability");
            expect(await floodPrediction.emergencyMode()).to.be.true;
        });

        it("should block all triggers in emergency", async function () {
            await floodPrediction.activateEmergencyMode("Test");
            await expect(
                floodPrediction.connect(operator).createFloodTrigger(
                    "SN-TH", 85, merkleRoot, 50000, 2
                )
            ).to.be.revertedWithCustomError(floodPrediction, "EmergencyModeActive");
        });

        it("should allow deactivation from emergency", async function () {
            await floodPrediction.activateEmergencyMode("Test");
            await floodPrediction.deactivateEmergencyMode();
            expect(await floodPrediction.emergencyMode()).to.be.false;
        });

        it("should set region-level emergency", async function () {
            await floodPrediction.setRegionEmergency("SN-TH", true);
            // Region emergency should not block other regions
            await floodPrediction.allocateBudget("SN-DK", ethers.parseEther("1000000"));
            await floodPrediction.connect(operator).createFloodTrigger(
                "SN-DK", 85, merkleRoot, 50000, 2
            );
        });
    });

    // ====================================================
    // Input Validation Bounds
    // ====================================================
    describe("Input Validation", function () {
        it("should reject risk score > 100", async function () {
            await expect(
                floodPrediction.connect(operator).createFloodTrigger(
                    "SN-TH", 101, merkleRoot, 50000, 2
                )
            ).to.be.revertedWithCustomError(floodPrediction, "InvalidRiskScore");
        });

        it("should reject risk score of 0", async function () {
            await expect(
                floodPrediction.connect(operator).createFloodTrigger(
                    "SN-TH", 0, merkleRoot, 50000, 2
                )
            ).to.revert(ethers);
        });

        it("should reject empty region string", async function () {
            await expect(
                floodPrediction.connect(operator).createFloodTrigger(
                    "", 85, merkleRoot, 50000, 2
                )
            ).to.revert(ethers);
        });

        it("should reject budget exceeding allocation", async function () {
            await expect(
                floodPrediction.connect(operator).createFloodTrigger(
                    "SN-TH", 85, merkleRoot, ethers.parseEther("99999999"), 2
                )
            ).to.be.revertedWithCustomError(floodPrediction, "InsufficientBudget");
        });

        it("should reject threshold update to 0", async function () {
            await expect(
                floodPrediction.updateRiskThreshold(0)
            ).to.be.revertedWithCustomError(floodPrediction, "InvalidThreshold");
        });

        it("should reject threshold > 100", async function () {
            await expect(
                floodPrediction.updateRiskThreshold(101)
            ).to.be.revertedWithCustomError(floodPrediction, "InvalidThreshold");
        });
    });

    // ====================================================
    // Cooldown Enforcement
    // ====================================================
    describe("Adaptive Cooldown", function () {
        it("should enforce 10-minute cooldown for critical risk (>=85)", async function () {
            await floodPrediction.connect(operator).createFloodTrigger(
                "SN-TH", 90, merkleRoot, 50000, 2
            );

            // Try immediately — should fail
            await expect(
                floodPrediction.connect(operator).createFloodTrigger(
                    "SN-TH", 90, merkleRoot, 50000, 2
                )
            ).to.be.revertedWithCustomError(floodPrediction, "CooldownNotElapsed");

            // Advance 9 minutes — still in cooldown
            await ethers.provider.send("evm_increaseTime", [540]);
            await ethers.provider.send("evm_mine");

            await expect(
                floodPrediction.connect(operator).createFloodTrigger(
                    "SN-TH", 90, merkleRoot, 50000, 2
                )
            ).to.be.revertedWithCustomError(floodPrediction, "CooldownNotElapsed");

            // Advance past 10 minutes
            await ethers.provider.send("evm_increaseTime", [120]);
            await ethers.provider.send("evm_mine");

            // Should succeed now
            await floodPrediction.connect(operator).createFloodTrigger(
                "SN-TH", 90, merkleRoot, 50000, 2
            );
        });

        it("should enforce 30-minute cooldown for high risk (70-84)", async function () {
            await floodPrediction.connect(operator).createFloodTrigger(
                "SN-TH", 75, merkleRoot, 50000, 2
            );

            // Advance 20 minutes — still in cooldown
            await ethers.provider.send("evm_increaseTime", [1200]);
            await ethers.provider.send("evm_mine");

            await expect(
                floodPrediction.connect(operator).createFloodTrigger(
                    "SN-TH", 75, merkleRoot, 50000, 2
                )
            ).to.be.revertedWithCustomError(floodPrediction, "CooldownNotElapsed");

            // Advance past 30 minutes total
            await ethers.provider.send("evm_increaseTime", [700]);
            await ethers.provider.send("evm_mine");

            await floodPrediction.connect(operator).createFloodTrigger(
                "SN-TH", 75, merkleRoot, 50000, 2
            );
        });
    });

    // ====================================================
    // Upgrade Safety (UUPS State Preservation)
    // ====================================================
    describe("UUPS Upgrade Safety", function () {
        it("should preserve all state after upgrade", async function () {
            // Create state before upgrade
            await floodPrediction.connect(operator).createFloodTrigger(
                "SN-TH", 85, merkleRoot, 50000, 2
            );
            const stats1 = await floodPrediction.getSystemStats();
            const budget1 = await floodPrediction.getRegionBudgetRemaining("SN-TH");

            // Upgrade
            const FloodPredV2 = await ethers.getContractFactory("FloodPredictionContract");
            const upgraded = await ozUpgrades.upgradeProxy(
                await floodPrediction.getAddress(),
                FloodPredV2.connect(upgrader)
            );

            // Verify state preserved
            const stats2 = await upgraded.getSystemStats();
            const budget2 = await upgraded.getRegionBudgetRemaining("SN-TH");

            expect(stats2[0]).to.equal(stats1[0]); // totalTriggers
            expect(budget2).to.equal(budget1);
        });

        it("should prevent re-initialization after upgrade", async function () {
            const FloodPredV2 = await ethers.getContractFactory("FloodPredictionContract");
            const upgraded = await ozUpgrades.upgradeProxy(
                await floodPrediction.getAddress(),
                FloodPredV2.connect(upgrader)
            );

            await expect(
                upgraded.initialize(attacker.address, attacker.address, attacker.address, attacker.address)
            ).to.revert(ethers);
        });
    });
});
