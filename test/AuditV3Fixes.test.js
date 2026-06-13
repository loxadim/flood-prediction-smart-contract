/**
 * @title Audit Round 3 — Regression Tests
 * @description Locks in the fixes from the third (full-project) code audit:
 *  - MobileMoneyProvider: per-item PaymentInitiated in batch, confirm-on-expired, pause-gated retry
 *  - MultiOracle: getConsensus reflects freshness, consensus settled-per-round guard
 *  - OpalGovernance: active-signer recount, proposalType <-> approveUpgrade selector binding
 *  - KYCAMLCompliance: expired-VERIFIED renewal, reinstate keeps expiry / restores exact status
 *  - FloodPrediction: no fail-open on stale consensus, retry dispatch safety gates
 */
import { expect } from "chai";
import hre from "hardhat";
import { MerkleTree } from "merkletreejs";
import { createRequire } from "module";
import { upgrades as makeUpgrades } from "@openzeppelin/hardhat-upgrades";
const require = createRequire(import.meta.url);
const keccak256 = require("keccak256");

const connection = await hre.network.connect();
const { ethers, networkHelpers } = connection;
const ozUpgrades = await makeUpgrades(hre, connection);

const hash = (label) => ethers.keccak256(ethers.toUtf8Bytes(label));

describe("Audit Round 3 — Regression", function () {

    // =========================================================================
    //  MobileMoneyProvider
    // =========================================================================
    describe("MobileMoneyProvider", function () {
        let mmp, owner, relayer, other;
        const REGION = "SN-TH";
        const PHONE = hash("+221770000001");

        beforeEach(async function () {
            [owner, relayer, other] = await ethers.getSigners();
            const MMP = await ethers.getContractFactory("MobileMoneyProvider");
            mmp = await MMP.deploy();
            await mmp.waitForDeployment();
            await mmp.addRelayer(relayer.address);
        });

        it("A18: batchInitiatePayments emits a per-item PaymentInitiated for each beneficiary", async function () {
            const hashes = [hash("ben-1"), hash("ben-2")];
            const amounts = [5000, 7000];
            const phones = [hash("p1"), hash("p2")];
            const providers = [0, 1]; // ORANGE_MONEY, WAVE

            await expect(mmp.connect(relayer).batchInitiatePayments(hashes, amounts, phones, REGION, providers))
                .to.emit(mmp, "PaymentInitiated");

            // Both per-item events must be present (relayer settles each individually).
            const events = await mmp.queryFilter(mmp.filters.PaymentInitiated());
            expect(events.length).to.equal(2);
        });

        it("A?: confirmPayment on an expired payment reverts and leaves it PENDING (no rolled-back state)", async function () {
            await mmp.connect(relayer).initiatePayment(hash("ben-x"), 5000, PHONE, REGION, 0);
            const id = (await mmp.queryFilter(mmp.filters.PaymentInitiated()))[0].args[0];

            // Move past the 30-min timeout.
            await networkHelpers.time.increase(31 * 60);

            await expect(mmp.connect(relayer).confirmPayment(id, "REF"))
                .to.be.revertedWithCustomError(mmp, "PaymentExpiredError");

            // Still PENDING (status 0), pending count unchanged — the revert rolled nothing back
            // because the dead state changes were removed.
            const p = await mmp.getPayment(id);
            expect(p.status).to.equal(0); // PENDING
            expect(await mmp.pendingPaymentCount()).to.equal(1);
        });

        it("A?: retryPayment is blocked while the contract is paused", async function () {
            await mmp.connect(relayer).initiatePayment(hash("ben-y"), 5000, PHONE, REGION, 0);
            const id = (await mmp.queryFilter(mmp.filters.PaymentInitiated()))[0].args[0];
            await mmp.connect(relayer).failPayment(id, "provider down");

            await mmp.pause();
            await expect(mmp.connect(relayer).retryPayment(id))
                .to.be.revertedWithCustomError(mmp, "EnforcedPause");

            await mmp.unpause();
            await expect(mmp.connect(relayer).retryPayment(id)).to.not.revert(ethers);
        });
    });

    // =========================================================================
    //  MultiOracle
    // =========================================================================
    describe("MultiOracle", function () {
        let oracle, owner, o1, o2, o3, o4, o5;
        const REGION = "SN-TH";

        beforeEach(async function () {
            [owner, o1, o2, o3, o4, o5] = await ethers.getSigners();
            const MO = await ethers.getContractFactory("MultiOracle");
            oracle = await MO.deploy();
            await oracle.waitForDeployment();
            for (const [i, o] of [o1, o2, o3, o4, o5].entries()) {
                await oracle.registerOracle(o.address, `Oracle-${i}`);
            }
        });

        async function reachConsensus() {
            await oracle.connect(o1).submitData(REGION, 80, "WASDI");
            await oracle.connect(o2).submitData(REGION, 82, "CHIRPS");
            await oracle.connect(o3).submitData(REGION, 78, "GFS");
        }

        it("A22: getConsensus reports reached=false once stale, but preserves the timestamp", async function () {
            await reachConsensus();
            let c = await oracle.getConsensus(REGION);
            expect(c.reached).to.be.true;
            const ts = c.timestamp;
            expect(ts).to.be.greaterThan(0n);

            await networkHelpers.time.increase(3601); // past default 1h freshness
            c = await oracle.getConsensus(REGION);
            expect(c.reached).to.be.false;          // consistent with isConsensusReached()
            expect(c.timestamp).to.equal(ts);        // timestamp preserved (distinguishes stale from never)
            expect(await oracle.isConsensusReached(REGION)).to.be.false;
        });

        it("A23: a round is marked settled once consensus is computed (guards reveal re-runs)", async function () {
            expect(await oracle.consensusComputedForRound(REGION, 0)).to.be.false;
            await reachConsensus();
            expect(await oracle.consensusComputedForRound(REGION, 0)).to.be.true;
        });
    });

    // =========================================================================
    //  OpalGovernance
    // =========================================================================
    describe("OpalGovernanceUpgradeable", function () {
        let gov, owner, actor1, actor2;

        beforeEach(async function () {
            [owner, actor1, actor2] = await ethers.getSigners();
            const Gov = await ethers.getContractFactory("OpalGovernanceUpgradeable");
            gov = await ozUpgrades.deployProxy(Gov, [owner.address, 2], { kind: "uups" });
            await gov.waitForDeployment();
        });

        it("A25: a signature from an actor removed after signing no longer counts toward quorum", async function () {
            await gov.addGovernanceActor(actor1.address, "Gov1", "GOVERNOR");
            await gov.addGovernanceActor(actor2.address, "Gov2", "GOVERNOR");

            // owner creates (auto-signs) + actor1 signs => quorum (2) reached.
            await gov.connect(owner).createProposal(1, "no-op param change", "0x", "", ethers.ZeroAddress);
            await gov.connect(actor1).signProposal(0);

            // actor1 is removed before execution. activeActorCount 3 -> 2 (== quorum), allowed.
            await gov.removeGovernanceActor(actor1.address);
            await networkHelpers.time.increase(3601); // past EXECUTION_DELAY

            // owner is the only still-active signer => 1 < quorum 2 => revert.
            await expect(gov.connect(owner).executeProposal(0))
                .to.be.revertedWithCustomError(gov, "InsufficientSignatures");
        });

        it("A24: a non-UPGRADE proposal carrying approveUpgrade() is rejected", async function () {
            await gov.addGovernanceActor(actor1.address, "Gov1", "GOVERNOR");
            await gov.setAllowedTarget(gov.target, true);

            const newImpl = await (await ethers.getContractFactory("OpalGovernanceUpgradeable")).deploy();
            await newImpl.waitForDeployment();
            const data = gov.interface.encodeFunctionData("approveUpgrade", [newImpl.target]);

            // ProposalType.BUDGET_ALLOCATION = 2 (NOT UPGRADE=3), but data calls approveUpgrade.
            await gov.connect(owner).createProposal(2, "sneaky upgrade", data, "", gov.target);
            await gov.connect(actor1).signProposal(0);
            await networkHelpers.time.increase(3601);

            await expect(gov.connect(owner).executeProposal(0))
                .to.be.revertedWithCustomError(gov, "ProposalTypeSelectorMismatch");
        });

        it("A24: an UPGRADE proposal calling approveUpgrade() still succeeds", async function () {
            await gov.addGovernanceActor(actor1.address, "Gov1", "GOVERNOR");
            await gov.setAllowedTarget(gov.target, true);

            const newImpl = await (await ethers.getContractFactory("OpalGovernanceUpgradeable")).deploy();
            await newImpl.waitForDeployment();
            const data = gov.interface.encodeFunctionData("approveUpgrade", [newImpl.target]);

            await gov.connect(owner).createProposal(3, "legit upgrade", data, "", gov.target); // UPGRADE
            await gov.connect(actor1).signProposal(0);
            await networkHelpers.time.increase(3601);

            await expect(gov.connect(owner).executeProposal(0))
                .to.emit(gov, "ProposalExecuted");
            expect(await gov.approvedUpgrades(newImpl.target)).to.be.true;
        });
    });

    // =========================================================================
    //  KYCAMLCompliance
    // =========================================================================
    describe("KYCAMLCompliance", function () {
        let kyc, owner, officer1, officer2;
        const BEN = hash("ben-kyc");
        const ID = hash("id");
        const DOC = hash("doc");
        const REGION = "SN-TH";

        beforeEach(async function () {
            [owner, officer1, officer2] = await ethers.getSigners();
            const KYC = await ethers.getContractFactory("KYCAMLCompliance");
            kyc = await KYC.deploy();
            await kyc.waitForDeployment();
            await kyc.addComplianceOfficer(officer1.address);
            await kyc.addComplianceOfficer(officer2.address);
        });

        async function verify(ben, validity) {
            await kyc.connect(officer1).submitAttestation(ben, ID, DOC, REGION);
            await kyc.connect(officer2).approveAttestation(ben, 0, validity); // RiskLevel.LOW=0
        }

        it("A26: an expired VERIFIED attestation can be renewed through submit -> approve", async function () {
            await verify(BEN, 1000);
            await networkHelpers.time.increase(1001); // expire it

            // Renewal submit must NOT revert (previously reverted AttestationAlreadyExists).
            await expect(kyc.connect(officer1).submitAttestation(BEN, ID, DOC, REGION))
                .to.not.revert(ethers);
            expect((await kyc.attestations(BEN)).status).to.equal(1); // PENDING

            await kyc.connect(officer2).approveAttestation(BEN, 0, 1000);
            expect((await kyc.attestations(BEN)).status).to.equal(2); // VERIFIED
            expect(await kyc.isCompliant(BEN)).to.be.true;
        });

        it("A27: reinstate restores VERIFIED without granting a fresh validity window", async function () {
            await verify(BEN, 1000);
            const originalExpiry = (await kyc.attestations(BEN)).expiresAt;

            await kyc.connect(officer1).suspendBeneficiary(BEN, "review");
            await kyc.connect(officer1).reinstateBeneficiary(BEN);

            const att = await kyc.attestations(BEN);
            expect(att.status).to.equal(2); // VERIFIED
            // expiresAt unchanged — NOT reset to now + defaultValidityPeriod (365d).
            expect(att.expiresAt).to.equal(originalExpiry);
        });

        it("A27: reinstating a REJECTED beneficiary does not launder them into PENDING", async function () {
            await kyc.connect(officer1).submitAttestation(BEN, ID, DOC, REGION);
            await kyc.connect(officer2).rejectAttestation(BEN, "bad docs");
            expect((await kyc.attestations(BEN)).status).to.equal(3); // REJECTED

            await kyc.connect(officer1).suspendBeneficiary(BEN, "flagged");
            await kyc.connect(officer1).reinstateBeneficiary(BEN);

            // Restored to the EXACT prior status (REJECTED), not upgraded to PENDING.
            expect((await kyc.attestations(BEN)).status).to.equal(3); // REJECTED
        });
    });

    // =========================================================================
    //  FloodPrediction
    // =========================================================================
    describe("FloodPredictionContract", function () {
        let fpc, mo, gov, jt, mmp;
        let admin, operator, upgrader, pauser, o1, o2, o3;
        const REGION = "SN-TH";

        function buildTree(data) {
            const leaves = data.map(b =>
                ethers.keccak256(ethers.keccak256(
                    ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [b.hash, b.amount])
                ))
            );
            const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
            return { tree, root: tree.getHexRoot() };
        }

        beforeEach(async function () {
            [admin, operator, upgrader, pauser, o1, o2, o3] = await ethers.getSigners();

            mo = await (await ethers.getContractFactory("MultiOracle")).deploy();
            await mo.waitForDeployment();
            gov = await ozUpgrades.deployProxy(
                await ethers.getContractFactory("OpalGovernanceUpgradeable"), [admin.address, 2], { kind: "uups" });
            await gov.waitForDeployment();
            jt = await (await ethers.getContractFactory("JokalanteTargeting")).deploy();
            await jt.waitForDeployment();
            mmp = await (await ethers.getContractFactory("MobileMoneyProvider")).deploy();
            await mmp.waitForDeployment();

            fpc = await ozUpgrades.deployProxy(
                await ethers.getContractFactory("FloodPredictionContract"),
                [admin.address, operator.address, upgrader.address, pauser.address], { kind: "uups" });
            await fpc.waitForDeployment();

            await fpc.setContractAddresses(mo.target, gov.target, jt.target, mmp.target, ethers.ZeroAddress);
            await fpc.allocateBudget(REGION, 100_000_000);
        });

        it("A19: createFloodTrigger reverts on STALE oracle consensus instead of failing open", async function () {
            // Reach a fresh consensus, then let it go stale.
            for (const [i, o] of [o1, o2, o3].entries()) await mo.registerOracle(o.address, `O${i}`);
            // need >= MIN_ORACLE_COUNT (4) active; register a 4th + 5th
            await mo.registerOracle(admin.address, "O3");
            await mo.registerOracle(upgrader.address, "O4");
            await mo.connect(o1).submitData(REGION, 80, "WASDI");
            await mo.connect(o2).submitData(REGION, 82, "CHIRPS");
            await mo.connect(o3).submitData(REGION, 78, "GFS");
            expect(await mo.isConsensusReached(REGION)).to.be.true;

            await networkHelpers.time.increase(3601); // consensus now stale

            const { root } = buildTree([{ hash: hash("b1"), amount: 25000 }]);
            await expect(
                fpc.connect(operator).createFloodTrigger(REGION, 80, root, 50000, 1)
            ).to.be.revertedWithCustomError(fpc, "StaleOracleConsensus");
        });

        it("A19: cold-start (no consensus ever) is still allowed for bootstrap", async function () {
            const { root } = buildTree([{ hash: hash("b1"), amount: 25000 }]);
            await expect(
                fpc.connect(operator).createFloodTrigger(REGION, 80, root, 50000, 1)
            ).to.not.revert(ethers);
        });

        it("A21: retryMobileMoneyDispatch is blocked during emergency mode", async function () {
            const { root } = buildTree([{ hash: hash("b1"), amount: 25000 }]);
            await fpc.connect(operator).createFloodTrigger(REGION, 80, root, 50000, 1);
            const eventId = await fpc.triggerIds(0); // real stored eventId

            await fpc.connect(admin).activateEmergencyMode("incident");

            await expect(
                fpc.connect(operator).retryMobileMoneyDispatch(eventId, [hash("b1")], [25000], [hash("p1")], [0])
            ).to.be.revertedWithCustomError(fpc, "EmergencyModeActive");
        });
    });
});
