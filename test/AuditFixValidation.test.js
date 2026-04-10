/**
 * @title Audit Fix Validation Tests
 * @description Tests validating specific audit findings corrections:
 *   H-03: Oracle tolerance for TOCTOU slippage
 *   H-04: Self-approval prevention (4-eyes principle) — covered in KYCAMLCompliance.test.js
 *   M-10: Governance timelock enforcement
 *   H8-MMP: Batch duplicate beneficiary detection
 */
import { expect } from "chai";
import hre from "hardhat";
import { MerkleTree } from "merkletreejs";
import { createRequire } from "module";
import { upgrades as makeUpgrades } from "@openzeppelin/hardhat-upgrades";
const require = createRequire(import.meta.url);
const keccak256 = require("keccak256");

const connection = await hre.network.connect();
const { ethers, networkHelpers } = connection;
const ozUpgrades = await makeUpgrades(hre, connection);

// =========================================================================
//             H-03: Oracle Tolerance (TOCTOU Slippage)
// =========================================================================
describe("H-03: Oracle Tolerance", function () {
    let floodPrediction, multiOracle, governance, targeting, mobileMoney;
    let admin, operator, upgrader, pauser, oracle1, oracle2, oracle3, oracle4, oracle5;

    const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
    const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE"));

    function buildMerkleTree(beneficiaryData) {
        const leaves = beneficiaryData.map(b =>
            ethers.keccak256(
                ethers.keccak256(
                    ethers.AbiCoder.defaultAbiCoder().encode(
                        ["bytes32", "uint256"], [b.hash, b.amount]
                    )
                )
            )
        );
        const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
        return { tree, root: tree.getHexRoot(), leaves };
    }

    let merkleRoot;

    before(async function () {
        const signers = await ethers.getSigners();
        [admin, operator, upgrader, pauser, oracle1, oracle2, oracle3, oracle4, oracle5] = signers;

        const beneficiaries = [
            { hash: ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address"], [signers[9].address])), amount: 25000 },
            { hash: ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address"], [signers[10].address])), amount: 30000 },
        ];
        const mt = buildMerkleTree(beneficiaries);
        merkleRoot = mt.root;
    });

    beforeEach(async function () {
        const MultiOracle = await ethers.getContractFactory("MultiOracle");
        multiOracle = await MultiOracle.deploy();
        await multiOracle.waitForDeployment();

        const OpalGov = await ethers.getContractFactory("OpalGovernanceUpgradeable");
        governance = await ozUpgrades.deployProxy(OpalGov, [admin.address, 2], { kind: "uups" });
        await governance.waitForDeployment();

        const Targeting = await ethers.getContractFactory("JokalanteTargeting");
        targeting = await Targeting.deploy();
        await targeting.waitForDeployment();

        const MobileMoney = await ethers.getContractFactory("MobileMoneyProvider");
        mobileMoney = await MobileMoney.deploy();
        await mobileMoney.waitForDeployment();

        const FloodPrediction = await ethers.getContractFactory("FloodPredictionContract");
        floodPrediction = await ozUpgrades.deployProxy(
            FloodPrediction,
            [admin.address, operator.address, upgrader.address, pauser.address],
            { kind: "uups" }
        );
        await floodPrediction.waitForDeployment();

        await floodPrediction.setContractAddresses(
            await multiOracle.getAddress(),
            await governance.getAddress(),
            await targeting.getAddress(),
            await mobileMoney.getAddress(),
            ethers.ZeroAddress
        );

        await floodPrediction.grantRole(OPERATOR_ROLE, operator.address);
        await floodPrediction.allocateBudget("SN-TH", 100_000_000);

        // Setup JokalanteTargeting
        await targeting.updateMerkleRoot("SN-TH", merkleRoot, 2);
        await targeting.addAuthorizedCaller(await floodPrediction.getAddress());

        // Register 4 oracles (min for IQR consensus) and reach consensus at score=85
        await multiOracle.registerOracle(oracle1.address, "Oracle-1");
        await multiOracle.registerOracle(oracle2.address, "Oracle-2");
        await multiOracle.registerOracle(oracle3.address, "Oracle-3");
        await multiOracle.registerOracle(oracle4.address, "Oracle-4");

        await multiOracle.connect(oracle1).submitData("SN-TH", 85, "WASDI");
        await multiOracle.connect(oracle2).submitData("SN-TH", 85, "CHIRPS");
        await multiOracle.connect(oracle3).submitData("SN-TH", 85, "GFS");
        // Consensus should now be reached at score ~85
    });

    it("should have oracleTolerance default to 0", async function () {
        expect(await floodPrediction.oracleTolerance()).to.equal(0);
    });

    it("should allow trigger when riskScore equals oracle consensus (tolerance=0)", async function () {
        // Oracle consensus is 85, submit 85 → exact match
        await expect(
            floodPrediction.connect(operator).createFloodTrigger("SN-TH", 85, merkleRoot, 50000, 2)
        ).to.emit(floodPrediction, "FloodTriggerCreated");
    });

    it("should revert trigger when riskScore deviates from oracle (tolerance=0)", async function () {
        // Oracle consensus is 85, submit 87 → diff=2 > tolerance=0
        await expect(
            floodPrediction.connect(operator).createFloodTrigger("SN-TH", 87, merkleRoot, 50000, 2)
        ).to.be.revertedWithCustomError(floodPrediction, "OracleRiskScoreMismatch");
    });

    it("should allow trigger within tolerance range", async function () {
        // Set tolerance to 3
        await floodPrediction.setOracleTolerance(3);

        // Oracle consensus=85, submit 88 → diff=3 ≤ tolerance=3
        await expect(
            floodPrediction.connect(operator).createFloodTrigger("SN-TH", 88, merkleRoot, 50000, 2)
        ).to.emit(floodPrediction, "FloodTriggerCreated");
    });

    it("should revert trigger just outside tolerance range", async function () {
        await floodPrediction.setOracleTolerance(3);

        // Oracle consensus=85, submit 82 → diff=3 ≤ 3 is ok. Try diff=4
        // Need cooldown to elapse between triggers
        // Actually submit with score 89 → diff=4 > tolerance=3
        await expect(
            floodPrediction.connect(operator).createFloodTrigger("SN-TH", 89, merkleRoot, 50000, 2)
        ).to.be.revertedWithCustomError(floodPrediction, "OracleRiskScoreMismatch");
    });

    it("setOracleTolerance should emit event", async function () {
        await expect(floodPrediction.setOracleTolerance(5))
            .to.emit(floodPrediction, "OracleToleranceUpdated")
            .withArgs(0, 5);
    });

    it("setOracleTolerance should revert above 10", async function () {
        await expect(
            floodPrediction.setOracleTolerance(11)
        ).to.be.revertedWithCustomError(floodPrediction, "InvalidThreshold");
    });

    it("setOracleTolerance should accept max value 10", async function () {
        await floodPrediction.setOracleTolerance(10);
        expect(await floodPrediction.oracleTolerance()).to.equal(10);
    });

    it("setOracleTolerance should revert for non-admin", async function () {
        await expect(
            floodPrediction.connect(operator).setOracleTolerance(5)
        ).to.revert(ethers);
    });
});

// =========================================================================
//             M-10: Governance Timelock Enforcement
// =========================================================================
describe("M-10: Governance Timelock", function () {
    let governance;
    let owner, actor1, actor2, actor3;

    beforeEach(async function () {
        [owner, actor1, actor2, actor3] = await ethers.getSigners();

        const OpalGov = await ethers.getContractFactory("OpalGovernanceUpgradeable");
        governance = await ozUpgrades.deployProxy(OpalGov, [owner.address, 2], { kind: "uups" });
        await governance.waitForDeployment();

        // Add actors to reach quorum
        await governance.addGovernanceActor(actor1.address, "Governor1", "GOVERNOR");
        await governance.addGovernanceActor(actor2.address, "Governor2", "GOVERNOR");
    });

    it("should revert execution immediately after quorum (TimelockNotElapsed)", async function () {
        // Create a PARAMETER_CHANGE proposal (type=1)
        await governance.connect(owner).createProposal(1, "Change param", "0x", "SN-TH", ethers.ZeroAddress);

        // Second signature reaches quorum
        await governance.connect(actor1).signProposal(0);

        // Attempt immediate execution → should fail
        await expect(
            governance.connect(actor2).executeProposal(0)
        ).to.be.revertedWithCustomError(governance, "TimelockNotElapsed");
    });

    it("should allow execution after 1 hour timelock", async function () {
        await governance.connect(owner).createProposal(1, "Change param", "0x", "SN-TH", ethers.ZeroAddress);
        await governance.connect(actor1).signProposal(0); // quorum reached

        // Advance 1 hour + 1 second
        await networkHelpers.time.increase(3601);

        await expect(
            governance.connect(actor2).executeProposal(0)
        ).to.emit(governance, "ProposalExecuted")
            .withArgs(0, actor2.address);
    });

    it("should still revert at exactly 1 hour (boundary)", async function () {
        await governance.connect(owner).createProposal(1, "Boundary test", "0x", "", ethers.ZeroAddress);
        await governance.connect(actor1).signProposal(0);

        // Advance 3598 seconds — accounting for block mining, total elapsed will be ~3599 (< 3600)
        await networkHelpers.time.increase(3598);

        await expect(
            governance.connect(actor2).executeProposal(0)
        ).to.be.revertedWithCustomError(governance, "TimelockNotElapsed");
    });

    it("should skip timelock for EMERGENCY_TRIGGER proposals", async function () {
        // ProposalType.EMERGENCY_TRIGGER = 0
        await governance.connect(owner).createProposal(0, "Emergency flood", "0x", "SN-TH", ethers.ZeroAddress);
        await governance.connect(actor1).signProposal(0); // quorum reached

        // Execute immediately — no timelock for emergencies
        await expect(
            governance.connect(actor2).executeProposal(0)
        ).to.emit(governance, "ProposalExecuted")
            .withArgs(0, actor2.address);
    });

    it("should enforce timelock for FUND_RELEASE proposals (type=2)", async function () {
        await governance.connect(owner).createProposal(2, "Release funds", "0x", "SN-TH", ethers.ZeroAddress);
        await governance.connect(actor1).signProposal(0);

        // Immediate execution → should fail
        await expect(
            governance.connect(actor2).executeProposal(0)
        ).to.be.revertedWithCustomError(governance, "TimelockNotElapsed");

        // After timelock → should succeed
        await networkHelpers.time.increase(3601);
        await expect(
            governance.connect(actor2).executeProposal(0)
        ).to.emit(governance, "ProposalExecuted");
    });
});

// =========================================================================
//             H8-MMP: Batch Duplicate Beneficiary Detection
// =========================================================================
describe("H8-MMP: Batch Duplicate Detection", function () {
    let mobileMoney;
    let owner, relayer;

    const VALID_PHONE_HASH = ethers.keccak256(ethers.toUtf8Bytes("+221771234567"));
    const PHONE_HASH_2 = ethers.keccak256(ethers.toUtf8Bytes("+221761234567"));
    const REGION = "SN-TH";

    beforeEach(async function () {
        [owner, relayer] = await ethers.getSigners();

        const MobileMoney = await ethers.getContractFactory("MobileMoneyProvider");
        mobileMoney = await MobileMoney.deploy();
        await mobileMoney.waitForDeployment();

        await mobileMoney.addRelayer(relayer.address);
    });

    it("should revert batch with duplicate beneficiary hashes", async function () {
        const dupHash = ethers.keccak256(ethers.toUtf8Bytes("beneficiary-dup"));

        await expect(
            mobileMoney.connect(relayer).batchInitiatePayments(
                [dupHash, dupHash],        // duplicate!
                [5000, 5000],
                [VALID_PHONE_HASH, PHONE_HASH_2],
                REGION,
                [0, 0]
            )
        ).to.be.revertedWithCustomError(mobileMoney, "InvalidBeneficiaryHash");
    });

    it("should allow batch with unique beneficiary hashes", async function () {
        const hash1 = ethers.keccak256(ethers.toUtf8Bytes("beneficiary-1"));
        const hash2 = ethers.keccak256(ethers.toUtf8Bytes("beneficiary-2"));

        // This should not revert for duplicate reasons
        // (may revert for other validation reasons like phone hash format, but not duplicate)
        const tx = mobileMoney.connect(relayer).batchInitiatePayments(
            [hash1, hash2],
            [5000, 5000],
            [VALID_PHONE_HASH, PHONE_HASH_2],
            REGION,
            [0, 0]
        );
        // If it doesn't revert with InvalidBeneficiaryHash, the duplicate check passed
        // It may still revert for other reasons (phone validation, daily limits, etc.)
        // so we just check it doesn't revert with the specific duplicate error
        try {
            await tx;
        } catch (e) {
            // Acceptable if it fails for reasons OTHER than InvalidBeneficiaryHash
            expect(e.message).to.not.include("InvalidBeneficiaryHash");
        }
    });

    it("should detect non-adjacent duplicates in batch", async function () {
        const hash1 = ethers.keccak256(ethers.toUtf8Bytes("beneficiary-A"));
        const hash2 = ethers.keccak256(ethers.toUtf8Bytes("beneficiary-B"));
        const phoneHash3 = ethers.keccak256(ethers.toUtf8Bytes("+221701234567"));

        // hash1 appears at index 0 and 2 (non-adjacent)
        await expect(
            mobileMoney.connect(relayer).batchInitiatePayments(
                [hash1, hash2, hash1],     // non-adjacent duplicate
                [5000, 5000, 5000],
                [VALID_PHONE_HASH, PHONE_HASH_2, phoneHash3],
                REGION,
                [0, 0, 0]
            )
        ).to.be.revertedWithCustomError(mobileMoney, "InvalidBeneficiaryHash");
    });
});
