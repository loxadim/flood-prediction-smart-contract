// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "../interfaces/IFloodPrediction.sol";
import "../interfaces/IMobileMoneyProvider.sol";
import "../interfaces/IKYCAMLCompliance.sol";
import "../interfaces/IMultiOracle.sol";
import "../interfaces/IJokalanteTargeting.sol";
import "./libs/FloodPredictionLib.sol";

/**
 * @title FloodPredictionContract
 * @author Babacar LO
 * @notice Core orchestrator for the OPAL flood prediction and parametric payment system
 * 
 * @dev This is the main contract that:
 * 1. Receives flood data from MultiOracle consensus
 * 2. Triggers parametric payouts when risk thresholds are met
 * 3. Verifies beneficiaries via Merkle proofs (JokalanteTargeting)
 * 4. Processes batch payments via Mobile Money providers
 * 5. Enforces governance rules from OpalGovernance
 * 6. Manages regional budgets (CFA Franc allocations)
 * 
 * Architecture:
 * - UUPS Proxy Upgradeable
 * - RBAC: ADMIN_ROLE, OPERATOR_ROLE, UPGRADER_ROLE, PAUSER_ROLE
 * - Parametric triggers: 70% risk threshold (standard), admin-only governance override path
 * - Adaptive cooldown: 10min (critical), 30min (high), 1h (normal)
 * - Replay protection: chainId + nonce
 * - Batch payment cap: 50 beneficiaries per transaction
 * 
 * Conformité Volet 3-6: Smart contract design, development, security, integration
 */
