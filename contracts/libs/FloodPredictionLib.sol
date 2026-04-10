// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/**
 * @title FloodPredictionLib
 * @dev Utility library for the FloodPrediction ecosystem
 * - String conversion utilities
 * - Event ID generation
 * - SMS message generation for mobile money notifications
 * - Hash utilities
 */
library FloodPredictionLib {

    //  custom errors for input validation
    error EmptyRegion();
    error InvalidAmount();

    /**
     * @dev Convert uint256 to string
     * @param value The number to convert
     * @return The string representation
     */
    function uint2str(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }

    /**
     * @dev Generate a unique event ID based on region + timestamp + chainId
     * @param region The geographic region code
     * @param timestamp The event timestamp
     * @param chainId The chain ID for replay protection
     * @param nonce Incrementing nonce for uniqueness
     * @return eventId The generated event ID string
     */
    function generateEventId(
        string memory region,
        uint256 timestamp,
        uint256 chainId,
        uint256 nonce
    ) internal pure returns (string memory) {
        // L-01 audit fix: validate inputs
        if (bytes(region).length == 0) revert EmptyRegion();
        return string(
            abi.encodePacked(
                "FLOOD-",
                region,
                "-",
                uint2str(timestamp),
                "-",
                uint2str(chainId),
                "-",
                uint2str(nonce)
            )
        );
    }

    /**
     * @dev Hash a beneficiary identity for Merkle tree leaf
     * Uses abi.encode (not abi.encodePacked) to prevent hash collisions (H-11 fix)
     * @param phoneHash Hash of the phone number
     * @param region Region code
     * @param amount Eligible amount
     * @return The beneficiary hash (Merkle leaf)
     */
    function hashBeneficiary(
        bytes32 phoneHash,
        string memory region,
        uint256 amount
    ) internal pure returns (bytes32) {
        // L-01 audit fix: validate inputs
        if (phoneHash == bytes32(0)) revert InvalidAmount();
        if (bytes(region).length == 0) revert EmptyRegion();
        return keccak256(abi.encode(phoneHash, region, amount));
    }

    /**
     * @dev Calculate adaptive cooldown period based on risk severity
     * @param riskScore Current risk score (0-100)
     * @param threshold Dynamic risk threshold (V-06 fix)
     * @return cooldown Cooldown period in seconds
     */
    function calculateCooldown(uint256 riskScore, uint256 threshold) internal pure returns (uint256) {
        // V-06 fix: use dynamic threshold instead of hardcoded values
        uint256 criticalThreshold = threshold + 15;
        if (riskScore >= criticalThreshold) return 10 minutes;  // Critical: minimal cooldown
        if (riskScore >= threshold) return 30 minutes;          // High: short cooldown
        return 1 hours;                                          // Normal: standard cooldown
    }

    /**
     * @dev Validate risk score is within valid range
     * @param riskScore The risk score to validate
     * @return bool Whether the score is valid (0-100)
     */
    function isValidRiskScore(uint256 riskScore) internal pure returns (bool) {
        return riskScore <= 100;
    }
}
