/**
 * @title Audit Round 6 — Regression Tests
 * @description Locks in the fixes from the sixth (full-project) local audit:
 *  - MultiOracle A61: the commit phase closes, so a late oracle cannot mirror a
 *    peer's already-revealed score (the gap A51 alone did not close)
 *  - MultiOracle A62: a deactivated/deregistered oracle's submission stops feeding
 *    consensus, and no reputation is written onto a deleted record
 *  - IKYCAMLCompliance / IWASDIOracle A63: never-emitted events removed
 *  - MockWASDIOracle A64: simulate* functions require authorization
 *  - Deployment A65: governance holds the FloodPrediction roles its whitelisted
 *    selectors require
 *  - Relayer A68: sanitizeForLogging only flags true ancestors as circular
 *  - Relayer A69: an unreadable beneficiary registry throws instead of degrading;
 *    lookups are case-insensitive
 *  - Relayer A70: the audit logger surfaces an uninitialized state instead of
 *    silently discarding entries
 *  - Relayer A71: the provider idempotency key changes between retries
 *  - Relayer A72/A73: provider error bodies are captured; simulation refuses an
 *    unknown provider
 *  - Coverage (R6-12): the two M-02 pagination helpers, removeAuthorizedCaller
 *    and setRiskAlertThreshold
 */
import { expect } from "chai";
import hre from "hardhat";
import { upgrades as makeUpgrades } from "@openzeppelin/hardhat-upgrades";
import { sanitizeForLogging } from "../relayer/crypto.js";
import { loadBeneficiaryRegistry, findBeneficiary } from "../relayer/registry.js";
import { idempotencyKey, describeFailure, executeProviderPayment } from "../relayer/providers.js";
import { AuditLogger } from "../relayer/security.js";
import fs from "node:fs/promises";

const connection = await hre.network.connect();
const { ethers, networkHelpers } = connection;
const ozUpgrades = await makeUpgrades(hre, connection);

const hash = (label) => ethers.keccak256(ethers.toUtf8Bytes(label));

/** A51 + A61: the commit hash is bound to the committing oracle. */
const commitHash = (oracle, region, score, source, salt) =>
    ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
            ["address", "string", "uint256", "string", "bytes32"],
            [oracle, region, score, source, salt]
        )
    );

