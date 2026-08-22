/**
 * @title Audit Round 5 — Regression Tests
 * @description Locks in the fixes from the fifth (full-project) local audit:
 *  - OpalGovernance A49: a reinstated actor is pushed back onto actorList, so
 *    executeProposal()'s active-signature recount sees their signature
 *  - OpalGovernance A50: rejectProposal compares against the proposal's frozen
 *    requiredSignatures, not the live quorum
 *  - MultiOracle A51: the commit-reveal hash is bound to msg.sender, so a
 *    commitment cannot be copied and replayed
 *  - MultiOracle A52: deregisterOracle reclaims a MAX_ORACLES slot
 *  - MultiOracle A53: a round advances on the A23 consensus flag, not on a
 *    timestamp comparison that also fired for same-block submissions
 *  - KYCAMLCompliance A54: a zero identityHash is rejected at submission
 *  - MobileMoneyProvider A55: an EXPIRED payment can be retried
 *  - JokalanteTargeting A56: region expiry extendable without rotating the root
 */
import { expect } from "chai";
import hre from "hardhat";
import { upgrades as makeUpgrades } from "@openzeppelin/hardhat-upgrades";
import { sanitizeForLogging } from "../relayer/crypto.js";

const connection = await hre.network.connect();
const { ethers, networkHelpers, provider } = connection;
const ozUpgrades = await makeUpgrades(hre, connection);

const hash = (label) => ethers.keccak256(ethers.toUtf8Bytes(label));

/** A51: commit hash must be bound to the committing oracle's address. */
function commitHash(oracle, region, riskScore, dataSource, salt) {
    return ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
            ["address", "string", "uint256", "string", "bytes32"],
            [oracle, region, riskScore, dataSource, salt]
        )
    );
}

