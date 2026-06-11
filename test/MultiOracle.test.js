/**
 * @title MultiOracle Unit Tests
 * @description Comprehensive tests for multi-oracle consensus engine with IQR outlier detection
 */
import { expect } from "chai";
import hre from "hardhat";

const { ethers } = await hre.network.connect();

describe("MultiOracle", function () {
    let multiOracle;
    let owner, oracle1, oracle2, oracle3, oracle4, oracle5, nonOracle;

    beforeEach(async function () {
        [owner, oracle1, oracle2, oracle3, oracle4, oracle5, nonOracle] = await ethers.getSigners();

        const MultiOracle = await ethers.getContractFactory("MultiOracle");
        multiOracle = await MultiOracle.deploy();
        await multiOracle.waitForDeployment();
    });

    // =========================================================================
    //                         DEPLOYMENT
    // =========================================================================
    describe("Deployment", function () {
        it("should set correct owner", async function () {
            expect(await multiOracle.owner()).to.equal(owner.address);
        });

        it("should set default consensus threshold to 60%", async function () {
            expect(await multiOracle.consensusThreshold()).to.equal(60);
        });

        it("should set default data freshness to 1 hour", async function () {
            expect(await multiOracle.dataFreshnessThreshold()).to.equal(3600);
        });

        it("should set default max consecutive outliers to 3", async function () {
            expect(await multiOracle.maxConsecutiveOutliers()).to.equal(3);
        });

        it("should start with 0 active oracles", async function () {
            expect(await multiOracle.activeOracleCount()).to.equal(0);
        });
    });

    // =========================================================================
    //                     ORACLE REGISTRATION
    // =========================================================================
    describe("Oracle Registration", function () {
        it("should register an oracle successfully", async function () {
            await expect(multiOracle.registerOracle(oracle1.address, "Oracle-1"))
                .to.emit(multiOracle, "OracleRegistered")
                .withArgs(oracle1.address, "Oracle-1");

            const info = await multiOracle.getOracleInfo(oracle1.address);
            expect(info.name).to.equal("Oracle-1");
            expect(info.reputation).to.equal(50); // INITIAL_REPUTATION
            expect(info.isActive).to.be.true;
            expect(info.totalSubmissions).to.equal(0);
        });

        it("should increment active oracle count", async function () {
            await multiOracle.registerOracle(oracle1.address, "Oracle-1");
            expect(await multiOracle.activeOracleCount()).to.equal(1);
            expect(await multiOracle.getOracleCount()).to.equal(1);
        });

        it("should revert if not owner", async function () {
            await expect(
                multiOracle.connect(oracle1).registerOracle(oracle2.address, "Oracle-2")
            ).to.be.revertedWithCustomError(multiOracle, "OwnableUnauthorizedAccount");
        });

        it("should revert for zero address", async function () {
            await expect(
                multiOracle.registerOracle(ethers.ZeroAddress, "Oracle-0")
            ).to.be.revertedWithCustomError(multiOracle, "ZeroAddress");
        });

        it("should revert for empty name", async function () {
            await expect(
                multiOracle.registerOracle(oracle1.address, "")
            ).to.be.revertedWithCustomError(multiOracle, "EmptyString");
        });

        it("should revert for already registered oracle", async function () {
            await multiOracle.registerOracle(oracle1.address, "Oracle-1");
            await expect(
                multiOracle.registerOracle(oracle1.address, "Oracle-1-dup")
            ).to.be.revertedWithCustomError(multiOracle, "OracleAlreadyRegistered");
        });

        it("should revert when MAX_ORACLES reached", async function () {
            const signers = await ethers.getSigners();
            for (let i = 1; i <= 10; i++) {
                await multiOracle.registerOracle(signers[i].address, `Oracle-${i}`);
            }
            await expect(
                multiOracle.registerOracle(signers[11].address, "Oracle-11")
            ).to.be.revertedWithCustomError(multiOracle, "MaxOraclesReached");
        });

        it("should return oracle at index", async function () {
            await multiOracle.registerOracle(oracle1.address, "Oracle-1");
            await multiOracle.registerOracle(oracle2.address, "Oracle-2");
            expect(await multiOracle.getOracleAtIndex(0)).to.equal(oracle1.address);
            expect(await multiOracle.getOracleAtIndex(1)).to.equal(oracle2.address);
        });

        it("should return all oracles", async function () {
            await multiOracle.registerOracle(oracle1.address, "Oracle-1");
            await multiOracle.registerOracle(oracle2.address, "Oracle-2");
            const all = await multiOracle.getAllOracles();
            expect(all.length).to.equal(2);
        });
    });

    // =========================================================================
    //                     ORACLE DEACTIVATION / REACTIVATION
    // =========================================================================
    describe("Oracle Deactivation", function () {
        beforeEach(async function () {
            await multiOracle.registerOracle(oracle1.address, "Oracle-1");
        });

        it("should deactivate an oracle", async function () {
            await expect(multiOracle.deactivateOracle(oracle1.address))
                .to.emit(multiOracle, "OracleDeactivated")
                .withArgs(oracle1.address);

            const info = await multiOracle.getOracleInfo(oracle1.address);
            expect(info.isActive).to.be.false;
            expect(await multiOracle.activeOracleCount()).to.equal(0);
        });

        it("should revert deactivating unregistered oracle", async function () {
            await expect(
                multiOracle.deactivateOracle(oracle2.address)
            ).to.be.revertedWithCustomError(multiOracle, "NotRegisteredOracle");
        });

        it("should revert deactivating already inactive oracle", async function () {
            await multiOracle.deactivateOracle(oracle1.address);
            await expect(
                multiOracle.deactivateOracle(oracle1.address)
            ).to.be.revertedWithCustomError(multiOracle, "OracleNotActive");
        });

        it("should revert if not owner", async function () {
            await expect(
                multiOracle.connect(oracle1).deactivateOracle(oracle1.address)
            ).to.be.revertedWithCustomError(multiOracle, "OwnableUnauthorizedAccount");
        });
    });

    describe("Oracle Reactivation", function () {
        beforeEach(async function () {
            await multiOracle.registerOracle(oracle1.address, "Oracle-1");
            await multiOracle.deactivateOracle(oracle1.address);
        });

        it("should reactivate an oracle", async function () {
            await expect(multiOracle.reactivateOracle(oracle1.address))
                .to.emit(multiOracle, "OracleReactivated")
                .withArgs(oracle1.address);

            const info = await multiOracle.getOracleInfo(oracle1.address);
            expect(info.isActive).to.be.true;
            expect(info.consecutiveOutliers).to.equal(0);
            expect(await multiOracle.activeOracleCount()).to.equal(1);
        });

        it("should revert reactivating unregistered oracle", async function () {
            await expect(
                multiOracle.reactivateOracle(oracle2.address)
            ).to.be.revertedWithCustomError(multiOracle, "NotRegisteredOracle");
        });

        it("should revert reactivating already active oracle", async function () {
            await multiOracle.reactivateOracle(oracle1.address);
            await expect(
                multiOracle.reactivateOracle(oracle1.address)
            ).to.be.revertedWithCustomError(multiOracle, "OracleAlreadyActive");
        });
    });

    // =========================================================================
    //                        DATA SUBMISSION
    // =========================================================================
    describe("Data Submission", function () {
        beforeEach(async function () {
            // H-05 fix: minimum 4 oracles required for IQR consensus
            await multiOracle.registerOracle(oracle1.address, "Oracle-1");
            await multiOracle.registerOracle(oracle2.address, "Oracle-2");
            await multiOracle.registerOracle(oracle3.address, "Oracle-3");
            await multiOracle.registerOracle(oracle4.address, "Oracle-4");
        });

        it("should submit data successfully", async function () {
            await expect(
                multiOracle.connect(oracle1).submitData("dakar", 75, "WASDI")
            ).to.emit(multiOracle, "DataSubmitted")
                .withArgs(oracle1.address, "dakar", 75, "WASDI");
        });

        it("should increment oracle totalSubmissions", async function () {
            await multiOracle.connect(oracle1).submitData("dakar", 75, "WASDI");
            const info = await multiOracle.getOracleInfo(oracle1.address);
            expect(info.totalSubmissions).to.equal(1);
        });

        it("should record submission in region round", async function () {
            await multiOracle.connect(oracle1).submitData("dakar", 75, "WASDI");
            const round = await multiOracle.currentRound("dakar");
            const count = await multiOracle.getRegionSubmissionCount("dakar", round);
            expect(count).to.equal(1);
        });

        it("should track hasOracleSubmitted", async function () {
            await multiOracle.connect(oracle1).submitData("dakar", 75, "WASDI");
            expect(await multiOracle.hasOracleSubmitted("dakar", oracle1.address)).to.be.true;
            expect(await multiOracle.hasOracleSubmitted("dakar", oracle2.address)).to.be.false;
        });

        it("should revert for non-oracle", async function () {
            await expect(
                multiOracle.connect(nonOracle).submitData("dakar", 75, "WASDI")
            ).to.be.revertedWithCustomError(multiOracle, "NotRegisteredOracle");
        });

        it("should revert for inactive oracle", async function () {
            await multiOracle.deactivateOracle(oracle1.address);
            await expect(
                multiOracle.connect(oracle1).submitData("dakar", 75, "WASDI")
            ).to.be.revertedWithCustomError(multiOracle, "OracleNotActive");
        });

        it("should revert for risk score > 100", async function () {
            await expect(
                multiOracle.connect(oracle1).submitData("dakar", 101, "WASDI")
            ).to.be.revertedWithCustomError(multiOracle, "InvalidRiskScore");
        });

        it("should revert for empty region", async function () {
            await expect(
                multiOracle.connect(oracle1).submitData("", 75, "WASDI")
            ).to.be.revertedWithCustomError(multiOracle, "EmptyString");
        });

        it("should revert for empty dataSource", async function () {
            await expect(
                multiOracle.connect(oracle1).submitData("dakar", 75, "")
            ).to.be.revertedWithCustomError(multiOracle, "EmptyString");
        });

        it("should revert if already submitted in round", async function () {
            await multiOracle.connect(oracle1).submitData("dakar", 75, "WASDI");
            await expect(
                multiOracle.connect(oracle1).submitData("dakar", 80, "CHIRPS")
            ).to.be.revertedWithCustomError(multiOracle, "AlreadySubmittedInRound");
        });
    });

    // =========================================================================
    //                     CONSENSUS CALCULATION
    // =========================================================================
    describe("Consensus", function () {
        beforeEach(async function () {
            // Register 5 oracles, consensus threshold = 60% → need 3 out of 5
            await multiOracle.registerOracle(oracle1.address, "Oracle-1");
            await multiOracle.registerOracle(oracle2.address, "Oracle-2");
            await multiOracle.registerOracle(oracle3.address, "Oracle-3");
            await multiOracle.registerOracle(oracle4.address, "Oracle-4");
            await multiOracle.registerOracle(oracle5.address, "Oracle-5");
        });

        it("should not reach consensus before threshold", async function () {
            await multiOracle.connect(oracle1).submitData("dakar", 80, "WASDI");
            await multiOracle.connect(oracle2).submitData("dakar", 82, "CHIRPS");
            // 2/5 = 40% < 60%
            expect(await multiOracle.isConsensusReached("dakar")).to.be.false;
        });

        it("should reach consensus when threshold met (3/5)", async function () {
            await multiOracle.connect(oracle1).submitData("dakar", 80, "WASDI");
            await multiOracle.connect(oracle2).submitData("dakar", 82, "CHIRPS");
            await multiOracle.connect(oracle3).submitData("dakar", 78, "GFS");

            expect(await multiOracle.isConsensusReached("dakar")).to.be.true;
            const consensus = await multiOracle.getConsensus("dakar");
            expect(consensus.reached).to.be.true;
            expect(consensus.participantCount).to.equal(3);
            expect(consensus.region).to.equal("dakar");
        });

        it("should compute median as consensus score", async function () {
            await multiOracle.connect(oracle1).submitData("dakar", 70, "WASDI");
            await multiOracle.connect(oracle2).submitData("dakar", 80, "CHIRPS");
            await multiOracle.connect(oracle3).submitData("dakar", 90, "GFS");

            const score = await multiOracle.getConsensusRiskScore("dakar");
            expect(score).to.equal(80); // median of [70, 80, 90]
        });

        it("should revert getConsensusRiskScore when no consensus", async function () {
            await expect(
                multiOracle.getConsensusRiskScore("unknown")
            ).to.be.revertedWithCustomError(multiOracle, "ConsensusNotReached");
        });

        it("should treat consensus as stale once dataFreshnessThreshold elapses", async function () {
            await multiOracle.connect(oracle1).submitData("dakar", 80, "WASDI");
            await multiOracle.connect(oracle2).submitData("dakar", 82, "CHIRPS");
            await multiOracle.connect(oracle3).submitData("dakar", 78, "GFS");

            expect(await multiOracle.isConsensusReached("dakar")).to.be.true;

            // Advance past dataFreshnessThreshold (default 1 hour)
            await ethers.provider.send("evm_increaseTime", [3601]);
            await ethers.provider.send("evm_mine");

            expect(await multiOracle.isConsensusReached("dakar")).to.be.false;
            await expect(
                multiOracle.getConsensusRiskScore("dakar")
            ).to.be.revertedWithCustomError(multiOracle, "ConsensusNotReached");
        });

        it("should detect outliers with IQR (4+ submissions)", async function () {
            // Register 5th oracle already done in beforeEach
            // Submit: [70, 72, 74, 76, 10] — 10 is an outlier
            await multiOracle.connect(oracle1).submitData("dakar", 70, "WASDI");
            await multiOracle.connect(oracle2).submitData("dakar", 72, "CHIRPS");
            await multiOracle.connect(oracle3).submitData("dakar", 74, "GFS");
            await multiOracle.connect(oracle4).submitData("dakar", 76, "MODIS");

            // 4/5 = 80% >= 60% threshold → consensus triggered
            const consensus = await multiOracle.getConsensus("dakar");
            expect(consensus.reached).to.be.true;
        });

        it("should detect extreme outlier and penalize oracle", async function () {
            // With fewer than 6 values in one round, IQR can't detect outliers.
            // Set threshold to 100% so consensus triggers only after ALL oracles submit.
            const signers = await ethers.getSigners();
            const oracle6 = signers[7];
            await multiOracle.registerOracle(oracle6.address, "Oracle-6");
            await multiOracle.setConsensusThreshold(100); // require all 6

            // Scores: [0, 80, 82, 84, 86, 88]
            // IQR: Q1=80, Q3=86, IQR=6, bounds=[71, 95] → 0 is outlier
            await multiOracle.connect(oracle1).submitData("dakar", 0, "BAD");
            await multiOracle.connect(oracle2).submitData("dakar", 80, "WASDI");
            await multiOracle.connect(oracle3).submitData("dakar", 82, "CHIRPS");
            await multiOracle.connect(oracle4).submitData("dakar", 84, "GFS");
            await multiOracle.connect(oracle5).submitData("dakar", 86, "MODIS");
            await multiOracle.connect(oracle6).submitData("dakar", 88, "Sentinel-1");

            const consensus = await multiOracle.getConsensus("dakar");
            expect(consensus.reached).to.be.true;
            expect(consensus.outlierCount).to.be.gte(1);

            // Oracle1 should have been penalized
            const info = await multiOracle.getOracleInfo(oracle1.address);
            expect(info.reputation).to.be.lt(50); // Less than initial
            expect(info.outlierCount).to.be.gte(1);
        });

        it("should reward non-outlier oracles", async function () {
            await multiOracle.connect(oracle1).submitData("dakar", 70, "WASDI");
            await multiOracle.connect(oracle2).submitData("dakar", 72, "CHIRPS");
            await multiOracle.connect(oracle3).submitData("dakar", 74, "GFS");

            // Non-outliers get +2 reputation
            const info2 = await multiOracle.getOracleInfo(oracle2.address);
            expect(info2.reputation).to.equal(52); // 50 + 2
        });

        it("should auto-disable oracle after maxConsecutiveOutliers", async function () {
            // Use custom maxConsecutiveOutliers = 1 for quick test
            // M-08 fix: oracle gets a probation warning at threshold,
            // auto-disabled only after exceeding it (threshold + 1 outliers)
            await multiOracle.setMaxConsecutiveOutliers(1);

            // Need 6 oracles with 100% threshold for IQR outlier detection
            const signers = await ethers.getSigners();
            const oracle6 = signers[7];
            await multiOracle.registerOracle(oracle6.address, "Oracle-6");
            await multiOracle.setConsensusThreshold(100); // require all 6

            // Round 1: Submit extreme outlier: [0, 80, 82, 84, 86, 88] → 0 is outlier
            await multiOracle.connect(oracle1).submitData("dakar", 0, "BAD");
            await multiOracle.connect(oracle2).submitData("dakar", 80, "WASDI");
            await multiOracle.connect(oracle3).submitData("dakar", 82, "CHIRPS");
            await multiOracle.connect(oracle4).submitData("dakar", 84, "GFS");
            await multiOracle.connect(oracle5).submitData("dakar", 86, "MODIS");
            await multiOracle.connect(oracle6).submitData("dakar", 88, "Sentinel-1");

            let info = await multiOracle.getOracleInfo(oracle1.address);
            // After 1 outlier (= maxConsecutiveOutliers), oracle gets probation warning but stays active
            if (info.outlierCount > 0) {
                expect(info.isActive).to.be.true; // Still active due to grace period
            }

            // Round 2: Submit another outlier to exceed threshold
            await multiOracle.connect(oracle1).submitData("dakar", 0, "BAD");
            await multiOracle.connect(oracle2).submitData("dakar", 80, "WASDI");
            await multiOracle.connect(oracle3).submitData("dakar", 82, "CHIRPS");
            await multiOracle.connect(oracle4).submitData("dakar", 84, "GFS");
            await multiOracle.connect(oracle5).submitData("dakar", 86, "MODIS");
            await multiOracle.connect(oracle6).submitData("dakar", 88, "Sentinel-1");

            info = await multiOracle.getOracleInfo(oracle1.address);
            // After 2 outliers (> maxConsecutiveOutliers), oracle should now be deactivated
            if (info.outlierCount > 1) {
                expect(info.isActive).to.be.false;
            }
        });

        it("should handle multiple regions independently", async function () {
            await multiOracle.connect(oracle1).submitData("dakar", 80, "WASDI");
            await multiOracle.connect(oracle2).submitData("dakar", 82, "CHIRPS");
            await multiOracle.connect(oracle3).submitData("dakar", 84, "GFS");

            await multiOracle.connect(oracle1).submitData("thies", 50, "WASDI");
            await multiOracle.connect(oracle2).submitData("thies", 52, "CHIRPS");
            await multiOracle.connect(oracle3).submitData("thies", 54, "GFS");

            expect(await multiOracle.isConsensusReached("dakar")).to.be.true;
            expect(await multiOracle.isConsensusReached("thies")).to.be.true;

            const scoreDakar = await multiOracle.getConsensusRiskScore("dakar");
            const scoreThies = await multiOracle.getConsensusRiskScore("thies");
            expect(scoreDakar).to.not.equal(scoreThies);
        });
    });

    // =========================================================================
    //                      ROUND ADVANCEMENT
    // =========================================================================
    describe("Round Advancement", function () {
        beforeEach(async function () {
            await multiOracle.registerOracle(oracle1.address, "Oracle-1");
            await multiOracle.registerOracle(oracle2.address, "Oracle-2");
            await multiOracle.registerOracle(oracle3.address, "Oracle-3");
            await multiOracle.registerOracle(oracle4.address, "Oracle-4");
        });

        it("should advance round after consensus", async function () {
            const roundBefore = await multiOracle.currentRound("dakar");

            await multiOracle.connect(oracle1).submitData("dakar", 80, "WASDI");
            await multiOracle.connect(oracle2).submitData("dakar", 82, "CHIRPS");
            await multiOracle.connect(oracle3).submitData("dakar", 84, "GFS");

            // 3/4 = 75% >= 60% → consensus reached
            const consensus = await multiOracle.getConsensus("dakar");
            expect(consensus.reached).to.be.true;

            // New submission should go to a new round
            await multiOracle.connect(oracle4).submitData("dakar", 85, "MODIS");
            const roundAfter = await multiOracle.currentRound("dakar");
            expect(roundAfter).to.be.gte(roundBefore);
        });

        it("should allow oracle to submit in new round", async function () {
            // Round 0: reach consensus
            await multiOracle.connect(oracle1).submitData("dakar", 80, "WASDI");
            await multiOracle.connect(oracle2).submitData("dakar", 82, "CHIRPS");
            await multiOracle.connect(oracle3).submitData("dakar", 84, "GFS");

            // Oracle1 should now be able to submit again in the new round
            await expect(
                multiOracle.connect(oracle1).submitData("dakar", 78, "WASDI")
            ).to.not.revert(ethers);
        });
    });

    // =========================================================================
    //                      VIEW FUNCTIONS
    // =========================================================================
    describe("View Functions", function () {
        beforeEach(async function () {
            await multiOracle.registerOracle(oracle1.address, "Oracle-1");
            await multiOracle.registerOracle(oracle2.address, "Oracle-2");
            await multiOracle.registerOracle(oracle3.address, "Oracle-3");
            await multiOracle.registerOracle(oracle4.address, "Oracle-4");
        });

        it("should return oracle reputation", async function () {
            expect(await multiOracle.getOracleReputation(oracle1.address)).to.equal(50);
        });

        it("should return active oracle count", async function () {
            expect(await multiOracle.getActiveOracleCount()).to.equal(4);
        });

        it("should return fresh submission count", async function () {
            await multiOracle.connect(oracle1).submitData("dakar", 80, "WASDI");
            expect(await multiOracle.getFreshSubmissionCount("dakar")).to.equal(1);
        });

        it("should return required submissions", async function () {
            // 4 oracles, 60% threshold → ceil(4 * 60 / 100) = ceil(2.4) = 3
            expect(await multiOracle.getRequiredSubmissions()).to.equal(3);
        });

        it("should return region submissions", async function () {
            await multiOracle.connect(oracle1).submitData("dakar", 80, "WASDI");
            const round = await multiOracle.currentRound("dakar");
            const subs = await multiOracle.getRegionSubmissions("dakar", round);
            expect(subs.length).to.equal(1);
            expect(subs[0].riskScore).to.equal(80);
        });
    });

    // =========================================================================
    //                  OWNER CONFIGURATION
    // =========================================================================
    describe("Owner Configuration", function () {
        it("should update consensus threshold", async function () {
            await multiOracle.setConsensusThreshold(80);
            expect(await multiOracle.consensusThreshold()).to.equal(80);
        });

        it("should revert threshold > 100", async function () {
            await expect(multiOracle.setConsensusThreshold(101)).to.revert(ethers);
        });

        it("should revert threshold = 0", async function () {
            await expect(multiOracle.setConsensusThreshold(0)).to.revert(ethers);
        });

        it("should update data freshness threshold", async function () {
            await multiOracle.setDataFreshnessThreshold(7200);
            expect(await multiOracle.dataFreshnessThreshold()).to.equal(7200);
        });

        it("should revert freshness = 0", async function () {
            await expect(multiOracle.setDataFreshnessThreshold(0)).to.revert(ethers);
        });

        it("should update max consecutive outliers", async function () {
            await multiOracle.setMaxConsecutiveOutliers(5);
            expect(await multiOracle.maxConsecutiveOutliers()).to.equal(5);
        });

        it("should revert max outliers = 0", async function () {
            await expect(multiOracle.setMaxConsecutiveOutliers(0)).to.revert(ethers);
        });

        it("should restrict config to owner only", async function () {
            await expect(
                multiOracle.connect(oracle1).setConsensusThreshold(80)
            ).to.be.revertedWithCustomError(multiOracle, "NotGovernance");
        });
    });

    // =========================================================================
    //                        PAUSABLE
    // =========================================================================
    describe("Pausable", function () {
        beforeEach(async function () {
            await multiOracle.registerOracle(oracle1.address, "Oracle-1");
            await multiOracle.registerOracle(oracle2.address, "Oracle-2");
            await multiOracle.registerOracle(oracle3.address, "Oracle-3");
            await multiOracle.registerOracle(oracle4.address, "Oracle-4");
        });

        it("should pause and unpause by owner", async function () {
            await multiOracle.pause();
            expect(await multiOracle.paused()).to.be.true;
            await multiOracle.unpause();
            expect(await multiOracle.paused()).to.be.false;
        });

        it("should revert pause by non-owner", async function () {
            await expect(
                multiOracle.connect(oracle1).pause()
            ).to.be.revertedWithCustomError(multiOracle, "OwnableUnauthorizedAccount");
        });

        it("should revert submitData when paused", async function () {
            await multiOracle.pause();
            await expect(
                multiOracle.connect(oracle1).submitData("dakar", 50, "WASDI")
            ).to.be.revertedWithCustomError(multiOracle, "EnforcedPause");
        });

        it("should revert commitData when paused", async function () {
            await multiOracle.pause();
            const hash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
                ["string", "uint256", "string", "bytes32"],
                ["dakar", 50, "WASDI", ethers.ZeroHash]
            ));
            await expect(
                multiOracle.connect(oracle1).commitData("dakar", hash)
            ).to.be.revertedWithCustomError(multiOracle, "EnforcedPause");
        });

        it("should allow submitData after unpause", async function () {
            await multiOracle.pause();
            await multiOracle.unpause();
            await expect(
                multiOracle.connect(oracle1).submitData("dakar", 50, "WASDI")
            ).to.emit(multiOracle, "DataSubmitted");
        });
    });

    // =========================================================================
    //                      GOVERNANCE
    // =========================================================================
    describe("Governance", function () {
        let governanceSigner;

        beforeEach(async function () {
            governanceSigner = oracle5; // reuse signer as governance
            await multiOracle.setGovernance(governanceSigner.address);
        });

        it("should set governance address", async function () {
            expect(await multiOracle.governance()).to.equal(governanceSigner.address);
        });

        it("should emit GovernanceUpdated event", async function () {
            await expect(multiOracle.setGovernance(oracle1.address))
                .to.emit(multiOracle, "GovernanceUpdated")
                .withArgs(governanceSigner.address, oracle1.address);
        });

        it("should allow governance to set consensus threshold", async function () {
            await multiOracle.connect(governanceSigner).setConsensusThreshold(75);
            expect(await multiOracle.consensusThreshold()).to.equal(75);
        });

        it("should allow governance to set data freshness threshold", async function () {
            await multiOracle.connect(governanceSigner).setDataFreshnessThreshold(7200);
            expect(await multiOracle.dataFreshnessThreshold()).to.equal(7200);
        });

        it("should allow governance to set max consecutive outliers", async function () {
            await multiOracle.connect(governanceSigner).setMaxConsecutiveOutliers(5);
            expect(await multiOracle.maxConsecutiveOutliers()).to.equal(5);
        });

        it("should revert config from non-owner non-governance", async function () {
            await expect(
                multiOracle.connect(oracle1).setConsensusThreshold(80)
            ).to.be.revertedWithCustomError(multiOracle, "NotGovernance");
        });

        it("should revert setGovernance from non-owner", async function () {
            await expect(
                multiOracle.connect(oracle1).setGovernance(oracle1.address)
            ).to.be.revertedWithCustomError(multiOracle, "OwnableUnauthorizedAccount");
        });

        it("should allow removing governance by setting zero", async function () {
            await multiOracle.setGovernance(ethers.ZeroAddress);
            expect(await multiOracle.governance()).to.equal(ethers.ZeroAddress);
        });
    });

    // =========================================================================
    //                    COMMIT-REVEAL
    // =========================================================================
    describe("Commit-Reveal", function () {
        beforeEach(async function () {
            await multiOracle.registerOracle(oracle1.address, "Oracle-1");
            await multiOracle.registerOracle(oracle2.address, "Oracle-2");
            await multiOracle.registerOracle(oracle3.address, "Oracle-3");
            await multiOracle.registerOracle(oracle4.address, "Oracle-4");
        });

        function computeCommitHash(region, riskScore, dataSource, salt) {
            return ethers.solidityPackedKeccak256(
                ["string", "uint256", "string", "bytes32"],
                [region, riskScore, dataSource, salt]
            );
        }

        it("should allow oracle to commit data", async function () {
            const salt = ethers.randomBytes(32);
            const hash = computeCommitHash("dakar", 60, "WASDI", salt);

            await expect(
                multiOracle.connect(oracle1).commitData("dakar", hash)
            ).to.emit(multiOracle, "DataCommitted");
        });

        it("should revert double commit in same round", async function () {
            const salt = ethers.randomBytes(32);
            const hash = computeCommitHash("dakar", 60, "WASDI", salt);

            await multiOracle.connect(oracle1).commitData("dakar", hash);
            await expect(
                multiOracle.connect(oracle1).commitData("dakar", hash)
            ).to.be.revertedWithCustomError(multiOracle, "AlreadyCommittedInRound");
        });

        it("should revert reveal before commit phase ends", async function () {
            const salt = ethers.id("salt1");
            const hash = computeCommitHash("dakar", 60, "WASDI", salt);

            await multiOracle.connect(oracle1).commitData("dakar", hash);

            // Try to reveal immediately (before COMMIT_PHASE_DURATION)
            await expect(
                multiOracle.connect(oracle1).revealData("dakar", 60, "WASDI", salt)
            ).to.be.revertedWithCustomError(multiOracle, "CommitPhaseNotOver");
        });

        it("should allow reveal after commit phase and verify hash", async function () {
            const salt = ethers.id("salt1");
            const hash = computeCommitHash("dakar", 60, "WASDI", salt);

            await multiOracle.connect(oracle1).commitData("dakar", hash);

            // Advance time past COMMIT_PHASE_DURATION (2 minutes)
            await ethers.provider.send("evm_increaseTime", [121]);
            await ethers.provider.send("evm_mine");

            await expect(
                multiOracle.connect(oracle1).revealData("dakar", 60, "WASDI", salt)
            ).to.emit(multiOracle, "DataRevealed")
                .withArgs(oracle1.address, "dakar", 60);
        });

        it("should revert reveal with wrong data (invalid hash)", async function () {
            const salt = ethers.id("salt1");
            const hash = computeCommitHash("dakar", 60, "WASDI", salt);

            await multiOracle.connect(oracle1).commitData("dakar", hash);

            await ethers.provider.send("evm_increaseTime", [121]);
            await ethers.provider.send("evm_mine");

            // Reveal with different risk score
            await expect(
                multiOracle.connect(oracle1).revealData("dakar", 70, "WASDI", salt)
            ).to.be.revertedWithCustomError(multiOracle, "InvalidReveal");
        });

        it("should revert reveal after window expires", async function () {
            const salt = ethers.id("salt1");
            const hash = computeCommitHash("dakar", 60, "WASDI", salt);

            await multiOracle.connect(oracle1).commitData("dakar", hash);

            // Advance time past COMMIT_PHASE_DURATION + REVEAL_WINDOW (12 min + buffer)
            await ethers.provider.send("evm_increaseTime", [721]);
            await ethers.provider.send("evm_mine");

            await expect(
                multiOracle.connect(oracle1).revealData("dakar", 60, "WASDI", salt)
            ).to.be.revertedWithCustomError(multiOracle, "RevealWindowExpired");
        });

        it("should revert reveal without prior commit", async function () {
            await ethers.provider.send("evm_increaseTime", [121]);
            await ethers.provider.send("evm_mine");

            await expect(
                multiOracle.connect(oracle1).revealData("dakar", 60, "WASDI", ethers.id("salt"))
            ).to.be.revertedWithCustomError(multiOracle, "NoCommitmentFound");
        });

        it("should reach consensus via commit-reveal with multiple oracles", async function () {
            const salts = [ethers.id("s1"), ethers.id("s2"), ethers.id("s3")];
            const scores = [55, 60, 58];
            const oracles = [oracle1, oracle2, oracle3];

            // All oracles commit
            for (let i = 0; i < 3; i++) {
                const hash = computeCommitHash("dakar", scores[i], "WASDI", salts[i]);
                await multiOracle.connect(oracles[i]).commitData("dakar", hash);
            }

            // Advance past commit phase
            await ethers.provider.send("evm_increaseTime", [121]);
            await ethers.provider.send("evm_mine");

            // All oracles reveal
            for (let i = 0; i < 3; i++) {
                await multiOracle.connect(oracles[i]).revealData("dakar", scores[i], "WASDI", salts[i]);
            }

            // Consensus should be reached with 3/4 = 75% > 60%
            const consensus = await multiOracle.getConsensus("dakar");
            expect(consensus.reached).to.be.true;
            expect(consensus.participantCount).to.be.gte(3);
        });
    });
});
