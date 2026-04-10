// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * @title MockBeneficiaryRegistry
 * @dev Mock beneficiary registry for testing the OPAL payment pipeline.
 * Generates deterministic beneficiary hashes, amounts, and phone numbers
 * for integration testing with FloodPredictionContract + MobileMoneyProvider.
 *
 * Usage in tests:
 *   MockBeneficiaryRegistry registry = new MockBeneficiaryRegistry();
 *   registry.registerBeneficiary("BEN-001", 25000, "+221771234567", "SN-TH");
 *   bytes32 hash = registry.getBeneficiaryHash("BEN-001");
 *
 * Merkle tree helpers:
 *   registry.registerBeneficiary("BEN-001", 25000, "+221771234567", "SN-TH");
 *   registry.registerBeneficiary("BEN-002", 30000, "+221761234567", "SN-TH");
 *   bytes32 root = registry.computeMerkleRoot("SN-TH");
 */
contract MockBeneficiaryRegistry {

    // ============================
    // Structs
    // ============================

    struct Beneficiary {
        string externalId;       // Off-chain identifier (e.g. "BEN-001")
        bytes32 identityHash;    // keccak256(externalId) — on-chain hash
        uint256 amount;          // Payment amount in CFA
        string phoneNumber;      // Senegalese phone number
        string region;           // Geographic region (e.g. "SN-TH")
        bool registered;
    }

    // ============================
    // State
    // ============================

    /// @notice externalId => Beneficiary
    mapping(string => Beneficiary) private _beneficiaries;

    /// @notice region => list of externalIds
    mapping(string => string[]) private _regionBeneficiaries;

    /// @notice region => computed Merkle root
    mapping(string => bytes32) public merkleRoots;

    /// @notice Total registered beneficiaries
    uint256 public totalRegistered;

    /// @notice All external IDs for enumeration
    string[] public allIds;

    // ============================
    // Errors
    // ============================
    error BeneficiaryAlreadyRegistered(string externalId);
    error BeneficiaryNotFound(string externalId);
    error EmptyRegion();
    error NoBeneficiariesInRegion(string region);

    // ============================
    // Events
    // ============================
    event BeneficiaryRegistered(string indexed externalId, bytes32 identityHash, uint256 amount, string region);
    event MerkleRootComputed(string indexed region, bytes32 merkleRoot, uint256 beneficiaryCount);
    event BatchRegistered(string indexed region, uint256 count);

    // ============================
    // Registration
    // ============================

    /**
     * @dev Register a single mock beneficiary
     * @param externalId Off-chain identifier (e.g. "BEN-001")
     * @param amount Payment amount in CFA
     * @param phoneNumber Senegalese phone (+221 7X XXXXXXX)
     * @param region Region code (e.g. "SN-TH")
     */
    function registerBeneficiary(
        string calldata externalId,
        uint256 amount,
        string calldata phoneNumber,
        string calldata region
    ) external {
        if (_beneficiaries[externalId].registered) revert BeneficiaryAlreadyRegistered(externalId);
        if (bytes(region).length == 0) revert EmptyRegion();

        bytes32 identityHash = keccak256(abi.encode(externalId));

        _beneficiaries[externalId] = Beneficiary({
            externalId: externalId,
            identityHash: identityHash,
            amount: amount,
            phoneNumber: phoneNumber,
            region: region,
            registered: true
        });

        _regionBeneficiaries[region].push(externalId);
        allIds.push(externalId);
        totalRegistered++;

        emit BeneficiaryRegistered(externalId, identityHash, amount, region);
    }

    /**
     * @dev Batch register mock beneficiaries for a region
     * @param externalIds Array of off-chain identifiers
     * @param amounts Array of amounts
     * @param phoneNumbers Array of phone numbers
     * @param region Region code
     */
    function batchRegisterBeneficiaries(
        string[] calldata externalIds,
        uint256[] calldata amounts,
        string[] calldata phoneNumbers,
        string calldata region
    ) external {
        if (bytes(region).length == 0) revert EmptyRegion();

        for (uint256 i = 0; i < externalIds.length; i++) {
            if (_beneficiaries[externalIds[i]].registered) revert BeneficiaryAlreadyRegistered(externalIds[i]);

            bytes32 identityHash = keccak256(abi.encode(externalIds[i]));

            _beneficiaries[externalIds[i]] = Beneficiary({
                externalId: externalIds[i],
                identityHash: identityHash,
                amount: amounts[i],
                phoneNumber: phoneNumbers[i],
                region: region,
                registered: true
            });

            _regionBeneficiaries[region].push(externalIds[i]);
            allIds.push(externalIds[i]);
            totalRegistered++;
        }

        emit BatchRegistered(region, externalIds.length);
    }

    // ============================
    // Getters
    // ============================

    /**
     * @dev Get the on-chain hash for a beneficiary (used as beneficiaryHash in payment flows)
     */
    function getBeneficiaryHash(string calldata externalId) external view returns (bytes32) {
        if (!_beneficiaries[externalId].registered) revert BeneficiaryNotFound(externalId);
        return _beneficiaries[externalId].identityHash;
    }

    /**
     * @dev Get full beneficiary record
     */
    function getBeneficiary(string calldata externalId) external view returns (Beneficiary memory) {
        if (!_beneficiaries[externalId].registered) revert BeneficiaryNotFound(externalId);
        return _beneficiaries[externalId];
    }

    /**
     * @dev Get number of beneficiaries in a region
     */
    function getRegionBeneficiaryCount(string calldata region) external view returns (uint256) {
        return _regionBeneficiaries[region].length;
    }

    /**
     * @dev Get beneficiary hashes for a region (for batch payment)
     */
    function getRegionBeneficiaryHashes(string calldata region) external view returns (bytes32[] memory) {
        string[] memory ids = _regionBeneficiaries[region];
        bytes32[] memory hashes = new bytes32[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            hashes[i] = _beneficiaries[ids[i]].identityHash;
        }
        return hashes;
    }

    /**
     * @dev Get amounts for a region (for batch payment)
     */
    function getRegionAmounts(string calldata region) external view returns (uint256[] memory) {
        string[] memory ids = _regionBeneficiaries[region];
        uint256[] memory amounts = new uint256[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            amounts[i] = _beneficiaries[ids[i]].amount;
        }
        return amounts;
    }

    /**
     * @dev Get phone numbers for a region (for batch payment)
     */
    function getRegionPhoneNumbers(string calldata region) external view returns (string[] memory) {
        string[] memory ids = _regionBeneficiaries[region];
        string[] memory phones = new string[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            phones[i] = _beneficiaries[ids[i]].phoneNumber;
        }
        return phones;
    }

    // ============================
    // Merkle Tree Helpers
    // ============================

    /**
     * @dev Compute a Merkle leaf for a beneficiary (matches FloodPredictionContract format)
     * leaf = keccak256(abi.encode(beneficiaryHash, amount))
     */
    function computeLeaf(string calldata externalId) external view returns (bytes32) {
        if (!_beneficiaries[externalId].registered) revert BeneficiaryNotFound(externalId);
        Beneficiary memory b = _beneficiaries[externalId];
        return keccak256(abi.encode(b.identityHash, b.amount));
    }

    /**
     * @dev Compute all leaves for a region (for building Merkle tree off-chain)
     */
    function computeRegionLeaves(string calldata region) external view returns (bytes32[] memory) {
        string[] memory ids = _regionBeneficiaries[region];
        if (ids.length == 0) revert NoBeneficiariesInRegion(region);

        bytes32[] memory leaves = new bytes32[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            Beneficiary memory b = _beneficiaries[ids[i]];
            leaves[i] = keccak256(abi.encode(b.identityHash, b.amount));
        }
        return leaves;
    }

    /**
     * @dev Verify a Merkle proof for a beneficiary against a stored root
     */
    function verifyBeneficiary(
        string calldata externalId,
        bytes32 merkleRoot,
        bytes32[] calldata proof
    ) external view returns (bool) {
        if (!_beneficiaries[externalId].registered) revert BeneficiaryNotFound(externalId);
        Beneficiary memory b = _beneficiaries[externalId];
        bytes32 leaf = keccak256(abi.encode(b.identityHash, b.amount));
        return MerkleProof.verify(proof, merkleRoot, leaf);
    }

    // ============================
    // Preset Scenarios
    // ============================

    /**
     * @dev Register a preset scenario: 5 beneficiaries in Thiès (SN-TH)
     * Represents a typical small-scale flood event
     */
    function loadScenarioThies() external {
        _registerPreset("BEN-TH-001", 25000, "+221771000001", "SN-TH");
        _registerPreset("BEN-TH-002", 30000, "+221761000002", "SN-TH");
        _registerPreset("BEN-TH-003", 25000, "+221701000003", "SN-TH");
        _registerPreset("BEN-TH-004", 50000, "+221781000004", "SN-TH");
        _registerPreset("BEN-TH-005", 25000, "+221751000005", "SN-TH");

        emit BatchRegistered("SN-TH", 5);
    }

    /**
     * @dev Register a preset scenario: 5 beneficiaries in Saint-Louis (SN-SL)
     */
    function loadScenarioSaintLouis() external {
        _registerPreset("BEN-SL-001", 35000, "+221771100001", "SN-SL");
        _registerPreset("BEN-SL-002", 40000, "+221761100002", "SN-SL");
        _registerPreset("BEN-SL-003", 25000, "+221701100003", "SN-SL");
        _registerPreset("BEN-SL-004", 45000, "+221781100004", "SN-SL");
        _registerPreset("BEN-SL-005", 30000, "+221751100005", "SN-SL");

        emit BatchRegistered("SN-SL", 5);
    }

    /**
     * @dev Register a preset scenario: 3 beneficiaries in Kaffrine (SN-KA)
     * All Orange Money users (prefix 77/78)
     */
    function loadScenarioKaffrine() external {
        _registerPreset("BEN-KA-001", 20000, "+221771200001", "SN-KA");
        _registerPreset("BEN-KA-002", 20000, "+221781200002", "SN-KA");
        _registerPreset("BEN-KA-003", 20000, "+221771200003", "SN-KA");

        emit BatchRegistered("SN-KA", 3);
    }

    // ============================
    // Internal
    // ============================

    function _registerPreset(
        string memory externalId,
        uint256 amount,
        string memory phoneNumber,
        string memory region
    ) internal {
        if (_beneficiaries[externalId].registered) return; // Skip if already loaded

        bytes32 identityHash = keccak256(abi.encode(externalId));

        _beneficiaries[externalId] = Beneficiary({
            externalId: externalId,
            identityHash: identityHash,
            amount: amount,
            phoneNumber: phoneNumber,
            region: region,
            registered: true
        });

        _regionBeneficiaries[region].push(externalId);
        allIds.push(externalId);
        totalRegistered++;
    }
}