contract FloodPredictionContract is 
    Initializable,
    AccessControlUpgradeable,
    UUPSUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardTransient, // L-10: Safe with UUPS proxies — uses EIP-1153 transient storage (per-tx), not persistent storage slots
    IFloodPrediction
{
    //  using-for removed — library is called via direct FloodPredictionLib.fn() syntax

    // ============================================
    // Roles
    // ============================================
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // ============================================
    // Constants
    // ============================================
    uint256 public constant VERSION = 3;
    uint256 public constant MAX_BATCH_SIZE = 50;
    uint256 public constant DEFAULT_RISK_THRESHOLD = 70;
    uint256 public constant GOVERNANCE_RISK_THRESHOLD = 85;
    uint256 public constant MAX_RISK_SCORE = 100;
    uint256 public constant MIN_PAYMENT_AMOUNT = 500;          // 500 FCFA
    uint256 public constant MAX_PAYMENT_AMOUNT = 5_000_000;    // 5M FCFA
    uint256 public constant COOLDOWN_CRITICAL = 10 minutes;
    uint256 public constant COOLDOWN_HIGH = 30 minutes;
    uint256 public constant COOLDOWN_NORMAL = 1 hours;
    uint256 public constant MAX_REGION_LENGTH = 20;
    uint256 public constant MAX_STRING_LENGTH = 500;

    // ============================================
    // Structs (additional, not in IFloodPrediction)
    // ============================================

    struct PaymentRecord {
        bytes32 beneficiaryHash;
        uint256 amount;
        uint256 paidAt;
        string eventId;
        bool verified;
    }

    // ============================================
    // State Variables
    // ============================================

    // Trigger storage
    mapping(string => FloodTrigger) public triggers;
    string[] public triggerIds;
    uint256 public triggerCount;

    // Budget management
    mapping(string => BudgetAllocation) public budgets;
    string[] public budgetRegions;
    uint256 public totalBudgetAllocated;
    uint256 public totalBudgetSpent;

    // Payment tracking
    mapping(bytes32 => PaymentRecord) public paymentRecords;
    uint256 public totalPaymentsProcessed;
    uint256 public totalAmountDisbursed;

    // Multi-batch tracking: how many beneficiaries paid per trigger
    mapping(string => uint256) public triggerPaidCount;

    //  committed budget tracking (reserved but not yet spent)
    mapping(string => uint256) public committedBudget;

    //  actual amount spent per trigger
    mapping(string => uint256) public triggerSpentAmount;

    // Nonces for replay protection
    mapping(string => uint256) public regionNonces;
    uint256 public globalNonce;

    // Cooldown tracking per region
    mapping(string => uint256) public lastTriggerTimestamp;

    // Risk threshold (configurable)
    uint256 public riskThreshold;

    // Connected contract addresses
    address public multiOracle;
    address public governance;
    address public jokalanteTargeting;
    address public mobileMoneyProvider;
    address public kycCompliance;

    // Emergency flags
    bool public emergencyMode;
    mapping(string => bool) public regionEmergency;

    /// @notice H-03 fix: maximum allowed deviation between the submitted riskScore and the
    /// oracle consensus score. Default 0 = strict equality. Admin can raise it (max 10 points)
    /// to absorb TOCTOU slippage between consensus reads and block inclusion.
    uint256 public oracleTolerance;

    /// @notice V-05 fix: tracks whether the Mobile Money dispatch for a given
    /// (eventId, beneficiaryHash) payment has been successfully sent to
    /// MobileMoneyProvider. Set on the success path of
    /// _processAndInitiateMobileMoney() and on a successful
    /// retryMobileMoneyDispatch(). Used to make retries one-shot — a payment
    /// that is already dispatched cannot be re-dispatched.
    mapping(bytes32 => bool) public mobileMoneyDispatched;

    // ============================================
    // Events (additional, beyond IFloodPrediction)
    // ============================================
    event TriggerCancelled(string indexed eventId, address cancelledBy, string reason);
    event SinglePaymentProcessed(
        string indexed eventId,
        bytes32 beneficiaryHash,
        uint256 amount,
        uint256 timestamp
    );
    event BudgetSpent(string indexed region, uint256 amount, string eventId);
    event EmergencyModeActivated(address activatedBy, string reason);
    event EmergencyModeDeactivated(address deactivatedBy);
    event RegionEmergencySet(string indexed region, bool status, address setBy);
    event RiskThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);
    event OracleToleranceUpdated(uint256 oldTolerance, uint256 newTolerance);
    event ContractAddressUpdated(string contractName, address oldAddress, address newAddress);
    event GovernanceOverride(string indexed eventId, address governor, string reason);
    event MobileMoneyPaymentsInitiated(string indexed eventId, uint256 count, uint256 totalAmount);
    event MobileMoneyPaymentsFailed(string indexed eventId, uint256 count, uint256 totalAmount);
    /// @notice Emitted when a previously-failed Mobile Money dispatch is retried (V-05 fix)
    event MobileMoneyDispatchRetried(string indexed eventId, uint256 count, uint256 totalAmount);
    event BudgetDeactivated(string indexed region, address operator);
    event BudgetCommitted(string indexed region, uint256 amount, string eventId);
    event BudgetCommitmentReleased(string indexed region, uint256 amount, string eventId);
    /// @notice Emitted when a beneficiary is skipped due to KYC non-compliance (C-01 fix)
    event KYCBeneficiarySkipped(string indexed eventId, bytes32 beneficiaryHash);

    // ============================================
    // Errors
    // ============================================
    error InvalidRiskScore();
    error BelowRiskThreshold();
    error CooldownNotElapsed();
    error TriggerNotFound();
    error TriggerNotActive();
    error TriggerAlreadyPaid();
    error InsufficientBudget();
    error InvalidBatchSize();
    error InvalidPaymentAmount();
    error BeneficiaryAlreadyPaid();
    error InvalidMerkleProof();
    error EmergencyModeActive();
    error NotInEmergencyMode();
    error ArrayLengthMismatch();
    error InvalidAddress();
    error RegionNotActive();
    error TriggerNotCancellable();
    error InvalidThreshold();
    error StringTooLong();
    error RegionStringTooLong();
    error KYCCheckFailed();
    error InvalidBeneficiaryCount();
    error OracleRiskScoreMismatch();
    error TriggerListTooLarge();
    error OracleNotConfigured();
    error RolesNotDistinct();
    error PaymentRecordMismatch();
    error PaymentAlreadyDispatched();

    // ============================================
    // Initializer
    // ============================================

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @dev Initialize the contract (called once via proxy)
     * V-02 fix: accept separate addresses for each role to enforce separation of duties
     * @param admin Address of the default admin (gets DEFAULT_ADMIN_ROLE + ADMIN_ROLE)
     * @param operator Address for OPERATOR_ROLE (trigger creation, payment processing)
     * @param upgrader Address for UPGRADER_ROLE (contract upgrades)
     * @param pauser Address for PAUSER_ROLE (emergency pause)
     */
    function initialize(
        address admin,
        address operator,
        address upgrader,
        address pauser
    ) public initializer {
        if (admin == address(0) || operator == address(0) || upgrader == address(0) || pauser == address(0))
            revert InvalidAddress();
        if (admin == operator || admin == upgrader || admin == pauser ||
            operator == upgrader || operator == pauser || upgrader == pauser)
            revert RolesNotDistinct();

        __AccessControl_init();
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
        _grantRole(OPERATOR_ROLE, operator);
        _grantRole(UPGRADER_ROLE, upgrader);
        _grantRole(PAUSER_ROLE, pauser);

        riskThreshold = DEFAULT_RISK_THRESHOLD;
    }

    /// @dev Authorization is enforced by onlyRole(UPGRADER_ROLE) modifier.
    /// Validates that the new implementation is a valid contract to prevent bricking the proxy.
    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) {
        if (newImplementation == address(0)) revert InvalidAddress();
        if (newImplementation.code.length == 0) revert InvalidAddress();
    }

    // ============================================
    // Trigger Management
    // ============================================

    /**
     * @dev Create a flood trigger when risk score exceeds threshold
     * @param region Geographic region code (e.g., "SN-TH")
     * @param riskScore Current flood risk score (0-100)
     * @param merkleRoot Beneficiary Merkle root
     * @param totalAmount Total budget for this event (FCFA)
     * @param beneficiaryCount Number of eligible beneficiaries
     * @return eventId Generated event identifier
     */
    function createFloodTrigger(
        string calldata region,
        uint256 riskScore,
        bytes32 merkleRoot,
        uint256 totalAmount,
        uint256 beneficiaryCount
    ) external onlyRole(OPERATOR_ROLE) whenNotPaused returns (string memory eventId) {
        if (emergencyMode || regionEmergency[region]) revert EmergencyModeActive();
        if (bytes(region).length == 0 || bytes(region).length > MAX_REGION_LENGTH) revert RegionStringTooLong();
        if (riskScore > MAX_RISK_SCORE) revert InvalidRiskScore();
        if (riskScore < riskThreshold) revert BelowRiskThreshold();
        // validate beneficiaryCount and totalAmount
        if (beneficiaryCount == 0) revert InvalidBeneficiaryCount();
        if (totalAmount == 0) revert InvalidPaymentAmount();

        // Check cooldown (V-06 fix: pass dynamic riskThreshold)
        uint256 cooldown = FloodPredictionLib.calculateCooldown(riskScore, riskThreshold);
        if (block.timestamp < lastTriggerTimestamp[region] + cooldown) {
            revert CooldownNotElapsed();
        }

        // H-2 fix: MultiOracle must be configured — no trigger without oracle backing.
        // Only validate score if consensus is reached (avoids blocking during oracle cold-start).
        // H-03 fix: use ±oracleTolerance instead of strict equality to absorb TOCTOU slippage.
        if (multiOracle == address(0)) revert OracleNotConfigured();
        if (IMultiOracle(multiOracle).isConsensusReached(region)) {
            uint256 oracleScore = IMultiOracle(multiOracle).getConsensusRiskScore(region);
            uint256 diff = riskScore > oracleScore ? riskScore - oracleScore : oracleScore - riskScore;
            if (diff > oracleTolerance) revert OracleRiskScoreMismatch();
        }

        // Check budget (H-01 fix: account for committed amounts)
        BudgetAllocation storage budget = budgets[region];
        uint256 available = budget.allocatedAmount - budget.spentAmount - committedBudget[region];
        if (!budget.isActive || available < totalAmount) {
            revert InsufficientBudget();
        }

        // Generate event ID with replay protection
        uint256 nonce = regionNonces[region]++;
        globalNonce++;

        eventId = FloodPredictionLib.generateEventId(
            region,
            block.timestamp,
            block.chainid,
            nonce
        );

        // Determine risk level
        RiskLevel level = _getRiskLevel(riskScore);

        triggers[eventId] = FloodTrigger({
            eventId: eventId,
            region: region,
            riskScore: riskScore,
            timestamp: block.timestamp,
            validatedAt: 0,
            paidAt: 0,
            status: TriggerStatus.ACTIVE,
            riskLevel: level,
            triggeredBy: msg.sender,
            totalAmount: totalAmount,
            beneficiaryCount: beneficiaryCount,
            merkleRoot: merkleRoot,
            isGovernanceOverride: false,
            chainId: block.chainid
        });

        triggerIds.push(eventId);
        triggerCount++;
        lastTriggerTimestamp[region] = block.timestamp;

        //  commit budget
        committedBudget[region] += totalAmount;
        emit BudgetCommitted(region, totalAmount, eventId);

        emit FloodTriggerCreated(eventId, region, riskScore, block.timestamp, msg.sender);
    }

    /**
     * @dev Create an emergency trigger via governance override
     * @param region Geographic region
     * @param riskScore Risk score
     * @param merkleRoot Beneficiary Merkle root
     * @param totalAmount Total payout amount
     * @param beneficiaryCount Number of beneficiaries
     * @param reason Reason for governance override
     * @return eventId Generated event identifier
     */
    function createGovernanceOverrideTrigger(
        string calldata region,
        uint256 riskScore,
        bytes32 merkleRoot,
        uint256 totalAmount,
        uint256 beneficiaryCount,
        string calldata reason
    ) external onlyRole(ADMIN_ROLE) whenNotPaused returns (string memory eventId) {
        if (riskScore > MAX_RISK_SCORE) revert InvalidRiskScore();
        if (bytes(region).length == 0 || bytes(region).length > MAX_REGION_LENGTH) revert RegionStringTooLong();
        //  validate beneficiaryCount and totalAmount
        if (beneficiaryCount == 0) revert InvalidBeneficiaryCount();
        if (totalAmount == 0) revert InvalidPaymentAmount();

        // enforce active budget unconditionally
        BudgetAllocation storage budget = budgets[region];
        if (!budget.isActive) revert RegionNotActive();
        uint256 available = budget.allocatedAmount - budget.spentAmount - committedBudget[region];
        if (available < totalAmount) {
            revert InsufficientBudget();
        }

        uint256 nonce = regionNonces[region]++;
        globalNonce++;

        eventId = FloodPredictionLib.generateEventId(
            region,
            block.timestamp,
            block.chainid,
            nonce
        );

        triggers[eventId] = FloodTrigger({
            eventId: eventId,
            region: region,
            riskScore: riskScore,
            timestamp: block.timestamp,
            validatedAt: block.timestamp, // Auto-validated
            paidAt: 0,
            status: TriggerStatus.VALIDATED,
            riskLevel: _getRiskLevel(riskScore),
            triggeredBy: msg.sender,
            totalAmount: totalAmount,
            beneficiaryCount: beneficiaryCount,
            merkleRoot: merkleRoot,
            isGovernanceOverride: true,
            chainId: block.chainid
        });

        triggerIds.push(eventId);
        triggerCount++;
        lastTriggerTimestamp[region] = block.timestamp; // M-08 fix: update cooldown for governance overrides

        // commit budget for governance override
        committedBudget[region] += totalAmount;
        emit BudgetCommitted(region, totalAmount, eventId);

        emit FloodTriggerCreated(eventId, region, riskScore, block.timestamp, msg.sender);
        emit GovernanceOverride(eventId, msg.sender, reason);
    }

    /**
     * @dev Validate a trigger (confirm payment readiness)
     * @param eventId Event to validate
     */
    function validateTrigger(string calldata eventId) external onlyRole(OPERATOR_ROLE) {
        FloodTrigger storage trigger = triggers[eventId];
        if (trigger.timestamp == 0) revert TriggerNotFound();
        if (trigger.status != TriggerStatus.ACTIVE) revert TriggerNotActive();
        // H3-FPC fix: block validation when emergency mode is active
        if (emergencyMode || regionEmergency[trigger.region]) revert EmergencyModeActive();

        trigger.status = TriggerStatus.VALIDATED;
        trigger.validatedAt = block.timestamp;

        emit TriggerValidated(eventId, msg.sender, block.timestamp);
    }

    /**
     * @dev Validate a trigger AND automatically process payments + initiate Mobile Money transfers.
     * This is the recommended one-step flow: validate → verify Merkle proofs → send to MobileMoneyProvider.
     * 
     * For triggers with >50 beneficiaries, call this for the first batch,
     * then use processBatchPayment() for subsequent batches.
     *
     * @param eventId Event to validate
     * @param beneficiaryHashes Array of beneficiary identity hashes
     * @param amounts Array of payment amounts in FCFA
     * @param merkleProofs Array of Merkle proofs for each beneficiary
     * @param phoneHashes Array of keccak256 phone hashes for Mobile Money (V-04 fix)
     * @param providers Array of mobile money providers for each beneficiary
     */
    function validateAndProcessPayments(
        string calldata eventId,
        bytes32[] calldata beneficiaryHashes,
        uint256[] calldata amounts,
        bytes32[][] calldata merkleProofs,
        bytes32[] calldata phoneHashes,
        IMobileMoneyProvider.MobileProvider[] calldata providers
    ) external onlyRole(OPERATOR_ROLE) whenNotPaused nonReentrant {
        // check emergency mode in payment flows
        if (emergencyMode || regionEmergency[triggers[eventId].region]) revert EmergencyModeActive();

        // 1. Validate trigger
        FloodTrigger storage trigger = triggers[eventId];
        if (trigger.timestamp == 0) revert TriggerNotFound();
        if (trigger.status != TriggerStatus.ACTIVE) revert TriggerNotActive();

        trigger.status = TriggerStatus.VALIDATED;
        trigger.validatedAt = block.timestamp;
        emit TriggerValidated(eventId, msg.sender, block.timestamp);

        // 2. Process payments and initiate Mobile Money
        _processAndInitiateMobileMoney(
            eventId, trigger, beneficiaryHashes, amounts, merkleProofs, phoneHashes, providers
        );
    }

    /**
     * @dev Cancel a trigger
     * @param eventId Event to cancel
     * @param reason Cancellation reason
     */
    function cancelTrigger(
        string calldata eventId,
        string calldata reason
    ) external onlyRole(ADMIN_ROLE) {
        FloodTrigger storage trigger = triggers[eventId];
        if (trigger.timestamp == 0) revert TriggerNotFound();
        if (trigger.status != TriggerStatus.ACTIVE && trigger.status != TriggerStatus.VALIDATED) revert TriggerNotCancellable();

        // L-03 fix: release committed budget
        uint256 paidSoFar = _estimateSpentForTrigger(eventId, trigger);
        uint256 toRelease = trigger.totalAmount > paidSoFar ? trigger.totalAmount - paidSoFar : 0;
        if (toRelease > 0 && committedBudget[trigger.region] >= toRelease) {
            committedBudget[trigger.region] -= toRelease;
            emit BudgetCommitmentReleased(trigger.region, toRelease, eventId);
        }

        trigger.status = TriggerStatus.CANCELLED;
        emit TriggerCancelled(eventId, msg.sender, reason);
    }

    // ============================================
    // Payment Processing
    // ============================================

    /**
     * @dev Process batch payment for beneficiaries with Merkle proof verification
     * AND automatically initiate Mobile Money transfers.
     * 
     * Use this for subsequent batches after validateAndProcessPayments(),
     * or standalone after a prior validateTrigger() call.
     *
     * @param eventId Event identifier
     * @param beneficiaryHashes Array of beneficiary hashes
     * @param amounts Array of payment amounts
     * @param merkleProofs Array of Merkle proofs
     * @param phoneHashes Array of keccak256 phone hashes for Mobile Money (V-04 fix)
     * @param providers Array of mobile money providers for each beneficiary
     */
    function processBatchPayment(
        string calldata eventId,
        bytes32[] calldata beneficiaryHashes,
        uint256[] calldata amounts,
        bytes32[][] calldata merkleProofs,
        bytes32[] calldata phoneHashes,
        IMobileMoneyProvider.MobileProvider[] calldata providers
    ) external onlyRole(OPERATOR_ROLE) whenNotPaused nonReentrant {
        //  check emergency mode in payment flows
        FloodTrigger storage trigger = triggers[eventId];
        if (trigger.timestamp == 0) revert TriggerNotFound();
        if (emergencyMode || regionEmergency[trigger.region]) revert EmergencyModeActive();
        if (trigger.status != TriggerStatus.VALIDATED) revert TriggerNotActive();

        _processAndInitiateMobileMoney(
            eventId, trigger, beneficiaryHashes, amounts, merkleProofs, phoneHashes, providers
        );
    }

    // ============================================
    // Internal: Payment Processing + Mobile Money
    // ============================================

    /**
     * @dev Internal: verify Merkle proofs, record payments, update budget,
     *      call MobileMoneyProvider.batchInitiatePayments(), and track multi-batch progress.
     */
    function _processAndInitiateMobileMoney(
        string memory eventId,
        FloodTrigger storage trigger,
        bytes32[] memory beneficiaryHashes,
        uint256[] memory amounts,
        bytes32[][] memory merkleProofs,
        bytes32[] memory phoneHashes,
        IMobileMoneyProvider.MobileProvider[] memory providers
    ) internal {
        uint256 count = beneficiaryHashes.length;
        if (count == 0 || count > MAX_BATCH_SIZE) revert InvalidBatchSize();
        if (count != amounts.length || count != merkleProofs.length || count != phoneHashes.length || count != providers.length) {
            revert ArrayLengthMismatch();
        }

        // require mobileMoneyProvider to be set BEFORE any state changes
        if (mobileMoneyProvider == address(0)) revert InvalidAddress();

        // C-01 fix: KYC compliance — skip non-compliant beneficiaries instead of reverting the entire batch.
        // kycSkip[i] == true means the beneficiary at index i will be excluded from processing and payment.
        bool[] memory kycSkip = new bool[](count);
        uint256 validCount = count;
        if (kycCompliance != address(0)) {
            bool[] memory kycResults = IKYCAMLCompliance(kycCompliance).batchCheckCompliance(beneficiaryHashes);
            for (uint256 i = 0; i < count; i++) {
                if (!kycResults[i]) {
                    kycSkip[i] = true;
                    validCount--;
                    emit KYCBeneficiarySkipped(eventId, beneficiaryHashes[i]);
                }
            }
            if (validCount == 0) revert KYCCheckFailed(); // every beneficiary in the batch failed KYC
        }

        //  check budget is active
        BudgetAllocation storage budget = budgets[trigger.region];
        if (!budget.isActive) revert RegionNotActive();
        uint256 totalBatch;

        for (uint256 i = 0; i < count; i++) {
            // C-01 fix: skip beneficiaries that failed KYC compliance check
            if (kycSkip[i]) continue;

            if (amounts[i] < MIN_PAYMENT_AMOUNT || amounts[i] > MAX_PAYMENT_AMOUNT) {
                revert InvalidPaymentAmount();
            }
            totalBatch += amounts[i];

            // Check not already paid
            bytes32 paymentKey = keccak256(abi.encode(eventId, beneficiaryHashes[i]));
            if (paymentRecords[paymentKey].paidAt > 0) revert BeneficiaryAlreadyPaid();

            // H-01 fix: verify via JokalanteTargeting when configured — this respects region expiry
            // and active status managed by the targeting module.
            // Falls back to direct Merkle check against trigger.merkleRoot when not configured.
            if (jokalanteTargeting != address(0)) {
                if (!IJokalanteTargeting(jokalanteTargeting).verifyBeneficiary(
                    trigger.region, beneficiaryHashes[i], amounts[i], merkleProofs[i]
                )) revert InvalidMerkleProof();
            } else {
                // V-01 fix: double-hash to prevent second-preimage attacks (OpenZeppelin standard)
                bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(beneficiaryHashes[i], amounts[i]))));
                if (!MerkleProof.verify(merkleProofs[i], trigger.merkleRoot, leaf)) {
                    revert InvalidMerkleProof();
                }
            }

            // Record payment on-chain
            paymentRecords[paymentKey] = PaymentRecord({
                beneficiaryHash: beneficiaryHashes[i],
                amount: amounts[i],
                paidAt: block.timestamp,
                eventId: eventId,
                verified: true
            });

            // H-01 fix: mark beneficiary as paid in JokalanteTargeting to prevent double-payment
            // across batches or trigger restarts.
            if (jokalanteTargeting != address(0)) {
                IJokalanteTargeting(jokalanteTargeting).markVerified(trigger.region, beneficiaryHashes[i]);
            }

            emit SinglePaymentProcessed(eventId, beneficiaryHashes[i], amounts[i], block.timestamp);
        }

        // Update budget
        // H1-FPC fix: guard against overspending this trigger's own allocation
        if (triggerSpentAmount[eventId] + totalBatch > trigger.totalAmount) revert InsufficientBudget();
        if (budget.allocatedAmount - budget.spentAmount < totalBatch) revert InsufficientBudget();
        budget.spentAmount += totalBatch;
        totalBudgetSpent += totalBatch;

        // release committed budget as it is spent
        if (committedBudget[trigger.region] >= totalBatch) {
            committedBudget[trigger.region] -= totalBatch;
        } else {
            committedBudget[trigger.region] = 0;
        }

        // Update global counters (validCount excludes KYC-skipped entries)
        totalPaymentsProcessed += validCount;
        totalAmountDisbursed += totalBatch;

        //track actual spend per trigger
        triggerSpentAmount[eventId] += totalBatch;

        // Track multi-batch progress (validCount excludes KYC-skipped entries)
        // H2-FPC fix: prevent triggerPaidCount from exceeding beneficiaryCount
        if (triggerPaidCount[eventId] + validCount > trigger.beneficiaryCount) revert InvalidBatchSize();
        triggerPaidCount[eventId] += validCount;
        if (triggerPaidCount[eventId] >= trigger.beneficiaryCount) {
            trigger.status = TriggerStatus.PAID;
            trigger.paidAt = block.timestamp;
        }

        emit BatchPaymentProcessed(eventId, validCount, totalBatch, block.timestamp);
        emit BudgetSpent(trigger.region, totalBatch, eventId);

        // H-03 fix: try/catch to decouple on-chain records from Mobile Money bridge.
        // C-01 fix: build filtered arrays excluding KYC-skipped entries so only compliant
        // beneficiaries are forwarded to the MobileMoneyProvider.
        bytes32[] memory filteredHashes  = new bytes32[](validCount);
        uint256[] memory filteredAmounts = new uint256[](validCount);
        bytes32[] memory filteredPhones  = new bytes32[](validCount);
        IMobileMoneyProvider.MobileProvider[] memory filteredProviders = new IMobileMoneyProvider.MobileProvider[](validCount);
        uint256 fIdx = 0;
        for (uint256 i = 0; i < count; i++) {
            if (!kycSkip[i]) {
                filteredHashes[fIdx]  = beneficiaryHashes[i];
                filteredAmounts[fIdx] = amounts[i];
                filteredPhones[fIdx]  = phoneHashes[i];
                filteredProviders[fIdx] = providers[i];
                fIdx++;
            }
        }
        try IMobileMoneyProvider(mobileMoneyProvider).batchInitiatePayments(
            filteredHashes,
            filteredAmounts,
            filteredPhones,
            trigger.region,
            filteredProviders
        ) {
            // V-05 fix: mark each dispatched payment so retryMobileMoneyDispatch()
            // cannot re-send a batch that already succeeded.
            for (uint256 i = 0; i < filteredHashes.length; i++) {
                mobileMoneyDispatched[keccak256(abi.encode(eventId, filteredHashes[i]))] = true;
            }
            emit MobileMoneyPaymentsInitiated(eventId, validCount, totalBatch);
        } catch {
            emit MobileMoneyPaymentsFailed(eventId, validCount, totalBatch);
        }
    }

    /**
     * @dev V-05 fix: retry dispatching to MobileMoneyProvider after a
     * MobileMoneyPaymentsFailed event.
     *
     * Budget accounting and payment records are finalized inside
     * _processAndInitiateMobileMoney() BEFORE the Mobile Money dispatch is
     * attempted (by design — H-03 fix decouples on-chain settlement from the
     * off-chain bridge). If that dispatch reverts (e.g. mobileMoneyProvider
     * was misconfigured or temporarily failing), this function lets an
     * operator re-attempt the SAME dispatch — without re-running Merkle/KYC
     * checks or re-touching budget — once the provider is fixed.
     *
     * Each beneficiary must already have a finalized PaymentRecord for this
     * eventId with a matching amount; this proves they were validated and
     * paid out of the budget by processBatchPayment()/validateAndProcessPayments()
     * and prevents this function being used to bypass those checks.
     *
     * One-shot per beneficiary: mobileMoneyDispatched[paymentKey] must be
     * false (i.e. the original dispatch genuinely failed, or a prior retry
     * for this beneficiary did) and is set true on success — preventing this
     * function from being used to re-send an already-successful dispatch and
     * cause duplicate off-chain Mobile Money payouts.
     *
     * Unlike the try/catch in _processAndInitiateMobileMoney, this call is
     * NOT swallowed — it reverts on failure so the operator can see the
     * underlying MobileMoneyProvider error.
     */
    function retryMobileMoneyDispatch(
        string calldata eventId,
        bytes32[] calldata beneficiaryHashes,
        uint256[] calldata amounts,
        bytes32[] calldata phoneHashes,
        IMobileMoneyProvider.MobileProvider[] calldata providers
    ) external onlyRole(OPERATOR_ROLE) whenNotPaused nonReentrant {
        uint256 count = beneficiaryHashes.length;
        if (count == 0 || count > MAX_BATCH_SIZE) revert InvalidBatchSize();
        if (count != amounts.length || count != phoneHashes.length || count != providers.length) {
            revert ArrayLengthMismatch();
        }
        if (mobileMoneyProvider == address(0)) revert InvalidAddress();

        FloodTrigger storage trigger = triggers[eventId];
        if (trigger.timestamp == 0) revert TriggerNotFound();

        uint256 totalBatch;
        for (uint256 i = 0; i < count; i++) {
            bytes32 paymentKey = keccak256(abi.encode(eventId, beneficiaryHashes[i]));
            PaymentRecord storage record = paymentRecords[paymentKey];
            if (record.paidAt == 0 || record.amount != amounts[i]) revert PaymentRecordMismatch();
            if (mobileMoneyDispatched[paymentKey]) revert PaymentAlreadyDispatched();
            totalBatch += amounts[i];
        }

        IMobileMoneyProvider(mobileMoneyProvider).batchInitiatePayments(
            beneficiaryHashes,
            amounts,
            phoneHashes,
            trigger.region,
            providers
        );

        for (uint256 i = 0; i < count; i++) {
            mobileMoneyDispatched[keccak256(abi.encode(eventId, beneficiaryHashes[i]))] = true;
        }

        emit MobileMoneyDispatchRetried(eventId, count, totalBatch);
    }

    // ============================================
    // Budget Management
    // ============================================

    /**
     * @dev Allocate budget to a region
     * @param region Region code
     * @param amount Budget amount in FCFA
     */
    function allocateBudget(
        string calldata region,
        uint256 amount
    ) external onlyRole(ADMIN_ROLE) {
        BudgetAllocation storage budget = budgets[region];

        if (!budget.isActive) {
            budget.region = region;
            budget.isActive = true;
            // C-02 fix: only add to enumeration array on first registration.
            // lastUpdated == 0 means this region has never been allocated a budget before.
            // Reactivations (deactivateBudget → allocateBudget) must not push again.
            if (budget.lastUpdated == 0) {
                budgetRegions.push(region);
            }
        }

        budget.allocatedAmount += amount;
        budget.lastUpdated = block.timestamp;
        totalBudgetAllocated += amount;

        emit BudgetAllocated(region, amount, msg.sender);
    }

    /**
     * @dev Deactivate a region's budget
     * @param region Region to deactivate
     */
    function deactivateBudget(string calldata region) external onlyRole(ADMIN_ROLE) {
        budgets[region].isActive = false;
        emit BudgetDeactivated(region, msg.sender); // M-03 fix: emit event for audit trail
    }

    // ============================================
    // Emergency Management
    // ============================================

    /**
     * @dev Activate global emergency mode
     * @param reason Reason for emergency
     */
    function activateEmergencyMode(string calldata reason) external onlyRole(ADMIN_ROLE) {
        emergencyMode = true;
        emit EmergencyModeActivated(msg.sender, reason);
    }

    /**
     * @dev Deactivate emergency mode
     */
    function deactivateEmergencyMode() external onlyRole(ADMIN_ROLE) {
        if (!emergencyMode) revert NotInEmergencyMode();
        emergencyMode = false;
        emit EmergencyModeDeactivated(msg.sender);
    }

    /**
     * @dev Set emergency status for a specific region
     * @param region Region code
     * @param status Emergency status
     */
    function setRegionEmergency(string calldata region, bool status) external onlyRole(ADMIN_ROLE) {
        regionEmergency[region] = status;
        emit RegionEmergencySet(region, status, msg.sender);
    }

    // ============================================
    // Configuration
    // ============================================

    /**
     * @dev Update risk threshold
     * @param newThreshold New threshold (0-100)
     */
    function updateRiskThreshold(uint256 newThreshold) external onlyRole(ADMIN_ROLE) {
        if (newThreshold == 0 || newThreshold > MAX_RISK_SCORE) revert InvalidThreshold();
        uint256 oldThreshold = riskThreshold;
        riskThreshold = newThreshold;
        emit RiskThresholdUpdated(oldThreshold, newThreshold);
    }

    /**
     * @dev H-03 fix: Set the oracle score tolerance (max deviation allowed between submitted
     * riskScore and oracle consensus). Default is 0 (strict equality). Raise to absorb
     * TOCTOU slippage in high-frequency consensus rounds.
     * @param newTolerance Tolerance in risk-score points (0–10)
     */
    function setOracleTolerance(uint256 newTolerance) external onlyRole(ADMIN_ROLE) {
        if (newTolerance > 10) revert InvalidThreshold();
        uint256 old = oracleTolerance;
        oracleTolerance = newTolerance;
        emit OracleToleranceUpdated(old, newTolerance);
    }

    /**
     * @dev Set connected contract addresses.
     *      Pass `address(0)` for any parameter to skip updating that address.
     *      This allows selective updates without requiring all addresses.
     * @param _multiOracle MultiOracle contract (address(0) = skip)
     * @param _governance Governance contract (address(0) = skip)
     * @param _targeting JokalanteTargeting contract (address(0) = skip)
     * @param _mobileMoney MobileMoneyProvider contract (address(0) = skip)
     * @param _kyc KYCAMLCompliance contract (address(0) = skip)
     */
    function setContractAddresses(
        address _multiOracle,
        address _governance,
        address _targeting,
        address _mobileMoney,
        address _kyc
    ) external onlyRole(ADMIN_ROLE) {
        if (_multiOracle != address(0)) {
            // M-07 fix: validate contract has code
            if (_multiOracle.code.length == 0) revert InvalidAddress();
            emit ContractAddressUpdated("MultiOracle", multiOracle, _multiOracle);
            multiOracle = _multiOracle;
        }
        if (_governance != address(0)) {
            if (_governance.code.length == 0) revert InvalidAddress();
            emit ContractAddressUpdated("Governance", governance, _governance);
            governance = _governance;
        }
        if (_targeting != address(0)) {
            if (_targeting.code.length == 0) revert InvalidAddress();
            emit ContractAddressUpdated("JokalanteTargeting", jokalanteTargeting, _targeting);
            jokalanteTargeting = _targeting;
        }
        if (_mobileMoney != address(0)) {
            if (_mobileMoney.code.length == 0) revert InvalidAddress();
            emit ContractAddressUpdated("MobileMoney", mobileMoneyProvider, _mobileMoney);
            mobileMoneyProvider = _mobileMoney;
        }
        if (_kyc != address(0)) {
            if (_kyc.code.length == 0) revert InvalidAddress();
            emit ContractAddressUpdated("KYCCompliance", kycCompliance, _kyc);
            kycCompliance = _kyc;
        }
    }

    // ============================================
    // Pause
    // ============================================

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ============================================
    // View Functions
    // ============================================

    /**
     * @dev Get a flood trigger by event ID
     */
    function getFloodTrigger(string calldata eventId) external view returns (FloodTrigger memory) {
        return triggers[eventId];
    }

    /**
     * @dev Get region budget information
     */
    function getRegionBudget(string calldata region) external view returns (BudgetAllocation memory) {
        return budgets[region];
    }

    /**
     * @dev Get budget remaining for a region
     */
    function getRegionBudgetRemaining(string calldata region) external view returns (uint256) {
        BudgetAllocation memory budget = budgets[region];
        if (!budget.isActive) return 0;
        // L-02v2 fix: subtract committedBudget to reflect actually available budget
        uint256 spent = budget.spentAmount + committedBudget[region];
        if (spent >= budget.allocatedAmount) return 0;
        return budget.allocatedAmount - spent;
    }

    /**
     * @dev Get payment record for a beneficiary in a specific event
     */
    function getPaymentRecord(string calldata eventId, bytes32 beneficiaryHash) external view returns (PaymentRecord memory) {
        bytes32 paymentKey = keccak256(abi.encode(eventId, beneficiaryHash));
        return paymentRecords[paymentKey];
    }

    /**
     * @dev Check if a beneficiary was already paid for an event
     */
    function isBeneficiaryPaid(string calldata eventId, bytes32 beneficiaryHash) external view returns (bool) {
        bytes32 paymentKey = keccak256(abi.encode(eventId, beneficiaryHash));
        return paymentRecords[paymentKey].paidAt > 0;
    }

    /**
     * @dev Get system statistics
     */
    function getSystemStats() external view returns (
        uint256 _triggerCount,
        uint256 _totalPayments,
        uint256 _totalDisbursed,
        uint256 _totalBudget,
        uint256 _totalSpent,
        uint256 _version
    ) {
        return (
            triggerCount,
            totalPaymentsProcessed,
            totalAmountDisbursed,
            totalBudgetAllocated,
            totalBudgetSpent,
            VERSION
        );
    }

    /**
     * @dev Get all trigger IDs — capped at 500 entries.
     * @notice For datasets > 500 triggers use getTriggerIdsPaginated() to avoid out-of-gas.
     */
    function getTriggerIds() external view returns (string[] memory) {
        if (triggerIds.length > 500) revert TriggerListTooLarge();
        return triggerIds;
    }

    /**
     * @dev Get trigger IDs with pagination (M-02 fix)
     * @param offset Start index
     * @param limit Maximum number of items to return
     * @return ids Paginated trigger IDs
     * @return total Total number of trigger IDs in storage
     */
    function getTriggerIdsPaginated(uint256 offset, uint256 limit) external view returns (string[] memory ids, uint256 total) {
        total = triggerIds.length;
        if (offset >= total) return (new string[](0), total);
        uint256 remaining = total - offset;
        uint256 count = limit < remaining ? limit : remaining;
        ids = new string[](count);
        for (uint256 i = 0; i < count; i++) {
            ids[i] = triggerIds[offset + i];
        }
    }

    /**
     * @dev Get budget regions with pagination (M-02 fix)
     * @param offset Start index
     * @param limit Maximum number of items to return
     * @return regions Paginated budget region codes
     * @return total Total number of budget regions in storage
     */
    function getBudgetRegionsPaginated(uint256 offset, uint256 limit) external view returns (string[] memory regions, uint256 total) {
        total = budgetRegions.length;
        if (offset >= total) return (new string[](0), total);
        uint256 remaining = total - offset;
        uint256 count = limit < remaining ? limit : remaining;
        regions = new string[](count);
        for (uint256 i = 0; i < count; i++) {
            regions[i] = budgetRegions[offset + i];
        }
    }

    /**
     * @dev Get contract version
     */
    function getVersion() external pure returns (uint256) {
        return VERSION;
    }

    /**
     * @dev Get cooldown remaining for a region
     * @param region Region code
     * @param riskScore Anticipated risk score
     * @return remaining Seconds remaining in cooldown (0 if no cooldown)
     */
    function getCooldownRemaining(string calldata region, uint256 riskScore) external view returns (uint256) {
        uint256 cooldown = FloodPredictionLib.calculateCooldown(riskScore, riskThreshold);
        uint256 lastTrigger = lastTriggerTimestamp[region];
        if (lastTrigger == 0) return 0;
        uint256 elapsed = block.timestamp - lastTrigger;
        if (elapsed >= cooldown) return 0;
        return cooldown - elapsed;
    }

    // ============================================
    // Internal
    // ============================================

    /**
     * @dev Determine risk level from numeric score
     * @param riskScore Numeric risk score (0-100)
     * @return RiskLevel enum: LOW (<50), MODERATE (50-69), HIGH (70-84), CRITICAL (>=85)
     */
    function _getRiskLevel(uint256 riskScore) internal pure returns (RiskLevel) {
        if (riskScore >= 85) return RiskLevel.CRITICAL;
        if (riskScore >= 70) return RiskLevel.HIGH;
        if (riskScore >= 50) return RiskLevel.MODERATE;
        return RiskLevel.LOW;
    }

    /**
     * @dev Estimate amount already spent for a trigger based on triggerPaidCount
     * Used in cancelTrigger to calculate how much committed budget to release
     */
    function _estimateSpentForTrigger(string memory eventId, FloodTrigger storage) internal view returns (uint256) {
        // L-01v2 fix: use actual tracked spend instead of proportional estimation
        return triggerSpentAmount[eventId];
    }

    /**
     * @dev Reserved storage gap for future upgrades.
     * Storage layout: oracleTolerance (1 slot) + __gap (47) = 48 reserved slots total.
     * Note: committedBudget, triggerSpentAmount, and mobileMoneyDispatched are mappings
     * and occupy keccak256-based storage slots, not numbered slots in the gap calculation.
     * V-05 fix: mobileMoneyDispatched mapping added, __gap reduced from 48 to 47 to
     * preserve the total reserved slot count.
     * When adding new state variables, reduce __gap size accordingly.
     */
    uint256[47] private __gap;
}
