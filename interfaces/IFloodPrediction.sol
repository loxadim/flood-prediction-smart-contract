// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "./IMobileMoneyProvider.sol";

/**
 * @title IFloodPrediction
 * @dev Interface for the FloodPrediction main orchestrator contract
 */
interface IFloodPrediction {
    
    enum TriggerStatus { INACTIVE, PENDING, ACTIVE, VALIDATED, PAID, EXPIRED, CANCELLED }
    enum RiskLevel { LOW, MODERATE, HIGH, CRITICAL }
    
    struct FloodTrigger {
        string eventId;
        string region;
        uint256 riskScore;          // 0-100
        uint256 timestamp;
        uint256 validatedAt;
        uint256 paidAt;
        TriggerStatus status;
        RiskLevel riskLevel;
        address triggeredBy;
        uint256 totalAmount;
        uint256 beneficiaryCount;
        bytes32 merkleRoot;
        bool isGovernanceOverride;
        uint256 chainId;            // M-01 fix: added chainId field
    }

    struct BudgetAllocation {
        string region;
        uint256 allocatedAmount;
        uint256 spentAmount;
        uint256 lastUpdated;
        bool isActive;
    }

    // Core functions
    function createFloodTrigger(
        string calldata region,
        uint256 riskScore,
        bytes32 merkleRoot,
        uint256 totalAmount,
        uint256 beneficiaryCount
    ) external returns (string memory eventId);

    function validateTrigger(string calldata eventId) external;

    //  added 5th parameter phoneHashes to match implementation (V-04 fix)
    function processBatchPayment(
        string calldata eventId,
        bytes32[] calldata beneficiaryHashes,
        uint256[] calldata amounts,
        bytes32[][] calldata merkleProofs,
        bytes32[] calldata phoneHashes,
        IMobileMoneyProvider.MobileProvider[] calldata providers
    ) external;

    //  validateAndProcessPayments added to interface (V-04 fix)
    function validateAndProcessPayments(
        string calldata eventId,
        bytes32[] calldata beneficiaryHashes,
        uint256[] calldata amounts,
        bytes32[][] calldata merkleProofs,
        bytes32[] calldata phoneHashes,
        IMobileMoneyProvider.MobileProvider[] calldata providers
    ) external;

    // Budget management
    function allocateBudget(string calldata region, uint256 amount) external;
    function deactivateBudget(string calldata region) external;

    // Trigger management
    function cancelTrigger(string calldata eventId, string calldata reason) external;
    function createGovernanceOverrideTrigger(
        string calldata region,
        uint256 riskScore,
        bytes32 merkleRoot,
        uint256 totalAmount,
        uint256 beneficiaryCount,
        string calldata reason
    ) external returns (string memory eventId);

    // Emergency management
    function activateEmergencyMode(string calldata reason) external;
    function deactivateEmergencyMode() external;
    function setRegionEmergency(string calldata region, bool status) external;

    // Configuration
    function updateRiskThreshold(uint256 newThreshold) external;
    function setContractAddresses(
        address _multiOracle,
        address _governance,
        address _targeting,
        address _mobileMoney,
        address _kyc
    ) external;

    // View functions
    function getFloodTrigger(string calldata eventId) external view returns (FloodTrigger memory);
    function getRegionBudget(string calldata region) external view returns (BudgetAllocation memory);
    function getRegionBudgetRemaining(string calldata region) external view returns (uint256);
    function isBeneficiaryPaid(string calldata eventId, bytes32 beneficiaryHash) external view returns (bool);
    function getVersion() external pure returns (uint256);
    function getCooldownRemaining(string calldata region, uint256 riskScore) external view returns (uint256);
    function getTriggerIdsPaginated(uint256 offset, uint256 limit) external view returns (string[] memory ids, uint256 total);
    function getBudgetRegionsPaginated(uint256 offset, uint256 limit) external view returns (string[] memory regions, uint256 total);
    
    // M-03 fix: events synchronized with implementation
    event FloodTriggerCreated(string indexed eventId, string region, uint256 riskScore, uint256 timestamp, address triggeredBy);
    event TriggerValidated(string indexed eventId, address validator, uint256 timestamp);
    event BatchPaymentProcessed(string indexed eventId, uint256 beneficiaryCount, uint256 totalAmount, uint256 timestamp);
    event BudgetAllocated(string indexed region, uint256 amount, address allocatedBy);
}
