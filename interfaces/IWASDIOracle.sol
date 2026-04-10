// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/**
 * @title IWASDIOracle
 * @dev Interface for WASDI satellite data oracle
 * WASDI = Web Advanced Space Developer Interface
 * Provides satellite-based flood risk assessment data
 */
interface IWASDIOracle {

    struct SatelliteData {
        string region;
        uint256 riskScore;          // 0-100
        uint256 rainfall;           // mm in last 24h
        uint256 soilMoisture;       // percentage 0-100
        uint256 waterLevel;         // cm above normal
        uint256 timestamp;
        string satelliteSource;     // "Sentinel-1", "Sentinel-2", "MODIS", etc.
        bool isProcessed;
    }

    // Data submission (from authorized oracle/relayer)
    function submitSatelliteData(
        string calldata region,
        uint256 riskScore,
        uint256 rainfall,
        uint256 soilMoisture,
        uint256 waterLevel,
        string calldata satelliteSource
    ) external;

    // View functions
    function getLatestData(string calldata region) external view returns (SatelliteData memory);
    function getRiskScore(string calldata region) external view returns (uint256);
    function isDataFresh(string calldata region) external view returns (bool);
    function getDataFreshnessThreshold() external view returns (uint256);

    // Simulation (for testing)
    function simulateHighRisk(string calldata region) external;
    function simulateLowRisk(string calldata region) external;

    // Events
    event SatelliteDataSubmitted(string indexed region, uint256 riskScore, uint256 rainfall, string source);
    event HighRiskDetected(string indexed region, uint256 riskScore, uint256 timestamp);
    event DataExpired(string indexed region, uint256 lastUpdate);
}
