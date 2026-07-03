/**
 * @title Audit Round 4 — Regression Tests
 * @description Locks in the fixes from the fourth (full-project) code audit:
 *  - FloodPrediction: leftover committedBudget released when a trigger reaches PAID,
 *    validateTrigger pause-gated
 *  - KYCAMLCompliance: fraud alerts / screening recordable on suspended beneficiaries,
 *    SANCTIONED approval records statusBeforeSuspension + risk level, rejectedCount
 *    stays accurate across re-submissions
 *  - OpalGovernance: initial quorum bounded by MAX_ACTORS
 *  - Relayer: unconfigured provider fails (never fakes success) in production mode,
 *    webhook signature validation never throws on malformed input
 */
import { expect } from "chai";
import hre from "hardhat";
import { MerkleTree } from "merkletreejs";
import { createRequire } from "module";
import { upgrades as makeUpgrades } from "@openzeppelin/hardhat-upgrades";
import { executeProviderPayment } from "../relayer/providers.js";
import { validateWebhookSignature } from "../relayer/crypto.js";
import { auditLogger } from "../relayer/security.js";
const require = createRequire(import.meta.url);
const keccak256 = require("keccak256");

const connection = await hre.network.connect();
const { ethers } = connection;
const ozUpgrades = await makeUpgrades(hre, connection);

const hash = (label) => ethers.keccak256(ethers.toUtf8Bytes(label));

function buildTree(data) {
    const leaves = data.map(b =>
        ethers.keccak256(ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [b.hash, b.amount])
        ))
    );
    const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
    return { tree, root: tree.getHexRoot(), leaves };
}

