// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "../../interfaces/IMobileMoneyProvider.sol";

/**
 * @title MockMobileMoneyProvider
 * @dev Mock implementation of IMobileMoneyProvider for testing
 * Simulates Mobile Money payment lifecycle without actual telco API calls.
 * Supports auto-confirm mode for simplified integration testing.
 *
 * Usage in tests:
 *   MockMobileMoneyProvider mock = new MockMobileMoneyProvider();
 *   mock.setAutoConfirm(true);  // payments auto-confirm on initiation
 *   floodPrediction.setContractAddresses(..., address(mock), ...);
 */
contract MockMobileMoneyProvider is IMobileMoneyProvider {

    // ============================
    // State
    // ============================

    /// @notice Auto-confirm payments on initiation (for simplified testing)
    bool public autoConfirm;

    /// @notice Auto-fail payments on initiation (for failure scenario testing)
    bool public autoFail;

    /// @notice Failure reason when autoFail is enabled
    string public autoFailReason;

    /// @notice Force revert on next call (for error testing)
    bool public forceRevert;

    /// @notice Payment storage
    mapping(bytes32 => Payment) private _payments;

    /// @notice Pending payment count
    uint256 public pendingCount;

    /// @notice Total disbursed amount
    uint256 private _totalDisbursed;

    /// @notice Total initiated payments
    uint256 public totalInitiated;

    /// @notice Total confirmed payments
    uint256 public totalConfirmed;

    /// @notice Total failed payments
    uint256 public totalFailed;

    /// @notice Nonce for unique payment IDs
    uint256 private _nonce;

    /// @notice History of all payment IDs (for test assertions)
    bytes32[] public paymentHistory;

    /// @notice Track batch calls for test assertions
    uint256 public batchCallCount;
    uint256 public lastBatchSize;

    // ============================
    // Errors
    // ============================
    error MockForceRevert();
    error PaymentNotFound(bytes32 paymentId);
    error PaymentNotPending(bytes32 paymentId);
    error MaxRetriesExceeded(bytes32 paymentId);

    // ============================
    // Configuration (test helpers)
    // ============================

    function setAutoConfirm(bool _autoConfirm) external {
        autoConfirm = _autoConfirm;
    }

    function setAutoFail(bool _autoFail, string calldata reason) external {
        autoFail = _autoFail;
        autoFailReason = reason;
    }

    function setForceRevert(bool _forceRevert) external {
        forceRevert = _forceRevert;
    }

    // ============================
    // IMobileMoneyProvider Implementation
    // ============================

    function initiatePayment(
        bytes32 beneficiaryHash,
        uint256 amount,
        bytes32 phoneHash,
        string calldata region,
        MobileProvider provider
    ) external override returns (bytes32 paymentId) {
        if (forceRevert) revert MockForceRevert();

        _nonce++;
        paymentId = keccak256(abi.encode(beneficiaryHash, region, block.chainid, _nonce));

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

        totalInitiated++;
        pendingCount++;
        paymentHistory.push(paymentId);

        emit PaymentInitiated(paymentId, beneficiaryHash, amount, region, provider);

        if (autoConfirm) {
            _payments[paymentId].status = PaymentStatus.CONFIRMED;
            _payments[paymentId].confirmedAt = block.timestamp;
            _payments[paymentId].transactionRef = "MOCK-AUTO-CONFIRM";
            _totalDisbursed += amount;
            totalConfirmed++;
            pendingCount--;
            emit PaymentConfirmed(paymentId, "MOCK-AUTO-CONFIRM", block.timestamp);
        } else if (autoFail) {
            _payments[paymentId].status = PaymentStatus.FAILED;
            totalFailed++;
            pendingCount--;
            emit PaymentFailed(paymentId, autoFailReason);
        }

        return paymentId;
    }

    function confirmPayment(
        bytes32 paymentId,
        string calldata transactionRef
    ) external override {
        if (_payments[paymentId].initiatedAt == 0) revert PaymentNotFound(paymentId);
        if (_payments[paymentId].status != PaymentStatus.PENDING) revert PaymentNotPending(paymentId);

        _payments[paymentId].status = PaymentStatus.CONFIRMED;
        _payments[paymentId].confirmedAt = block.timestamp;
        _payments[paymentId].transactionRef = transactionRef;

        _totalDisbursed += _payments[paymentId].amount;
        totalConfirmed++;
        pendingCount--;

        emit PaymentConfirmed(paymentId, transactionRef, block.timestamp);
    }

    function failPayment(
        bytes32 paymentId,
        string calldata reason
    ) external override {
        if (_payments[paymentId].initiatedAt == 0) revert PaymentNotFound(paymentId);
        if (_payments[paymentId].status != PaymentStatus.PENDING) revert PaymentNotPending(paymentId);

        _payments[paymentId].status = PaymentStatus.FAILED;
        totalFailed++;
        pendingCount--;

        emit PaymentFailed(paymentId, reason);
    }

    function retryPayment(bytes32 paymentId) external override {
        if (_payments[paymentId].initiatedAt == 0) revert PaymentNotFound(paymentId);
        if (_payments[paymentId].retryCount >= 3) revert MaxRetriesExceeded(paymentId);

        _payments[paymentId].status = PaymentStatus.PENDING;
        _payments[paymentId].retryCount++;
        _payments[paymentId].initiatedAt = block.timestamp;
        pendingCount++;

        emit PaymentRetried(paymentId, _payments[paymentId].retryCount);
    }

    function batchInitiatePayments(
        bytes32[] calldata beneficiaryHashes,
        uint256[] calldata amounts,
        bytes32[] calldata phoneHashes,
        string calldata region,
        MobileProvider[] calldata providers
    ) external override returns (bytes32[] memory paymentIds) {
        if (forceRevert) revert MockForceRevert();

        uint256 count = beneficiaryHashes.length;
        paymentIds = new bytes32[](count);
        uint256 totalAmount;

        batchCallCount++;
        lastBatchSize = count;

        for (uint256 i = 0; i < count; i++) {
            _nonce++;
            bytes32 paymentId = keccak256(abi.encode(beneficiaryHashes[i], region, block.chainid, _nonce));

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
            totalAmount += amounts[i];
            paymentHistory.push(paymentId);

            if (autoConfirm) {
                _payments[paymentId].status = PaymentStatus.CONFIRMED;
                _payments[paymentId].confirmedAt = block.timestamp;
                _payments[paymentId].transactionRef = "MOCK-BATCH-CONFIRM";
                _totalDisbursed += amounts[i];
                totalConfirmed++;
            } else if (autoFail) {
                _payments[paymentId].status = PaymentStatus.FAILED;
                totalFailed++;
            } else {
                pendingCount++;
            }
        }

        totalInitiated += count;
        if (autoConfirm || autoFail) {
            // pendingCount not incremented
        }

        emit BatchPaymentInitiated(count, region, totalAmount);
        return paymentIds;
    }

    function batchConfirmPayments(
        bytes32[] calldata paymentIds,
        string[] calldata transactionRefs
    ) external override {
        for (uint256 i = 0; i < paymentIds.length; i++) {
            if (_payments[paymentIds[i]].status == PaymentStatus.PENDING) {
                _payments[paymentIds[i]].status = PaymentStatus.CONFIRMED;
                _payments[paymentIds[i]].confirmedAt = block.timestamp;
                _payments[paymentIds[i]].transactionRef = transactionRefs[i];
                _totalDisbursed += _payments[paymentIds[i]].amount;
                totalConfirmed++;
                pendingCount--;
                emit PaymentConfirmed(paymentIds[i], transactionRefs[i], block.timestamp);
            }
        }
    }

    // ============================
    // View Functions
    // ============================

    function getPayment(bytes32 paymentId) external view override returns (Payment memory) {
        if (_payments[paymentId].initiatedAt == 0) revert PaymentNotFound(paymentId);
        return _payments[paymentId];
    }

    function getPaymentStatus(bytes32 paymentId) external view override returns (PaymentStatus) {
        if (_payments[paymentId].initiatedAt == 0) revert PaymentNotFound(paymentId);
        return _payments[paymentId].status;
    }

    function getPendingPaymentCount() external view override returns (uint256) {
        return pendingCount;
    }

    function getTotalDisbursed() external view override returns (uint256) {
        return _totalDisbursed;
    }

    // ============================
    // Test Helpers
    // ============================

    /// @notice Get the total number of payments ever initiated
    function getPaymentHistoryLength() external view returns (uint256) {
        return paymentHistory.length;
    }

    /// @notice Simulate a payment expiry
    function simulateExpiry(bytes32 paymentId) external {
        if (_payments[paymentId].status == PaymentStatus.PENDING) {
            _payments[paymentId].status = PaymentStatus.EXPIRED;
            pendingCount--;
            emit PaymentExpired(paymentId);
        }
    }
}
