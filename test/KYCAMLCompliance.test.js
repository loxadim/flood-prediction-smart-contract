/**
 * @title KYCAMLCompliance Comprehensive Tests
 * @description Tests for KYC/AML compliance: attestation lifecycle, H-04 self-approval,
 * fraud detection, screening, suspension/reinstatement (C-03), batch compliance, configuration
 * Target: increase coverage from 62% to 85%+
 */
import { expect } from "chai";
import hre from "hardhat";

const connection = await hre.network.connect();
const { ethers, networkHelpers } = connection;

describe("KYCAMLCompliance", function () {
    let kyc;
    let owner, officer1, officer2, authorizedContract, unauthorized;

    // Helpers
    const hash = (label) => ethers.keccak256(ethers.toUtf8Bytes(label));
    const BEN_HASH = hash("beneficiary-1");
    const BEN_HASH_2 = hash("beneficiary-2");
    const BEN_HASH_3 = hash("beneficiary-3");
    const ID_HASH = hash("identity-1");
    const DOC_HASH = hash("document-1");
    const REGION = "SN-TH";

    beforeEach(async function () {
        [owner, officer1, officer2, authorizedContract, unauthorized] = await ethers.getSigners();

        const KYC = await ethers.getContractFactory("KYCAMLCompliance");
        kyc = await KYC.deploy();
        await kyc.waitForDeployment();

        // Owner is already officer #1 (set in constructor)
        // Add officer1 and officer2 as additional officers
        await kyc.addComplianceOfficer(officer1.address);
        await kyc.addComplianceOfficer(officer2.address);

        // Authorize a contract for isCompliant / batchCheckCompliance calls
        await kyc.authorizeContract(authorizedContract.address);
    });

    // =========================================================================
    //                         DEPLOYMENT & CONSTRUCTOR
    // =========================================================================
    describe("Deployment", function () {
        it("should set deployer as owner", async function () {
            expect(await kyc.owner()).to.equal(owner.address);
        });

        it("should register deployer as first compliance officer", async function () {
            expect(await kyc.complianceOfficers(owner.address)).to.be.true;
        });

        it("should set officerCount to 1 initially", async function () {
            // We added 2 more in beforeEach, so deploy a fresh one
            const KYC = await ethers.getContractFactory("KYCAMLCompliance");
            const fresh = await KYC.deploy();
            await fresh.waitForDeployment();
            expect(await fresh.officerCount()).to.equal(1);
        });

        it("should set default validity to 365 days", async function () {
            expect(await kyc.defaultValidityPeriod()).to.equal(365n * 24n * 3600n);
        });

        it("should set fraud threshold to 3", async function () {
            expect(await kyc.fraudThreshold()).to.equal(3);
        });
    });

    // =========================================================================
    //                         OFFICER MANAGEMENT
    // =========================================================================
    describe("Officer Management", function () {
        it("should add compliance officer", async function () {
            const newOfficer = ethers.Wallet.createRandom();
            await kyc.addComplianceOfficer(newOfficer.address);
            expect(await kyc.complianceOfficers(newOfficer.address)).to.be.true;
            expect(await kyc.officerCount()).to.equal(4); // owner + officer1 + officer2 + new
        });

        it("should revert adding zero address", async function () {
            await expect(
                kyc.addComplianceOfficer(ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(kyc, "InvalidAddress");
        });

        it("should revert adding already existing officer", async function () {
            await expect(
                kyc.addComplianceOfficer(officer1.address)
            ).to.be.revertedWithCustomError(kyc, "AlreadyAnOfficer");
        });

        it("should revert if non-owner adds officer", async function () {
            await expect(
                kyc.connect(officer1).addComplianceOfficer(unauthorized.address)
            ).to.be.revertedWithCustomError(kyc, "OwnableUnauthorizedAccount");
        });

        it("should remove compliance officer", async function () {
            await kyc.removeComplianceOfficer(officer1.address);
            expect(await kyc.complianceOfficers(officer1.address)).to.be.false;
            expect(await kyc.officerCount()).to.equal(2); // owner + officer2
        });

        it("should revert removing non-officer", async function () {
            await expect(
                kyc.removeComplianceOfficer(unauthorized.address)
            ).to.be.revertedWithCustomError(kyc, "NotAnOfficer");
        });

        it("should revert removing last officer", async function () {
            // Remove officer1 and officer2 first
            await kyc.removeComplianceOfficer(officer1.address);
            await kyc.removeComplianceOfficer(officer2.address);
            // Now only owner remains — removing should fail
            await expect(
                kyc.removeComplianceOfficer(owner.address)
            ).to.be.revertedWithCustomError(kyc, "CannotRemoveLastOfficer");
        });

        it("should revert if non-owner removes officer", async function () {
            await expect(
                kyc.connect(officer1).removeComplianceOfficer(officer2.address)
            ).to.be.revertedWithCustomError(kyc, "OwnableUnauthorizedAccount");
        });
    });

    // =========================================================================
    //                     CONTRACT AUTHORIZATION
    // =========================================================================
    describe("Contract Authorization", function () {
        it("should authorize a contract", async function () {
            const addr = ethers.Wallet.createRandom().address;
            await kyc.authorizeContract(addr);
            expect(await kyc.authorizedContracts(addr)).to.be.true;
        });

        it("should revert authorizing zero address", async function () {
            await expect(
                kyc.authorizeContract(ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(kyc, "InvalidAddress");
        });

        it("should deauthorize a contract", async function () {
            await kyc.deauthorizeContract(authorizedContract.address);
            expect(await kyc.authorizedContracts(authorizedContract.address)).to.be.false;
        });

        it("should revert if non-owner authorizes", async function () {
            await expect(
                kyc.connect(officer1).authorizeContract(unauthorized.address)
            ).to.be.revertedWithCustomError(kyc, "OwnableUnauthorizedAccount");
        });
    });

    // =========================================================================
    //                     ATTESTATION LIFECYCLE
    // =========================================================================
    describe("Attestation Submission", function () {
        it("should submit attestation successfully", async function () {
            await expect(
                kyc.connect(officer1).submitAttestation(BEN_HASH, ID_HASH, DOC_HASH, REGION)
            ).to.emit(kyc, "AttestationSubmitted")
                .withArgs(BEN_HASH, ID_HASH, REGION);

            const att = await kyc.getAttestation(BEN_HASH);
            expect(att.identityHash).to.equal(ID_HASH);
            expect(att.documentHash).to.equal(DOC_HASH);
            expect(att.status).to.equal(1); // PENDING
            expect(att.submittedBy).to.equal(officer1.address);
            expect(att.region).to.equal(REGION);
        });

        it("should increment totalAttestations", async function () {
            await kyc.connect(officer1).submitAttestation(BEN_HASH, ID_HASH, DOC_HASH, REGION);
            expect(await kyc.totalAttestations()).to.equal(1);
        });

        it("should revert with zero beneficiary hash", async function () {
            await expect(
                kyc.connect(officer1).submitAttestation(ethers.ZeroHash, ID_HASH, DOC_HASH, REGION)
            ).to.be.revertedWithCustomError(kyc, "InvalidBeneficiaryHash");
        });

        it("should revert if attestation already exists (PENDING)", async function () {
            await kyc.connect(officer1).submitAttestation(BEN_HASH, ID_HASH, DOC_HASH, REGION);
            await expect(
                kyc.connect(officer1).submitAttestation(BEN_HASH, ID_HASH, DOC_HASH, REGION)
            ).to.be.revertedWithCustomError(kyc, "AttestationAlreadyExists");
        });

        it("should revert if attestation already VERIFIED", async function () {
            await kyc.connect(officer1).submitAttestation(BEN_HASH, ID_HASH, DOC_HASH, REGION);
            await kyc.connect(officer2).approveAttestation(BEN_HASH, 0, 0); // RiskLevel.LOW, default validity
            await expect(
                kyc.connect(officer1).submitAttestation(BEN_HASH, ID_HASH, DOC_HASH, REGION)
            ).to.be.revertedWithCustomError(kyc, "AttestationAlreadyExists");
        });

        it("should allow re-submission after REJECTED", async function () {
            await kyc.connect(officer1).submitAttestation(BEN_HASH, ID_HASH, DOC_HASH, REGION);
            await kyc.connect(officer2).rejectAttestation(BEN_HASH, "Bad docs");
            // Re-submission should succeed
            await kyc.connect(officer1).submitAttestation(BEN_HASH, ID_HASH, DOC_HASH, REGION);
            const att = await kyc.getAttestation(BEN_HASH);
            expect(att.status).to.equal(1); // PENDING
        });

        it("should revert if non-officer submits", async function () {
            await expect(
                kyc.connect(unauthorized).submitAttestation(BEN_HASH, ID_HASH, DOC_HASH, REGION)
            ).to.be.revertedWithCustomError(kyc, "NotComplianceOfficer");
        });
    });

    // =========================================================================
    //                     ATTESTATION APPROVAL (+ H-04)
    // =========================================================================
    describe("Attestation Approval", function () {
        beforeEach(async function () {
            // officer1 submits
            await kyc.connect(officer1).submitAttestation(BEN_HASH, ID_HASH, DOC_HASH, REGION);
        });

        it("should approve attestation by a different officer (4-eyes)", async function () {
            await expect(
                kyc.connect(officer2).approveAttestation(BEN_HASH, 0, 365 * 24 * 3600) // LOW risk, 1 year
            ).to.emit(kyc, "AttestationApproved");

            const att = await kyc.getAttestation(BEN_HASH);
            expect(att.status).to.equal(2); // VERIFIED
            expect(att.riskLevel).to.equal(0); // LOW
            expect(att.verifiedBy).to.equal(officer2.address);
            expect(att.expiresAt).to.be.gt(0);
        });

        it("H-04: should revert self-approval (same officer submits and approves)", async function () {
            await expect(
                kyc.connect(officer1).approveAttestation(BEN_HASH, 0, 0)
            ).to.be.revertedWithCustomError(kyc, "SelfApprovalNotAllowed");
        });

        it("should increment approvedCount", async function () {
            await kyc.connect(officer2).approveAttestation(BEN_HASH, 0, 0);
            expect(await kyc.approvedCount()).to.equal(1);
        });

        it("should use defaultValidityPeriod when validityPeriod is 0", async function () {
            await kyc.connect(officer2).approveAttestation(BEN_HASH, 0, 0);
            const att = await kyc.getAttestation(BEN_HASH);
            const defaultValidity = await kyc.defaultValidityPeriod();
            // expiresAt ≈ verifiedAt + defaultValidityPeriod
            expect(att.expiresAt).to.equal(att.verifiedAt + defaultValidity);
        });

        it("should revert if validityPeriod exceeds maxValidityPeriod", async function () {
            const tooLong = 731 * 24 * 3600; // > 730 days
            await expect(
                kyc.connect(officer2).approveAttestation(BEN_HASH, 0, tooLong)
            ).to.be.revertedWithCustomError(kyc, "InvalidValidityPeriod");
        });

        it("should auto-suspend if riskLevel is SANCTIONED", async function () {
            await expect(
                kyc.connect(officer2).approveAttestation(BEN_HASH, 3, 0) // RiskLevel.SANCTIONED = 3
            ).to.emit(kyc, "BeneficiarySuspended");

            const att = await kyc.getAttestation(BEN_HASH);
            expect(att.status).to.equal(5); // SUSPENDED
        });

        it("should revert for non-existing attestation", async function () {
            await expect(
                kyc.connect(officer2).approveAttestation(BEN_HASH_2, 0, 0)
            ).to.be.revertedWithCustomError(kyc, "AttestationNotFound");
        });

        it("should revert if attestation is not PENDING", async function () {
            await kyc.connect(officer2).approveAttestation(BEN_HASH, 0, 0); // Now VERIFIED
            await expect(
                kyc.connect(officer2).approveAttestation(BEN_HASH, 0, 0)
            ).to.be.revertedWithCustomError(kyc, "AttestationNotPending");
        });

        it("should revert if non-officer approves", async function () {
            await expect(
                kyc.connect(unauthorized).approveAttestation(BEN_HASH, 0, 0)
            ).to.be.revertedWithCustomError(kyc, "NotComplianceOfficer");
        });
    });

    // =========================================================================
    //                     ATTESTATION REJECTION
    // =========================================================================
    describe("Attestation Rejection", function () {
        beforeEach(async function () {
            await kyc.connect(officer1).submitAttestation(BEN_HASH, ID_HASH, DOC_HASH, REGION);
        });

        it("should reject attestation", async function () {
            await expect(
                kyc.connect(officer2).rejectAttestation(BEN_HASH, "Forged documents")
            ).to.emit(kyc, "AttestationRejected")
                .withArgs(BEN_HASH, "Forged documents");

            const att = await kyc.getAttestation(BEN_HASH);
            expect(att.status).to.equal(3); // REJECTED
        });

        it("should increment rejectedCount", async function () {
            await kyc.connect(officer2).rejectAttestation(BEN_HASH, "Bad ID");
            expect(await kyc.rejectedCount()).to.equal(1);
        });

        it("should revert for non-existing attestation", async function () {
            await expect(
                kyc.connect(officer2).rejectAttestation(BEN_HASH_2, "No record")
            ).to.be.revertedWithCustomError(kyc, "AttestationNotFound");
        });

        it("should revert if not PENDING", async function () {
            await kyc.connect(officer2).rejectAttestation(BEN_HASH, "Bad");
            await expect(
                kyc.connect(officer2).rejectAttestation(BEN_HASH, "Again")
            ).to.be.revertedWithCustomError(kyc, "AttestationNotPending");
        });

        it("should revert if non-officer rejects", async function () {
            await expect(
                kyc.connect(unauthorized).rejectAttestation(BEN_HASH, "Hack")
            ).to.be.revertedWithCustomError(kyc, "NotComplianceOfficer");
        });
    });

    // =========================================================================
    //                     SCREENING
    // =========================================================================
    describe("Screening", function () {
        it("should record cleared screening result", async function () {
            const result = {
                isCleared: true,
                sanctionsChecked: true,
                pepChecked: true,
                screenedAt: Math.floor(Date.now() / 1000),
                screeningProvider: "WorldCheck"
            };

            await expect(
                kyc.connect(officer1).recordScreening(BEN_HASH, result)
            ).to.emit(kyc, "ScreeningRecorded")
                .withArgs(BEN_HASH, true, "WorldCheck");

            const sr = await kyc.getScreeningResult(BEN_HASH);
            expect(sr.isCleared).to.be.true;
            expect(sr.sanctionsChecked).to.be.true;
            expect(sr.pepChecked).to.be.true;
            expect(sr.screeningProvider).to.equal("WorldCheck");
        });

        it("should auto-suspend on sanctions match", async function () {
            // First submit an attestation so there's a status to save
            await kyc.connect(officer1).submitAttestation(BEN_HASH, ID_HASH, DOC_HASH, REGION);

            const result = {
                isCleared: false,
                sanctionsChecked: true,
                pepChecked: false,
                screenedAt: Math.floor(Date.now() / 1000),
                screeningProvider: "OFAC"
            };

            await expect(
                kyc.connect(officer1).recordScreening(BEN_HASH, result)
            ).to.emit(kyc, "BeneficiarySuspended")
                .withArgs(BEN_HASH, "Sanctions match detected");

            const att = await kyc.getAttestation(BEN_HASH);
            expect(att.status).to.equal(5); // SUSPENDED
        });

        it("should NOT auto-suspend if sanctions not checked", async function () {
            await kyc.connect(officer1).submitAttestation(BEN_HASH, ID_HASH, DOC_HASH, REGION);

            const result = {
                isCleared: false,
                sanctionsChecked: false,
                pepChecked: true,
                screenedAt: Math.floor(Date.now() / 1000),
                screeningProvider: "Provider"
            };

            await kyc.connect(officer1).recordScreening(BEN_HASH, result);
            const att = await kyc.getAttestation(BEN_HASH);
            expect(att.status).to.equal(1); // Still PENDING
        });

        it("should revert with zero hash", async function () {
            const result = {
                isCleared: true,
                sanctionsChecked: true,
                pepChecked: true,
                screenedAt: 0,
                screeningProvider: "Test"
            };
            await expect(
                kyc.connect(officer1).recordScreening(ethers.ZeroHash, result)
            ).to.be.revertedWithCustomError(kyc, "InvalidBeneficiaryHash");
        });

        it("should revert if non-officer calls recordScreening", async function () {
            const result = {
                isCleared: true,
                sanctionsChecked: true,
                pepChecked: true,
                screenedAt: 0,
                screeningProvider: "Test"
            };
            await expect(
                kyc.connect(unauthorized).recordScreening(BEN_HASH, result)
            ).to.be.revertedWithCustomError(kyc, "NotComplianceOfficer");
        });
    });

    // =========================================================================
    //                     SUSPENSION & REINSTATEMENT (C-03)
    // =========================================================================
    describe("Suspension & Reinstatement", function () {
        beforeEach(async function () {
            // Submit and approve an attestation
            await kyc.connect(officer1).submitAttestation(BEN_HASH, ID_HASH, DOC_HASH, REGION);
            await kyc.connect(officer2).approveAttestation(BEN_HASH, 0, 0); // VERIFIED
        });

        it("should suspend a VERIFIED beneficiary", async function () {
            await expect(
                kyc.connect(officer1).suspendBeneficiary(BEN_HASH, "Suspicious activity")
            ).to.emit(kyc, "BeneficiarySuspended")
                .withArgs(BEN_HASH, "Suspicious activity");

            const att = await kyc.getAttestation(BEN_HASH);
            expect(att.status).to.equal(5); // SUSPENDED
        });

        it("should increment suspendedCount and decrement approvedCount on VERIFIED suspension", async function () {
            const approvedBefore = await kyc.approvedCount();
            await kyc.connect(officer1).suspendBeneficiary(BEN_HASH, "Fraud");
            expect(await kyc.suspendedCount()).to.equal(1);
            expect(await kyc.approvedCount()).to.equal(approvedBefore - 1n);
        });

        it("should revert suspending already suspended", async function () {
            await kyc.connect(officer1).suspendBeneficiary(BEN_HASH, "First");
            await expect(
                kyc.connect(officer1).suspendBeneficiary(BEN_HASH, "Second")
            ).to.be.revertedWithCustomError(kyc, "BeneficiaryAlreadySuspended");
        });

        it("should revert if non-officer suspends", async function () {
            await expect(
                kyc.connect(unauthorized).suspendBeneficiary(BEN_HASH, "Hack")
            ).to.be.revertedWithCustomError(kyc, "NotComplianceOfficer");
        });

        it("C-03: should reinstate and restore VERIFIED status", async function () {
            await kyc.connect(officer1).suspendBeneficiary(BEN_HASH, "Temp");

            await expect(
                kyc.connect(officer2).reinstateBeneficiary(BEN_HASH)
            ).to.emit(kyc, "BeneficiaryReinstated")
                .withArgs(BEN_HASH);

            const att = await kyc.getAttestation(BEN_HASH);
            expect(att.status).to.equal(2); // VERIFIED (restored)
            expect(att.expiresAt).to.be.gt(0); // Renewed expiry
        });

        it("C-03: should reinstate PENDING status when suspended from PENDING", async function () {
            // Submit a new beneficiary and suspend while PENDING
            await kyc.connect(officer1).submitAttestation(BEN_HASH_2, ID_HASH, DOC_HASH, REGION);
            await kyc.connect(officer1).suspendBeneficiary(BEN_HASH_2, "Check pending");

            await kyc.connect(officer2).reinstateBeneficiary(BEN_HASH_2);
            const att = await kyc.getAttestation(BEN_HASH_2);
            expect(att.status).to.equal(1); // PENDING (restored)
        });

        it("should reset fraudAlertCount on reinstatement", async function () {
            // Generate 2 fraud alerts then suspend manually
            await kyc.connect(officer1).raiseFraudAlert(BEN_HASH, "Alert1");
            await kyc.connect(officer1).raiseFraudAlert(BEN_HASH, "Alert2");
            await kyc.connect(officer1).suspendBeneficiary(BEN_HASH, "Manual");

            await kyc.connect(officer2).reinstateBeneficiary(BEN_HASH);
            expect(await kyc.fraudAlertCount(BEN_HASH)).to.equal(0);
        });

        it("should revert reinstating non-suspended beneficiary", async function () {
            await expect(
                kyc.connect(officer1).reinstateBeneficiary(BEN_HASH)
            ).to.be.revertedWithCustomError(kyc, "NotSuspended");
        });

        it("should revert if non-officer reinstates", async function () {
            await kyc.connect(officer1).suspendBeneficiary(BEN_HASH, "Temp");
            await expect(
                kyc.connect(unauthorized).reinstateBeneficiary(BEN_HASH)
            ).to.be.revertedWithCustomError(kyc, "NotComplianceOfficer");
        });

        it("should decrement suspendedCount on reinstatement", async function () {
            await kyc.connect(officer1).suspendBeneficiary(BEN_HASH, "Temp");
            const suspBefore = await kyc.suspendedCount();
            await kyc.connect(officer2).reinstateBeneficiary(BEN_HASH);
            expect(await kyc.suspendedCount()).to.equal(suspBefore - 1n);
        });
    });

    // =========================================================================
    //                     FRAUD DETECTION
    // =========================================================================
    describe("Fraud Detection", function () {
        beforeEach(async function () {
            await kyc.connect(officer1).submitAttestation(BEN_HASH, ID_HASH, DOC_HASH, REGION);
            await kyc.connect(officer2).approveAttestation(BEN_HASH, 0, 0); // VERIFIED
        });

        it("should raise fraud alert and increment count", async function () {
            await expect(
                kyc.connect(officer1).raiseFraudAlert(BEN_HASH, "Duplicate identity")
            ).to.emit(kyc, "FraudAlertRaised");

            expect(await kyc.fraudAlertCount(BEN_HASH)).to.equal(1);
        });

        it("should auto-suspend after reaching fraudThreshold (3)", async function () {
            await kyc.connect(officer1).raiseFraudAlert(BEN_HASH, "Alert-1");
            await kyc.connect(officer1).raiseFraudAlert(BEN_HASH, "Alert-2");

            // 3rd alert should trigger auto-suspension
            await expect(
                kyc.connect(officer1).raiseFraudAlert(BEN_HASH, "Alert-3")
            ).to.emit(kyc, "BeneficiarySuspended")
                .withArgs(BEN_HASH, "Fraud threshold exceeded");

            const att = await kyc.getAttestation(BEN_HASH);
            expect(att.status).to.equal(5); // SUSPENDED
        });

        it("should NOT auto-suspend below threshold", async function () {
            await kyc.connect(officer1).raiseFraudAlert(BEN_HASH, "Alert-1");
            await kyc.connect(officer1).raiseFraudAlert(BEN_HASH, "Alert-2");
            // 2 alerts < threshold of 3
            const att = await kyc.getAttestation(BEN_HASH);
            expect(att.status).to.equal(2); // Still VERIFIED
        });

        it("should revert if non-officer raises alert", async function () {
            await expect(
                kyc.connect(unauthorized).raiseFraudAlert(BEN_HASH, "Alert")
            ).to.be.revertedWithCustomError(kyc, "NotComplianceOfficer");
        });
    });

    // =========================================================================
    //                     COMPLIANCE CHECKS
    // =========================================================================
    describe("Compliance Checks (isCompliant)", function () {
        it("should return true for VERIFIED + not expired + LOW risk + cleared screening", async function () {
            await kyc.connect(officer1).submitAttestation(BEN_HASH, ID_HASH, DOC_HASH, REGION);
            await kyc.connect(officer2).approveAttestation(BEN_HASH, 0, 0); // LOW risk

            // Record cleared screening
            await kyc.connect(officer1).recordScreening(BEN_HASH, {
                isCleared: true,
                sanctionsChecked: true,
                pepChecked: true,
                screenedAt: Math.floor(Date.now() / 1000),
                screeningProvider: "WorldCheck"
            });

            // Query from authorized contract
            expect(await kyc.connect(authorizedContract).isCompliant(BEN_HASH)).to.be.true;
        });

        it("should return true for owner calling isCompliant", async function () {
            await kyc.connect(officer1).submitAttestation(BEN_HASH, ID_HASH, DOC_HASH, REGION);
            await kyc.connect(officer2).approveAttestation(BEN_HASH, 0, 0);
            expect(await kyc.connect(owner).isCompliant(BEN_HASH)).to.be.true;
        });

        it("should revert for unauthorized caller", async function () {
            await kyc.connect(officer1).submitAttestation(BEN_HASH, ID_HASH, DOC_HASH, REGION);
            await kyc.connect(officer2).approveAttestation(BEN_HASH, 0, 0);
            await expect(
                kyc.connect(unauthorized).isCompliant(BEN_HASH)
            ).to.be.revertedWithCustomError(kyc, "NotAuthorizedContract");
        });

        it("should return false for NOT_VERIFIED", async function () {
            expect(await kyc.connect(owner).isCompliant(BEN_HASH)).to.be.false;
        });

        it("should return false for PENDING", async function () {
            await kyc.connect(officer1).submitAttestation(BEN_HASH, ID_HASH, DOC_HASH, REGION);
            expect(await kyc.connect(owner).isCompliant(BEN_HASH)).to.be.false;
        });

        it("should return false for expired attestation", async function () {
            await kyc.connect(officer1).submitAttestation(BEN_HASH, ID_HASH, DOC_HASH, REGION);
            // Approve with minimum validity (30 days)
            await kyc.connect(officer2).approveAttestation(BEN_HASH, 0, 30 * 24 * 3600);

            // Advance time beyond 30 days
            await networkHelpers.time.increase(31 * 24 * 3600);

            expect(await kyc.connect(owner).isCompliant(BEN_HASH)).to.be.false;
        });

        it("should return false for HIGH risk", async function () {
            await kyc.connect(officer1).submitAttestation(BEN_HASH, ID_HASH, DOC_HASH, REGION);
            await kyc.connect(officer2).approveAttestation(BEN_HASH, 2, 0); // HIGH
            expect(await kyc.connect(owner).isCompliant(BEN_HASH)).to.be.false;
        });

        it("should return false when screening not cleared", async function () {
            await kyc.connect(officer1).submitAttestation(BEN_HASH, ID_HASH, DOC_HASH, REGION);
            await kyc.connect(officer2).approveAttestation(BEN_HASH, 0, 0);

            // Record failed screening
            await kyc.connect(officer1).recordScreening(BEN_HASH, {
                isCleared: false,
                sanctionsChecked: true,
                pepChecked: false,
                screenedAt: Math.floor(Date.now() / 1000),
                screeningProvider: "OFAC"
            });

            expect(await kyc.connect(owner).isCompliant(BEN_HASH)).to.be.false;
        });

        it("should return true without screening (no sanctions check done)", async function () {
            await kyc.connect(officer1).submitAttestation(BEN_HASH, ID_HASH, DOC_HASH, REGION);
            await kyc.connect(officer2).approveAttestation(BEN_HASH, 0, 0);
            // No screening recorded → sanctionsChecked defaults to false → skip check
            expect(await kyc.connect(owner).isCompliant(BEN_HASH)).to.be.true;
        });
    });

    // =========================================================================
    //                     BATCH COMPLIANCE
    // =========================================================================
    describe("Batch Compliance", function () {
        it("should check multiple beneficiaries", async function () {
            // Submit & approve two beneficiaries
            await kyc.connect(officer1).submitAttestation(BEN_HASH, ID_HASH, DOC_HASH, REGION);
            await kyc.connect(officer2).approveAttestation(BEN_HASH, 0, 0);

            await kyc.connect(officer1).submitAttestation(BEN_HASH_2, ID_HASH, DOC_HASH, REGION);
            // Leave BEN_HASH_2 as PENDING (not compliant)

            const results = await kyc.connect(authorizedContract).batchCheckCompliance([BEN_HASH, BEN_HASH_2, BEN_HASH_3]);
            expect(results[0]).to.be.true;  // VERIFIED
            expect(results[1]).to.be.false; // PENDING
            expect(results[2]).to.be.false; // NOT_VERIFIED
        });

        it("should revert for batch > 200", async function () {
            const hashes = Array.from({ length: 201 }, (_, i) => hash(`batch-${i}`));
            await expect(
                kyc.connect(authorizedContract).batchCheckCompliance(hashes)
            ).to.be.revertedWithCustomError(kyc, "BatchTooLarge");
        });

        it("should revert for unauthorized caller", async function () {
            await expect(
                kyc.connect(unauthorized).batchCheckCompliance([BEN_HASH])
            ).to.be.revertedWithCustomError(kyc, "NotAuthorizedContract");
        });

        it("should handle empty array", async function () {
            const results = await kyc.connect(owner).batchCheckCompliance([]);
            expect(results.length).to.equal(0);
        });
    });

    // =========================================================================
    //                     CONFIGURATION
    // =========================================================================
    describe("Configuration", function () {
        describe("updateDefaultValidity", function () {
            it("should update default validity period", async function () {
                const newPeriod = 180n * 24n * 3600n; // 180 days
                await expect(kyc.updateDefaultValidity(newPeriod))
                    .to.emit(kyc, "DefaultValidityUpdated")
                    .withArgs(365n * 24n * 3600n, newPeriod);
                expect(await kyc.defaultValidityPeriod()).to.equal(newPeriod);
            });

            it("should revert if period < 30 days", async function () {
                await expect(
                    kyc.updateDefaultValidity(29n * 24n * 3600n)
                ).to.be.revertedWithCustomError(kyc, "PeriodTooShort");
            });

            it("should revert if period > maxValidityPeriod", async function () {
                await expect(
                    kyc.updateDefaultValidity(731n * 24n * 3600n)
                ).to.be.revertedWithCustomError(kyc, "ExceedsMaxValidity");
            });

            it("should revert if non-owner calls", async function () {
                await expect(
                    kyc.connect(officer1).updateDefaultValidity(180n * 24n * 3600n)
                ).to.be.revertedWithCustomError(kyc, "OwnableUnauthorizedAccount");
            });
        });

        describe("updateFraudThreshold", function () {
            it("should update fraud threshold", async function () {
                await expect(kyc.updateFraudThreshold(5))
                    .to.emit(kyc, "FraudThresholdUpdated")
                    .withArgs(3, 5);
                expect(await kyc.fraudThreshold()).to.equal(5);
            });

            it("should revert if threshold < 1", async function () {
                await expect(
                    kyc.updateFraudThreshold(0)
                ).to.be.revertedWithCustomError(kyc, "InvalidThreshold");
            });

            it("should revert if threshold > 10", async function () {
                await expect(
                    kyc.updateFraudThreshold(11)
                ).to.be.revertedWithCustomError(kyc, "InvalidThreshold");
            });

            it("should revert if non-owner calls", async function () {
                await expect(
                    kyc.connect(officer1).updateFraudThreshold(5)
                ).to.be.revertedWithCustomError(kyc, "OwnableUnauthorizedAccount");
            });
        });
    });

    // =========================================================================
    //                     VIEW FUNCTIONS
    // =========================================================================
    describe("View Functions", function () {
        it("should return correct compliance stats", async function () {
            await kyc.connect(officer1).submitAttestation(BEN_HASH, ID_HASH, DOC_HASH, REGION);
            await kyc.connect(officer2).approveAttestation(BEN_HASH, 0, 0);

            await kyc.connect(officer1).submitAttestation(BEN_HASH_2, ID_HASH, DOC_HASH, REGION);
            await kyc.connect(officer2).rejectAttestation(BEN_HASH_2, "Bad");

            const [total, approved, rejected, suspended, officers] = await kyc.getComplianceStats();
            expect(total).to.equal(2);
            expect(approved).to.equal(1);
            expect(rejected).to.equal(1);
            expect(suspended).to.equal(0);
            expect(officers).to.equal(3); // owner + officer1 + officer2
        });

        it("should report isExpired correctly", async function () {
            await kyc.connect(officer1).submitAttestation(BEN_HASH, ID_HASH, DOC_HASH, REGION);
            await kyc.connect(officer2).approveAttestation(BEN_HASH, 0, 30 * 24 * 3600);

            expect(await kyc.isExpired(BEN_HASH)).to.be.false;

            await networkHelpers.time.increase(31 * 24 * 3600);
            expect(await kyc.isExpired(BEN_HASH)).to.be.true;
        });

        it("should return false for isExpired when no attestation", async function () {
            expect(await kyc.isExpired(BEN_HASH)).to.be.false;
        });

        it("should return attestation details via getAttestation", async function () {
            await kyc.connect(officer1).submitAttestation(BEN_HASH, ID_HASH, DOC_HASH, REGION);
            const att = await kyc.getAttestation(BEN_HASH);
            expect(att.identityHash).to.equal(ID_HASH);
            expect(att.documentHash).to.equal(DOC_HASH);
            expect(att.region).to.equal(REGION);
        });

        it("should return screening result via getScreeningResult", async function () {
            await kyc.connect(officer1).recordScreening(BEN_HASH, {
                isCleared: true,
                sanctionsChecked: true,
                pepChecked: true,
                screenedAt: 12345,
                screeningProvider: "Test"
            });
            const sr = await kyc.getScreeningResult(BEN_HASH);
            expect(sr.isCleared).to.be.true;
            expect(sr.screeningProvider).to.equal("Test");
        });
    });
});
