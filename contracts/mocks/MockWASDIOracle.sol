// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "../../interfaces/IWASDIOracle.sol";

/**
 * @title MockWASDIOracle
 * @dev Mock implementation of WASDI satellite data oracle for testing
 * Simulates satellite flood risk data without actual WASDI API integration
 */
contract MockWASDIOracle is IWASDIOracle, Ownable2Step {

    // I-04 fix: custom errors instead of require strings
    error NotAuthorized();
    error InvalidRiskScore();
    error InvalidSoilMoisture();

    // Data freshness threshold (1 hour)
    uint256 public constant DATA_FRESHNESS_THRESHOLD = 1 hours;

    // Region => latest satellite data
    mapping(string => SatelliteData) public latestDataMap;

    // Authorized data submitters
    mapping(address => bool) public authorizedSubmitters;

    // ============================================
    // Constructor
    // ============================================
    constructor() Ownable(msg.sender) {
        authorizedSubmitters[msg.sender] = true;
    }

    // ============================================
    // Submitter Management
    // ============================================

    function addSubmitter(address submitter) external onlyOwner {
        authorizedSubmitters[submitter] = true;
    }

    function removeSubmitter(address submitter) external onlyOwner {
        authorizedSubmitters[submitter] = false;
    }

    // ============================================
    // Data Submission
    // ============================================

    /**
     * @dev Submit satellite data for a region
     */
    function submitSatelliteData(
        string calldata region,
        uint256 riskScore,
        uint256 rainfall,
        uint256 soilMoisture,
        uint256 waterLevel,
        string calldata satelliteSource
    ) external override {
        if (!authorizedSubmitters[msg.sender]) revert NotAuthorized();
        if (riskScore > 100) revert InvalidRiskScore();
        if (soilMoisture > 100) revert InvalidSoilMoisture();

        latestDataMap[region] = SatelliteData({
            region: region,
            riskScore: riskScore,
            rainfall: rainfall,
            soilMoisture: soilMoisture,
            waterLevel: waterLevel,
            timestamp: block.timestamp,
            satelliteSource: satelliteSource,
            isProcessed: true
        });

        emit SatelliteDataSubmitted(region, riskScore, rainfall, satelliteSource);

        if (riskScore >= 70) {
            emit HighRiskDetected(region, riskScore, block.timestamp);
        }
    }

    // ============================================
    // Simulation Functions (for testing)
    // ============================================

    /**
     * @dev Simulate a high-risk flood scenario
     * @param region Target region
     */
    function simulateHighRisk(string calldata region) external override {
        latestDataMap[region] = SatelliteData({
            region: region,
            riskScore: 85,
            rainfall: 120,        // 120mm in 24h (heavy rain)
            soilMoisture: 95,     // 95% saturated
            waterLevel: 250,      // 250cm above normal
            timestamp: block.timestamp,
            satelliteSource: "MOCK-Sentinel-1",
            isProcessed: true
        });

        emit SatelliteDataSubmitted(region, 85, 120, "MOCK-Sentinel-1");
        emit HighRiskDetected(region, 85, block.timestamp);
    }

    /**
     * @dev Simulate a low-risk scenario
     * @param region Target region
     */
    function simulateLowRisk(string calldata region) external override {
        latestDataMap[region] = SatelliteData({
            region: region,
            riskScore: 15,
            rainfall: 10,         // 10mm in 24h (light rain)
            soilMoisture: 30,     // 30% moisture
            waterLevel: 10,       // 10cm (normal)
            timestamp: block.timestamp,
            satelliteSource: "MOCK-Sentinel-2",
            isProcessed: true
        });

        emit SatelliteDataSubmitted(region, 15, 10, "MOCK-Sentinel-2");
    }

    /**
     * @dev Simulate custom scenario
     */
    function simulateCustom(
        string calldata region,
        uint256 riskScore,
        uint256 rainfall,
        uint256 soilMoisture,
        uint256 waterLevel
    ) external {
        require(riskScore <= 100 && soilMoisture <= 100, "Invalid values");

        latestDataMap[region] = SatelliteData({
            region: region,
            riskScore: riskScore,
            rainfall: rainfall,
            soilMoisture: soilMoisture,
            waterLevel: waterLevel,
            timestamp: block.timestamp,
            satelliteSource: "MOCK-Custom",
            isProcessed: true
        });

        emit SatelliteDataSubmitted(region, riskScore, rainfall, "MOCK-Custom");
        if (riskScore >= 70) {
            emit HighRiskDetected(region, riskScore, block.timestamp);
        }
    }

    // ============================================
    // View Functions
    // ============================================

    function getLatestData(string calldata region) external view override returns (SatelliteData memory) {
        return latestDataMap[region];
    }

    function getRiskScore(string calldata region) external view override returns (uint256) {
        return latestDataMap[region].riskScore;
    }

    function isDataFresh(string calldata region) external view override returns (bool) {
        SatelliteData memory data = latestDataMap[region];
        if (data.timestamp == 0) return false;
        return (block.timestamp - data.timestamp) <= DATA_FRESHNESS_THRESHOLD;
    }

    function getDataFreshnessThreshold() external pure override returns (uint256) {
        return DATA_FRESHNESS_THRESHOLD;
    }
}
