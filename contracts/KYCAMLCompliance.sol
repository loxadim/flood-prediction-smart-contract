// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "../interfaces/IKYCAMLCompliance.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title KYCAMLCompliance
 * @dev On-chain KYC/AML compliance registry for beneficiaries
 * 
 * Architecture (RGPD-compliant):
 * ┌──────────────────┐     submit docs      ┌──────────────────┐
 * │  Beneficiary     │ ───────────────────▶ │  Off-Chain KYC   │
 * │  (via agent)     │                      │  Verification    │
 * └──────────────────┘                      │  Service         │
 *                                           └────────┬─────────┘
 *                                                    │ approve/reject
 *                                                    ▼
 * ┌──────────────────┐     attestation hash  ┌──────────────────┐
 * │  Smart Contract  │ ◀─────────────────── │  Compliance      │
 * │  (on-chain)      │                      │  Relayer         │
 * │  - No PII stored │                      │                  │
 * │  - Hashes only   │                      │  - Identity hash │
 * │  - Status flags  │                      │  - Document hash │
 * └──────────────────┘                      └──────────────────┘
 * 
 * Conformité Volet 5:
 * - Exigences KYC/AML : Vérification d'identité off-chain, attestation on-chain
 * - Protection des données : Aucune donnée personnelle sur la blockchain (hashes uniquement)
 * - Responsabilité donateurs : Audit trail immutable des vérifications
 * - Détection de fraude : Sanctions screening, suspension, alertes
 */
