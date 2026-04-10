// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/**
 * @title IKYCAMLCompliance
 * @dev Interface for KYC/AML compliance verification
 * 
 * Architecture:
 * - Off-chain KYC verification (document check, identity verification)
 * - On-chain attestation hash for proof of compliance
 * - Sanctions list screening via off-chain relayer
 * - GDPR-compliant: no personal data stored on-chain
 * 
 * Conformité:
 * - Exigences KYC/AML (Volet 5 — Étendue des travaux)
 * - Règles de protection des données (RGPD/NDPD)
 * - Normes de responsabilité des donateurs
 */
interface IKYCAMLCompliance {

    // ============================================
    // Enums
    // ============================================

    enum VerificationStatus {
        NOT_VERIFIED,       // No KYC submitted
        PENDING,            // KYC documents submitted, awaiting review
        VERIFIED,           // KYC approved
        REJECTED,           // KYC rejected
        EXPIRED,            // KYC verification expired
        SUSPENDED           // Account suspended (sanctions/fraud)
    }

    enum RiskLevel {
        LOW,                // Standard beneficiary
        MEDIUM,             // Enhanced due diligence required
        HIGH,               // Blocked pending review
        SANCTIONED          // On sanctions list — blocked
    }

    // ============================================
    // Structs
    // ============================================

    struct ComplianceAttestation {
        bytes32 identityHash;           // keccak256(name, DOB, national ID) — no PII on-chain
        bytes32 documentHash;           // Hash of KYC documents
        VerificationStatus status;      // Current verification status
        RiskLevel riskLevel;            // AML risk assessment
        uint256 verifiedAt;             // Timestamp of verification
        uint256 expiresAt;              // Expiration timestamp
        address verifiedBy;             // Address of the compliance officer who approved
        /// @notice H-04 fix: officer who submitted the attestation.
        /// approveAttestation enforces that verifiedBy != submittedBy (4-eyes principle).
        address submittedBy;
        string region;                  // Geographic region (e.g., "SN-TH" for Thiès, Sénégal)
    }

    struct ScreeningResult {
        bool isCleared;                 // True if not on any sanctions list
        bool sanctionsChecked;          // True if sanctions screening was performed
        bool pepChecked;                // True if PEP (Politically Exposed Person) check done
        uint256 screenedAt;             // Timestamp of last screening
        string screeningProvider;       // Name of screening service used
    }

    // ============================================
    // Functions
    // ============================================

    function submitAttestation(
        bytes32 beneficiaryHash,
        bytes32 identityHash,
        bytes32 documentHash,
        string calldata region
    ) external;

    function approveAttestation(
        bytes32 beneficiaryHash,
        RiskLevel riskLevel,
        uint256 validityPeriod
    ) external;

    function rejectAttestation(
        bytes32 beneficiaryHash,
        string calldata reason
    ) external;

    function recordScreening(
        bytes32 beneficiaryHash,
        ScreeningResult memory result
    ) external;

    function isCompliant(bytes32 beneficiaryHash) external view returns (bool);

    function getAttestation(bytes32 beneficiaryHash) external view returns (ComplianceAttestation memory);

    function getScreeningResult(bytes32 beneficiaryHash) external view returns (ScreeningResult memory);

    function suspendBeneficiary(bytes32 beneficiaryHash, string calldata reason) external;

    function batchCheckCompliance(bytes32[] calldata beneficiaryHashes) external view returns (bool[] memory results);

    // ============================================
    // Events
    // ============================================

    event AttestationSubmitted(bytes32 indexed beneficiaryHash, bytes32 identityHash, string region);
    event AttestationApproved(bytes32 indexed beneficiaryHash, RiskLevel riskLevel, uint256 expiresAt);
    event AttestationRejected(bytes32 indexed beneficiaryHash, string reason);
    event AttestationExpired(bytes32 indexed beneficiaryHash);
    event BeneficiarySuspended(bytes32 indexed beneficiaryHash, string reason);
    event BeneficiaryReinstated(bytes32 indexed beneficiaryHash);
    event ScreeningRecorded(bytes32 indexed beneficiaryHash, bool isCleared, string provider);
    event FraudAlertRaised(bytes32 indexed beneficiaryHash, string alertType, uint256 timestamp);
}