describe("Audit Round 6 — Regression", function () {

    // =====================================================================
    //  MultiOracle
    // =====================================================================
    describe("MultiOracle", function () {
        let mo, signers, o1, o2, o3, o4;
        const REGION = "SN-TH";

        beforeEach(async function () {
            signers = await ethers.getSigners();
            [, o1, o2, o3, o4] = signers;
            const MO = await ethers.getContractFactory("MultiOracle");
            mo = await MO.deploy();
            await mo.waitForDeployment();
            for (let i = 1; i <= 5; i++) await mo.registerOracle(signers[i].address, `O${i}`);
        });

        it("A61: an oracle cannot commit once the commit phase has closed", async function () {
            const salt = hash("o1-salt");
            await mo.connect(o1).commitData(REGION, commitHash(o1.address, REGION, 77, "WASDI", salt));

            await networkHelpers.time.increase(130); // past COMMIT_PHASE_DURATION (2 min)

            await expect(
                mo.connect(o2).commitData(REGION, commitHash(o2.address, REGION, 60, "WASDI", hash("o2-salt")))
            ).to.be.revertedWithCustomError(mo, "CommitPhaseOver");
        });

        it("A61: a late oracle can no longer mirror a peer's revealed score", async function () {
            const salt = hash("o1-private-salt");
            await mo.connect(o1).commitData(REGION, commitHash(o1.address, REGION, 77, "WASDI", salt));
            await networkHelpers.time.increase(130);

            // o1 reveals — (score, dataSource, salt) become public
            await mo.connect(o1).revealData(REGION, 77, "WASDI", salt);

            // o2 tries the attack: commit the peer's now-public values under its own address
            await expect(
                mo.connect(o2).commitData(REGION, commitHash(o2.address, REGION, 77, "WASDI", salt))
            ).to.be.revertedWithCustomError(mo, "CommitPhaseOver");

            const round = await mo.currentRound(REGION);
            expect(await mo.getRegionSubmissionCount(REGION, round)).to.equal(1n);
        });

        it("A61: all oracles committing inside the window still reach consensus", async function () {
            const salts = [hash("s1"), hash("s2"), hash("s3")];
            const scores = [55, 60, 58];
            const oracles = [o1, o2, o3];

            for (let i = 0; i < 3; i++) {
                await mo.connect(oracles[i]).commitData(
                    REGION, commitHash(oracles[i].address, REGION, scores[i], "WASDI", salts[i])
                );
            }
            await networkHelpers.time.increase(130);
            for (let i = 0; i < 3; i++) {
                await mo.connect(oracles[i]).revealData(REGION, scores[i], "WASDI", salts[i]);
            }

            // required = ceil(5 * 60 / 100) = 3
            expect(await mo.isConsensusReached(REGION)).to.be.true;
            expect((await mo.getConsensus(REGION)).participantCount).to.equal(3n);
        });

        it("A61: a lapsed commit-reveal cycle does not strand the region", async function () {
            const round0 = await mo.currentRound(REGION);
            await mo.connect(o1).commitData(REGION, commitHash(o1.address, REGION, 77, "WASDI", hash("a")));

            // commit phase closed, reveal window still open -> no new commits
            await networkHelpers.time.increase(130);
            await expect(
                mo.connect(o2).commitData(REGION, commitHash(o2.address, REGION, 70, "WASDI", hash("b")))
            ).to.be.revertedWithCustomError(mo, "CommitPhaseOver");

            // nobody revealed; let the whole cycle lapse
            // (COMMIT_PHASE_DURATION 2 min + REVEAL_WINDOW 10 min)
            await networkHelpers.time.increase(12 * 60);

            // the next commit opens a fresh round with a fresh window
            await expect(
                mo.connect(o2).commitData(REGION, commitHash(o2.address, REGION, 70, "WASDI", hash("b")))
            ).to.emit(mo, "DataCommitted");

            const round1 = await mo.currentRound(REGION);
            expect(round1).to.equal(round0 + 1n);
            expect(await mo.roundCommitStart(REGION, round1)).to.be.greaterThan(0n);

            // and the new round runs a normal cycle to completion
            await networkHelpers.time.increase(130);
            await expect(mo.connect(o2).revealData(REGION, 70, "WASDI", hash("b")))
                .to.emit(mo, "DataRevealed");
        });

        it("A62: a deactivated oracle's submission stops feeding consensus", async function () {
            // O1 submits a poisoned value, then is found compromised
            await mo.connect(o1).submitData(REGION, 100, "WASDI");
            await mo.connect(o2).submitData(REGION, 40, "WASDI");
            expect(await mo.getFreshSubmissionCount(REGION)).to.equal(2n);

            await mo.deactivateOracle(o1.address);
            // the poisoned submission is no longer counted
            expect(await mo.getFreshSubmissionCount(REGION)).to.equal(1n);

            // required = ceil(4 * 60 / 100) = 3 -> needs two more honest submissions
            await mo.connect(o3).submitData(REGION, 42, "WASDI");
            expect(await mo.isConsensusReached(REGION)).to.be.false;

            await mo.connect(o4).submitData(REGION, 44, "WASDI");
            const consensus = await mo.getConsensus(REGION);
            expect(consensus.reached).to.be.true;
            // 3 honest participants — the removed oracle is excluded
            expect(consensus.participantCount).to.equal(3n);
            // median of [40, 42, 44] — untouched by the poisoned 100
            expect(consensus.consensusRiskScore).to.equal(42n);
        });

        it("A62: no reputation is written onto a deregistered record", async function () {
            await mo.connect(o1).submitData(REGION, 70, "WASDI");
            await mo.deactivateOracle(o1.address);
            await mo.deregisterOracle(o1.address);

            await mo.connect(o2).submitData(REGION, 71, "WASDI");
            await mo.connect(o3).submitData(REGION, 72, "WASDI");
            await mo.connect(o4).submitData(REGION, 73, "WASDI");
            expect(await mo.isConsensusReached(REGION)).to.be.true;

            const info = await mo.getOracleInfo(o1.address);
            expect(info.registeredAt).to.equal(0n);
            expect(info.reputation).to.equal(0n); // no phantom record
            expect(info.isActive).to.be.false;
        });

        it("A62: a reactivated oracle's earlier submission counts again", async function () {
            await mo.connect(o1).submitData(REGION, 70, "WASDI");
            await mo.deactivateOracle(o1.address);
            expect(await mo.getFreshSubmissionCount(REGION)).to.equal(0n);

            await mo.reactivateOracle(o1.address);
            expect(await mo.getFreshSubmissionCount(REGION)).to.equal(1n);
        });
    });

    // =====================================================================
    //  Interfaces — A63
    // =====================================================================
    describe("Interfaces", function () {
        it("A63: the never-emitted events are gone from the ABIs", async function () {
            const kyc = await ethers.getContractFactory("KYCAMLCompliance");
            const wasdi = await ethers.getContractFactory("WASDIOracleConnector");
            const names = (f) => f.interface.fragments.filter(x => x.type === "event").map(x => x.name);

            expect(names(kyc)).to.not.include("AttestationExpired");
            expect(names(wasdi)).to.not.include("DataExpired");
            // the events that ARE emitted are untouched
            expect(names(kyc)).to.include("AttestationApproved");
            expect(names(wasdi)).to.include("SatelliteDataSubmitted");
        });
    });

    // =====================================================================
    //  MockWASDIOracle — A64
    // =====================================================================
    describe("MockWASDIOracle", function () {
        let mock, owner, outsider;

        beforeEach(async function () {
            [owner, outsider] = await ethers.getSigners();
            const M = await ethers.getContractFactory("MockWASDIOracle");
            mock = await M.deploy();
            await mock.waitForDeployment();
        });

        it("A64: simulate* functions reject an unauthorized caller", async function () {
            for (const call of [
                () => mock.connect(outsider).simulateHighRisk("SN-TH"),
                () => mock.connect(outsider).simulateLowRisk("SN-TH"),
                () => mock.connect(outsider).simulateCustom("SN-TH", 90, 100, 80, 200),
            ]) {
                await expect(call()).to.be.revertedWithCustomError(mock, "NotAuthorized");
            }
            // the region was never written
            expect((await mock.getLatestData("SN-TH")).isProcessed).to.be.false;
        });

        it("A64: an authorized submitter can still simulate", async function () {
            await mock.addSubmitter(outsider.address);
            await expect(mock.connect(outsider).simulateHighRisk("SN-TH"))
                .to.emit(mock, "HighRiskDetected");
            expect(await mock.getRiskScore("SN-TH")).to.equal(85);
        });

        it("A64: simulateCustom validates its inputs with custom errors", async function () {
            await expect(mock.simulateCustom("SN-TH", 101, 10, 10, 10))
                .to.be.revertedWithCustomError(mock, "InvalidRiskScore");
            await expect(mock.simulateCustom("SN-TH", 50, 10, 101, 10))
                .to.be.revertedWithCustomError(mock, "InvalidSoilMoisture");
        });
    });

    // =====================================================================
    //  Governance authority on FloodPrediction — A65
    // =====================================================================
    describe("Governance authority", function () {
        let fp, gov, deployer, operator, upgrader, pauser, actor2;

        beforeEach(async function () {
            [deployer, operator, upgrader, pauser, actor2] = await ethers.getSigners();
            const FP = await ethers.getContractFactory("FloodPredictionContract");
            fp = await ozUpgrades.deployProxy(FP,
                [deployer.address, operator.address, upgrader.address, pauser.address], { kind: "uups" });
            await fp.waitForDeployment();

            const Gov = await ethers.getContractFactory("OpalGovernanceUpgradeable");
            gov = await ozUpgrades.deployProxy(Gov, [deployer.address, 2], { kind: "uups" });
            await gov.waitForDeployment();

            // the deploy-script wiring, including the A65 role grants
            await gov.setFloodPredictionContract(await fp.getAddress());
            const emergencySelectors = [
                fp.interface.getFunction("createGovernanceOverrideTrigger").selector,
                fp.interface.getFunction("pause").selector,
                fp.interface.getFunction("unpause").selector,
                fp.interface.getFunction("activateEmergencyMode").selector,
                fp.interface.getFunction("deactivateEmergencyMode").selector,
                fp.interface.getFunction("setRegionEmergency").selector,
            ];
            await gov.setEmergencyAllowedSelectorBatch(emergencySelectors, emergencySelectors.map(() => true));
            await gov.setAllowedSelectorBatch(
                [fp.interface.getFunction("updateRiskThreshold").selector], [true]);
            await gov.addGovernanceActor(actor2.address, "A2", "GOVERNOR");

            await fp.grantRole(await fp.ADMIN_ROLE(), await gov.getAddress());
            await fp.grantRole(await fp.PAUSER_ROLE(), await gov.getAddress());
        });

        it("A65: governance holds the roles its whitelisted selectors need", async function () {
            const govAddr = await gov.getAddress();
            expect(await fp.hasRole(await fp.ADMIN_ROLE(), govAddr)).to.be.true;
            expect(await fp.hasRole(await fp.PAUSER_ROLE(), govAddr)).to.be.true;
        });

        it("A65: an EMERGENCY_TRIGGER pause proposal now actually pauses", async function () {
            const data = fp.interface.encodeFunctionData("pause", []);
            await gov.connect(deployer).createProposal(0, "emergency pause", data, "SN-TH", ethers.ZeroAddress);
            await gov.connect(actor2).signProposal(0);

            await expect(gov.connect(deployer).executeProposal(0)).to.emit(gov, "ProposalExecuted");
            expect(await fp.paused()).to.be.true;
        });

        it("A65: an emergency-mode proposal executes", async function () {
            const data = fp.interface.encodeFunctionData("activateEmergencyMode", ["flood alert"]);
            await gov.connect(deployer).createProposal(0, "emergency mode", data, "SN-TH", ethers.ZeroAddress);
            await gov.connect(actor2).signProposal(0);

            await expect(gov.connect(deployer).executeProposal(0)).to.emit(fp, "EmergencyModeActivated");
            expect(await fp.emergencyMode()).to.be.true;
        });

        it("A65: a PARAMETER_CHANGE proposal executes after the timelock", async function () {
            const data = fp.interface.encodeFunctionData("updateRiskThreshold", [80]);
            await gov.connect(deployer).createProposal(1, "raise threshold", data, "SN-TH", ethers.ZeroAddress);
            await gov.connect(actor2).signProposal(0);
            await networkHelpers.time.increase(3700); // EXECUTION_DELAY

            await expect(gov.connect(deployer).executeProposal(0)).to.emit(fp, "RiskThresholdUpdated");
            expect(await fp.riskThreshold()).to.equal(80);
        });
    });

    // =====================================================================
    //  Coverage gaps closed — R6-12
    // =====================================================================
    describe("Previously untested view/admin functions", function () {
        it("R6-12: getTriggerIdsPaginated handles empty, partial and out-of-range pages", async function () {
            const [deployer, operator, upgrader, pauser] = await ethers.getSigners();
            const FP = await ethers.getContractFactory("FloodPredictionContract");
            const fp = await ozUpgrades.deployProxy(FP,
                [deployer.address, operator.address, upgrader.address, pauser.address], { kind: "uups" });
            await fp.waitForDeployment();

            // empty state
            let [ids, total] = await fp.getTriggerIdsPaginated(0, 10);
            expect(total).to.equal(0n);
            expect(ids.length).to.equal(0);

            // offset beyond the end returns an empty page but the real total
            [ids, total] = await fp.getTriggerIdsPaginated(5, 10);
            expect(total).to.equal(0n);
            expect(ids.length).to.equal(0);

            // limit 0 yields an empty page
            [ids, total] = await fp.getTriggerIdsPaginated(0, 0);
            expect(ids.length).to.equal(0);
        });

        it("R6-12: getBudgetRegionsPaginated pages correctly across boundaries", async function () {
            const [deployer, operator, upgrader, pauser] = await ethers.getSigners();
            const FP = await ethers.getContractFactory("FloodPredictionContract");
            const fp = await ozUpgrades.deployProxy(FP,
                [deployer.address, operator.address, upgrader.address, pauser.address], { kind: "uups" });
            await fp.waitForDeployment();

            const codes = ["SN-TH", "SN-DK", "SN-SL", "SN-ZG", "SN-KL"];
            for (const c of codes) await fp.allocateBudget(c, 1_000_000n);

            let [regions, total] = await fp.getBudgetRegionsPaginated(0, 2);
            expect(total).to.equal(5n);
            expect(regions).to.deep.equal(["SN-TH", "SN-DK"]);

            // final partial page: 1 item remains, limit asks for more
            [regions, total] = await fp.getBudgetRegionsPaginated(4, 10);
            expect(total).to.equal(5n);
            expect(regions).to.deep.equal(["SN-KL"]);

            // offset == total is an empty page, not a revert
            [regions, total] = await fp.getBudgetRegionsPaginated(5, 3);
            expect(total).to.equal(5n);
            expect(regions.length).to.equal(0);

            // exact-fit page
            [regions] = await fp.getBudgetRegionsPaginated(0, 5);
            expect(regions).to.deep.equal(codes);
        });

        it("R6-12: removeAuthorizedCaller revokes markVerified access", async function () {
            const [owner, caller] = await ethers.getSigners();
            const JT = await ethers.getContractFactory("JokalanteTargeting");
            const jt = await JT.deploy();
            await jt.waitForDeployment();
            await jt.updateMerkleRoot("SN-TH", "0x" + "ab".repeat(32), 100);

            await jt.addAuthorizedCaller(caller.address);
            await expect(jt.connect(caller).markVerified("SN-TH", hash("b1")))
                .to.emit(jt, "BeneficiaryVerified");

            await jt.removeAuthorizedCaller(caller.address);
            expect(await jt.authorizedCallers(caller.address)).to.be.false;
            await expect(jt.connect(caller).markVerified("SN-TH", hash("b2")))
                .to.be.revertedWithCustomError(jt, "NotAuthorizedCaller");
        });

        it("R6-12: setRiskAlertThreshold gates the HighRiskDetected event", async function () {
            const W = await ethers.getContractFactory("WASDIOracleConnector");
            const w = await W.deploy();
            await w.waitForDeployment();
            expect(await w.riskAlertThreshold()).to.equal(70);

            await w.setRiskAlertThreshold(50);
            expect(await w.riskAlertThreshold()).to.equal(50);

            // 60 is below the default 70 but at/above the new 50
            await expect(w.submitSatelliteData("SN-TH", 60, 100, 50, 200, "Sentinel-1"))
                .to.emit(w, "HighRiskDetected");

            await expect(w.setRiskAlertThreshold(0))
                .to.be.revertedWithCustomError(w, "InvalidRiskScore");
            await expect(w.setRiskAlertThreshold(101))
                .to.be.revertedWithCustomError(w, "InvalidRiskScore");
        });
    });

    // =====================================================================
    //  Relayer
    // =====================================================================
    describe("Relayer", function () {
        it("A68: a shared non-cyclic sub-object is not flagged as circular", function () {
            const shared = { status: 200, code: "OK" };
            const out = sanitizeForLogging({ first: shared, second: shared });
            expect(out.first).to.deep.equal({ status: 200, code: "OK" });
            expect(out.second).to.deep.equal({ status: 200, code: "OK" });
        });

        it("A68: a genuine cycle is still detected", function () {
            const node = { name: "root" };
            node.self = node;
            const out = sanitizeForLogging(node);
            expect(out.name).to.equal("root");
            expect(out.self).to.equal("[Circular]");
        });

        it("A68: nested PII and credentials are still stripped", function () {
            const out = sanitizeForLogging({
                apiKey: "secret",
                response: { beneficiary: { phoneNumber: "+221770000000", ref: "b-1" } },
                batch: [{ msisdn: "+221770000001", amount: 5000 }],
            });
            expect(out.apiKey).to.equal("***REDACTED***");
            expect(out.response.beneficiary).to.not.have.property("phoneNumber");
            expect(out.response.beneficiary.ref).to.equal("b-1");
            expect(out.batch[0]).to.not.have.property("msisdn");
            expect(out.batch[0].amount).to.equal(5000);
        });

        it("A69: an unreadable registry throws instead of degrading to empty", async function () {
            const rel = "./relayer/__r6_bad_registry.json";
            await fs.writeFile("relayer/__r6_bad_registry.json", '{ "0xabc": { "phoneNumber": ');
            try {
                await expect(loadBeneficiaryRegistry(rel)).to.be.rejectedWith(/not valid JSON/);
            } finally {
                await fs.unlink("relayer/__r6_bad_registry.json").catch(() => {});
            }
        });

        it("A69: a non-object registry is rejected", async function () {
            const rel = "./relayer/__r6_array_registry.json";
            await fs.writeFile("relayer/__r6_array_registry.json", '[1, 2, 3]');
            try {
                await expect(loadBeneficiaryRegistry(rel)).to.be.rejectedWith(/must be a JSON object/);
            } finally {
                await fs.unlink("relayer/__r6_array_registry.json").catch(() => {});
            }
        });

        it("A69: a genuinely missing registry is still tolerated", async function () {
            const registry = await loadBeneficiaryRegistry("./relayer/__r6_absent_registry.json");
            expect(registry).to.deep.equal({});
        });

        it("A69: a valid registry loads, and lookups ignore hex case", async function () {
            const rel = "./relayer/__r6_ok_registry.json";
            const key = "0x" + "AB".repeat(32);
            await fs.writeFile("relayer/__r6_ok_registry.json",
                JSON.stringify({ [key]: { phoneNumber: "+221770000000", externalReference: "b-1" } }));
            try {
                const registry = await loadBeneficiaryRegistry(rel);
                // the event delivers a lowercase hash; the file holds uppercase
                const found = findBeneficiary(registry, "0x" + "ab".repeat(32));
                expect(found).to.not.equal(null);
                expect(found.externalReference).to.equal("b-1");
            } finally {
                await fs.unlink("relayer/__r6_ok_registry.json").catch(() => {});
            }
        });

        it("A70: an uninitialized audit logger reports instead of silently dropping", async function () {
            const logger = new AuditLogger();
            expect(logger.logFile).to.equal(null);

            const errors = [];
            const original = console.error;
            console.error = (...args) => errors.push(args.join(" "));
            try {
                await logger.log("PAYMENT_REQUEST", { paymentId: "0xdead" });
            } finally {
                console.error = original;
            }

            expect(errors.join("\n")).to.match(/NOT PERSISTED/);
            expect(errors.join("\n")).to.match(/PAYMENT_REQUEST/);
        });

        it("A70: an initialized logger persists entries to disk", async function () {
            const logger = new AuditLogger();
            await logger.initialize();
            expect(logger.logFile).to.be.a("string");

            await logger.log("R6_SELFTEST", { marker: "audit-v6" });
            const contents = await fs.readFile(logger.logFile, "utf8");
            expect(contents).to.include("R6_SELFTEST");
            expect(contents).to.include("audit-v6");
        });

        it("A71: the idempotency key changes between retries", function () {
            const base = { paymentId: "0xfeed" };
            expect(idempotencyKey({ ...base, retryCount: 0 })).to.equal("0xfeed-0");
            expect(idempotencyKey({ ...base, retryCount: 1 })).to.equal("0xfeed-1");
            expect(idempotencyKey({ ...base, retryCount: 2 })).to.equal("0xfeed-2");
            // a resend of the same attempt keeps the same key, so it stays deduplicated
            expect(idempotencyKey({ ...base, retryCount: 1 }))
                .to.equal(idempotencyKey({ ...base, retryCount: 1 }));
            // absent retryCount defaults to a first attempt
            expect(idempotencyKey(base)).to.equal("0xfeed-0");
        });

        it("A72: a provider error body is captured into the failure reason", async function () {
            const response = {
                status: 402,
                text: async () => '{"error":"INSUFFICIENT_FLOAT"}',
            };
            const reason = await describeFailure("Orange Money", response);
            expect(reason).to.include("402");
            expect(reason).to.include("INSUFFICIENT_FLOAT");
        });

        it("A72: an unreadable body still yields a usable reason", async function () {
            const response = { status: 500, text: async () => { throw new Error("stream closed"); } };
            const reason = await describeFailure("Wave", response);
            expect(reason).to.include("500");
            expect(reason).to.include("Wave");
        });

        it("A73: simulation refuses an unknown provider instead of reporting success", async function () {
            const saved = {
                SIMULATE_PAYMENTS: process.env.SIMULATE_PAYMENTS,
                PRIVATE_KEY: process.env.PRIVATE_KEY,
                MOBILE_MONEY_PROVIDER_ADDRESS: process.env.MOBILE_MONEY_PROVIDER_ADDRESS,
            };
            process.env.SIMULATE_PAYMENTS = "true";
            process.env.PRIVATE_KEY = process.env.PRIVATE_KEY
                ?? "0x0000000000000000000000000000000000000000000000000000000000000001";
            process.env.MOBILE_MONEY_PROVIDER_ADDRESS = process.env.MOBILE_MONEY_PROVIDER_ADDRESS
                ?? "0x1234567890123456789012345678901234567890";
            try {
                const bad = await executeProviderPayment("UNKNOWN_PROVIDER", {
                    paymentId: "0x" + "11".repeat(32), amount: "50000", phoneNumber: "+221770000000",
                });
                expect(bad.success).to.be.false;
                expect(bad.reason).to.include("UNKNOWN_PROVIDER");

                // a real provider still simulates successfully
                const good = await executeProviderPayment("ORANGE_MONEY", {
                    paymentId: "0x" + "22".repeat(32), amount: "50000", phoneNumber: "+221770000000",
                });
                expect(good.success).to.be.true;
                expect(good.transactionRef).to.include("SIMULATED");
            } finally {
                for (const [k, v] of Object.entries(saved)) {
                    if (v === undefined) delete process.env[k];
                    else process.env[k] = v;
                }
            }
        });
    });
});
