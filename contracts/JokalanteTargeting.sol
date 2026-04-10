// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "../interfaces/IJokalanteTargeting.sol";

/**
 * @title JokalanteTargeting
 * @author DPA Foundation
 * @notice Beneficiary targeting via Merkle trees — privacy-preserving eligibility verification
 * 
 * @dev Uses Merkle trees to verify beneficiary eligibility without storing personal data on-chain.
 * The Merkle root is generated off-chain from the beneficiary list and stored on-chain.
 * Verification is done by providing a Merkle proof for a specific beneficiary hash.
 * 
 * Security fixes applied:
 * - H-11: Uses abi.encode (not abi.encodePacked) to prevent hash collisions
 * - M-07: Pagination for region listing
 * - H-09: O(1) lookup for beneficiary verification
 * 
 * Conformité Volet 3: Conception de contrats intelligents
 */
contract JokalanteTargeting is IJokalanteTargeting, Ownable2Step {

    // ============================================
    // State
    // ============================================

    // Region => targeting criteria
    mapping(string => TargetingCriteria) internal _criteria;
    
    // Track all regions for enumeration
    string[] internal _regionList;
    mapping(string => bool) internal _regionExists;
    mapping(string => uint256) internal _regionIndex;
    
    // Beneficiary tracking: region => beneficiaryHash => verified
    mapping(string => mapping(bytes32 => bool)) internal _verified;
    
    // Authorized callers (L-06 fix: allow FloodPrediction contract to call markVerified)
    mapping(address => bool) public authorizedCallers;
    
    // Stats
    uint256 public totalRegions;
    uint256 public activeRegionCount;
    uint256 public totalVerifications;
    
    // Configuration
    uint256 public constant MAX_BATCH_SIZE = 50;
    uint256 public defaultExpiryDuration = 90 days;
    uint256 public maxBeneficiariesPerRegion = 50000;

    // ============================================
    // Errors
    // ============================================
    error InvalidMerkleRoot();
    error InvalidBeneficiaryCount();
    error RegionNotActive();
    error MerkleRootExpired();
    error InvalidProof();
    error BatchTooLarge();
    error ArrayLengthMismatch();
    error InvalidExpiryDuration();
    error InvalidMaxBeneficiaries();
    error NotAuthorizedCaller();
    error InvalidAddress();

    // ============================================
    // Constructor
    // ============================================
    constructor() Ownable(msg.sender) {}

    // ============================================
    // Merkle Tree Management
    // ============================================

    /**
     * @dev Update the Merkle root for a region's beneficiary list
     * @param region Geographic region code (e.g., "SN-TH" for Thiès)
     * @param merkleRoot New Merkle root of the beneficiary list
     * @param beneficiaryCount Number of beneficiaries in the list
     */
    function updateMerkleRoot(
        string calldata region,
        bytes32 merkleRoot,
        uint256 beneficiaryCount
    ) external override onlyOwner {
        if (merkleRoot == bytes32(0)) revert InvalidMerkleRoot();
        if (beneficiaryCount == 0 || beneficiaryCount > maxBeneficiariesPerRegion) 
            revert InvalidBeneficiaryCount();

        bool isNew = !_regionExists[region];
        // M-JOKA fix: read isActive BEFORE overwriting _criteria[region]
        bool wasActive = _criteria[region].isActive;

        _criteria[region] = TargetingCriteria({
            region: region,
            merkleRoot: merkleRoot,
            beneficiaryCount: beneficiaryCount,
            createdAt: block.timestamp,
            expiresAt: block.timestamp + defaultExpiryDuration,
            isActive: true,
            createdBy: msg.sender
        });

        if (isNew) {
            _regionExists[region] = true;
            _regionIndex[region] = _regionList.length;
            _regionList.push(region);
            totalRegions++;
            activeRegionCount++;
        } else if (!wasActive) {
            // Region existed but was deactivated — reactivating it
            activeRegionCount++;
        }

        emit MerkleRootUpdated(region, merkleRoot, beneficiaryCount);
    }

    /**
     * @dev Deactivate a region's targeting criteria
     * @param region Region to deactivate
     */
    function deactivateRegion(string calldata region) external onlyOwner {
        if (!_criteria[region].isActive) revert RegionNotActive();
        _criteria[region].isActive = false;
        activeRegionCount--;
        emit RegionDeactivated(region);
    }

    // ============================================
    // Verification
    // ============================================

    /**
     * @dev Verify a beneficiary is in the Merkle tree for a region
     * Uses abi.encode (H-11 fix) to prevent hash collision attacks
     * @param region Geographic region
     * @param beneficiaryHash Hash of the beneficiary data
     * @param merkleProof Merkle proof for the leaf
     * @return isValid Whether the proof is valid
     */
    function verifyBeneficiary(
        string calldata region,
        bytes32 beneficiaryHash,
        uint256 amount,
        bytes32[] calldata merkleProof
    ) external view override returns (bool) {
        TargetingCriteria memory criteria = _criteria[region];
        if (!criteria.isActive) revert RegionNotActive();
        if (block.timestamp > criteria.expiresAt) revert MerkleRootExpired();

        // H-07 fix: leaf includes (beneficiaryHash, amount) — unified with FloodPredictionContract
        // V-01 fix: double-hash to prevent second-preimage attacks (OpenZeppelin standard)
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(beneficiaryHash, amount))));
        return MerkleProof.verify(merkleProof, criteria.merkleRoot, leaf);
    }

    /**
     * @dev Batch verify multiple beneficiaries (M-07 pagination support)
     * @param region Geographic region
     * @param beneficiaryHashes Array of beneficiary hashes
     * @param merkleProofs Array of Merkle proofs
     * @return results Array of verification results
     */
    function verifyBeneficiaryBatch(
        string calldata region,
        bytes32[] calldata beneficiaryHashes,
        uint256[] calldata amounts,
        bytes32[][] calldata merkleProofs
    ) external view override returns (bool[] memory results) {
        if (beneficiaryHashes.length != merkleProofs.length) revert ArrayLengthMismatch();
        if (beneficiaryHashes.length != amounts.length) revert ArrayLengthMismatch();
        if (beneficiaryHashes.length > MAX_BATCH_SIZE) revert BatchTooLarge();

        TargetingCriteria memory criteria = _criteria[region];
        if (!criteria.isActive) revert RegionNotActive();
        if (block.timestamp > criteria.expiresAt) revert MerkleRootExpired();

        results = new bool[](beneficiaryHashes.length);
        for (uint256 i = 0; i < beneficiaryHashes.length; i++) {
            // H-07 fix: leaf includes (beneficiaryHash, amount)
            // V-01 fix: double-hash to prevent second-preimage attacks
            bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(beneficiaryHashes[i], amounts[i]))));
            results[i] = MerkleProof.verify(merkleProofs[i], criteria.merkleRoot, leaf);
        }
    }

    /**
     * @dev Record a beneficiary as verified (called after payment processed)
     * @param region Geographic region
     * @param beneficiaryHash Hash of the beneficiary
     */
    function markVerified(string calldata region, bytes32 beneficiaryHash) external {
        if (msg.sender != owner() && !authorizedCallers[msg.sender]) revert NotAuthorizedCaller();
        _verified[region][beneficiaryHash] = true;
        totalVerifications++;
        emit BeneficiaryVerified(region, beneficiaryHash);
    }

    /**
     * @dev Add an authorized caller (e.g., FloodPredictionContract)
     * @param caller Address to authorize
     */
    function addAuthorizedCaller(address caller) external onlyOwner {
        if (caller == address(0)) revert InvalidAddress();
        authorizedCallers[caller] = true;
    }

    /**
     * @dev Remove an authorized caller
     * @param caller Address to remove
     */
    function removeAuthorizedCaller(address caller) external onlyOwner {
        authorizedCallers[caller] = false;
    }

    /**
     * @dev Check if a beneficiary has been verified/paid
     * @param region Geographic region
     * @param beneficiaryHash Hash of the beneficiary
     * @return Whether already verified
     */
    function isAlreadyVerified(string calldata region, bytes32 beneficiaryHash) external view returns (bool) {
        return _verified[region][beneficiaryHash];
    }

    // ============================================
    // View Functions
    // ============================================

    /**
     * @dev Get targeting criteria for a region
     */
    function getTargetingCriteria(string calldata region) external view override returns (TargetingCriteria memory) {
        return _criteria[region];
    }

    /**
     * @dev Get Merkle root for a region
     */
    function getMerkleRoot(string calldata region) external view override returns (bytes32) {
        return _criteria[region].merkleRoot;
    }

    /**
     * @dev Get beneficiary count for a region
     */
    function getBeneficiaryCount(string calldata region) external view override returns (uint256) {
        return _criteria[region].beneficiaryCount;
    }

    /**
     * @dev Check if a region is active
     */
    function isRegionActive(string calldata region) external view override returns (bool) {
        return _criteria[region].isActive && block.timestamp <= _criteria[region].expiresAt;
    }

    /**
     * @dev Get active regions with pagination (M-07)
     * @param offset Start index
     * @param limit Max number to return
     * @return regions Array of active region names
     */
    function getActiveRegions(uint256 offset, uint256 limit) external view override returns (string[] memory) {
        if (offset >= _regionList.length) return new string[](0);
        
        uint256 remaining = _regionList.length - offset;
        uint256 count = limit < remaining ? limit : remaining;
        
        // First pass: count active regions in range
        uint256 activeCount = 0;
        for (uint256 i = offset; i < offset + count && i < _regionList.length; i++) {
            if (_criteria[_regionList[i]].isActive) activeCount++;
        }
        
        // Second pass: collect active regions
        string[] memory regions = new string[](activeCount);
        uint256 idx = 0;
        for (uint256 i = offset; i < offset + count && i < _regionList.length; i++) {
            if (_criteria[_regionList[i]].isActive) {
                regions[idx++] = _regionList[i];
            }
        }
        
        return regions;
    }

    /**
     * @dev Get total active region count
     */
    function getActiveRegionCount() external view override returns (uint256) {
        return activeRegionCount;
    }

    // ============================================
    // Configuration
    // ============================================

    /**
     * @dev Update default expiry duration for Merkle roots
     * @param duration New duration in seconds
     */
    function updateDefaultExpiry(uint256 duration) external onlyOwner {
        if (duration < 1 days || duration > 365 days) revert InvalidExpiryDuration();
        uint256 old = defaultExpiryDuration;
        defaultExpiryDuration = duration;
        emit DefaultExpiryUpdated(old, duration);
    }

    /**
     * @dev Update max beneficiaries per region
     * @param maxCount New maximum
     */
    function updateMaxBeneficiaries(uint256 maxCount) external onlyOwner {
        if (maxCount < 100 || maxCount > 100000) revert InvalidMaxBeneficiaries();
        uint256 old = maxBeneficiariesPerRegion;
        maxBeneficiariesPerRegion = maxCount;
        emit MaxBeneficiariesUpdated(old, maxCount);
    }
}