describe("Audit Round 4 — Regression", function () {

    // =========================================================================
    //  FloodPredictionContract
    // =========================================================================
    describe("FloodPredictionContract", function () {
        let fpc, mo, mmp;
        let admin, operator, upgrader, pauser;
        const REGION = "SN-TH";

        beforeEach(async function () {
            [admin, operator, upgrader, pauser] = await ethers.getSigners();

            mo = await (await ethers.getContractFactory("MultiOracle")).deploy();
            await mo.waitForDeployment();
            mmp = await (await ethers.getContractFactory("MobileMoneyProvider")).deploy();
            await mmp.waitForDeployment();

            fpc = await ozUpgrades.deployProxy(
                await ethers.getContractFactory("FloodPredictionContract"),
                [admin.address, operator.address, upgrader.address, pauser.address], { kind: "uups" });
            await fpc.waitForDeployment();

            await fpc.setContractAddresses(mo.target, ethers.ZeroAddress, ethers.ZeroAddress, mmp.target, ethers.ZeroAddress);
            await mmp.addRelayer(fpc.target);
            await fpc.allocateBudget(REGION, 1_000_000);
        });

        it("A31: releases leftover committed budget when a trigger reaches PAID under its declared total", async function () {
            // Trigger declares 100_000 for 1 beneficiary; actual payout is 25_000.
            const b1 = hash("b1");
            const { tree, root, leaves } = buildTree([{ hash: b1, amount: 25_000 }]);
            await fpc.connect(operator).createFloodTrigger(REGION, 80, root, 100_000, 1);
            const eventId = await fpc.triggerIds(0);
            expect(await fpc.committedBudget(REGION)).to.equal(100_000);

            const proof = tree.getHexProof(leaves[0]);
            await expect(
                fpc.connect(operator).validateAndProcessPayments(eventId, [b1], [25_000], [proof], [hash("p1")], [0])
            ).to.emit(fpc, "BudgetCommitmentReleased").withArgs(REGION, 75_000, eventId);

            expect((await fpc.getFloodTrigger(eventId)).status).to.equal(4); // PAID
            expect(await fpc.committedBudget(REGION)).to.equal(0);
            // Full unspent budget is available again for future triggers
            expect(await fpc.getRegionBudgetRemaining(REGION)).to.equal(975_000);
        });

        it("A31: releases nothing when the trigger spends exactly its declared total", async function () {
            const b1 = hash("b1-exact");
            const { tree, root, leaves } = buildTree([{ hash: b1, amount: 25_000 }]);
            await fpc.connect(operator).createFloodTrigger(REGION, 80, root, 25_000, 1);
            const eventId = await fpc.triggerIds(0);

            const proof = tree.getHexProof(leaves[0]);
            await fpc.connect(operator).validateAndProcessPayments(eventId, [b1], [25_000], [proof], [hash("p1")], [0]);

            expect((await fpc.getFloodTrigger(eventId)).status).to.equal(4); // PAID
            expect(await fpc.committedBudget(REGION)).to.equal(0);
            expect(await fpc.getRegionBudgetRemaining(REGION)).to.equal(975_000);
        });

        it("A36: validateTrigger is blocked while the contract is paused", async function () {
            const { root } = buildTree([{ hash: hash("b1"), amount: 25_000 }]);
            await fpc.connect(operator).createFloodTrigger(REGION, 80, root, 50_000, 1);
            const eventId = await fpc.triggerIds(0);

            await fpc.connect(pauser).pause();
            await expect(fpc.connect(operator).validateTrigger(eventId))
                .to.be.revertedWithCustomError(fpc, "EnforcedPause");

            await fpc.connect(pauser).unpause();
            await expect(fpc.connect(operator).validateTrigger(eventId))
                .to.emit(fpc, "TriggerValidated");
        });
    });

    // =========================================================================
    //  KYCAMLCompliance
    // =========================================================================
    describe("KYCAMLCompliance", function () {
        let kyc, owner, officer2;
        const BEN = hash("ben-audit4");

        beforeEach(async function () {
            [owner, officer2] = await ethers.getSigners();
            kyc = await (await ethers.getContractFactory("KYCAMLCompliance")).deploy();
            await kyc.waitForDeployment();
            await kyc.addComplianceOfficer(officer2.address);
        });

        it("A32: fraud alerts remain recordable after auto-suspension", async function () {
            await kyc.submitAttestation(BEN, hash("id"), hash("doc"), "SN-TH");

            await kyc.raiseFraudAlert(BEN, "SIM_SWAP");
            await kyc.raiseFraudAlert(BEN, "DUPLICATE_CLAIM");
            await kyc.raiseFraudAlert(BEN, "IDENTITY_MISMATCH"); // threshold hit -> suspended
            expect((await kyc.getAttestation(BEN)).status).to.equal(5); // SUSPENDED

            // 4th alert must be recorded, not reverted
            await expect(kyc.raiseFraudAlert(BEN, "NEW_EVIDENCE"))
                .to.emit(kyc, "FraudAlertRaised");
            expect(await kyc.fraudAlertCount(BEN)).to.equal(4);
            expect((await kyc.getAttestation(BEN)).status).to.equal(5); // still SUSPENDED
        });

        it("A32: sanctions screening remains recordable on an already-suspended beneficiary", async function () {
            await kyc.submitAttestation(BEN, hash("id"), hash("doc"), "SN-TH");
            await kyc.suspendBeneficiary(BEN, "manual");

            await expect(kyc.recordScreening(BEN, {
                isCleared: false, sanctionsChecked: true, pepChecked: true,
                screenedAt: Math.floor(Date.now() / 1000), screeningProvider: "OFAC",
            })).to.emit(kyc, "ScreeningRecorded");

            const screening = await kyc.getScreeningResult(BEN);
            expect(screening.isCleared).to.be.false;
            expect(screening.sanctionsChecked).to.be.true;
        });

        it("A33: SANCTIONED approval records prior status and risk level for reinstatement", async function () {
            await kyc.submitAttestation(BEN, hash("id"), hash("doc"), "SN-TH"); // PENDING (by owner)
            await kyc.connect(officer2).approveAttestation(BEN, 3 /* SANCTIONED */, 0);

            let att = await kyc.getAttestation(BEN);
            expect(att.status).to.equal(5); // SUSPENDED
            expect(att.riskLevel).to.equal(3); // SANCTIONED persisted for the audit trail

            await kyc.reinstateBeneficiary(BEN);
            att = await kyc.getAttestation(BEN);
            expect(att.status).to.equal(1); // PENDING restored (was NOT_VERIFIED before fix)
        });

        it("A37: rejectedCount is decremented when a REJECTED beneficiary re-submits", async function () {
            await kyc.submitAttestation(BEN, hash("id"), hash("doc"), "SN-TH");
            await kyc.rejectAttestation(BEN, "incomplete documents");
            let stats = await kyc.getComplianceStats();
            expect(stats.rejected).to.equal(1);

            await kyc.submitAttestation(BEN, hash("id-2"), hash("doc-2"), "SN-TH");
            stats = await kyc.getComplianceStats();
            expect(stats.rejected).to.equal(0);
            expect((await kyc.getAttestation(BEN)).status).to.equal(1); // PENDING
        });
    });

    // =========================================================================
    //  OpalGovernanceUpgradeable
    // =========================================================================
    describe("OpalGovernanceUpgradeable", function () {
        it("A48: initialize rejects a quorum above MAX_ACTORS (permanently unmeetable)", async function () {
            const [admin] = await ethers.getSigners();
            const Gov = await ethers.getContractFactory("OpalGovernanceUpgradeable");

            let failed = false;
            try {
                await ozUpgrades.deployProxy(Gov, [admin.address, 21], { kind: "uups" });
            } catch {
                failed = true;
            }
            expect(failed, "quorum 21 > MAX_ACTORS (20) should revert").to.be.true;

            // Boundary: exactly MAX_ACTORS is accepted
            const gov = await ozUpgrades.deployProxy(Gov, [admin.address, 20], { kind: "uups" });
            await gov.waitForDeployment();
            expect(await gov.quorum()).to.equal(20);
        });
    });

    // =========================================================================
    //  Relayer (off-chain)
    // =========================================================================
    describe("Relayer", function () {
        const savedEnv = {};
        const ENV_KEYS = [
            "SIMULATE_PAYMENTS",
            "ORANGE_MONEY_API_KEY", "WAVE_API_KEY", "FREE_MONEY_API_KEY", "EMONEY_API_KEY",
            "ORANGE_MONEY_API_URL", "WAVE_API_URL", "FREE_MONEY_API_URL", "EMONEY_API_URL",
            "PRIVATE_KEY", "MOBILE_MONEY_PROVIDER_ADDRESS",
        ];

        before(async function () {
            for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
            process.env.PRIVATE_KEY = process.env.PRIVATE_KEY
                || "0x0000000000000000000000000000000000000000000000000000000000000001";
            process.env.MOBILE_MONEY_PROVIDER_ADDRESS = process.env.MOBILE_MONEY_PROVIDER_ADDRESS
                || "0x1234567890123456789012345678901234567890";
            await auditLogger.initialize();
        });

        after(function () {
            for (const key of ENV_KEYS) {
                if (savedEnv[key] === undefined) delete process.env[key];
                else process.env[key] = savedEnv[key];
            }
        });

        it("A40: an unconfigured provider FAILS the payment in production mode (no fake success)", async function () {
            process.env.SIMULATE_PAYMENTS = "false";
            for (const key of ["ORANGE_MONEY_API_KEY", "WAVE_API_KEY", "FREE_MONEY_API_KEY", "EMONEY_API_KEY"]) {
                delete process.env[key];
            }

            for (const provider of ["ORANGE_MONEY", "WAVE", "FREE_MONEY", "EMONEY"]) {
                const result = await executeProviderPayment(provider, {
                    paymentId: "0xaudit4-a40",
                    beneficiaryHash: "0xbene",
                    phoneNumber: "+221770000000",
                    amount: 1500,
                    region: "SN-TH",
                    externalReference: "ref-a40",
                });
                expect(result.success, `${provider} must not fake a success`).to.be.false;
                expect(result.reason).to.equal("PROVIDER_NOT_CONFIGURED");
            }
        });

        it("A40: simulation mode still short-circuits before reaching the adapters", async function () {
            process.env.SIMULATE_PAYMENTS = "true";
            const result = await executeProviderPayment("ORANGE_MONEY", {
                paymentId: "0xaudit4-sim",
                beneficiaryHash: "0xbene",
                phoneNumber: "+221770000000",
                amount: 1500,
                region: "SN-TH",
                externalReference: "ref-sim",
            });
            expect(result.success).to.be.true;
            expect(result.transactionRef).to.include("SIMULATED");
        });

        it("A44: validateWebhookSignature returns false (does not throw) on malformed signatures", function () {
            const payload = { paymentId: "0xabc", status: "SUCCESS" };
            const secret = "webhook-secret";

            // Wrong length: previously threw ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH
            expect(validateWebhookSignature(payload, "sha256=short", secret)).to.be.false;
            expect(validateWebhookSignature(payload, "", secret)).to.be.false;

            // Correct signature still validates
            const crypto = require("node:crypto");
            const good = "sha256=" + crypto.createHmac("sha256", secret)
                .update(JSON.stringify(payload)).digest("hex");
            expect(validateWebhookSignature(payload, good, secret)).to.be.true;
        });
    });
});
