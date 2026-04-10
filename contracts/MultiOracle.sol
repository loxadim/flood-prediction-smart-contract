// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "../interfaces/IMultiOracle.sol";

/**
 * @title MultiOracle
 * @author Flood Prediction System
 * @notice Multi-oracle consensus engine with IQR outlier detection and reputation system.
 *
 * @dev This contract implements a robust multi-oracle architecture where multiple
 * independent oracle providers submit flood-risk scores for geographic regions.
 * A consensus value is derived from the submitted data after filtering outliers
 * using the Interquartile Range (IQR) statistical method.
 *
 * ## Architecture Overview
 *
 * 1. **Oracle Management** – The contract owner registers, deactivates, and
 *    reactivates oracle addresses.  Each oracle carries a name, a reputation
 *    score (0-100, starting at 50), and activity counters.
 *
 * 2. **Data Submission** – Registered active oracles submit a risk score (0-100)
 *    along with the data-source identifier (e.g. "WASDI", "CHIRPS", "GFS") for
 *    a given region.  Submissions are grouped into rounds; a new round begins
 *    automatically when a fresh consensus cycle is needed.
 *
 * 3. **IQR Outlier Detection** – Once enough data points are collected
 *    (≥ 60 % of active oracles by default), the engine sorts the scores and
 *    computes Q1, Q3, and the IQR.  Any score outside [Q1 - 1.5·IQR,
 *    Q3 + 1.5·IQR] is flagged as an outlier.
 *
 * 4. **Consensus Calculation** – The consensus risk score is the median of the
 *    remaining (non-outlier) values.
 *
 * 5. **Reputation System** – After each consensus round every participating
 *    oracle receives a reputation adjustment: +2 for a normal submission,
 *    −10 for an outlier.  Reputation is capped to the [0, 100] range.
 *    An oracle that produces 3 consecutive outliers is automatically
 *    deactivated.
 *
 * 6. **Data Freshness** – Only submissions younger than
 *    `dataFreshnessThreshold` (default 1 hour) are considered for consensus.
 *
 * ## Security
 *
 * - Inherits OpenZeppelin `Ownable2Step` for safe ownership transfer.
 * - Inherits OpenZeppelin `ReentrancyGuard` for protection against reentrant
 *   calls during consensus calculation and reputation updates.
 * - Inherits OpenZeppelin `Pausable` for emergency pause capability.
 * - Maximum number of oracles is capped at `MAX_ORACLES` (10) to bound gas
 *   consumption of the on-chain sort.
 * - Commit-reveal scheme prevents front-running between oracles.
 * - Governance address can update critical parameters via multi-sig.
 */