describe("Audit Round 5 — Regression", function () {

    // =========================================================================
    //  OpalGovernanceUpgradeable
    // =========================================================================
    describe("OpalGovernanceUpgradeable", function () {
        let gov, owner, a1, a2, a3;

        async function deploy(quorum) {
            const Gov = await ethers.getContractFactory("OpalGovernanceUpgradeable");
            const g = await ozUpgrades.deployProxy(Gov, [owner.address, quorum], { kind: "uups" });
            await g.waitForDeployment();
            return g;
        }

        beforeEach(async function () {
            [owner, a1, a2, a3] = await ethers.getSigners();
            gov = await deploy(2);
        });

        it("A49: a reinstated actor is pushed back onto actorList", async function () {
            // a2 keeps activeActorCount above quorum so a1 is removable
            await gov.addGovernanceActor(a1.address, "A1", "GOVERNOR");
            await gov.addGovernanceActor(a2.address, "A2", "GOVERNOR");
            expect((await gov.getActorList()).length).to.equal(3);

            await gov.removeGovernanceActor(a1.address);
            expect((await gov.getActorList()).length).to.equal(2);

            await gov.addGovernanceActor(a1.address, "A1-new", "GOVERNOR");

            const list = await gov.getActorList();
            expect(list.length).to.equal(3);
            expect(list).to.include(a1.address);
            // the invariant that A49 restores: the two counters agree
            expect(await gov.activeActorCount()).to.equal(BigInt(list.length));
        });

        it("A49: a reinstated actor's signature counts toward execution", async function () {
            await gov.addGovernanceActor(a1.address, "A1", "GOVERNOR");
            await gov.addGovernanceActor(a2.address, "A2", "GOVERNOR");
            await gov.removeGovernanceActor(a1.address);
            await gov.addGovernanceActor(a1.address, "A1-new", "GOVERNOR");

            // a1 proposes (auto-signs), owner signs -> 2 active signers == quorum
            await gov.connect(a1).createProposal(1, "reinstated actor", "0x", "SN-TH", ethers.ZeroAddress);
            await gov.connect(owner).signProposal(0);
            await networkHelpers.time.increase(3700); // clear EXECUTION_DELAY

            await expect(gov.connect(owner).executeProposal(0))
                .to.emit(gov, "ProposalExecuted");
        });

        it("A49: repeated key rotations never push quorum out of reach", async function () {
            gov = await deploy(3);
            await gov.addGovernanceActor(a1.address, "A1", "GOVERNOR");
            await gov.addGovernanceActor(a2.address, "A2", "GOVERNOR");
            await gov.addGovernanceActor(a3.address, "A3", "GOVERNOR");

            for (const actor of [a1, a2]) {
                await gov.removeGovernanceActor(actor.address);
                await gov.addGovernanceActor(actor.address, "rotated", "GOVERNOR");
            }

            expect((await gov.getActorList()).length).to.equal(4);

            await gov.connect(owner).createProposal(1, "after rotations", "0x", "SN-TH", ethers.ZeroAddress);
            for (const s of [a1, a2, a3]) await gov.connect(s).signProposal(0);
            await networkHelpers.time.increase(3700);

            await expect(gov.connect(owner).executeProposal(0))
                .to.emit(gov, "ProposalExecuted");
        });

        it("A50: rejection uses the proposal's frozen requiredSignatures", async function () {
            await gov.addGovernanceActor(a1.address, "A1", "GOVERNOR");
            await gov.addGovernanceActor(a2.address, "A2", "GOVERNOR");
            await gov.addGovernanceActor(a3.address, "A3", "GOVERNOR");

            // proposal created while quorum == 2, so requiredSignatures == 2
            await gov.connect(a1).createProposal(1, "reject me", "0x", "SN-TH", ethers.ZeroAddress);
            expect((await gov.getProposal(0)).requiredSignatures).to.equal(2);

            // quorum is raised afterwards; the proposal must keep answering to 2
            await gov.updateQuorum(4);
            expect(await gov.quorum()).to.equal(4);

            await gov.connect(a2).rejectProposal(0);
            expect((await gov.getProposal(0)).status).to.equal(0); // still PENDING (1 of 2)

            await gov.connect(a3).rejectProposal(0);
            expect((await gov.getProposal(0)).status).to.equal(3); // REJECTED at 2 of 2
        });
    });

    // =========================================================================
    //  MultiOracle
    // =========================================================================
    describe("MultiOracle", function () {
        let mo, owner, o1, o2, o3, o4, signers;
        const REGION = "SN-TH";

        beforeEach(async function () {
            signers = await ethers.getSigners();
            [owner, o1, o2, o3, o4] = signers;
            const MO = await ethers.getContractFactory("MultiOracle");
            mo = await MO.deploy();
            await mo.waitForDeployment();
            for (let i = 1; i <= 4; i++) await mo.registerOracle(signers[i].address, `O${i}`);
        });

        it("A51: a copied commitment cannot be revealed by another oracle", async function () {
            const salt = hash("o1-secret-salt");
            const h = commitHash(o1.address, REGION, 77, "WASDI", salt);

            await mo.connect(o1).commitData(REGION, h);
            // o2 copies o1's commit hash straight off the chain
            await mo.connect(o2).commitData(REGION, h);

            await networkHelpers.time.increase(130); // past COMMIT_PHASE_DURATION

            await expect(mo.connect(o1).revealData(REGION, 77, "WASDI", salt))
                .to.emit(mo, "DataRevealed");

            // o2 replays the now-public values against its copied commitment
            await expect(mo.connect(o2).revealData(REGION, 77, "WASDI", salt))
                .to.be.revertedWithCustomError(mo, "InvalidReveal");

            const round = await mo.currentRound(REGION);
            expect(await mo.getRegionSubmissionCount(REGION, round)).to.equal(1n);
        });

        it("A51: an oracle's own commitment still reveals normally", async function () {
            const salt = hash("o1-salt");
            await mo.connect(o1).commitData(REGION, commitHash(o1.address, REGION, 65, "WASDI", salt));
            await networkHelpers.time.increase(130);

            await expect(mo.connect(o1).revealData(REGION, 65, "WASDI", salt))
                .to.emit(mo, "DataRevealed")
                .withArgs(o1.address, REGION, 65);
        });

        it("A52: deregisterOracle frees a MAX_ORACLES slot", async function () {
            for (let i = 5; i <= 10; i++) await mo.registerOracle(signers[i].address, `O${i}`);
            expect(await mo.getOracleCount()).to.equal(10);

            await expect(mo.registerOracle(signers[11].address, "NEW"))
                .to.be.revertedWithCustomError(mo, "MaxOraclesReached");

            await mo.deactivateOracle(signers[10].address);
            await expect(mo.deregisterOracle(signers[10].address))
                .to.emit(mo, "OracleDeregistered")
                .withArgs(signers[10].address);

            expect(await mo.getOracleCount()).to.equal(9);
            const list = await mo.getAllOracles();
            expect(list).to.not.include(signers[10].address);

            // the freed slot is usable, and the new oracle lands in oracleList
            await mo.registerOracle(signers[11].address, "NEW");
            expect(await mo.getOracleCount()).to.equal(10);
            expect(await mo.getAllOracles()).to.include(signers[11].address);
        });

        it("A52: an active oracle cannot be deregistered", async function () {
            await expect(mo.deregisterOracle(o1.address))
                .to.be.revertedWithCustomError(mo, "OracleStillActive");
        });

        it("A52: a deregistered oracle can re-register with a clean history", async function () {
            await mo.connect(o1).submitData(REGION, 70, "WASDI");
            expect((await mo.getOracleInfo(o1.address)).totalSubmissions).to.equal(1);

            await mo.deactivateOracle(o1.address);
            await mo.deregisterOracle(o1.address);
            expect((await mo.getOracleInfo(o1.address)).registeredAt).to.equal(0);

            await mo.registerOracle(o1.address, "O1-again");
            const info = await mo.getOracleInfo(o1.address);
            expect(info.reputation).to.equal(50); // INITIAL_REPUTATION
            expect(info.totalSubmissions).to.equal(0);
            expect(info.isActive).to.be.true;
        });

        it("A53: submissions sharing the consensus block stay in one round", async function () {
            await mo.connect(o1).submitData(REGION, 70, "WASDI");
            await mo.connect(o2).submitData(REGION, 72, "WASDI");

            // A relayer flushing its queue puts the consensus-triggering tx and the
            // follow-up submissions into the SAME block.
            await provider.request({ method: "evm_setAutomine", params: [false] });
            await mo.connect(o3).submitData(REGION, 74, "WASDI"); // reaches consensus in round 0
            await mo.connect(o4).submitData(REGION, 71, "WASDI");
            await mo.connect(o1).submitData(REGION, 73, "WASDI");
            await mo.connect(o2).submitData(REGION, 75, "WASDI");
            await provider.request({ method: "evm_mine", params: [] });
            await provider.request({ method: "evm_setAutomine", params: [true] });

            expect(await mo.isConsensusReached(REGION)).to.be.true;

            // Exactly one new round opened, holding all three post-consensus submissions —
            // previously each submission opened its own single-entry round.
            const round = await mo.currentRound(REGION);
            expect(round).to.equal(1n);
            expect(await mo.getRegionSubmissionCount(REGION, round)).to.equal(3n);
            expect(await mo.getRegionSubmissionCount(REGION, 0)).to.equal(3n);
        });

        it("A53: a stale round still advances", async function () {
            await mo.connect(o1).submitData(REGION, 70, "WASDI");
            const round = await mo.currentRound(REGION);

            await networkHelpers.time.increase(3700); // past dataFreshnessThreshold (1h)
            await mo.connect(o2).submitData(REGION, 71, "WASDI");

            expect(await mo.currentRound(REGION)).to.equal(round + 1n);
        });
    });

    // =========================================================================
    //  KYCAMLCompliance
    // =========================================================================
    describe("KYCAMLCompliance", function () {
        let kyc, owner, officer;

        beforeEach(async function () {
            [owner, officer] = await ethers.getSigners();
            const KYC = await ethers.getContractFactory("KYCAMLCompliance");
            kyc = await KYC.deploy();
            await kyc.waitForDeployment();
            await kyc.addComplianceOfficer(officer.address);
        });

        it("A54: a zero identityHash is rejected at submission", async function () {
            await expect(
                kyc.connect(officer).submitAttestation(hash("ben-1"), ethers.ZeroHash, hash("doc"), "SN-TH")
            ).to.be.revertedWithCustomError(kyc, "InvalidIdentityHash");

            // nothing was recorded, so the beneficiary is not bricked
            expect(await kyc.totalAttestations()).to.equal(0);
        });

        it("A54: the beneficiary stays usable after a rejected zero-hash submission", async function () {
            const bh = hash("ben-1");
            await expect(
                kyc.connect(officer).submitAttestation(bh, ethers.ZeroHash, hash("doc"), "SN-TH")
            ).to.be.revertedWithCustomError(kyc, "InvalidIdentityHash");

            // a correct submission still goes through the normal submit -> approve flow
            await kyc.connect(officer).submitAttestation(bh, hash("id"), hash("doc"), "SN-TH");
            await kyc.connect(owner).approveAttestation(bh, 0, 0); // owner != submitter (4-eyes)

            expect((await kyc.getAttestation(bh)).status).to.equal(2); // VERIFIED
        });
    });

    // =========================================================================
    //  MobileMoneyProvider
    // =========================================================================
    describe("MobileMoneyProvider", function () {
        let mmp, owner, relayer;

        async function initiate(amount = 50000) {
            const tx = await mmp.connect(relayer)
                .initiatePayment(hash("ben-1"), amount, hash("phone-1"), "SN-TH", 0);
            const rc = await tx.wait();
            const ev = rc.logs
                .map(l => { try { return mmp.interface.parseLog(l); } catch { return null; } })
                .find(e => e && e.name === "PaymentInitiated");
            return ev.args[0];
        }

        beforeEach(async function () {
            [owner, relayer] = await ethers.getSigners();
            const MMP = await ethers.getContractFactory("MobileMoneyProvider");
            mmp = await MMP.deploy();
            await mmp.waitForDeployment();
            await mmp.addRelayer(relayer.address);
        });

        it("A55: an EXPIRED payment can be retried", async function () {
            const paymentId = await initiate();

            await networkHelpers.time.increase(3600); // past the 30-min default timeout
            await mmp.connect(relayer).expireStalePayments([paymentId]);
            expect(await mmp.getPaymentStatus(paymentId)).to.equal(3); // EXPIRED

            await expect(mmp.connect(relayer).retryPayment(paymentId))
                .to.emit(mmp, "PaymentRetried")
                .withArgs(paymentId, 1);

            const payment = await mmp.getPayment(paymentId);
            expect(payment.status).to.equal(0); // PENDING
            expect(payment.retryCount).to.equal(1);
            expect(await mmp.getPendingPaymentCount()).to.equal(1);
        });

        it("A55: a retried expired payment can then be confirmed", async function () {
            const paymentId = await initiate();
            await networkHelpers.time.increase(3600);
            await mmp.connect(relayer).expireStalePayments([paymentId]);
            await mmp.connect(relayer).retryPayment(paymentId);

            await expect(mmp.connect(relayer).confirmPayment(paymentId, "TX-REF-1"))
                .to.emit(mmp, "PaymentConfirmed");
            expect(await mmp.getTotalDisbursed()).to.equal(50000);
        });

        it("A55: retrying an expired payment re-reserves the daily allowance", async function () {
            await mmp.setDailyLimit("SN-TH", 60000);
            const paymentId = await initiate(50000);
            expect(await mmp.getRemainingDailyLimit("SN-TH")).to.equal(10000);

            await networkHelpers.time.increase(3600);
            await mmp.connect(relayer).expireStalePayments([paymentId]);
            expect(await mmp.getRemainingDailyLimit("SN-TH")).to.equal(60000); // refunded

            await mmp.connect(relayer).retryPayment(paymentId);
            expect(await mmp.getRemainingDailyLimit("SN-TH")).to.equal(10000); // re-reserved
        });

        it("A55: MAX_RETRIES still bounds expired-payment retries", async function () {
            const paymentId = await initiate();
            for (let i = 0; i < 3; i++) {
                await networkHelpers.time.increase(3600);
                await mmp.connect(relayer).expireStalePayments([paymentId]);
                await mmp.connect(relayer).retryPayment(paymentId);
            }
            await networkHelpers.time.increase(3600);
            await mmp.connect(relayer).expireStalePayments([paymentId]);

            await expect(mmp.connect(relayer).retryPayment(paymentId))
                .to.be.revertedWithCustomError(mmp, "MaxRetriesExceeded");
        });

        it("A55: a CONFIRMED payment is still not retryable", async function () {
            const paymentId = await initiate();
            await mmp.connect(relayer).confirmPayment(paymentId, "TX-REF-1");

            await expect(mmp.connect(relayer).retryPayment(paymentId))
                .to.be.revertedWithCustomError(mmp, "PaymentNotPending");
        });
    });

    // =========================================================================
    //  JokalanteTargeting
    // =========================================================================
    describe("JokalanteTargeting", function () {
        let targeting, owner;
        const REGION = "SN-TH";
        const ROOT = "0x" + "ab".repeat(32);

        beforeEach(async function () {
            [owner] = await ethers.getSigners();
            const JT = await ethers.getContractFactory("JokalanteTargeting");
            targeting = await JT.deploy();
            await targeting.waitForDeployment();
            await targeting.updateMerkleRoot(REGION, ROOT, 100);
        });

        it("A56: expiry is extendable without rotating the root", async function () {
            const before = (await targeting.getTargetingCriteria(REGION)).expiresAt;

            await expect(targeting.extendRegionExpiry(REGION, 30 * 24 * 3600))
                .to.emit(targeting, "RegionExpiryExtended");

            const after = await targeting.getTargetingCriteria(REGION);
            expect(after.expiresAt).to.equal(before + BigInt(30 * 24 * 3600));
            expect(after.merkleRoot).to.equal(ROOT); // root untouched
        });

        it("A56: an already-lapsed root is revived from the current time", async function () {
            await networkHelpers.time.increase(91 * 24 * 3600); // past the 90-day default
            expect(await targeting.isRegionActive(REGION)).to.be.false;

            await targeting.extendRegionExpiry(REGION, 30 * 24 * 3600);

            expect(await targeting.isRegionActive(REGION)).to.be.true;
            expect((await targeting.getTargetingCriteria(REGION)).merkleRoot).to.equal(ROOT);
        });

        it("A56: extension is owner-only and bounded", async function () {
            const [, other] = await ethers.getSigners();
            await expect(targeting.connect(other).extendRegionExpiry(REGION, 86400))
                .to.be.revertedWithCustomError(targeting, "OwnableUnauthorizedAccount");

            await expect(targeting.extendRegionExpiry(REGION, 3600))
                .to.be.revertedWithCustomError(targeting, "InvalidExpiryDuration");
            await expect(targeting.extendRegionExpiry(REGION, 366 * 24 * 3600))
                .to.be.revertedWithCustomError(targeting, "InvalidExpiryDuration");
            await expect(targeting.extendRegionExpiry("SN-XX", 86400))
                .to.be.revertedWithCustomError(targeting, "RegionNotActive");
        });
    });

    // =========================================================================
    //  Relayer
    // =========================================================================
    describe("Relayer", function () {
        it("A58: sanitizeForLogging strips PII nested in sub-objects and arrays", function () {
            const sanitized = sanitizeForLogging({
                paymentId: "0xabc",
                apiKey: "super-secret",
                phoneNumber: "+221770000000",
                response: {
                    status: 200,
                    beneficiary: { phoneNumber: "+221770000001", ref: "b-002" },
                },
                batch: [{ phoneNumber: "+221770000002", amount: 5000 }],
            });

            expect(sanitized.paymentId).to.equal("0xabc");
            expect(sanitized.apiKey).to.equal("***REDACTED***");
            expect(sanitized).to.not.have.property("phoneNumber");
            expect(sanitized.response.beneficiary).to.not.have.property("phoneNumber");
            expect(sanitized.response.beneficiary.ref).to.equal("b-002");
            expect(sanitized.batch[0]).to.not.have.property("phoneNumber");
            expect(sanitized.batch[0].amount).to.equal(5000);
        });

        it("A58: sanitizeForLogging leaves non-objects and null untouched", function () {
            expect(sanitizeForLogging(null)).to.equal(null);
            expect(sanitizeForLogging("plain")).to.equal("plain");
            expect(sanitizeForLogging(42)).to.equal(42);
        });
    });
});