contract KYCAMLCompliance is IKYCAMLCompliance, Ownable2Step {

    // ============================================
    // State
    // ============================================

    // Attestations by beneficiary hash
    mapping(bytes32 => ComplianceAttestation) public attestations;
    
    // Screening results by beneficiary hash
    mapping(bytes32 => ScreeningResult) public screenings;
    
    // Authorized compliance officers / relayers
    mapping(address => bool) public complianceOfficers;
    uint256 public officerCount;
    
    // Authorized contracts that can query compliance
    mapping(address => bool) public authorizedContracts;
    
    // Fraud detection: count of suspicious activities per beneficiary
    mapping(bytes32 => uint256) public fraudAlertCount;
    
    // C-03 fix: store status before suspension to restore on reinstatement
    mapping(bytes32 => VerificationStatus) public statusBeforeSuspension;
    
    // Statistics
    uint256 public totalAttestations;
    uint256 public approvedCount;
    uint256 public rejectedCount;
    uint256 public suspendedCount;
    
    // Configuration
    uint256 public defaultValidityPeriod = 365 days; // 1 year default KYC validity
    uint256 public maxValidityPeriod = 730 days;     // 2 years max
    uint256 public fraudThreshold = 3;               // Auto-suspend after 3 fraud alerts
    
    // ============================================
    // Errors
    // ============================================
    error NotComplianceOfficer();
    error NotAuthorizedContract();
    error InvalidBeneficiaryHash();
    error AttestationAlreadyExists();
    error AttestationNotFound();
    error AttestationNotPending();
    error InvalidValidityPeriod();
    error BeneficiaryAlreadySuspended();
    error CannotRemoveLastOfficer();
    error BatchTooLarge();
    error InvalidAddress();
    error AlreadyAnOfficer();
    error NotAnOfficer();
    error PeriodTooShort();
    error ExceedsMaxValidity();
    error InvalidThreshold();
    error NotSuspended();
    /// @notice H-04 fix: raised when the approving officer is the same as the submitting officer
    error SelfApprovalNotAllowed();
    
    // ============================================
    // Events (M-06 fix: configuration change tracking)
    // ============================================
    event DefaultValidityUpdated(uint256 oldValidity, uint256 newValidity);
    event FraudThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);
    
    // ============================================
    // Modifiers
    // ============================================
    
    modifier onlyComplianceOfficer() {
        if (!complianceOfficers[msg.sender]) revert NotComplianceOfficer();
        _;
    }
    
    modifier onlyAuthorized() {
        if (!authorizedContracts[msg.sender] && msg.sender != owner()) 
            revert NotAuthorizedContract();
        _;
    }
    
    // ============================================
    // Constructor
    // ============================================
    
    constructor() Ownable(msg.sender) {
        complianceOfficers[msg.sender] = true;
        officerCount = 1;
    }
    
    // ============================================
    // Officer Management
    // ============================================
    
    /**
     * @dev Add a compliance officer/relayer
     * @param officer Address to authorize
     */
    function addComplianceOfficer(address officer) external onlyOwner {
        if (officer == address(0)) revert InvalidAddress();
        if (complianceOfficers[officer]) revert AlreadyAnOfficer();
        complianceOfficers[officer] = true;
        officerCount++;
    }
    
    /**
     * @dev Remove a compliance officer
     * @param officer Address to remove
     */
    function removeComplianceOfficer(address officer) external onlyOwner {
        if (!complianceOfficers[officer]) revert NotAnOfficer();
        if (officerCount <= 1) revert CannotRemoveLastOfficer();
        complianceOfficers[officer] = false;
        officerCount--;
    }
    
    /**
     * @dev Authorize a contract to query compliance
     * @param _contract Contract address to authorize
     */
    function authorizeContract(address _contract) external onlyOwner {
        if (_contract == address(0)) revert InvalidAddress();
        authorizedContracts[_contract] = true;
    }
    
    /**
     * @dev Remove contract authorization
     * @param _contract Contract address to deauthorize
     */
    function deauthorizeContract(address _contract) external onlyOwner {
        authorizedContracts[_contract] = false;
    }
    
    // ============================================
    // KYC Attestation Management
    // ============================================
    
    /**
     * @dev Submit a KYC attestation (called by compliance officer after off-chain verification)
     * @param beneficiaryHash Hash of the beneficiary identity
     * @param identityHash Hash of identity documents (no PII on-chain)
     * @param documentHash Hash of supporting KYC documents
     * @param region Geographic region code (e.g., "SN-TH" for Thiès)
     */
    function submitAttestation(
        bytes32 beneficiaryHash,
        bytes32 identityHash,
        bytes32 documentHash,
        string calldata region
    ) external override onlyComplianceOfficer {
        if (beneficiaryHash == bytes32(0)) revert InvalidBeneficiaryHash();
        
        ComplianceAttestation storage existing = attestations[beneficiaryHash];
        // Allow re-submission if previous was rejected or expired
        if (existing.status == VerificationStatus.VERIFIED ||
            existing.status == VerificationStatus.PENDING) {
            revert AttestationAlreadyExists();
        }
        // A SUSPENDED beneficiary must go through reinstateBeneficiary(), not
        // a fresh attestation that would silently reset their status to PENDING.
        if (existing.status == VerificationStatus.SUSPENDED) {
            revert BeneficiaryAlreadySuspended();
        }
        
        attestations[beneficiaryHash] = ComplianceAttestation({
            identityHash: identityHash,
            documentHash: documentHash,
            status: VerificationStatus.PENDING,
            riskLevel: RiskLevel.LOW,
            verifiedAt: 0,
            expiresAt: 0,
            verifiedBy: address(0),
            submittedBy: msg.sender,   // H-04 fix: record submitter for 4-eyes enforcement
            region: region
        });
        
        totalAttestations++;
        
        emit AttestationSubmitted(beneficiaryHash, identityHash, region);
    }
    
    /**
     * @dev Approve a KYC attestation after successful off-chain verification
     * @param beneficiaryHash Hash of the beneficiary
     * @param riskLevel Assessed AML risk level
     * @param validityPeriod Duration of validity in seconds
     */
    function approveAttestation(
        bytes32 beneficiaryHash,
        RiskLevel riskLevel,
        uint256 validityPeriod
    ) external override onlyComplianceOfficer {
        ComplianceAttestation storage attestation = attestations[beneficiaryHash];
        if (attestation.identityHash == bytes32(0)) revert AttestationNotFound();
        if (attestation.status != VerificationStatus.PENDING) revert AttestationNotPending();

        // H-04 fix: enforce 4-eyes principle — the approver must differ from the submitter.
        if (msg.sender == attestation.submittedBy) revert SelfApprovalNotAllowed();

        if (validityPeriod == 0) validityPeriod = defaultValidityPeriod;
        if (validityPeriod > maxValidityPeriod) revert InvalidValidityPeriod();
        
        // Sanctioned beneficiaries cannot be approved
        if (riskLevel == RiskLevel.SANCTIONED) {
            attestation.status = VerificationStatus.SUSPENDED;
            suspendedCount++;
            emit BeneficiarySuspended(beneficiaryHash, "Sanctioned entity");
            return;
        }
        
        attestation.status = VerificationStatus.VERIFIED;
        attestation.riskLevel = riskLevel;
        attestation.verifiedAt = block.timestamp;
        attestation.expiresAt = block.timestamp + validityPeriod;
        attestation.verifiedBy = msg.sender;
        
        approvedCount++;
        
        emit AttestationApproved(beneficiaryHash, riskLevel, attestation.expiresAt);
    }
    
    /**
     * @dev Reject a KYC attestation
     * @param beneficiaryHash Hash of the beneficiary
     * @param reason Reason for rejection
     */
    function rejectAttestation(
        bytes32 beneficiaryHash,
        string calldata reason
    ) external override onlyComplianceOfficer {
        ComplianceAttestation storage attestation = attestations[beneficiaryHash];
        if (attestation.identityHash == bytes32(0)) revert AttestationNotFound();
        if (attestation.status != VerificationStatus.PENDING) revert AttestationNotPending();
        
        attestation.status = VerificationStatus.REJECTED;
        rejectedCount++;
        
        emit AttestationRejected(beneficiaryHash, reason);
    }
    
    /**
     * @dev Record sanctions screening result (from off-chain screening service)
     * @param beneficiaryHash Hash of the beneficiary
     * @param result Screening result from provider
     */
    function recordScreening(
        bytes32 beneficiaryHash,
        ScreeningResult memory result
    ) external override onlyComplianceOfficer {
        if (beneficiaryHash == bytes32(0)) revert InvalidBeneficiaryHash();
        
        screenings[beneficiaryHash] = result;
        
        emit ScreeningRecorded(beneficiaryHash, result.isCleared, result.screeningProvider);
        
        // Auto-suspend if sanctions match found
        if (!result.isCleared && result.sanctionsChecked) {
            _suspendBeneficiary(beneficiaryHash, "Sanctions match detected");
        }
    }
    
    // ============================================
    // Fraud Detection & Suspension
    // ============================================
    
    /**
     * @dev Suspend a beneficiary (fraud, sanctions, etc.)
     * @param beneficiaryHash Hash of the beneficiary
     * @param reason Reason for suspension
     */
    function suspendBeneficiary(
        bytes32 beneficiaryHash, 
        string calldata reason
    ) external override onlyComplianceOfficer {
        _suspendBeneficiary(beneficiaryHash, reason);
    }
    
    /**
     * @dev Reinstate a previously suspended beneficiary
     * @param beneficiaryHash Hash of the beneficiary
     */
    function reinstateBeneficiary(bytes32 beneficiaryHash) external onlyComplianceOfficer {
        ComplianceAttestation storage attestation = attestations[beneficiaryHash];
        if (attestation.status != VerificationStatus.SUSPENDED) revert NotSuspended();
        
        // C-03 fix: restore the status the beneficiary had before suspension
        VerificationStatus previousStatus = statusBeforeSuspension[beneficiaryHash];
        if (previousStatus == VerificationStatus.VERIFIED) {
            attestation.status = VerificationStatus.VERIFIED;
            attestation.expiresAt = block.timestamp + defaultValidityPeriod;
            approvedCount++;
        } else {
            // Was PENDING or other non-VERIFIED status — restore to PENDING, require re-verification
            attestation.status = VerificationStatus.PENDING;
        }
        suspendedCount--;
        fraudAlertCount[beneficiaryHash] = 0;
        delete statusBeforeSuspension[beneficiaryHash];
        
        emit BeneficiaryReinstated(beneficiaryHash);
    }

    /**
     * @dev Raise a fraud alert for a beneficiary
     * @param beneficiaryHash Hash of the beneficiary
     * @param alertType Type of fraud detected
     */
    function raiseFraudAlert(
        bytes32 beneficiaryHash, 
        string calldata alertType
    ) external onlyComplianceOfficer {
        fraudAlertCount[beneficiaryHash]++;
        
        emit FraudAlertRaised(beneficiaryHash, alertType, block.timestamp);
        
        // Auto-suspend after threshold
        if (fraudAlertCount[beneficiaryHash] >= fraudThreshold) {
            _suspendBeneficiary(beneficiaryHash, "Fraud threshold exceeded");
        }
    }
    
    // ============================================
    // Compliance Checks (called by FloodPrediction contract)
    // ============================================
    
    /**
     * @dev Check if a beneficiary is compliant for receiving payments
     * @param beneficiaryHash Hash of the beneficiary
     * @return bool True if verified + not expired + cleared sanctions
     * H9-KYC fix: restricted to owner and authorized contracts (RGPD — compliance status is sensitive)
     */
    function isCompliant(bytes32 beneficiaryHash) external view override onlyAuthorized returns (bool) {
        return _isCompliant(beneficiaryHash);
    }
    
    /**
     * @dev Get compliance attestation for a beneficiary
     * @param beneficiaryHash Hash of the beneficiary
     * @return ComplianceAttestation Current attestation
     */
    function getAttestation(bytes32 beneficiaryHash) external view override returns (ComplianceAttestation memory) {
        return attestations[beneficiaryHash];
    }
    
    /**
     * @dev Get screening result for a beneficiary
     * @param beneficiaryHash Hash of the beneficiary
     * @return ScreeningResult Latest screening
     */
    function getScreeningResult(bytes32 beneficiaryHash) external view override returns (ScreeningResult memory) {
        return screenings[beneficiaryHash];
    }
    
    /**
     * @dev Batch check compliance for multiple beneficiaries (used before batch payments)
     * @param beneficiaryHashes Array of beneficiary hashes
     * @return results Array of compliance status
     * H9-KYC fix: restricted to owner and authorized contracts (compliance status is sensitive data)
     */
    function batchCheckCompliance(
        bytes32[] calldata beneficiaryHashes
    ) external view override onlyAuthorized returns (bool[] memory results) {
        if (beneficiaryHashes.length > 200) revert BatchTooLarge();
        
        results = new bool[](beneficiaryHashes.length);
        for (uint256 i = 0; i < beneficiaryHashes.length; i++) {
            results[i] = _isCompliant(beneficiaryHashes[i]);
        }
    }
    
    // ============================================
    // Configuration
    // ============================================
    
    /**
     * @dev Update default validity period for KYC attestations
     * @param period New validity period in seconds
     */
    function updateDefaultValidity(uint256 period) external onlyOwner {
        if (period < 30 days) revert PeriodTooShort();
        if (period > maxValidityPeriod) revert ExceedsMaxValidity();
        uint256 oldPeriod = defaultValidityPeriod;
        defaultValidityPeriod = period;
        emit DefaultValidityUpdated(oldPeriod, period);
    }
    
    /**
     * @dev Update fraud alert threshold
     * @param threshold New threshold for auto-suspension
     */
    function updateFraudThreshold(uint256 threshold) external onlyOwner {
        if (threshold < 1 || threshold > 10) revert InvalidThreshold();
        uint256 oldThreshold = fraudThreshold;
        fraudThreshold = threshold;
        emit FraudThresholdUpdated(oldThreshold, threshold);
    }
    
    // ============================================
    // View Functions
    // ============================================
    
    /**
     * @dev Get compliance statistics
     */
    function getComplianceStats() external view returns (
        uint256 total,
        uint256 approved,
        uint256 rejected,
        uint256 suspended,
        uint256 officers
    ) {
        return (totalAttestations, approvedCount, rejectedCount, suspendedCount, officerCount);
    }
    
    /**
     * @dev Check if attestation is expired
     * @param beneficiaryHash Hash of the beneficiary
     * @return bool True if expired
     */
    function isExpired(bytes32 beneficiaryHash) external view returns (bool) {
        ComplianceAttestation memory att = attestations[beneficiaryHash];
        return att.expiresAt > 0 && block.timestamp > att.expiresAt;
    }
    
    // ============================================
    // Internal
    // ============================================
    
    function _suspendBeneficiary(bytes32 beneficiaryHash, string memory reason) internal {
        ComplianceAttestation storage attestation = attestations[beneficiaryHash];
        if (attestation.status == VerificationStatus.SUSPENDED) revert BeneficiaryAlreadySuspended();
        
        // C-03 fix: store the current status before suspension
        statusBeforeSuspension[beneficiaryHash] = attestation.status;
        
        // M-05 fix: only decrement approvedCount when previously VERIFIED
        if (attestation.status == VerificationStatus.VERIFIED) {
            approvedCount--;
        }
        
        attestation.status = VerificationStatus.SUSPENDED;
        suspendedCount++;
        
        emit BeneficiarySuspended(beneficiaryHash, reason);
    }

    /**
     * @dev Internal compliance check used by both isCompliant() and batchCheckCompliance()
     * @param beneficiaryHash Hash of the beneficiary
     * @return bool True if verified + not expired + cleared sanctions
     */
    function _isCompliant(bytes32 beneficiaryHash) internal view returns (bool) {
        ComplianceAttestation memory attestation = attestations[beneficiaryHash];
        
        // Must be VERIFIED status
        if (attestation.status != VerificationStatus.VERIFIED) return false;
        
        // Must not be expired
        if (block.timestamp > attestation.expiresAt) return false;
        
        // Must not be HIGH risk or SANCTIONED
        if (attestation.riskLevel == RiskLevel.HIGH || 
            attestation.riskLevel == RiskLevel.SANCTIONED) return false;
        
        // Check sanctions screening if available
        ScreeningResult memory screening = screenings[beneficiaryHash];
        if (screening.sanctionsChecked && !screening.isCleared) return false;
        
        return true;
    }
}
