// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "../interfaces/IOpalGovernance.sol";

/**
 * @title OpalGovernanceUpgradeable
 * @author DPA Foundation
 * @notice Multi-sig governance for emergency flood triggers and parameter changes
 * 
 * @dev Implements a proposal-sign-execute workflow with:
 * - Configurable quorum for multi-sig approvals
 * - 24-hour deadline enforcement
 * - Emergency override capability for high-severity events
 * - Maximum 20 governance actors
 * - UUPS upgradeable pattern
 * 
 * Conformité Volet 3: Conception de contrats intelligents
 * Conformité Volet 5: Sécurité et gouvernance
 */
contract OpalGovernanceUpgradeable is 
    Initializable,
    Ownable2StepUpgradeable,
    UUPSUpgradeable,
    IOpalGovernance
{

    // ============================================
    // Constants
    // ============================================
    uint256 public constant MAX_ACTORS = 20;
    uint256 public constant DEFAULT_DEADLINE = 24 hours;
    uint256 public constant EMERGENCY_DEADLINE = 4 hours;
    uint256 public constant MIN_QUORUM = 2;

    // ============================================
    // State
    // ============================================
    
    // Governance actors
    mapping(address => GovernanceActor) public actors;
    address[] public actorList;
    uint256 public activeActorCount;
    
    // Proposals
    mapping(uint256 => Proposal) public proposals;
    uint256 public proposalCount;
    uint256 public executedProposalCount;
    
    // Signatures: proposalId => actor => signed
    mapping(uint256 => mapping(address => bool)) public proposalSignatures;
    
    // Configuration
    uint256 public quorum;
    
    // Connected contract references
    address public floodPredictionContract;

    // Selector whitelist for proposal execution 
    mapping(bytes4 => bool) public allowedSelectors;

    // M-03 fix: configurable gas limit for proposal execution
    uint256 public executionGasLimit;

    // M-10 fix: timelock — record when quorum was reached and enforce delay
    mapping(uint256 => uint256) public quorumReachedAt;
    uint256 public constant EXECUTION_DELAY = 1 hours;

    // M-01v2 fix: separate rejection count to avoid conflating approvals and rejections
    mapping(uint256 => uint256) public proposalRejectionCount;
    mapping(uint256 => mapping(address => bool)) public proposalRejections;

    // V-03 fix: track upgrade implementations approved via governance proposal
    mapping(address => bool) public approvedUpgrades;

    // V-04 fix: whitelist of contract addresses that proposals may call.
    // executeProposal() previously only checked the function selector, allowing
    // proposal.target to point at any attacker-controlled contract exposing a
    // colliding selector.
    mapping(address => bool) public allowedTargets;

    // H12-GOV fix: dedicated whitelist of selectors that EMERGENCY_TRIGGER
    // proposals may execute, separate from allowedSelectors (used by
    // PARAMETER_CHANGE/BUDGET_ALLOCATION/UPGRADE/ORACLE_OVERRIDE proposals).
    // Without this split, any whitelisted selector could be executed
    // immediately by self-labeling a proposal EMERGENCY_TRIGGER, bypassing
    // the EXECUTION_DELAY owner-veto window added by the M-10 fix.
    mapping(bytes4 => bool) public emergencyAllowedSelectors;

    // ============================================
    // Events (M-10 fix)
    // ============================================
    event SelectorWhitelisted(bytes4 indexed selector, bool allowed);
    event TargetWhitelisted(address indexed target, bool allowed);
    event EmergencySelectorWhitelisted(bytes4 indexed selector, bool allowed);

    // ============================================
    // Errors
    // ============================================
    error NotGovernanceActor();
    error ActorAlreadyRegistered();
    error ActorNotRegistered();
    error InvalidAddress();
    error MaxActorsReached();
    error ProposalNotFound();
    error ProposalNotPending();
    error ProposalIsExpired();
    error AlreadySigned();
    error InsufficientSignatures();
    error InvalidQuorum();
    error CannotRemoveBelowQuorum();
    error SelectorNotWhitelisted();
    error TargetNotWhitelisted();
    error ProposalTypeSelectorMismatch();
    error ExecutionFailed();
    error TimelockNotElapsed();
    error ProposalNotExpired();
    error ArrayLengthMismatch();
    error UpgradeNotApproved();
    error InvalidGasLimit();
    error AlreadyRejected();

    // ============================================
    // Modifiers
    // ============================================
    
    modifier onlyGovernanceActor() {
        if (!actors[msg.sender].isActive) revert NotGovernanceActor();
        _;
    }

    // ============================================
    // Initializer (UUPS)
    // ============================================

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @dev Initialize the governance contract
     * @param initialOwner Address of the initial owner
     * @param initialQuorum Required signatures for proposals
     */
    function initialize(
        address initialOwner,
        uint256 initialQuorum
    ) public initializer {
        __Ownable_init(initialOwner);

        // A48 fix: bound the initial quorum by MAX_ACTORS — a quorum that can never be
        // met (more signatures than actors can ever exist) would render every proposal
        // permanently unexecutable with no recovery other than an upgrade.
        if (initialQuorum < MIN_QUORUM || initialQuorum > MAX_ACTORS) revert InvalidQuorum();
        quorum = initialQuorum;
        executionGasLimit = 500_000; // default 500K

        // Register owner as first governance actor
        actors[initialOwner] = GovernanceActor({
            actorAddress: initialOwner,
            name: "Admin",
            role: "ADMIN",
            isActive: true,
            proposalCount: 0,
            signatureCount: 0,
            registeredAt: block.timestamp
        });
        actorList.push(initialOwner);
        activeActorCount = 1;

        emit GovernanceActorAdded(initialOwner, "Admin", "ADMIN");

        // H13-GOV fix: whitelist this contract as an allowed proposal target
        // and approveUpgrade() as an allowed selector, so UPGRADE proposals
        // (a self-call to approveUpgrade via executeProposal) can execute.
        // Without this, the only sanctioned UUPS upgrade path (V-03 fix) is
        // unreachable — executeProposal always reverts with TargetNotWhitelisted.
        allowedTargets[address(this)] = true;
        allowedSelectors[this.approveUpgrade.selector] = true;
        emit TargetWhitelisted(address(this), true);
        emit SelectorWhitelisted(this.approveUpgrade.selector, true);
    }

    /// @dev V-03 fix: Authorization requires both ownership AND governance approval.
    /// The upgrade must first be approved via a governance proposal calling approveUpgrade().
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
        if (newImplementation == address(0)) revert InvalidAddress();
        if (newImplementation.code.length == 0) revert InvalidAddress();
        if (!approvedUpgrades[newImplementation]) revert UpgradeNotApproved();
        // Clear approval after use (single-use)
        approvedUpgrades[newImplementation] = false;
    }

    /**
     * @dev Approve an implementation address for UUPS upgrade.
     * Can only be called by this contract itself (via executeProposal).
     * @param implementation Address of the new implementation contract
     */
    function approveUpgrade(address implementation) external {
        if (msg.sender != address(this)) revert NotGovernanceActor();
        if (implementation == address(0)) revert InvalidAddress();
        if (implementation.code.length == 0) revert InvalidAddress();
        approvedUpgrades[implementation] = true;
    }

    // ============================================
    // Actor Management
    // ============================================

    /**
     * @dev Add a governance actor
     * @param actor Address of the actor
     * @param name Human-readable name
     * @param role Role: "ADMIN", "GOVERNOR", or "OBSERVER"
     */
    function addGovernanceActor(
        address actor, 
        string calldata name, 
        string calldata role
    ) external override onlyOwner {
        if (actor == address(0)) revert InvalidAddress();
        if (actors[actor].isActive) revert ActorAlreadyRegistered();
        if (activeActorCount >= MAX_ACTORS) revert MaxActorsReached();

        // Check if previously registered but deactivated
        if (actors[actor].registeredAt > 0) {
            actors[actor].isActive = true;
            actors[actor].name = name;
            actors[actor].role = role;
            activeActorCount++;
            emit GovernanceActorAdded(actor, name, role);
            return;
        }

        actors[actor] = GovernanceActor({
            actorAddress: actor,
            name: name,
            role: role,
            isActive: true,
            proposalCount: 0,
            signatureCount: 0,
            registeredAt: block.timestamp
        });
        actorList.push(actor);
        activeActorCount++;

        emit GovernanceActorAdded(actor, name, role);
    }

    /**
     * @dev Remove a governance actor
     * @param actor Address to remove
     */
    function removeGovernanceActor(address actor) external override onlyOwner {
        if (!actors[actor].isActive) revert ActorNotRegistered();
        if (activeActorCount - 1 < quorum) revert CannotRemoveBelowQuorum();

        actors[actor].isActive = false;
        activeActorCount--;

        // L-06 fix: swap-and-pop to keep actorList compact
        for (uint256 i = 0; i < actorList.length; i++) {
            if (actorList[i] == actor) {
                actorList[i] = actorList[actorList.length - 1];
                actorList.pop();
                break;
            }
        }

        emit GovernanceActorRemoved(actor);
    }

    /**
     * @dev Update the quorum requirement
     * @param newQuorum New required signature count
     */
    function updateQuorum(uint256 newQuorum) external override onlyOwner {
        if (newQuorum < MIN_QUORUM || newQuorum > activeActorCount) revert InvalidQuorum();
        uint256 oldQuorum = quorum;
        quorum = newQuorum;
        emit QuorumUpdated(oldQuorum, newQuorum);
    }

    // ============================================
    // Proposal Lifecycle
    // ============================================

    /**
     * @dev Create a new governance proposal
     * @param proposalType Type of proposal
     * @param description Human-readable description
     * @param data Encoded function call data
     * @param region Affected region (if applicable)
     * @param target H-02 fix: contract address to call on execution.
     *               Pass address(0) to default to floodPredictionContract.
     * @return proposalId The new proposal's ID
     */
    function createProposal(
        ProposalType proposalType,
        string calldata description,
        bytes calldata data,
        string calldata region,
        address target
    ) external override onlyGovernanceActor returns (uint256 proposalId) {
        proposalId = proposalCount++;

        uint256 deadline = proposalType == ProposalType.EMERGENCY_TRIGGER
            ? block.timestamp + EMERGENCY_DEADLINE
            : block.timestamp + DEFAULT_DEADLINE;

        proposals[proposalId] = Proposal({
            id: proposalId,
            proposalType: proposalType,
            status: ProposalStatus.PENDING,
            proposer: msg.sender,
            target: target,
            description: description,
            data: data,
            signatureCount: 1,  // Proposer auto-signs
            requiredSignatures: quorum,
            createdAt: block.timestamp,
            deadline: deadline,
            executedAt: 0,
            region: region
        });

        proposalSignatures[proposalId][msg.sender] = true;
        actors[msg.sender].proposalCount++;
        actors[msg.sender].signatureCount++;

        emit ProposalCreated(proposalId, proposalType, msg.sender, region);
        emit ProposalSigned(proposalId, msg.sender, 1);
    }

    /**
     * @dev Sign (approve) a proposal
     * @param proposalId Proposal to sign
     */
    function signProposal(uint256 proposalId) external override onlyGovernanceActor {
        Proposal storage proposal = proposals[proposalId];
        if (proposal.status != ProposalStatus.PENDING) revert ProposalNotPending();
        if (block.timestamp > proposal.deadline) revert ProposalIsExpired();
        if (proposalSignatures[proposalId][msg.sender]) revert AlreadySigned();

        proposalSignatures[proposalId][msg.sender] = true;
        proposal.signatureCount++;
        actors[msg.sender].signatureCount++;

        // M-10 fix: record when quorum is first reached
        if (proposal.signatureCount >= proposal.requiredSignatures && quorumReachedAt[proposalId] == 0) {
            quorumReachedAt[proposalId] = block.timestamp;
        }

        emit ProposalSigned(proposalId, msg.sender, proposal.signatureCount);
    }

    /**
     * @dev Execute a proposal that has reached quorum
     * @param proposalId Proposal to execute
     */
    function executeProposal(uint256 proposalId) external override onlyGovernanceActor {
        Proposal storage proposal = proposals[proposalId];
        if (proposal.status != ProposalStatus.PENDING) revert ProposalNotPending();
        if (block.timestamp > proposal.deadline) revert ProposalIsExpired();

        // A25 fix: count only signatures from actors that are STILL active. The stored
        // signatureCount is not decremented when an actor is removed, so a proposal signed
        // by since-removed (e.g. compromised) actors must not remain executable on the basis
        // of those stale signatures. actorList is kept compact (removed actors are popped),
        // so iterating it counts exactly the currently-active signers. Bounded by MAX_ACTORS.
        uint256 activeSignatures = 0;
        for (uint256 i = 0; i < actorList.length; i++) {
            if (proposalSignatures[proposalId][actorList[i]]) activeSignatures++;
        }
        if (activeSignatures < proposal.requiredSignatures) revert InsufficientSignatures();

        // H-02 fix: resolve the execution target.
        // Use proposal.target when explicitly set; fall back to floodPredictionContract.
        address executionTarget = proposal.target != address(0) ? proposal.target : floodPredictionContract;
        bool hasCall = proposal.data.length > 0 && executionTarget != address(0);
        bool isEmergency = proposal.proposalType == ProposalType.EMERGENCY_TRIGGER;

        if (hasCall) {
            // V-04 fix: the target contract itself must be explicitly whitelisted —
            // the selector whitelist alone does not stop a colliding selector on an
            // attacker-controlled contract.
            if (!allowedTargets[executionTarget]) revert TargetNotWhitelisted();
            // M-3 fix: enforce selector whitelist — data shorter than 4 bytes is always rejected.
            if (proposal.data.length < 4) revert SelectorNotWhitelisted();
            bytes4 selector = bytes4(proposal.data);

            // H12-GOV fix: EMERGENCY_TRIGGER proposals may only call selectors from
            // emergencyAllowedSelectors, a whitelist disjoint from the general
            // allowedSelectors used by all other proposal types. This stops a
            // proposer from self-labeling a routine parameter change (e.g.
            // setConsensusThreshold) as "emergency" purely to skip EXECUTION_DELAY.
            if (isEmergency) {
                if (!emergencyAllowedSelectors[selector]) revert SelectorNotWhitelisted();
            } else {
                if (!allowedSelectors[selector]) revert SelectorNotWhitelisted();
            }

            // A24 fix: bind the upgrade-approval selector to the UPGRADE proposal type.
            // Otherwise a proposal labeled BUDGET_ALLOCATION/PARAMETER_CHANGE could carry
            // approveUpgrade(maliciousImpl) in its data — signers would see a benign label
            // while actually authorizing a UUPS implementation. The reverse is also enforced:
            // an UPGRADE proposal may only call approveUpgrade.
            bool isApproveUpgrade = selector == this.approveUpgrade.selector;
            bool isUpgradeType = proposal.proposalType == ProposalType.UPGRADE;
            if (isApproveUpgrade != isUpgradeType) revert ProposalTypeSelectorMismatch();
        }

        // H11-GOV fix: enforce timelock for non-emergency proposals.
        // H12-GOV fix: the exemption now strictly tracks isEmergency, which (for
        // calls) requires the selector to be in emergencyAllowedSelectors — verified
        // above. EMERGENCY_TRIGGER has a 4h deadline — a 1h timelock could create a
        // race condition if quorum is reached late, blocking execution before the deadline.
        if (!isEmergency) {
            uint256 qReached = quorumReachedAt[proposalId];
            if (qReached == 0) revert InsufficientSignatures();
            if (block.timestamp < qReached + EXECUTION_DELAY) revert TimelockNotElapsed();
        }

        proposal.status = ProposalStatus.EXECUTED;
        proposal.executedAt = block.timestamp;
        executedProposalCount++;

        // Execute the encoded function call if data is provided and target is set
        if (hasCall) {
            (bool success, bytes memory returnData) = executionTarget.call{gas: executionGasLimit}(proposal.data);
            if (!success) {
                if (returnData.length > 0) {
                    /// @solidity memory-safe-assembly
                    assembly { revert(add(returnData, 32), mload(returnData)) }
                }
                revert ExecutionFailed();
            }
        }

        emit ProposalExecuted(proposalId, msg.sender);
    }

    /**
     * @dev Reject a proposal (owner or quorum of governance actors)
     * M-01v2 fix: uses separate rejectionCount to avoid conflating with approval signatureCount
     * @param proposalId Proposal to reject
     */
    function rejectProposal(uint256 proposalId) external override {
        Proposal storage proposal = proposals[proposalId];
        if (proposal.status != ProposalStatus.PENDING) revert ProposalNotPending();

        // L-02 fix: allow owner OR governance actor with quorum
        if (msg.sender == owner()) {
            proposal.status = ProposalStatus.REJECTED;
            emit ProposalRejected(proposalId, msg.sender);
        } else if (actors[msg.sender].isActive) {
            // M-01v2 fix: separate rejection tracking (cannot reject if already signed or rejected)
            if (proposalSignatures[proposalId][msg.sender]) revert AlreadySigned();
            if (proposalRejections[proposalId][msg.sender]) revert AlreadyRejected();
            proposalRejections[proposalId][msg.sender] = true;
            proposalRejectionCount[proposalId]++;
            if (proposalRejectionCount[proposalId] >= quorum) {
                proposal.status = ProposalStatus.REJECTED;
                emit ProposalRejected(proposalId, msg.sender);
            }
        } else {
            revert NotGovernanceActor();
        }
    }

    /**
     * @dev Expire a stale proposal past its deadline
     * @param proposalId Proposal to expire
     */
    function expireProposal(uint256 proposalId) external {
        Proposal storage proposal = proposals[proposalId];
        if (proposal.status != ProposalStatus.PENDING) revert ProposalNotPending();
        if (block.timestamp <= proposal.deadline) revert ProposalNotExpired();

        proposal.status = ProposalStatus.EXPIRED;
        emit ProposalExpired(proposalId);
    }

    // ============================================
    // Configuration
    // ============================================

    /**
     * @dev Set the FloodPrediction contract address for proposal execution
     * @param _contract Address of the FloodPrediction contract
     */
    function setFloodPredictionContract(address _contract) external onlyOwner {
        if (_contract == address(0)) revert InvalidAddress();
        // M-08 fix: validate contract has code
        if (_contract.code.length == 0) revert InvalidAddress();

        // V-04 fix: keep the execution target whitelist in sync with the
        // default fallback target (proposal.target == address(0)).
        if (floodPredictionContract != address(0)) {
            allowedTargets[floodPredictionContract] = false;
            emit TargetWhitelisted(floodPredictionContract, false);
        }
        floodPredictionContract = _contract;
        allowedTargets[_contract] = true;
        emit TargetWhitelisted(_contract, true);
    }

    /**
     * @dev Add or remove a function selector from the whitelist
     * @param selector The 4-byte function selector
     * @param allowed Whether the selector is allowed
     */
    function setAllowedSelector(bytes4 selector, bool allowed) external onlyOwner {
        allowedSelectors[selector] = allowed;
        emit SelectorWhitelisted(selector, allowed);
    }

    /**
     * @dev Add or remove a contract address from the proposal execution target
     * whitelist (V-04 fix). A proposal's `target` (when non-zero) must be
     * whitelisted here before executeProposal() will call into it.
     * @param target Contract address
     * @param allowed Whether proposals may call this target
     */
    function setAllowedTarget(address target, bool allowed) external onlyOwner {
        if (target == address(0)) revert InvalidAddress();
        allowedTargets[target] = allowed;
        emit TargetWhitelisted(target, allowed);
    }

    /**
     * @dev Batch set allowed selectors
     * @param selectors Array of 4-byte function selectors
     * @param allowed Array of booleans
     */
    function setAllowedSelectorBatch(bytes4[] calldata selectors, bool[] calldata allowed) external onlyOwner {
        if (selectors.length != allowed.length) revert ArrayLengthMismatch();
        for (uint256 i = 0; i < selectors.length; i++) {
            allowedSelectors[selectors[i]] = allowed[i];
            emit SelectorWhitelisted(selectors[i], allowed[i]);
        }
    }

    /**
     * @dev Add or remove a function selector from the EMERGENCY_TRIGGER whitelist
     * (H12-GOV fix). Only selectors here can be executed by an EMERGENCY_TRIGGER
     * proposal, and doing so skips the EXECUTION_DELAY timelock — so this should
     * be limited to genuine emergency-response functions (pause, emergency mode,
     * region emergency flags, governance override triggers).
     * @param selector The 4-byte function selector
     * @param allowed Whether the selector is allowed for EMERGENCY_TRIGGER proposals
     */
    function setEmergencyAllowedSelector(bytes4 selector, bool allowed) external onlyOwner {
        emergencyAllowedSelectors[selector] = allowed;
        emit EmergencySelectorWhitelisted(selector, allowed);
    }

    /**
     * @dev Batch set EMERGENCY_TRIGGER-allowed selectors (H12-GOV fix)
     * @param selectors Array of 4-byte function selectors
     * @param allowed Array of booleans
     */
    function setEmergencyAllowedSelectorBatch(bytes4[] calldata selectors, bool[] calldata allowed) external onlyOwner {
        if (selectors.length != allowed.length) revert ArrayLengthMismatch();
        for (uint256 i = 0; i < selectors.length; i++) {
            emergencyAllowedSelectors[selectors[i]] = allowed[i];
            emit EmergencySelectorWhitelisted(selectors[i], allowed[i]);
        }
    }

    /**
     * @dev Update execution gas limit for proposal calls (M-03 fix)
     * @param newLimit New gas limit (100K–5M range)
     */
    function setExecutionGasLimit(uint256 newLimit) external onlyOwner {
        if (newLimit < 100_000 || newLimit > 5_000_000) revert InvalidGasLimit();
        executionGasLimit = newLimit;
    }

    // ============================================
    // View Functions
    // ============================================

    function getProposal(uint256 proposalId) external view override returns (Proposal memory) {
        return proposals[proposalId];
    }

    function getGovernanceActor(address actor) external view override returns (GovernanceActor memory) {
        return actors[actor];
    }

    function getActiveActorCount() external view override returns (uint256) {
        return activeActorCount;
    }

    function getQuorum() external view override returns (uint256) {
        return quorum;
    }

    function hasSignedProposal(uint256 proposalId, address actor) external view override returns (bool) {
        return proposalSignatures[proposalId][actor];
    }

    /**
     * @dev Get all actor addresses
     */
    function getActorList() external view returns (address[] memory) {
        return actorList;
    }

    /**
     * @dev Get governance statistics
     */
    function getStats() external view returns (
        uint256 totalProposals,
        uint256 executed,
        uint256 actors_,
        uint256 currentQuorum
    ) {
        return (proposalCount, executedProposalCount, activeActorCount, quorum);
    }

    /**
     * @dev Reserved storage gap for future upgrades.
     * V-04 fix: allowedTargets mapping added, __gap reduced from 47 to 46.
     * H12-GOV fix: emergencyAllowedSelectors mapping added, __gap reduced from 46 to 45.
     * When adding new state variables, reduce __gap size accordingly.
     */
    uint256[45] private __gap;
}
