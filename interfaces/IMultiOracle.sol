// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/**
 * @title IMultiOracle
 * @dev Interface for multi-oracle consensus engine with IQR outlier detection
 * 
 * Architecture:
 * - Multiple oracles submit flood risk data via commit-reveal scheme
 * - IQR (Interquartile Range) outlier detection filters anomalous data
 * - Consensus requires threshold agreement (default 60%)
 * - Reputation system tracks oracle reliability
 * - Pausable for emergency scenarios
 * - Governance-connected for decentralized parameter management
 */
interface IMultiOracle {

    struct OracleData {
        address oracle;
        uint256 riskScore;          // 0-100
        uint256 timestamp;
        string dataSource;          // "WASDI", "CHIRPS", "GFS", etc.
        bool isOutlier;
    }

    struct ConsensusResult {
        uint256 consensusRiskScore;
        uint256 participantCount;
        uint256 outlierCount;
        uint256 timestamp;
        bool reached;
        string region;
    }

    struct OracleInfo {
        address oracleAddress;
        string name;
        uint256 reputation;         // 0-100
        uint256 totalSubmissions;
        uint256 outlierCount;
        uint256 consecutiveOutliers;
        bool isActive;
        uint256 registeredAt;
    }

    // Oracle management
    function registerOracle(address oracle, string calldata name) external;
    function deactivateOracle(address oracle) external;
    function reactivateOracle(address oracle) external;

    // Data submission (direct — backward compatible)
    function submitData(
        string calldata region,
        uint256 riskScore,
        string calldata dataSource
    ) external;

    // Data submission (commit-reveal)
    function commitData(string calldata region, bytes32 commitHash) external;
    function revealData(
        string calldata region,
        uint256 riskScore,
        string calldata dataSource,
        bytes32 salt
    ) external;

    // Consensus
    function getConsensus(string calldata region) external view returns (ConsensusResult memory);
    function isConsensusReached(string calldata region) external view returns (bool);
    function getConsensusRiskScore(string calldata region) external view returns (uint256);

    // Oracle info
    function getOracleInfo(address oracle) external view returns (OracleInfo memory);
    function getActiveOracleCount() external view returns (uint256);
    function getOracleReputation(address oracle) external view returns (uint256);

    // Events
    event OracleRegistered(address indexed oracle, string name);
    event OracleDeactivated(address indexed oracle);
    event OracleReactivated(address indexed oracle);
    event DataSubmitted(address indexed oracle, string region, uint256 riskScore, string dataSource);
    event DataCommitted(address indexed oracle, string region, uint256 round);
    event DataRevealed(address indexed oracle, string region, uint256 riskScore);
    event ConsensusReached(string indexed region, uint256 riskScore, uint256 participantCount);
    event OutlierDetected(address indexed oracle, string region, uint256 riskScore);
    event ReputationUpdated(address indexed oracle, uint256 newReputation);
    event GovernanceUpdated(address indexed oldGovernance, address indexed newGovernance);
}