contract MultiOracle is IMultiOracle, Ownable2Step, ReentrancyGuard, Pausable {

    // =========================================================================
    //                              CONSTANTS
    // =========================================================================

    /// @notice Maximum number of oracles that can be registered.
    uint256 public constant MAX_ORACLES = 10;

    /// @notice I-03 audit fix: minimum number of active oracles for consensus.
    uint256 public constant MIN_ORACLE_COUNT = 4;

    /// @notice Minimum risk score value.
    uint256 public constant MIN_RISK_SCORE = 0;

    /// @notice Maximum risk score value.
    uint256 public constant MAX_RISK_SCORE = 100;

    /// @notice Maximum reputation value.
    uint256 public constant MAX_REPUTATION = 100;

    /// @notice Initial reputation assigned to newly registered oracles.
    uint256 public constant INITIAL_REPUTATION = 50;

    /// @notice Reputation bonus for a normal (non-outlier) submission.
    uint256 public constant REPUTATION_BONUS = 2;

    /// @notice Reputation penalty for an outlier submission.
    uint256 public constant REPUTATION_PENALTY = 10;

    /// @notice IQR multiplier numerator (1.5 = 3/2).
    uint256 public constant IQR_MULTIPLIER_NUM = 3;

    /// @notice IQR multiplier denominator (1.5 = 3/2).
    uint256 public constant IQR_MULTIPLIER_DEN = 2;

    /// @notice Duration of the commit phase before reveal is allowed.
    uint256 public constant COMMIT_PHASE_DURATION = 2 minutes;

    /// @notice Maximum time after commit phase ends to reveal (after which commit expires).
    uint256 public constant REVEAL_WINDOW = 10 minutes;

    // =========================================================================
    //                           STATE VARIABLES
    // =========================================================================

    /// @notice Percentage of active oracles that must submit for consensus.
    /// @dev Expressed as a whole number, e.g. 60 means 60 %.
    uint256 public consensusThreshold;

    /// @notice Maximum age (in seconds) for a data point to be considered fresh.
    uint256 public dataFreshnessThreshold;

    /// @notice Number of consecutive outlier submissions before auto-disable.
    uint256 public maxConsecutiveOutliers;

    /// @notice Number of currently active oracles.
    uint256 public activeOracleCount;

    /// @notice Ordered list of all registered oracle addresses (active + inactive).
    address[] public oracleList;

    /// @notice Mapping from oracle address to its metadata.
    mapping(address => OracleInfo) private _oracles;

    /// @notice Submissions for a given region in a given round.
    /// @dev regionSubmissions[region][round] => OracleData[]
    mapping(string => mapping(uint256 => OracleData[])) private _regionSubmissions;

    /// @notice Current round number per region.
    mapping(string => uint256) public currentRound;

    /// @notice Latest consensus result per region.
    mapping(string => ConsensusResult) private _latestConsensus;

    /// @notice Tracks whether an oracle has already submitted in the current
    ///         round for a given region.
    /// @dev hasSubmittedInRound[region][round][oracle] => bool
    mapping(string => mapping(uint256 => mapping(address => bool))) private _hasSubmittedInRound;

    /// @notice Governance address authorized to update critical parameters.
    address public governance;

    // ---- Commit-Reveal State ----

    /// @dev Stores a pending commit: hash + timestamp.
    struct Commitment {
        bytes32 commitHash;
        uint256 commitTimestamp;
    }

    /// @notice Pending commits per region per round per oracle.
    mapping(string => mapping(uint256 => mapping(address => Commitment))) private _commitments;

    /// @notice Tracks whether an oracle has committed in the current round.
    mapping(string => mapping(uint256 => mapping(address => bool))) private _hasCommittedInRound;

    /// @notice Timestamp when the first commit was made in a round (starts commit phase timer).
    mapping(string => mapping(uint256 => uint256)) public roundCommitStart;

    // =========================================================================
    //                              ERRORS
    // =========================================================================

    /// @notice Thrown when the caller is not a registered oracle.
    error NotRegisteredOracle();

    /// @notice Thrown when the oracle is not currently active.
    error OracleNotActive();

    /// @notice Thrown when the oracle is already active (cannot reactivate).
    error OracleAlreadyActive();

    /// @notice Thrown when the oracle address is already registered.
    error OracleAlreadyRegistered();

    /// @notice Thrown when attempting to register more oracles than `MAX_ORACLES`.
    error MaxOraclesReached();

    /// @notice Thrown when a risk score is outside the valid range [0, 100].
    error InvalidRiskScore();

    /// @notice Thrown when an oracle tries to submit twice in the same round.
    error AlreadySubmittedInRound();

    /// @notice Thrown when the zero address is supplied where it is not allowed.
    error ZeroAddress();

    /// @notice Thrown when an empty string is supplied where it is not allowed.
    error EmptyString();

    /// @notice Thrown when consensus has not been reached for the queried region.
    error ConsensusNotReached();
    error InvalidThreshold();
    error FreshnessThresholdTooLow();
    error FreshnessThresholdTooHigh();
    error InvalidMaxOutliers();
    error InsufficientOracleCount();
    error NotGovernance();
    error CommitPhaseNotOver();
    error RevealWindowExpired();
    error InvalidReveal();
    error AlreadyCommittedInRound();
    error NoCommitmentFound();

    // =========================================================================
    //                         CONFIG CHANGE EVENTS
    // =========================================================================

    /// @notice Emitted when the consensus threshold is updated.
    event ConsensusThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);

    /// @notice Emitted when the data freshness threshold is updated.
    event DataFreshnessThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);

    /// @notice Emitted when the max consecutive outliers is updated.
    event MaxConsecutiveOutliersUpdated(uint256 oldMax, uint256 newMax);

    /// @notice M-08 fix: Emitted when an oracle enters probation before auto-deactivation.
    event OracleProbationWarning(address indexed oracle, uint256 consecutiveOutliers, uint256 maxAllowed);

    /// @notice H5-MO fix: Emitted when active oracle count drops below the minimum required for reliable consensus.
    event InsufficientOracleCountWarning(uint256 activeCount, uint256 minRequired);

    // =========================================================================
    //                             MODIFIERS
    // =========================================================================

    /**
     * @dev Restricts the function to registered oracles only.
     */
    modifier onlyOracle() {
        if (_oracles[msg.sender].registeredAt == 0) revert NotRegisteredOracle();
        _;
    }

    /**
     * @dev Restricts the function to active oracles only.
     */
    modifier onlyActiveOracle() {
        if (_oracles[msg.sender].registeredAt == 0) revert NotRegisteredOracle();
        if (!_oracles[msg.sender].isActive) revert OracleNotActive();
        _;
    }

    /**
     * @dev Restricts the function to the owner or the governance contract.
     */
    modifier onlyOwnerOrGovernance() {
        if (msg.sender != owner() && msg.sender != governance) revert NotGovernance();
        _;
    }

    // =========================================================================
    //                            CONSTRUCTOR
    // =========================================================================

    /**
     * @notice Deploys the MultiOracle contract.
     * @dev Sets default values for consensus threshold (60 %), data freshness
     *      (1 hour), and max consecutive outliers (3).
     */
    constructor() Ownable(msg.sender) {
        consensusThreshold = 60;
        dataFreshnessThreshold = 1 hours;
        maxConsecutiveOutliers = 3;
    }

    // =========================================================================
    //                     ORACLE MANAGEMENT (OWNER ONLY)
    // =========================================================================

    /**
     * @notice Registers a new oracle.
     * @dev Only the contract owner can register oracles.  The oracle is
     *      immediately set to active with `INITIAL_REPUTATION`.
     *
     * Requirements:
     * - `oracle` must not be the zero address.
     * - `oracle` must not already be registered.
     * - Total registered oracles must be below `MAX_ORACLES`.
     * - `name` must not be empty.
     *
     * Emits an {OracleRegistered} event.
     *
     * @param oracle The address of the oracle to register.
     * @param name   A human-readable name for the oracle.
     */
    function registerOracle(address oracle, string calldata name) external override onlyOwner {
        if (oracle == address(0)) revert ZeroAddress();
        if (bytes(name).length == 0) revert EmptyString();
        if (_oracles[oracle].registeredAt != 0) revert OracleAlreadyRegistered();
        if (oracleList.length >= MAX_ORACLES) revert MaxOraclesReached();

        _oracles[oracle] = OracleInfo({
            oracleAddress: oracle,
            name: name,
            reputation: INITIAL_REPUTATION,
            totalSubmissions: 0,
            outlierCount: 0,
            consecutiveOutliers: 0,
            isActive: true,
            registeredAt: block.timestamp
        });

        oracleList.push(oracle);
        activeOracleCount++;

        emit OracleRegistered(oracle, name);
    }

    /**
     * @notice Deactivates a registered oracle.
     * @dev Only the contract owner can deactivate oracles.  The oracle keeps
     *      its reputation and statistics but will no longer be counted towards
     *      the consensus quorum.
     *
     * Requirements:
     * - `oracle` must be registered.
     * - `oracle` must currently be active.
     *
     * Emits an {OracleDeactivated} event.
     *
     * @param oracle The address of the oracle to deactivate.
     */
    function deactivateOracle(address oracle) external override onlyOwner {
        if (_oracles[oracle].registeredAt == 0) revert NotRegisteredOracle();
        if (!_oracles[oracle].isActive) revert OracleNotActive();

        _oracles[oracle].isActive = false;
        activeOracleCount--;

        emit OracleDeactivated(oracle);
    }

    /**
     * @notice Reactivates a previously deactivated oracle.
     * @dev Only the contract owner can reactivate oracles.  The oracle's
     *      consecutive outlier counter is reset upon reactivation to give it a
     *      fresh start.
     *
     * Requirements:
     * - `oracle` must be registered.
     * - `oracle` must currently be inactive.
     *
     * Emits an {OracleReactivated} event.
     *
     * @param oracle The address of the oracle to reactivate.
     */
    function reactivateOracle(address oracle) external override onlyOwner {
        if (_oracles[oracle].registeredAt == 0) revert NotRegisteredOracle();
        if (_oracles[oracle].isActive) revert OracleAlreadyActive();

        _oracles[oracle].isActive = true;
        _oracles[oracle].consecutiveOutliers = 0;
        activeOracleCount++;

        emit OracleReactivated(oracle);
    }

    // =========================================================================
    //                          DATA SUBMISSION
    // =========================================================================

    /**
     * @notice Phase 1 of commit-reveal: oracle commits a hash of its data.
     * @dev The commit hash is `keccak256(abi.encodePacked(region, riskScore, dataSource, salt))`.
     *      Each oracle can commit only once per round per region.
     *
     * @param region     The geographic region identifier.
     * @param commitHash The keccak256 hash of the data to be revealed later.
     */
    function commitData(
        string calldata region,
        bytes32 commitHash
    ) external onlyActiveOracle whenNotPaused {
        if (bytes(region).length == 0) revert EmptyString();

        _maybeAdvanceRound(region);
        uint256 round = currentRound[region];

        if (_hasCommittedInRound[region][round][msg.sender]) {
            revert AlreadyCommittedInRound();
        }

        _commitments[region][round][msg.sender] = Commitment({
            commitHash: commitHash,
            commitTimestamp: block.timestamp
        });
        _hasCommittedInRound[region][round][msg.sender] = true;

        // Record the start of the commit phase for this round
        if (roundCommitStart[region][round] == 0) {
            roundCommitStart[region][round] = block.timestamp;
        }

        emit DataCommitted(msg.sender, region, round);
    }

    /**
     * @notice Phase 2 of commit-reveal: oracle reveals its committed data.
     * @dev Verifies the revealed data matches the previously committed hash.
     *      The reveal must happen after `COMMIT_PHASE_DURATION` and before
     *      `COMMIT_PHASE_DURATION + REVEAL_WINDOW` from the round's first commit.
     *
     * After verification, the data is recorded exactly as in the original
     * `submitData` flow and consensus is triggered if the threshold is met.
     *
     * @param region     The geographic region identifier.
     * @param riskScore  The flood risk score in [0, 100].
     * @param dataSource The data source name.
     * @param salt       The random salt used in the commit hash.
     */
    function revealData(
        string calldata region,
        uint256 riskScore,
        string calldata dataSource,
        bytes32 salt
    ) external onlyActiveOracle nonReentrant whenNotPaused {
        if (riskScore > MAX_RISK_SCORE) revert InvalidRiskScore();
        if (bytes(region).length == 0) revert EmptyString();
        if (bytes(dataSource).length == 0) revert EmptyString();

        uint256 round = currentRound[region];

        // Verify commitment exists
        Commitment storage commitment = _commitments[region][round][msg.sender];
        if (commitment.commitTimestamp == 0) revert NoCommitmentFound();

        // Verify timing: must be after commit phase, within reveal window
        uint256 commitStart = roundCommitStart[region][round];
        if (block.timestamp < commitStart + COMMIT_PHASE_DURATION) revert CommitPhaseNotOver();
        if (block.timestamp > commitStart + COMMIT_PHASE_DURATION + REVEAL_WINDOW) revert RevealWindowExpired();

        // Verify hash matches
        bytes32 expectedHash = keccak256(abi.encodePacked(region, riskScore, dataSource, salt));
        if (expectedHash != commitment.commitHash) revert InvalidReveal();

        // Prevent double submission
        if (_hasSubmittedInRound[region][round][msg.sender]) {
            revert AlreadySubmittedInRound();
        }

        // Record submission (same logic as original submitData)
        OracleData memory data = OracleData({
            oracle: msg.sender,
            riskScore: riskScore,
            timestamp: block.timestamp,
            dataSource: dataSource,
            isOutlier: false
        });

        _regionSubmissions[region][round].push(data);
        _hasSubmittedInRound[region][round][msg.sender] = true;
        _oracles[msg.sender].totalSubmissions++;

        emit DataRevealed(msg.sender, region, riskScore);
        emit DataSubmitted(msg.sender, region, riskScore, dataSource);

        // Check consensus
        if (activeOracleCount < MIN_ORACLE_COUNT) {
            emit InsufficientOracleCountWarning(activeOracleCount, MIN_ORACLE_COUNT);
        } else {
            uint256 freshCount = _countFreshSubmissions(region, round);
            uint256 required = _requiredSubmissions();
            if (freshCount >= required && required > 0) {
                _calculateConsensus(region, round);
            }
        }
    }

    /**
     * @notice Direct data submission without commit-reveal (backward compatible).
     * @dev The caller must be a registered, active oracle.  Each oracle may
     *      submit only once per round per region.  If the current round's
     *      consensus has already been computed (or the latest submission is
     *      older than the freshness window), a new round is started
     *      automatically.
     *
     * After recording the data the function checks whether the consensus
     * threshold has been met and, if so, triggers the consensus calculation.
     *
     * Requirements:
     * - Caller must be a registered, active oracle.
     * - `riskScore` must be in [0, 100].
     * - `region` and `dataSource` must not be empty.
     * - The oracle must not have already submitted in the current round.
     *
     * Emits a {DataSubmitted} event.
     * May emit {ConsensusReached}, {OutlierDetected}, and {ReputationUpdated}
     * events if consensus is triggered.
     *
     * @param region     The geographic region identifier (e.g. "dakar-ouest").
     * @param riskScore  The flood risk score in [0, 100].
     * @param dataSource The data source name (e.g. "WASDI", "CHIRPS").
     */
    function submitData(
        string calldata region,
        uint256 riskScore,
        string calldata dataSource
    ) external override onlyActiveOracle nonReentrant whenNotPaused {
        if (riskScore > MAX_RISK_SCORE) revert InvalidRiskScore();
        if (bytes(region).length == 0) revert EmptyString();
        if (bytes(dataSource).length == 0) revert EmptyString();

        // Advance round if needed (previous consensus reached or stale data)
        _maybeAdvanceRound(region);

        uint256 round = currentRound[region];

        if (_hasSubmittedInRound[region][round][msg.sender]) {
            revert AlreadySubmittedInRound();
        }

        // Record submission
        OracleData memory data = OracleData({
            oracle: msg.sender,
            riskScore: riskScore,
            timestamp: block.timestamp,
            dataSource: dataSource,
            isOutlier: false // will be determined during consensus
        });

        _regionSubmissions[region][round].push(data);
        _hasSubmittedInRound[region][round][msg.sender] = true;

        // Update oracle stats
        _oracles[msg.sender].totalSubmissions++;

        emit DataSubmitted(msg.sender, region, riskScore, dataSource);

        // Check if consensus threshold is met
        // H5-MO fix: emit warning (not revert) when oracle count is below minimum —
        // prevents a DOS where cascading deactivations block all future submissions.
        if (activeOracleCount < MIN_ORACLE_COUNT) {
            emit InsufficientOracleCountWarning(activeOracleCount, MIN_ORACLE_COUNT);
        } else {
            uint256 freshCount = _countFreshSubmissions(region, round);
            uint256 required = _requiredSubmissions();
            if (freshCount >= required && required > 0) {
                _calculateConsensus(region, round);
            }
        }
    }

    // =========================================================================
    //                        CONSENSUS VIEWS
    // =========================================================================

    /**
     * @notice Returns the latest consensus result for a region.
     * @param region The geographic region identifier.
     * @return The `ConsensusResult` struct.
     */
    function getConsensus(string calldata region) external view override returns (ConsensusResult memory) {
        return _latestConsensus[region];
    }

    /**
     * @notice Checks whether consensus has been reached for a region.
     * @param region The geographic region identifier.
     * @return `true` if a valid consensus exists, `false` otherwise.
     */
    function isConsensusReached(string calldata region) external view override returns (bool) {
        return _latestConsensus[region].reached;
    }

    /**
     * @notice Returns the consensus risk score for a region.
     * @dev Reverts if no consensus has been reached.
     * @param region The geographic region identifier.
     * @return The consensus risk score in [0, 100].
     */
    function getConsensusRiskScore(string calldata region) external view override returns (uint256) {
        if (!_latestConsensus[region].reached) revert ConsensusNotReached();
        return _latestConsensus[region].consensusRiskScore;
    }

    // =========================================================================
    //                          ORACLE VIEWS
    // =========================================================================

    /**
     * @notice Returns detailed information about a specific oracle.
     * @param oracle The address of the oracle.
     * @return The `OracleInfo` struct for the given address.
     */
    function getOracleInfo(address oracle) external view override returns (OracleInfo memory) {
        return _oracles[oracle];
    }

    /**
     * @notice Returns the number of currently active oracles.
     * @return The count of active oracles.
     */
    function getActiveOracleCount() external view override returns (uint256) {
        return activeOracleCount;
    }

    /**
     * @notice Returns the reputation score for a given oracle.
     * @param oracle The address of the oracle.
     * @return The reputation score in [0, 100].
     */
    function getOracleReputation(address oracle) external view override returns (uint256) {
        return _oracles[oracle].reputation;
    }

    // =========================================================================
    //                      ADDITIONAL VIEW FUNCTIONS
    // =========================================================================

    /**
     * @notice Returns the total number of registered oracles (active + inactive).
     * @return The length of the oracle list.
     */
    function getOracleCount() external view returns (uint256) {
        return oracleList.length;
    }

    /**
     * @notice Returns the oracle address at a given index in the oracle list.
     * @param index The zero-based index.
     * @return The oracle address.
     */
    function getOracleAtIndex(uint256 index) external view returns (address) {
        return oracleList[index];
    }

    /**
     * @notice Returns the submissions for a specific region and round.
     * @param region The geographic region identifier.
     * @param round  The round number.
     * @return An array of `OracleData` structs.
     */
    function getRegionSubmissions(
        string calldata region,
        uint256 round
    ) external view returns (OracleData[] memory) {
        return _regionSubmissions[region][round];
    }

    /**
     * @notice Returns the number of submissions for a specific region and round.
     * @param region The geographic region identifier.
     * @param round  The round number.
     * @return The submission count.
     */
    function getRegionSubmissionCount(
        string calldata region,
        uint256 round
    ) external view returns (uint256) {
        return _regionSubmissions[region][round].length;
    }

    /**
     * @notice Checks if an oracle has already submitted in the current round
     *         for a given region.
     * @param region The geographic region identifier.
     * @param oracle The oracle address.
     * @return `true` if the oracle has submitted, `false` otherwise.
     */
    function hasOracleSubmitted(
        string calldata region,
        address oracle
    ) external view returns (bool) {
        uint256 round = currentRound[region];
        return _hasSubmittedInRound[region][round][oracle];
    }

    /**
     * @notice Returns the number of fresh (non-stale) submissions in the
     *         current round for a given region.
     * @param region The geographic region identifier.
     * @return The count of fresh submissions.
     */
    function getFreshSubmissionCount(string calldata region) external view returns (uint256) {
        uint256 round = currentRound[region];
        return _countFreshSubmissions(region, round);
    }

    /**
     * @notice Returns the number of submissions required to reach consensus.
     * @dev Returns type(uint256).max when active oracle count is below MIN_ORACLE_COUNT,
     *      indicating that consensus cannot currently be reached.
     * @return The minimum number of submissions needed (or type(uint256).max if unavailable).
     */
    function getRequiredSubmissions() external view returns (uint256) {
        return _requiredSubmissions();
    }

    /**
     * @notice Returns all registered oracle addresses.
     * @return An array of oracle addresses.
     */
    function getAllOracles() external view returns (address[] memory) {
        return oracleList;
    }

    // =========================================================================
    //                    OWNER CONFIGURATION FUNCTIONS
    // =========================================================================

    /**
     * @notice Pauses the contract, preventing data submissions.
     * @dev Only the owner can pause.
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpauses the contract, re-enabling data submissions.
     * @dev Only the owner can unpause.
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Sets the governance contract address.
     * @dev Only the owner can set the governance address. The governance
     *      contract can then update critical parameters.
     * @param newGovernance The address of the governance contract (or zero to remove).
     */
    function setGovernance(address newGovernance) external onlyOwner {
        address oldGovernance = governance;
        governance = newGovernance;
        emit GovernanceUpdated(oldGovernance, newGovernance);
    }

    /**
     * @notice Updates the consensus threshold percentage.
     * @dev Must be between 1 and 100 (inclusive).
     *      Can be called by the owner or the governance contract.
     * @param newThreshold The new threshold value (e.g. 60 for 60 %).
     */
    function setConsensusThreshold(uint256 newThreshold) external onlyOwnerOrGovernance {
        // L-05 audit fix: enforce minimum 50% threshold for security
        if (newThreshold < 50 || newThreshold > 100) revert InvalidThreshold();
        uint256 oldThreshold = consensusThreshold;
        consensusThreshold = newThreshold;
        emit ConsensusThresholdUpdated(oldThreshold, newThreshold);
    }

    /**
     * @notice Updates the data freshness threshold.
     * @dev Must be greater than zero.
     *      Can be called by the owner or the governance contract.
     * @param newThreshold The new freshness threshold in seconds.
     */
    function setDataFreshnessThreshold(uint256 newThreshold) external onlyOwnerOrGovernance {
        if (newThreshold < 5 minutes) revert FreshnessThresholdTooLow();
        if (newThreshold > 7 days) revert FreshnessThresholdTooHigh();
        uint256 oldThreshold = dataFreshnessThreshold;
        dataFreshnessThreshold = newThreshold;
        emit DataFreshnessThresholdUpdated(oldThreshold, newThreshold);
    }

    /**
     * @notice Updates the maximum consecutive outlier count before auto-disable.
     * @dev Must be greater than zero.
     *      Can be called by the owner or the governance contract.
     * @param newMax The new maximum consecutive outlier count.
     */
    function setMaxConsecutiveOutliers(uint256 newMax) external onlyOwnerOrGovernance {
        if (newMax == 0) revert InvalidMaxOutliers();
        uint256 oldMax = maxConsecutiveOutliers;
        maxConsecutiveOutliers = newMax;
        emit MaxConsecutiveOutliersUpdated(oldMax, newMax);
    }

    // =========================================================================
    //                       INTERNAL FUNCTIONS
    // =========================================================================

    /**
     * @dev Advances to a new round for the given region if the previous
     *      consensus has been reached or if all current submissions are stale.
     *
     * A round advance happens when:
     * - A consensus was already reached for the current round, OR
     * - The current round has at least one submission and all of them are
     *   older than the data freshness threshold.
     *
     * @param region The geographic region identifier.
     */
    function _maybeAdvanceRound(string memory region) internal {
        uint256 round = currentRound[region];

        // If the latest consensus exists and was produced in this round,
        // advance the round so new submissions go into a fresh cycle.
        if (_latestConsensus[region].reached && _latestConsensus[region].timestamp > 0) {
            OracleData[] storage subs = _regionSubmissions[region][round];
            if (subs.length > 0) {
                // Check if consensus was already computed for this round by
                // seeing if there is at least one submission that has the
                // outlier flag potentially set (consensus was run).
                // A simpler heuristic: if consensus timestamp >= earliest
                // submission timestamp of this round, advance.
                bool consensusFromThisRound = _latestConsensus[region].timestamp >= subs[0].timestamp;
                if (consensusFromThisRound) {
                    currentRound[region] = round + 1;
                    return;
                }
            }
        }

        // Also advance if all submissions in the current round are stale.
        OracleData[] storage submissions = _regionSubmissions[region][round];
        if (submissions.length > 0) {
            bool allStale = true;
            for (uint256 i = 0; i < submissions.length; i++) {
                if (block.timestamp - submissions[i].timestamp < dataFreshnessThreshold) {
                    allStale = false;
                    break;
                }
            }
            if (allStale) {
                currentRound[region] = round + 1;
            }
        }
    }

    /**
     * @dev Returns the minimum number of fresh submissions required to trigger
     *      consensus, computed as `ceil(activeOracleCount * threshold / 100)`.
     * @return The required count.
     */
    function _requiredSubmissions() internal view returns (uint256) {
        // H5-MO fix: return max value (prevents consensus) instead of reverting when
        // oracle count is below MIN_ORACLE_COUNT — caller guards against this case.
        if (activeOracleCount < MIN_ORACLE_COUNT) return type(uint256).max;
        // ceil(activeOracleCount * consensusThreshold / 100)
        uint256 required = (activeOracleCount * consensusThreshold + 99) / 100;
        // Ensure at least 2 submissions even if formula gives 1
        return required < 2 ? 2 : required;
    }

    /**
     * @dev Counts the number of fresh (non-stale) submissions in a given
     *      round for a region.
     * @param region The geographic region identifier.
     * @param round  The round number.
     * @return count The number of fresh submissions.
     */
    function _countFreshSubmissions(
        string memory region,
        uint256 round
    ) internal view returns (uint256 count) {
        OracleData[] storage subs = _regionSubmissions[region][round];
        for (uint256 i = 0; i < subs.length; i++) {
            if (block.timestamp - subs[i].timestamp < dataFreshnessThreshold) {
                count++;
            }
        }
    }

    /**
     * @dev Core consensus calculation.
     *
     * Steps:
     * 1. Collect fresh submissions for the given region and round.
     * 2. Sort the risk scores (insertion sort – bounded by `MAX_ORACLES`).
     * 3. Compute Q1, Q3, IQR and determine the valid range.
     * 4. Flag outliers and emit {OutlierDetected} events.
     * 5. Compute the median of remaining (non-outlier) values.
     * 6. Update reputations and auto-disable if needed.
     * 7. Store the consensus result and emit {ConsensusReached}.
     *
     * @param region The geographic region identifier.
     * @param round  The round number.
     */
    function _calculateConsensus(string memory region, uint256 round) internal {
        OracleData[] storage submissions = _regionSubmissions[region][round];

        // -----------------------------------------------------------------
        // Step 1: Collect fresh submissions into memory arrays
        // -----------------------------------------------------------------
        uint256 len = submissions.length;
        uint256[] memory scores = new uint256[](len);
        address[] memory submitters = new address[](len);
        uint256 freshCount = 0;

        for (uint256 i = 0; i < len; i++) {
            if (block.timestamp - submissions[i].timestamp < dataFreshnessThreshold) {
                scores[freshCount] = submissions[i].riskScore;
                submitters[freshCount] = submissions[i].oracle;
                freshCount++;
            }
        }

        // Need at least 1 submission (should always be true at this point)
        if (freshCount == 0) return;

        // Resize in-memory (we just use `freshCount` as the effective length)

        // -----------------------------------------------------------------
        // Step 2: Sort scores (insertion sort, O(n²) but n ≤ MAX_ORACLES = 10)
        // -----------------------------------------------------------------
        // We sort parallel arrays `scores` and `submitters` so indices stay
        // aligned.
        for (uint256 i = 1; i < freshCount; i++) {
            uint256 keyScore = scores[i];
            address keyAddr = submitters[i];
            uint256 j = i;
            while (j > 0 && scores[j - 1] > keyScore) {
                scores[j] = scores[j - 1];
                submitters[j] = submitters[j - 1];
                j--;
            }
            scores[j] = keyScore;
            submitters[j] = keyAddr;
        }

        // -----------------------------------------------------------------
        // Step 3: IQR outlier detection
        // -----------------------------------------------------------------
        bool[] memory isOutlier = new bool[](freshCount);
        uint256 outlierCount = 0;

        if (freshCount >= 4) {
            // Compute Q1 and Q3 using inclusive median-of-halves method.
            // Lower half indices: 0 .. (freshCount/2 - 1)
            // Upper half indices: (freshCount+1)/2 .. freshCount-1
            uint256 q1 = _computeMedian(scores, 0, freshCount / 2);
            uint256 q3 = _computeMedian(scores, (freshCount + 1) / 2, freshCount);
            uint256 iqr = q3 - q1;

            // Lower bound = Q1 - 1.5 * IQR  (use safe math with unsigned)
            // Upper bound = Q3 + 1.5 * IQR
            // 1.5 = IQR_MULTIPLIER_NUM / IQR_MULTIPLIER_DEN = 3/2
            uint256 iqrScaled = iqr * IQR_MULTIPLIER_NUM; // iqr * 3

            // Lower bound (may underflow, so clamp to 0)
            uint256 lowerBound;
            if (q1 * IQR_MULTIPLIER_DEN >= iqrScaled) {
                lowerBound = (q1 * IQR_MULTIPLIER_DEN - iqrScaled) / IQR_MULTIPLIER_DEN;
            } else {
                lowerBound = 0;
            }

            // Upper bound (clamp to MAX_RISK_SCORE)
            uint256 upperBound = (q3 * IQR_MULTIPLIER_DEN + iqrScaled) / IQR_MULTIPLIER_DEN;
            if (upperBound > MAX_RISK_SCORE) {
                upperBound = MAX_RISK_SCORE;
            }

            for (uint256 i = 0; i < freshCount; i++) {
                if (scores[i] < lowerBound || scores[i] > upperBound) {
                    isOutlier[i] = true;
                    outlierCount++;
                }
            }
        }
        // If fewer than 4 data points we cannot reliably compute IQR,
        // so we skip outlier detection and treat all values as valid.

        // -----------------------------------------------------------------
        // Step 4: Flag outliers in storage and emit events
        // -----------------------------------------------------------------
        // We need to map sorted submitters back to storage indices so that
        // the `isOutlier` flag is persisted.
        for (uint256 i = 0; i < freshCount; i++) {
            if (isOutlier[i]) {
                // Find and flag the submission in storage
                _flagOutlierInStorage(submissions, submitters[i]);
                emit OutlierDetected(submitters[i], region, scores[i]);
            }
        }

        // -----------------------------------------------------------------
        // Step 5: Compute consensus score (median of non-outlier values)
        // -----------------------------------------------------------------
        uint256 validCount = freshCount - outlierCount;
        uint256 consensusScore;

        if (validCount == 0) {
            // Edge case: all values were outliers – use overall median
            consensusScore = _computeMedian(scores, 0, freshCount);
            validCount = freshCount;
            // Reset outlierCount since we are using all values
            outlierCount = 0;
        } else {
            // Build array of non-outlier scores (already sorted)
            uint256[] memory validScores = new uint256[](validCount);
            uint256 idx = 0;
            for (uint256 i = 0; i < freshCount; i++) {
                if (!isOutlier[i]) {
                    validScores[idx] = scores[i];
                    idx++;
                }
            }
            consensusScore = _computeMedian(validScores, 0, validCount);
        }

        // -----------------------------------------------------------------
        // Step 6: Update reputations
        // -----------------------------------------------------------------
        for (uint256 i = 0; i < freshCount; i++) {
            if (isOutlier[i]) {
                _penalizeOracle(submitters[i]);
            } else {
                _rewardOracle(submitters[i]);
            }
        }

        // -----------------------------------------------------------------
        // Step 7: Store consensus result and emit event
        // -----------------------------------------------------------------
        _latestConsensus[region] = ConsensusResult({
            consensusRiskScore: consensusScore,
            participantCount: freshCount,
            outlierCount: outlierCount,
            timestamp: block.timestamp,
            reached: true,
            region: region
        });

        emit ConsensusReached(region, consensusScore, freshCount);
    }

    /**
     * @dev Computes the median of a sorted sub-array `arr[lo .. hi-1]`.
     *
     * If the sub-array length is even the median is the arithmetic mean of the
     * two middle elements (integer division truncates towards zero).
     *
     * @param arr The sorted array.
     * @param lo  Start index (inclusive).
     * @param hi  End index (exclusive).
     * @return The median value.
     */
    function _computeMedian(
        uint256[] memory arr,
        uint256 lo,
        uint256 hi
    ) internal pure returns (uint256) {
        uint256 length = hi - lo;
        if (length == 0) return 0;
        if (length == 1) return arr[lo];

        uint256 mid = lo + length / 2;
        if (length % 2 == 0) {
            return (arr[mid - 1] + arr[mid]) / 2;
        } else {
            return arr[mid];
        }
    }

    /**
     * @dev Finds the submission by `oracle` in `submissions` and sets its
     *      `isOutlier` flag to `true`.
     *
     * @param submissions The storage array of submissions.
     * @param oracle      The address of the oracle whose submission to flag.
     */
    function _flagOutlierInStorage(
        OracleData[] storage submissions,
        address oracle
    ) internal {
        for (uint256 i = 0; i < submissions.length; i++) {
            if (submissions[i].oracle == oracle) {
                submissions[i].isOutlier = true;
                return;
            }
        }
    }

    /**
     * @dev Rewards an oracle for a non-outlier submission.
     *
     *  - Increases reputation by `REPUTATION_BONUS` (capped at `MAX_REPUTATION`).
     *  - Resets the consecutive outlier counter.
     *
     * Emits a {ReputationUpdated} event.
     *
     * @param oracle The address of the oracle to reward.
     */
    function _rewardOracle(address oracle) internal {
        OracleInfo storage info = _oracles[oracle];

        // Reset consecutive outlier streak
        info.consecutiveOutliers = 0;

        // Increase reputation (cap at MAX_REPUTATION)
        uint256 newRep = info.reputation + REPUTATION_BONUS;
        if (newRep > MAX_REPUTATION) {
            newRep = MAX_REPUTATION;
        }
        info.reputation = newRep;

        emit ReputationUpdated(oracle, newRep);
    }

    /**
     * @dev Penalizes an oracle for an outlier submission.
     *
     *  - Decreases reputation by `REPUTATION_PENALTY` (floored at 0).
     *  - Increments the outlier count and consecutive outlier counter.
     *  - If the consecutive outlier count reaches `maxConsecutiveOutliers`,
     *    the oracle is automatically deactivated.
     *
     * Emits {ReputationUpdated} and potentially {OracleDeactivated} events.
     *
     * @param oracle The address of the oracle to penalize.
     */
    function _penalizeOracle(address oracle) internal {
        OracleInfo storage info = _oracles[oracle];

        // Decrease reputation (floor at 0)
        if (info.reputation >= REPUTATION_PENALTY) {
            info.reputation -= REPUTATION_PENALTY;
        } else {
            info.reputation = 0;
        }

        // Increment outlier counts
        info.outlierCount++;
        info.consecutiveOutliers++;

        emit ReputationUpdated(oracle, info.reputation);

        // M-08 fix: probation warning at threshold, deactivation only after grace period
        if (info.consecutiveOutliers == maxConsecutiveOutliers && info.isActive) {
            // Probation warning — oracle gets one more chance
            emit OracleProbationWarning(oracle, info.consecutiveOutliers, maxConsecutiveOutliers);
        } else if (info.consecutiveOutliers > maxConsecutiveOutliers && info.isActive) {
            // Auto-disable after exceeding threshold (grace period exhausted)
            info.isActive = false;
            activeOracleCount--;
            emit OracleDeactivated(oracle);
        }
    }
}
