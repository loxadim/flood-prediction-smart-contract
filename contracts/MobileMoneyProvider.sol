// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../interfaces/IMobileMoneyProvider.sol";

/**
 * @title MobileMoneyProvider
 * @author DPA Foundation — OPAL Platform
 * @notice Production Mobile Money provider for Senegal
 * @dev Implements IMobileMoneyProvider with:
 *      - Orange Money, Wave support
 *      - Provider supplied as parameter (any provider can serve any phone number)
 *      - Off-chain relayer bridge pattern
 *      - Nonce-based replay protection
 *      - Configurable payment timeouts
 *      - GDPR-compliant: only hashes on-chain
 *
 * Supported providers:
 * ┌──────────────────┬──────────────────────┐
 * │ Provider         │ API                  │
 * ├──────────────────┼──────────────────────┤
 * │ Orange Money     │ Orange Money API v3  │
 * │ Wave             │ Wave Business API    │
 * └──────────────────┴──────────────────────┘
 *
 * Architecture:
 * ┌────────────┐  initiate  ┌───────────────────────┐  event  ┌──────────────┐
 * │  Flood     │ ─────────▶ │  MobileMoney          │ ──────▶ │   Relayer    │
 * │  Predict   │            │  Provider             │         │   Service    │
 * └────────────┘            └───────────────────────┘         └──────┬───────┘
 *                                                                     │
 *                           ┌───────────────────────┐  confirm ┌─────▼────────┐
 *                           │  On-chain record      │ ◀─────── │  Orange/Wave │
 *                           │  (status update)      │          │  API         │
 *                           └───────────────────────┘          └──────────────┘
 */
