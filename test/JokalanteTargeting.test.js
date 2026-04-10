/**
 * @title JokalanteTargeting Unit Tests
 * @description Tests for MerkleTree-based beneficiary targeting and verification
 */
import { expect } from "chai";
import hre from "hardhat";
import { MerkleTree } from "merkletreejs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const keccak256 = require("keccak256");

const { ethers } = await hre.network.connect();

describe("JokalanteTargeting", function () {
    let targeting;
    let owner, other;

    // Helpers to build Merkle trees (H-07: leaf = keccak256(abi.encode(beneficiaryHash, amount)))
    function buildMerkleTree(beneficiaryHashes, amounts) {
        const leaves = beneficiaryHashes.map((h, i) =>
            ethers.keccak256(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [h, amounts[i]])))
        );
        const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
        return { tree, leaves };
    }

    function getProof(tree, leaf) {
        return tree.getHexProof(leaf);
    }

    beforeEach(async function () {
        [owner, other] = await ethers.getSigners();

        const Targeting = await ethers.getContractFactory("JokalanteTargeting");
        targeting = await Targeting.deploy();
        await targeting.waitForDeployment();
    });

    // =========================================================================
    //                         DEPLOYMENT
    // =========================================================================
    describe("Deployment", function () {
        it("should set correct owner", async function () {
            expect(await targeting.owner()).to.equal(owner.address);
        });

        it("should start with 0 regions", async function () {
            expect(await targeting.totalRegions()).to.equal(0);
            expect(await targeting.activeRegionCount()).to.equal(0);
        });

        it("should have default expiry of 90 days", async function () {
            expect(await targeting.defaultExpiryDuration()).to.equal(90 * 24 * 3600);
        });

        it("should have default max 50000 beneficiaries per region", async function () {
            expect(await targeting.maxBeneficiariesPerRegion()).to.equal(50000);
        });
    });

    // =========================================================================
    //                   MERKLE ROOT MANAGEMENT
    // =========================================================================
    describe("Merkle Root Management", function () {
        const testRoot = ethers.keccak256(ethers.toUtf8Bytes("test-merkle-root"));
        const REGION = "SN-TH";

        it("should update Merkle root", async function () {
            await expect(targeting.updateMerkleRoot(REGION, testRoot, 100))
                .to.emit(targeting, "MerkleRootUpdated")
                .withArgs(REGION, testRoot, 100);

            const criteria = await targeting.getTargetingCriteria(REGION);
            expect(criteria.merkleRoot).to.equal(testRoot);
            expect(criteria.beneficiaryCount).to.equal(100);
            expect(criteria.isActive).to.be.true;
        });

        it("should increment region counts for new region", async function () {
            await targeting.updateMerkleRoot(REGION, testRoot, 100);
            expect(await targeting.totalRegions()).to.equal(1);
            expect(await targeting.activeRegionCount()).to.equal(1);
        });

        it("should update existing region without incrementing count", async function () {
            await targeting.updateMerkleRoot(REGION, testRoot, 100);
            const newRoot = ethers.keccak256(ethers.toUtf8Bytes("new-root"));
            await targeting.updateMerkleRoot(REGION, newRoot, 200);

            expect(await targeting.totalRegions()).to.equal(1);
            const criteria = await targeting.getTargetingCriteria(REGION);
            expect(criteria.merkleRoot).to.equal(newRoot);
            expect(criteria.beneficiaryCount).to.equal(200);
        });

        it("should revert for zero Merkle root", async function () {
            await expect(
                targeting.updateMerkleRoot(REGION, ethers.ZeroHash, 100)
            ).to.be.revertedWithCustomError(targeting, "InvalidMerkleRoot");
        });

        it("should revert for zero beneficiary count", async function () {
            await expect(
                targeting.updateMerkleRoot(REGION, testRoot, 0)
            ).to.be.revertedWithCustomError(targeting, "InvalidBeneficiaryCount");
        });

        it("should revert for count > maxBeneficiariesPerRegion", async function () {
            await expect(
                targeting.updateMerkleRoot(REGION, testRoot, 50001)
            ).to.be.revertedWithCustomError(targeting, "InvalidBeneficiaryCount");
        });

        it("should revert if not owner", async function () {
            await expect(
                targeting.connect(other).updateMerkleRoot(REGION, testRoot, 100)
            ).to.be.revertedWithCustomError(targeting, "OwnableUnauthorizedAccount");
        });
    });

    // =========================================================================
    //                    REGION DEACTIVATION
    // =========================================================================
    describe("Region Deactivation", function () {
        const testRoot = ethers.keccak256(ethers.toUtf8Bytes("deactivation-root"));
        const REGION = "SN-DK";

        beforeEach(async function () {
            await targeting.updateMerkleRoot(REGION, testRoot, 50);
        });

        it("should deactivate a region", async function () {
            await expect(targeting.deactivateRegion(REGION))
                .to.emit(targeting, "RegionDeactivated")
                .withArgs(REGION);

            const criteria = await targeting.getTargetingCriteria(REGION);
            expect(criteria.isActive).to.be.false;
            expect(await targeting.activeRegionCount()).to.equal(0);
        });

        it("should revert deactivating already inactive region", async function () {
            await targeting.deactivateRegion(REGION);
            await expect(
                targeting.deactivateRegion(REGION)
            ).to.be.revertedWithCustomError(targeting, "RegionNotActive");
        });

        it("should revert if not owner", async function () {
            await expect(
                targeting.connect(other).deactivateRegion(REGION)
            ).to.be.revertedWithCustomError(targeting, "OwnableUnauthorizedAccount");
        });
    });

    // =========================================================================
    //                     VERIFICATION
    // =========================================================================
    describe("Beneficiary Verification", function () {
        const REGION = "SN-TH";
        let tree, leaves, beneficiaryHashes, amounts;

        beforeEach(async function () {
            // Create 5 beneficiary hashes
            beneficiaryHashes = [];
            amounts = [];
            for (let i = 0; i < 5; i++) {
                beneficiaryHashes.push(
                    ethers.keccak256(ethers.toUtf8Bytes(`beneficiary-${i}`))
                );
                amounts.push(10000 + i * 1000);
            }

            // Build Merkle tree
            const result = buildMerkleTree(beneficiaryHashes, amounts);
            tree = result.tree;
            leaves = result.leaves;

            const root = "0x" + tree.getRoot().toString("hex");
            await targeting.updateMerkleRoot(REGION, root, 5);
        });

        it("should verify a valid beneficiary", async function () {
            const proof = getProof(tree, leaves[0]);
            const isValid = await targeting.verifyBeneficiary(
                REGION, beneficiaryHashes[0], amounts[0], proof
            );
            expect(isValid).to.be.true;
        });

        it("should reject invalid proof", async function () {
            const fakeHash = ethers.keccak256(ethers.toUtf8Bytes("fake-beneficiary"));
            const proof = getProof(tree, leaves[0]); // Wrong proof for this hash
            const isValid = await targeting.verifyBeneficiary(
                REGION, fakeHash, amounts[0], proof
            );
            expect(isValid).to.be.false;
        });

        it("should revert for inactive region", async function () {
            await targeting.deactivateRegion(REGION);
            const proof = getProof(tree, leaves[0]);
            await expect(
                targeting.verifyBeneficiary(REGION, beneficiaryHashes[0], amounts[0], proof)
            ).to.be.revertedWithCustomError(targeting, "RegionNotActive");
        });

        it("should revert for expired Merkle root", async function () {
            // Advance time past 90 days
            await ethers.provider.send("evm_increaseTime", [91 * 24 * 3600]);
            await ethers.provider.send("evm_mine", []);

            const proof = getProof(tree, leaves[0]);
            await expect(
                targeting.verifyBeneficiary(REGION, beneficiaryHashes[0], amounts[0], proof)
            ).to.be.revertedWithCustomError(targeting, "MerkleRootExpired");
        });
    });

    // =========================================================================
    //                   BATCH VERIFICATION
    // =========================================================================
    describe("Batch Verification", function () {
        const REGION = "SN-TH";
        let tree, leaves, beneficiaryHashes, amounts;

        beforeEach(async function () {
            beneficiaryHashes = [];
            amounts = [];
            for (let i = 0; i < 10; i++) {
                beneficiaryHashes.push(
                    ethers.keccak256(ethers.toUtf8Bytes(`batch-ben-${i}`))
                );
                amounts.push(5000 + i * 500);
            }

            const result = buildMerkleTree(beneficiaryHashes, amounts);
            tree = result.tree;
            leaves = result.leaves;

            const root = "0x" + tree.getRoot().toString("hex");
            await targeting.updateMerkleRoot(REGION, root, 10);
        });

        it("should batch verify multiple beneficiaries", async function () {
            const hashesToVerify = [beneficiaryHashes[0], beneficiaryHashes[1], beneficiaryHashes[2]];
            const amountsToVerify = [amounts[0], amounts[1], amounts[2]];
            const proofs = [
                getProof(tree, leaves[0]),
                getProof(tree, leaves[1]),
                getProof(tree, leaves[2])
            ];

            const results = await targeting.verifyBeneficiaryBatch(
                REGION, hashesToVerify, amountsToVerify, proofs
            );

            expect(results[0]).to.be.true;
            expect(results[1]).to.be.true;
            expect(results[2]).to.be.true;
        });

        it("should revert batch with mismatched arrays", async function () {
            await expect(
                targeting.verifyBeneficiaryBatch(
                    REGION,
                    [beneficiaryHashes[0]],
                    [amounts[0]],
                    [getProof(tree, leaves[0]), getProof(tree, leaves[1])]
                )
            ).to.be.revertedWithCustomError(targeting, "ArrayLengthMismatch");
        });

        it("should revert batch > 50", async function () {
            const hashes = new Array(51).fill(beneficiaryHashes[0]);
            const amts = new Array(51).fill(amounts[0]);
            const proofs = new Array(51).fill(getProof(tree, leaves[0]));

            await expect(
                targeting.verifyBeneficiaryBatch(REGION, hashes, amts, proofs)
            ).to.be.revertedWithCustomError(targeting, "BatchTooLarge");
        });
    });

    // =========================================================================
    //                    MARK VERIFIED
    // =========================================================================
    describe("Mark Verified", function () {
        it("should mark a beneficiary as verified", async function () {
            const hash = ethers.keccak256(ethers.toUtf8Bytes("mark-test"));
            await expect(targeting.markVerified("SN-TH", hash))
                .to.emit(targeting, "BeneficiaryVerified")
                .withArgs("SN-TH", hash);

            expect(await targeting.isAlreadyVerified("SN-TH", hash)).to.be.true;
            expect(await targeting.totalVerifications()).to.equal(1);
        });

        it("should revert if not owner or authorized caller", async function () {
            const hash = ethers.keccak256(ethers.toUtf8Bytes("mark-test"));
            await expect(
                targeting.connect(other).markVerified("SN-TH", hash)
            ).to.be.revertedWithCustomError(targeting, "NotAuthorizedCaller");
        });
    });

    // =========================================================================
    //                     VIEW FUNCTIONS
    // =========================================================================
    describe("View Functions", function () {
        const root = ethers.keccak256(ethers.toUtf8Bytes("view-root"));

        beforeEach(async function () {
            await targeting.updateMerkleRoot("SN-TH", root, 100);
            await targeting.updateMerkleRoot("SN-DK", root, 200);
            await targeting.updateMerkleRoot("SN-SL", root, 300);
        });

        it("should return Merkle root for region", async function () {
            expect(await targeting.getMerkleRoot("SN-TH")).to.equal(root);
        });

        it("should return beneficiary count", async function () {
            expect(await targeting.getBeneficiaryCount("SN-TH")).to.equal(100);
        });

        it("should return isRegionActive", async function () {
            expect(await targeting.isRegionActive("SN-TH")).to.be.true;
        });

        it("should return active regions with pagination", async function () {
            const regions = await targeting.getActiveRegions(0, 10);
            expect(regions.length).to.equal(3);
        });

        it("should handle offset in pagination", async function () {
            const regions = await targeting.getActiveRegions(1, 10);
            expect(regions.length).to.equal(2);
        });

        it("should return active region count", async function () {
            expect(await targeting.getActiveRegionCount()).to.equal(3);
        });
    });

    // =========================================================================
    //                     CONFIGURATION
    // =========================================================================
    describe("Configuration", function () {
        it("should update default expiry duration", async function () {
            await targeting.updateDefaultExpiry(180 * 24 * 3600); // 180 days
            expect(await targeting.defaultExpiryDuration()).to.equal(180 * 24 * 3600);
        });

        it("should revert expiry < 1 day", async function () {
            await expect(targeting.updateDefaultExpiry(3600)).to.revert(ethers);
        });

        it("should revert expiry > 365 days", async function () {
            await expect(targeting.updateDefaultExpiry(366 * 24 * 3600)).to.revert(ethers);
        });

        it("should update max beneficiaries per region", async function () {
            await targeting.updateMaxBeneficiaries(100000);
            expect(await targeting.maxBeneficiariesPerRegion()).to.equal(100000);
        });

        it("should revert max beneficiaries < 100", async function () {
            await expect(targeting.updateMaxBeneficiaries(50)).to.revert(ethers);
        });

        it("should revert max beneficiaries > 100000", async function () {
            await expect(targeting.updateMaxBeneficiaries(100001)).to.revert(ethers);
        });

        it("should revert if not owner", async function () {
            await expect(
                targeting.connect(other).updateDefaultExpiry(180 * 24 * 3600)
            ).to.be.revertedWithCustomError(targeting, "OwnableUnauthorizedAccount");
        });
    });
});
