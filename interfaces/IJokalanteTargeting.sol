// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/**
 * @title IJokalanteTargeting
 * @dev Interface for beneficiary targeting via Merkle trees
 * Privacy-preserving eligibility verification — no PII on-chain
 */
interface IJokalanteTargeting {

    struct TargetingCriteria {
        string region;
        bytes32 merkleRoot;
        uint256 beneficiaryCount;
        uint256 createdAt;
        uint256 expiresAt;
        bool isActive;
        address createdBy;
    }

    // Merkle tree management
    function updateMerkleRoot(
        string calldata region,
        bytes32 merkleRoot,
        uint256 beneficiaryCount
    ) external;

    // Verification (H-07: leaf = keccak256(abi.encode(beneficiaryHash, amount)))
    function verifyBeneficiary(
        string calldata region,
        bytes32 beneficiaryHash,
        uint256 amount,
        bytes32[] calldata merkleProof
    ) external view returns (bool);

    function markVerified(string calldata region, bytes32 beneficiaryHash) external;

    function verifyBeneficiaryBatch(
        string calldata region,
        bytes32[] calldata beneficiaryHashes,
        uint256[] calldata amounts,
        bytes32[][] calldata merkleProofs
    ) external view returns (bool[] memory);

    // View functions
    function getTargetingCriteria(string calldata region) external view returns (TargetingCriteria memory);
    function getMerkleRoot(string calldata region) external view returns (bytes32);
    function getBeneficiaryCount(string calldata region) external view returns (uint256);
    function isRegionActive(string calldata region) external view returns (bool);

    // Pagination
    function getActiveRegions(uint256 offset, uint256 limit) external view returns (string[] memory);
    function getActiveRegionCount() external view returns (uint256);

    // Events
    event MerkleRootUpdated(string indexed region, bytes32 merkleRoot, uint256 beneficiaryCount);
    event BeneficiaryVerified(string indexed region, bytes32 beneficiaryHash);
    event RegionDeactivated(string indexed region);
    event DefaultExpiryUpdated(uint256 oldDuration, uint256 newDuration);
    event MaxBeneficiariesUpdated(uint256 oldMax, uint256 newMax);
}