contract MobileMoneyProvider is IMobileMoneyProvider, Ownable2Step, Pausable, ReentrancyGuard {

    // ============================
    // Constants
    // ============================
    uint256 public constant MAX_PAYMENT_AMOUNT = 5_000_000;  // 5,000,000 CFA max per payment (M-11 fix: aligned with other contracts)
    uint256 public constant MIN_PAYMENT_AMOUNT = 500;       // 500 CFA minimum
    uint256 public constant MAX_BATCH_SIZE = 50; // M-06 fix: unified with FloodPredictionContract
    uint256 public constant MAX_RETRIES = 3;
    uint256 public constant DEFAULT_TIMEOUT = 30 minutes;
    uint256 public constant MAX_TIMEOUT = 24 hours;
    uint256 public constant MIN_TIMEOUT = 5 minutes;

    // ============================
    // State Variables
    // ============================
    
    /// @notice Payment timeout duration
    uint256 public paymentTimeout;
    
    /// @notice Authorized relayer addresses
    mapping(address => bool) public authorizedRelayers;
    
    /// @notice Number of authorized relayers
    uint256 public relayerCount;
    
    /// @notice Pending payment count (O(1) tracker)
    uint256 public pendingPaymentCount;
    
    /// @notice Payment storage
    mapping(bytes32 => Payment) private _payments;
    
    /// @notice Nonce per region for replay protection
    mapping(string => uint256) public regionNonces;
    
    /// @notice Global nonce
    uint256 public globalNonce;
    
    /// @notice Total amount disbursed (confirmed)
    uint256 private _totalDisbursed;
    
    /// @notice Total payments initiated
    uint256 public totalPaymentsInitiated;
    
    /// @notice Total payments confirmed
    uint256 public totalPaymentsConfirmed;
    
    /// @notice Total payments failed
    uint256 public totalPaymentsFailed;
    
    /// @notice Provider stats
    mapping(MobileProvider => uint256) public providerPaymentCount;
    
    /// @notice Region disbursement totals
    mapping(string => uint256) public regionDisbursed;
    
    /// @notice Daily limit per region (0 = no limit)
    mapping(string => uint256) public regionDailyLimit;
    
    /// @notice Daily spend tracking: region -> day -> amount
    mapping(string => mapping(uint256 => uint256)) public regionDailySpend;

    // ============================
    // Errors
    // ============================
    error UnauthorizedRelayer();
    error InvalidAmount(uint256 amount);
    error EmptyPhone();
    error EmptyRegion();
    error PaymentNotFound(bytes32 paymentId);
    error InvalidBeneficiaryHash();
    error PaymentNotPending(bytes32 paymentId);
    error PaymentAlreadyExists(bytes32 paymentId);
    error MaxRetriesExceeded(bytes32 paymentId);
    error PaymentExpiredError(bytes32 paymentId);
    error ArrayLengthMismatch();
    error BatchTooLarge(uint256 size);
    error EmptyBatch();
    error DailyLimitExceeded(string region, uint256 limit, uint256 attempted);
    error InvalidTimeout(uint256 timeout);
    error ZeroAddress();
    error CannotRemoveLastRelayer();

    // ============================
    // Events (additional to interface)
    // ============================
    event RelayerAdded(address indexed relayer);
    event RelayerRemoved(address indexed relayer);
    event TimeoutUpdated(uint256 oldTimeout, uint256 newTimeout);
    event DailyLimitSet(string indexed region, uint256 limit);
    event PaymentSkipped(bytes32 indexed paymentId, string reason);

    // ============================
    // Modifiers
    // ============================
    modifier onlyRelayer() {
        if (!authorizedRelayers[msg.sender]) revert UnauthorizedRelayer();
        _;
    }

    // ============================
    // Constructor
    // ============================
    constructor() Ownable(msg.sender) {
        paymentTimeout = DEFAULT_TIMEOUT;
        authorizedRelayers[msg.sender] = true;
        relayerCount = 1;
        emit RelayerAdded(msg.sender);
    }

    // ============================
    // Core Payment Operations
    // ============================

    /**
     * @inheritdoc IMobileMoneyProvider
     */
    function initiatePayment(
        bytes32 beneficiaryHash,
        uint256 amount,
        bytes32 phoneHash,
        string calldata region,
        MobileProvider provider
    ) external override onlyRelayer whenNotPaused nonReentrant returns (bytes32 paymentId) {
        // Validate
        _validatePaymentInputs(beneficiaryHash, amount, phoneHash, region);
        _checkDailyLimit(region, amount);

        // Generate unique payment ID
        paymentId = _generatePaymentId(beneficiaryHash, region);
        if (_payments[paymentId].initiatedAt > 0) revert PaymentAlreadyExists(paymentId);

        // Store payment (V-04 fix: phoneHash instead of plaintext)
        _payments[paymentId] = Payment({
            paymentId: paymentId,
            beneficiaryHash: beneficiaryHash,
            amount: amount,
            phoneHash: phoneHash,
            region: region,
            provider: provider,
            status: PaymentStatus.PENDING,
            initiatedAt: block.timestamp,
            confirmedAt: 0,
            retryCount: 0,
            transactionRef: ""
        });

        pendingPaymentCount++;
        totalPaymentsInitiated++;
        providerPaymentCount[provider]++;

        // Track daily spend
        uint256 today = block.timestamp / 1 days;
        regionDailySpend[region][today] += amount;

        emit PaymentInitiated(paymentId, beneficiaryHash, amount, region, provider);
        
        return paymentId;
    }

    /**
     * @inheritdoc IMobileMoneyProvider
     */
    function confirmPayment(
        bytes32 paymentId,
        string calldata transactionRef
    ) external override onlyRelayer nonReentrant {
        Payment storage payment = _payments[paymentId];
        if (payment.initiatedAt == 0) revert PaymentNotFound(paymentId);
        if (payment.status != PaymentStatus.PENDING) revert PaymentNotPending(paymentId);
        
        // Check expiry. A stale payment cannot be confirmed: the state changes
        // below would be rolled back by the revert anyway, so we revert cleanly.
        // The payment stays PENDING and is durably moved to EXPIRED (with the
        // daily-spend refund) by expireStalePayments()/batchConfirmPayments().
        if (block.timestamp > payment.initiatedAt + paymentTimeout) {
            revert PaymentExpiredError(paymentId);
        }

        payment.status = PaymentStatus.CONFIRMED;
        payment.confirmedAt = block.timestamp;
        payment.transactionRef = transactionRef;
        
        _totalDisbursed += payment.amount;
        regionDisbursed[payment.region] += payment.amount;
        totalPaymentsConfirmed++;
        pendingPaymentCount--;

        emit PaymentConfirmed(paymentId, transactionRef, block.timestamp);
    }

    /**
     * @inheritdoc IMobileMoneyProvider
     */
    function failPayment(
        bytes32 paymentId,
        string calldata reason
    ) external override onlyRelayer nonReentrant {
        Payment storage payment = _payments[paymentId];
        if (payment.initiatedAt == 0) revert PaymentNotFound(paymentId);
        if (payment.status != PaymentStatus.PENDING) revert PaymentNotPending(paymentId);

        payment.status = PaymentStatus.FAILED;
        totalPaymentsFailed++;
        pendingPaymentCount--;

        _refundDailySpend(payment);

        emit PaymentFailed(paymentId, reason);
    }

    /**
     * @inheritdoc IMobileMoneyProvider
     */
    function retryPayment(bytes32 paymentId) external override onlyRelayer whenNotPaused nonReentrant {
        Payment storage payment = _payments[paymentId];
        if (payment.initiatedAt == 0) revert PaymentNotFound(paymentId);
        if (payment.status != PaymentStatus.FAILED) revert PaymentNotPending(paymentId);
        if (payment.retryCount >= MAX_RETRIES) revert MaxRetriesExceeded(paymentId);

        // Re-reserve the daily allowance under today's date, since failPayment
        // already refunded it under the original initiation date.
        _checkDailyLimit(payment.region, payment.amount);

        payment.status = PaymentStatus.PENDING;
        payment.retryCount++;
        payment.initiatedAt = block.timestamp; // Reset timeout
        pendingPaymentCount++;

        uint256 today = block.timestamp / 1 days;
        regionDailySpend[payment.region][today] += payment.amount;

        emit PaymentRetried(paymentId, payment.retryCount);
    }

    // ============================
    // Batch Operations
    // ============================

    /**
     * @inheritdoc IMobileMoneyProvider
     */
    function batchInitiatePayments(
        bytes32[] calldata beneficiaryHashes,
        uint256[] calldata amounts,
        bytes32[] calldata phoneHashes,
        string calldata region,
        MobileProvider[] calldata providers
    ) external override onlyRelayer whenNotPaused nonReentrant returns (bytes32[] memory paymentIds) {
        uint256 count = beneficiaryHashes.length;
        if (count == 0) revert EmptyBatch();
        if (count > MAX_BATCH_SIZE) revert BatchTooLarge(count);
        if (count != amounts.length || count != phoneHashes.length || count != providers.length) revert ArrayLengthMismatch();

        // H8-MMP fix: reject batch if any beneficiary hash appears more than once.
        // _generatePaymentId uses nonces so duplicate hashes would produce distinct IDs,
        // silently sending two payments to the same beneficiary.
        for (uint256 i = 0; i < count; i++) {
            for (uint256 j = i + 1; j < count; j++) {
                if (beneficiaryHashes[i] == beneficiaryHashes[j]) revert InvalidBeneficiaryHash();
            }
        }

        // Calculate total and check daily limit
        uint256 totalAmount;
        for (uint256 i = 0; i < count; i++) {
            totalAmount += amounts[i];
        }
        _checkDailyLimit(region, totalAmount);

        paymentIds = new bytes32[](count);

        for (uint256 i = 0; i < count; i++) {
            _validatePaymentInputs(beneficiaryHashes[i], amounts[i], phoneHashes[i], region);
            
            bytes32 paymentId = _generatePaymentId(beneficiaryHashes[i], region);
            if (_payments[paymentId].initiatedAt > 0) revert PaymentAlreadyExists(paymentId);

            _payments[paymentId] = Payment({
                paymentId: paymentId,
                beneficiaryHash: beneficiaryHashes[i],
                amount: amounts[i],
                phoneHash: phoneHashes[i],
                region: region,
                provider: providers[i],
                status: PaymentStatus.PENDING,
                initiatedAt: block.timestamp,
                confirmedAt: 0,
                retryCount: 0,
                transactionRef: ""
            });

            paymentIds[i] = paymentId;
            providerPaymentCount[providers[i]]++;

            // Emit a per-item PaymentInitiated so the off-chain relayer can act on
            // each payment individually (BatchPaymentInitiated alone carries no
            // paymentIds, leaving the relayer unable to execute or confirm transfers).
            emit PaymentInitiated(paymentId, beneficiaryHashes[i], amounts[i], region, providers[i]);
        }

        totalPaymentsInitiated += count;
        pendingPaymentCount += count;

        // Track daily spend
        uint256 today = block.timestamp / 1 days;
        regionDailySpend[region][today] += totalAmount;

        emit BatchPaymentInitiated(count, region, totalAmount);
        
        return paymentIds;
    }

    /**
     * @inheritdoc IMobileMoneyProvider
     */
    function batchConfirmPayments(
        bytes32[] calldata paymentIds,
        string[] calldata transactionRefs
    ) external override onlyRelayer nonReentrant {
        if (paymentIds.length == 0) revert EmptyBatch();
        if (paymentIds.length > MAX_BATCH_SIZE) revert BatchTooLarge(paymentIds.length);
        if (paymentIds.length != transactionRefs.length) revert ArrayLengthMismatch();

        for (uint256 i = 0; i < paymentIds.length; i++) {
            Payment storage payment = _payments[paymentIds[i]];
            if (_payments[paymentIds[i]].initiatedAt == 0) revert PaymentNotFound(paymentIds[i]);
            if (payment.status != PaymentStatus.PENDING) {
                emit PaymentSkipped(paymentIds[i], "NOT_PENDING");
                continue; // M-04 fix: emit event instead of silent skip
            }

            // Check expiry
            if (block.timestamp > payment.initiatedAt + paymentTimeout) {
                payment.status = PaymentStatus.EXPIRED;
                pendingPaymentCount--;
                _refundDailySpend(payment);
                emit PaymentExpired(paymentIds[i]);
                continue;
            }

            payment.status = PaymentStatus.CONFIRMED;
            payment.confirmedAt = block.timestamp;
            payment.transactionRef = transactionRefs[i];
            
            _totalDisbursed += payment.amount;
            regionDisbursed[payment.region] += payment.amount;
            totalPaymentsConfirmed++;
            pendingPaymentCount--;

            emit PaymentConfirmed(paymentIds[i], transactionRefs[i], block.timestamp);
        }
    }

    // ============================
    // View Functions
    // ============================

    /**
     * @inheritdoc IMobileMoneyProvider
     */
    function getPayment(bytes32 paymentId) external view override returns (Payment memory) {
        if (_payments[paymentId].initiatedAt == 0) revert PaymentNotFound(paymentId);
        return _payments[paymentId];
    }

    /**
     * @inheritdoc IMobileMoneyProvider
     */
    function getPaymentStatus(bytes32 paymentId) external view override returns (PaymentStatus) {
        if (_payments[paymentId].initiatedAt == 0) revert PaymentNotFound(paymentId);
        return _payments[paymentId].status;
    }

    /**
     * @inheritdoc IMobileMoneyProvider
     */
    function getPendingPaymentCount() external view override returns (uint256) {
        return pendingPaymentCount;
    }

    /**
     * @inheritdoc IMobileMoneyProvider
     */
    function getTotalDisbursed() external view override returns (uint256) {
        return _totalDisbursed;
    }

    /**
     * @notice Get remaining daily limit for a region
     */
    function getRemainingDailyLimit(string calldata region) external view returns (uint256) {
        uint256 limit = regionDailyLimit[region];
        if (limit == 0) return type(uint256).max; // No limit
        uint256 today = block.timestamp / 1 days;
        uint256 spent = regionDailySpend[region][today];
        return spent >= limit ? 0 : limit - spent;
    }

    // ============================
    // Admin Functions
    // ============================

    /**
     * @notice Add an authorized relayer
     */
    function addRelayer(address relayer) external onlyOwner {
        if (relayer == address(0)) revert ZeroAddress();
        if (!authorizedRelayers[relayer]) {
            authorizedRelayers[relayer] = true;
            relayerCount++;
            emit RelayerAdded(relayer);
        }
    }

    /**
     * @notice Remove an authorized relayer
     */
    function removeRelayer(address relayer) external onlyOwner {
        if (authorizedRelayers[relayer]) {
            if (relayerCount <= 1) revert CannotRemoveLastRelayer();
            authorizedRelayers[relayer] = false;
            relayerCount--;
            emit RelayerRemoved(relayer);
        }
    }

    /**
     * @notice Set daily disbursement limit for a region
     * @param region Region code
     * @param limit Daily limit in CFA (0 = unlimited)
     */
    function setDailyLimit(string calldata region, uint256 limit) external onlyOwner {
        regionDailyLimit[region] = limit;
        emit DailyLimitSet(region, limit);
    }

    /**
     * @notice Update payment timeout
     */
    function setTimeout(uint256 newTimeout) external onlyOwner {
        if (newTimeout < MIN_TIMEOUT || newTimeout > MAX_TIMEOUT) revert InvalidTimeout(newTimeout);
        uint256 oldTimeout = paymentTimeout;
        paymentTimeout = newTimeout;
        emit TimeoutUpdated(oldTimeout, newTimeout);
    }

    /**
     * @notice Expire stale pending payments
     * @param paymentIds Array of payment IDs to check and expire (max MAX_BATCH_SIZE)
     */
    function expireStalePayments(bytes32[] calldata paymentIds) external onlyRelayer {
        if (paymentIds.length > MAX_BATCH_SIZE) revert BatchTooLarge(paymentIds.length); // L-09 fix
        for (uint256 i = 0; i < paymentIds.length; i++) {
            Payment storage payment = _payments[paymentIds[i]];
            if (payment.status == PaymentStatus.PENDING &&
                block.timestamp > payment.initiatedAt + paymentTimeout) {
                payment.status = PaymentStatus.EXPIRED;
                pendingPaymentCount--;
                _refundDailySpend(payment);
                emit PaymentExpired(paymentIds[i]);
            }
        }
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ============================
    // Internal Functions
    // ============================

    /**
     * @dev Validate payment input parameters
     * @param beneficiaryHash Hashed beneficiary identity (must be non-zero)
     * @param amount Payment amount in CFA
     * @param phoneHash V-04 fix: keccak256 hash of phone number (must be non-zero)
     * @param region Geographic region code
     */
    function _validatePaymentInputs(
        bytes32 beneficiaryHash,
        uint256 amount,
        bytes32 phoneHash,
        string memory region
    ) internal pure {
        if (beneficiaryHash == bytes32(0)) revert InvalidBeneficiaryHash(); // I-06 fix
        if (amount < MIN_PAYMENT_AMOUNT || amount > MAX_PAYMENT_AMOUNT) revert InvalidAmount(amount);
        if (phoneHash == bytes32(0)) revert EmptyPhone();
        if (bytes(region).length == 0) revert EmptyRegion();
    }

    /**
     * @dev Generate a unique payment ID using nonces for replay protection
     * @param beneficiaryHash Hashed beneficiary identity
     * @param region Geographic region code
     * @return Unique keccak256 payment identifier
     */
    function _generatePaymentId(
        bytes32 beneficiaryHash,
        string memory region
    ) internal returns (bytes32) {
        globalNonce++;
        regionNonces[region]++;
        // M-05 fix: include block.chainid for cross-chain replay protection
        return keccak256(abi.encode(
            beneficiaryHash,
            region,
            globalNonce,
            regionNonces[region],
            block.chainid
        ));
    }

    /**
     * @dev Checks that a payment does not exceed the daily disbursement limit for a region.
     * If no limit is configured (limit == 0), the check is skipped.
     * Reverts with `DailyLimitExceeded` if the cumulative daily spend would exceed the limit.
     * @param region Geographic region code (e.g., "SN-TH")
     * @param amount Payment amount to validate against the remaining daily allowance
     */
    function _checkDailyLimit(string memory region, uint256 amount) internal view {
        uint256 limit = regionDailyLimit[region];
        if (limit == 0) return; // No limit
        uint256 today = block.timestamp / 1 days;
        uint256 spent = regionDailySpend[region][today];
        if (spent + amount > limit) {
            revert DailyLimitExceeded(region, limit, spent + amount);
        }
    }

    /**
     * @dev Reverses the regionDailySpend accounting recorded for a payment on
     * the day it was initiated. Used whenever a payment leaves the PENDING
     * state without being disbursed (FAILED or EXPIRED), so the daily
     * allowance it reserved becomes available again.
     * @param payment The payment whose initiation-day spend should be refunded
     */
    function _refundDailySpend(Payment storage payment) internal {
        uint256 day = payment.initiatedAt / 1 days;
        if (regionDailySpend[payment.region][day] >= payment.amount) {
            regionDailySpend[payment.region][day] -= payment.amount;
        }
    }
}
