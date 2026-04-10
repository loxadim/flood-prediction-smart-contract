// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/**
 * @title IMobileMoneyProvider
 * @dev Interface for Mobile Money payment bridge (off-chain relay pattern)
 * 
 * Architecture:
 * ┌─────────┐  initiate   ┌──────────┐  relay event  ┌──────────┐
 * │ Contract│ ──────────▶ │ On-Chain  │ ────────────▶ │ Off-Chain│
 * │ (Flood  │             │ Provider  │               │ Relayer  │
 * │ Predict)│             │           │               │          │
 * └─────────┘             └──────────┘               └────┬─────┘
 *                                                          │
 *                         ┌──────────┐  API call     ┌────▼─────┐
 *                         │ Confirm  │ ◀──────────── │ Mobile   │
 *                         │ on-chain │               │ Money API│
 *                         └──────────┘               └──────────┘
 */
interface IMobileMoneyProvider {

    enum PaymentStatus { PENDING, CONFIRMED, FAILED, EXPIRED, CANCELLED }
    enum MobileProvider { ORANGE_MONEY, WAVE, FREE_MONEY, EMONEY }

    struct Payment {
        bytes32 paymentId;
        bytes32 beneficiaryHash;
        uint256 amount;
        bytes32 phoneHash;          // V-04 fix: hash instead of plaintext
        string region;
        MobileProvider provider;    // Mobile money provider
        PaymentStatus status;
        uint256 initiatedAt;
        uint256 confirmedAt;
        uint256 retryCount;
        string transactionRef;      // Mobile money transaction reference
    }

    // Payment operations
    function initiatePayment(
        bytes32 beneficiaryHash,
        uint256 amount,
        bytes32 phoneHash,
        string calldata region,
        MobileProvider provider
    ) external returns (bytes32 paymentId);

    function confirmPayment(
        bytes32 paymentId,
        string calldata transactionRef
    ) external;

    function failPayment(
        bytes32 paymentId,
        string calldata reason
    ) external;

    function retryPayment(bytes32 paymentId) external;

    // Batch operations
    function batchInitiatePayments(
        bytes32[] calldata beneficiaryHashes,
        uint256[] calldata amounts,
        bytes32[] calldata phoneHashes,
        string calldata region,
        MobileProvider[] calldata providers
    ) external returns (bytes32[] memory paymentIds);

    function batchConfirmPayments(
        bytes32[] calldata paymentIds,
        string[] calldata transactionRefs
    ) external;

    // View functions
    function getPayment(bytes32 paymentId) external view returns (Payment memory);
    function getPaymentStatus(bytes32 paymentId) external view returns (PaymentStatus);
    function getPendingPaymentCount() external view returns (uint256);
    function getTotalDisbursed() external view returns (uint256);

    // Events
    event PaymentInitiated(bytes32 indexed paymentId, bytes32 beneficiaryHash, uint256 amount, string region, MobileProvider provider);
    event PaymentConfirmed(bytes32 indexed paymentId, string transactionRef, uint256 timestamp);
    event PaymentFailed(bytes32 indexed paymentId, string reason);
    event PaymentRetried(bytes32 indexed paymentId, uint256 retryCount);
    event PaymentExpired(bytes32 indexed paymentId);
    event BatchPaymentInitiated(uint256 count, string region, uint256 totalAmount);
}
