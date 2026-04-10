// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/**
 * @title IOpalGovernance
 * @dev Interface for multi-sig governance for emergency flood triggers
 * 
 * Architecture:
 * - Proposal-sign-execute workflow
 * - Multi-sig with configurable quorum
 * - Emergency override capability for high-severity events
 * - Deadline enforcement (default 24h)
 */
interface IOpalGovernance {

    enum ProposalStatus { PENDING, APPROVED, EXECUTED, REJECTED, EXPIRED }
    enum ProposalType { EMERGENCY_TRIGGER, PARAMETER_CHANGE, BUDGET_ALLOCATION, UPGRADE, ORACLE_OVERRIDE }

    struct Proposal {
        uint256 id;
        ProposalType proposalType;
        ProposalStatus status;
        address proposer;
        /// @notice H-02 fix: explicit target contract for proposal execution.
        /// When address(0), the governance contract falls back to floodPredictionContract.
        address target;
        string description;
        bytes data;                 // Encoded function call
        uint256 signatureCount;
        uint256 requiredSignatures;
        uint256 createdAt;
        uint256 deadline;
        uint256 executedAt;
        string region;
    }

    struct GovernanceActor {
        address actorAddress;
        string name;
        string role;                // "ADMIN", "GOVERNOR", "OBSERVER"
        bool isActive;
        uint256 proposalCount;
        uint256 signatureCount;
        uint256 registeredAt;
    }

    // Proposal lifecycle
    function createProposal(
        ProposalType proposalType,
        string calldata description,
        bytes calldata data,
        string calldata region,
        address target
    ) external returns (uint256 proposalId);

    function signProposal(uint256 proposalId) external;
    function executeProposal(uint256 proposalId) external;
    function rejectProposal(uint256 proposalId) external;

    // Governance management
    function addGovernanceActor(address actor, string calldata name, string calldata role) external;
    function removeGovernanceActor(address actor) external;
    function updateQuorum(uint256 newQuorum) external;

    // View functions
    function getProposal(uint256 proposalId) external view returns (Proposal memory);
    function getGovernanceActor(address actor) external view returns (GovernanceActor memory);
    function getActiveActorCount() external view returns (uint256);
    function getQuorum() external view returns (uint256);
    function hasSignedProposal(uint256 proposalId, address actor) external view returns (bool);

    // Events
    event ProposalCreated(uint256 indexed proposalId, ProposalType proposalType, address proposer, string region);
    event ProposalSigned(uint256 indexed proposalId, address signer, uint256 signatureCount);
    event ProposalExecuted(uint256 indexed proposalId, address executor);
    event ProposalRejected(uint256 indexed proposalId, address rejector);
    event ProposalExpired(uint256 indexed proposalId);
    event GovernanceActorAdded(address indexed actor, string name, string role);
    event GovernanceActorRemoved(address indexed actor);
    event QuorumUpdated(uint256 oldQuorum, uint256 newQuorum);
}
