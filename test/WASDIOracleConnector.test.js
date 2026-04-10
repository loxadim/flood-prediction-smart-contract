/**
 * @title WASDIOracleConnector Unit Tests
 * @description Tests for satellite data oracle connector with anomaly detection
 */
import { expect } from "chai";
import hre from "hardhat";

const { ethers } = await hre.network.connect();

describe("WASDIOracleConnector", function () {
    let oracle;
    let owner, relayer1, relayer2, other;

    const REGION = "SN-TH";
    const RISK_SCORE = 65;
    const RAINFALL = 150;
    const SOIL_MOISTURE = 45;
    const WATER_LEVEL = 500;
    const SAT_SOURCE = "Sentinel-2";

    beforeEach(async function () {
        [owner, relayer1, relayer2, other] = await ethers.getSigners();

        const Oracle = await ethers.getContractFactory("WASDIOracleConnector");
        oracle = await Oracle.deploy();
        await oracle.waitForDeployment();
    });

    // =========================================================================
    //                         DEPLOYMENT
    // =========================================================================
    describe("Deployment", function () {
        it("should set correct owner", async function () {
            expect(await oracle.owner()).to.equal(owner.address);
        });

        it("should set owner as first relayer", async function () {
            expect(await oracle.authorizedRelayers(owner.address)).to.be.true;
        });

        it("should set default freshness threshold to 6 hours", async function () {
            expect(await oracle.getDataFreshnessThreshold()).to.equal(6 * 3600);
        });

        it("should have default satellite sources registered", async function () {
            const sources = ["Sentinel-1", "Sentinel-2", "MODIS", "Landsat-8", "Landsat-9", "VIIRS"];
            for (const source of sources) {
                expect(await oracle.supportedSources(source)).to.be.true;
            }
        });

        it("should not be paused", async function () {
            expect(await oracle.paused()).to.be.false;
        });
    });

    // =========================================================================
    //                      RELAYER MANAGEMENT
    // =========================================================================
    describe("Relayer Management", function () {
        it("should add a relayer", async function () {
            await expect(oracle.addRelayer(relayer1.address))
                .to.emit(oracle, "RelayerAdded")
                .withArgs(relayer1.address);
            expect(await oracle.authorizedRelayers(relayer1.address)).to.be.true;
        });

        it("should remove a relayer", async function () {
            await oracle.addRelayer(relayer1.address);
            await expect(oracle.removeRelayer(relayer1.address))
                .to.emit(oracle, "RelayerRemoved")
                .withArgs(relayer1.address);
            expect(await oracle.authorizedRelayers(relayer1.address)).to.be.false;
        });

        it("should revert adding zero address", async function () {
            await expect(
                oracle.addRelayer(ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(oracle, "ZeroAddress");
        });

        it("should revert adding existing relayer", async function () {
            await oracle.addRelayer(relayer1.address);
            await expect(
                oracle.addRelayer(relayer1.address)
            ).to.be.revertedWithCustomError(oracle, "RelayerAlreadyAuthorized");
        });

        it("should revert removing non-relayer", async function () {
            await expect(
                oracle.removeRelayer(relayer1.address)
            ).to.be.revertedWithCustomError(oracle, "RelayerNotAuthorized");
        });

        it("should revert if not owner", async function () {
            await expect(
                oracle.connect(other).addRelayer(relayer1.address)
            ).to.be.revertedWithCustomError(oracle, "OwnableUnauthorizedAccount");
        });
    });

    // =========================================================================
    //                  SATELLITE DATA SUBMISSION
    // =========================================================================
    describe("Satellite Data Submission", function () {
        it("should submit data successfully", async function () {
            const tx = await oracle.submitSatelliteData(
                REGION, RISK_SCORE, RAINFALL, SOIL_MOISTURE, WATER_LEVEL, SAT_SOURCE
            );
            await expect(tx).to.emit(oracle, "SatelliteDataSubmitted");
        });

        it("should store latest data correctly", async function () {
            await oracle.submitSatelliteData(
                REGION, RISK_SCORE, RAINFALL, SOIL_MOISTURE, WATER_LEVEL, SAT_SOURCE
            );
            const data = await oracle.getLatestData(REGION);
            expect(data.riskScore).to.equal(RISK_SCORE);
            expect(data.rainfall).to.equal(RAINFALL);
            expect(data.soilMoisture).to.equal(SOIL_MOISTURE);
            expect(data.waterLevel).to.equal(WATER_LEVEL);
        });

        it("should revert for invalid risk score > 100", async function () {
            await expect(
                oracle.submitSatelliteData(REGION, 101, RAINFALL, SOIL_MOISTURE, WATER_LEVEL, SAT_SOURCE)
            ).to.be.revertedWithCustomError(oracle, "InvalidRiskScore");
        });

        it("should revert for invalid rainfall > 2000", async function () {
            await expect(
                oracle.submitSatelliteData(REGION, RISK_SCORE, 2001, SOIL_MOISTURE, WATER_LEVEL, SAT_SOURCE)
            ).to.be.revertedWithCustomError(oracle, "InvalidRainfall");
        });

        it("should revert for invalid soil moisture > 100", async function () {
            await expect(
                oracle.submitSatelliteData(REGION, RISK_SCORE, RAINFALL, 101, WATER_LEVEL, SAT_SOURCE)
            ).to.be.revertedWithCustomError(oracle, "InvalidSoilMoisture");
        });

        it("should revert for invalid water level > 10000", async function () {
            await expect(
                oracle.submitSatelliteData(REGION, RISK_SCORE, RAINFALL, SOIL_MOISTURE, 10001, SAT_SOURCE)
            ).to.be.revertedWithCustomError(oracle, "InvalidWaterLevel");
        });

        it("should revert for unsupported satellite source", async function () {
            await expect(
                oracle.submitSatelliteData(REGION, RISK_SCORE, RAINFALL, SOIL_MOISTURE, WATER_LEVEL, "FakeSource")
            ).to.be.revertedWithCustomError(oracle, "UnsupportedSatelliteSource");
        });

        it("should revert if not a relayer", async function () {
            await expect(
                oracle.connect(other).submitSatelliteData(
                    REGION, RISK_SCORE, RAINFALL, SOIL_MOISTURE, WATER_LEVEL, SAT_SOURCE
                )
            ).to.be.revertedWithCustomError(oracle, "UnauthorizedRelayer");
        });

        it("should revert when paused", async function () {
            await oracle.pause();
            await expect(
                oracle.submitSatelliteData(REGION, RISK_SCORE, RAINFALL, SOIL_MOISTURE, WATER_LEVEL, SAT_SOURCE)
            ).to.be.revertedWithCustomError(oracle, "EnforcedPause");
        });
    });

    // =========================================================================
    //                    ANOMALY DETECTION
    // =========================================================================
    describe("Anomaly Detection", function () {
        it("should detect anomaly when spike > 40 points", async function () {
            // First submission: low risk
            await oracle.submitSatelliteData(REGION, 20, RAINFALL, SOIL_MOISTURE, WATER_LEVEL, SAT_SOURCE);

            // Second submission: spike of 45 points
            const tx = await oracle.submitSatelliteData(REGION, 65, RAINFALL, SOIL_MOISTURE, WATER_LEVEL, SAT_SOURCE);
            await expect(tx).to.emit(oracle, "AnomalyDetected");
        });

        it("should NOT detect anomaly for small changes", async function () {
            await oracle.submitSatelliteData(REGION, 20, RAINFALL, SOIL_MOISTURE, WATER_LEVEL, SAT_SOURCE);

            // Small change of 10 points
            const tx = await oracle.submitSatelliteData(REGION, 30, RAINFALL, SOIL_MOISTURE, WATER_LEVEL, SAT_SOURCE);
            const receipt = await tx.wait();
            const anomalyLogs = receipt.logs.filter(
                l => l.fragment && l.fragment.name === "AnomalyDetected"
            );
            expect(anomalyLogs.length).to.equal(0);
        });
    });

    // =========================================================================
    //                     VIEW FUNCTIONS
    // =========================================================================
    describe("View Functions", function () {
        beforeEach(async function () {
            await oracle.submitSatelliteData(REGION, RISK_SCORE, RAINFALL, SOIL_MOISTURE, WATER_LEVEL, SAT_SOURCE);
        });

        it("should return risk score if data is fresh", async function () {
            expect(await oracle.getRiskScore(REGION)).to.equal(RISK_SCORE);
        });

        it("should return 0 risk score if data is stale", async function () {
            await ethers.provider.send("evm_increaseTime", [7 * 3600]); // > 6h freshness
            await ethers.provider.send("evm_mine", []);
            expect(await oracle.getRiskScore(REGION)).to.equal(0);
        });

        it("should report data as fresh", async function () {
            expect(await oracle.isDataFresh(REGION)).to.be.true;
        });

        it("should report data as stale after freshness period", async function () {
            await ethers.provider.send("evm_increaseTime", [7 * 3600]);
            await ethers.provider.send("evm_mine", []);
            expect(await oracle.isDataFresh(REGION)).to.be.false;
        });

        it("should return historical data", async function () {
            // Submit more data to build history
            await oracle.submitSatelliteData(REGION, 70, 200, 50, 600, SAT_SOURCE);
            await oracle.submitSatelliteData(REGION, 80, 250, 55, 700, SAT_SOURCE);

            const history = await oracle.getHistoricalData(REGION, 3);
            expect(history.length).to.equal(3);
        });

        it("should return average risk", async function () {
            await oracle.submitSatelliteData(REGION, 75, RAINFALL, SOIL_MOISTURE, WATER_LEVEL, SAT_SOURCE);
            const avg = await oracle.getAverageRisk(REGION, 2);
            // (65 + 75) / 2 = 70
            expect(avg).to.equal(70);
        });

        it("should report recent anomaly", async function () {
            // Create anomaly
            await oracle.submitSatelliteData(REGION, 10, RAINFALL, SOIL_MOISTURE, WATER_LEVEL, SAT_SOURCE);
            await oracle.submitSatelliteData(REGION, 90, RAINFALL, SOIL_MOISTURE, WATER_LEVEL, SAT_SOURCE);

            expect(await oracle.hasRecentAnomaly(REGION, 3600)).to.be.true;
        });
    });

    // =========================================================================
    //                    SIMULATION FUNCTIONS
    // =========================================================================
    describe("Simulation Functions", function () {
        it("should simulate high risk", async function () {
            // C-02 fix: testMode is now false by default, enable it for simulation tests
            await oracle.setTestMode(true);
            await expect(oracle.simulateHighRisk(REGION))
                .to.emit(oracle, "SatelliteDataSubmitted");

            const score = await oracle.getRiskScore(REGION);
            expect(score).to.be.greaterThan(80);
        });

        it("should simulate low risk", async function () {
            // C-02 fix: testMode is now false by default, enable it for simulation tests
            await oracle.setTestMode(true);
            await expect(oracle.simulateLowRisk(REGION))
                .to.emit(oracle, "SatelliteDataSubmitted");

            const score = await oracle.getRiskScore(REGION);
            expect(score).to.be.lessThan(30);
        });

        it("should revert simulation if not relayer", async function () {
            await expect(
                oracle.connect(other).simulateHighRisk(REGION)
            ).to.be.revertedWithCustomError(oracle, "UnauthorizedRelayer");
        });
    });

    // =========================================================================
    //                  SATELLITE SOURCE MANAGEMENT
    // =========================================================================
    describe("Satellite Source Management", function () {
        it("should add a new source", async function () {
            await oracle.addSatelliteSource("Copernicus-GLO30");
            expect(await oracle.supportedSources("Copernicus-GLO30")).to.be.true;
        });

        it("should remove a source", async function () {
            await oracle.removeSatelliteSource("VIIRS");
            expect(await oracle.supportedSources("VIIRS")).to.be.false;
        });

        it("should silently overwrite existing source", async function () {
            // addSatelliteSource does not revert on duplicate, just overwrites
            await oracle.addSatelliteSource("Sentinel-2");
            expect(await oracle.supportedSources("Sentinel-2")).to.be.true;
        });

        it("should silently remove non-existing source", async function () {
            // removeSatelliteSource does not revert on non-existing, just sets false
            await oracle.removeSatelliteSource("NonExistent");
            expect(await oracle.supportedSources("NonExistent")).to.be.false;
        });
    });

    // =========================================================================
    //                  ADMIN CONFIGURATION
    // =========================================================================
    describe("Admin Configuration", function () {
        it("should set freshness threshold", async function () {
            await oracle.setFreshnessThreshold(3600); // 1 hour
            expect(await oracle.getDataFreshnessThreshold()).to.equal(3600);
        });

        it("should revert freshness < 30 minutes", async function () {
            await expect(
                oracle.setFreshnessThreshold(200) // < 1800 seconds (30 min)
            ).to.be.revertedWithCustomError(oracle, "InvalidFreshnessThreshold");
        });

        it("should revert freshness > 7 days", async function () {
            await expect(
                oracle.setFreshnessThreshold(8 * 24 * 3600) // 8 days
            ).to.be.revertedWithCustomError(oracle, "InvalidFreshnessThreshold");
        });

        it("should pause the contract", async function () {
            await oracle.pause();
            expect(await oracle.paused()).to.be.true;
        });

        it("should unpause the contract", async function () {
            await oracle.pause();
            await oracle.unpause();
            expect(await oracle.paused()).to.be.false;
        });

        it("should revert if not owner (pause)", async function () {
            await expect(
                oracle.connect(other).pause()
            ).to.be.revertedWithCustomError(oracle, "OwnableUnauthorizedAccount");
        });
    });
});
