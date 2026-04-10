/**
 * @title OpalGovernanceUpgradeable Unit Tests
 * @description Tests for multi-sig governance: actors, proposals, signing, execution, quorum
 */
import { expect } from "chai";
import hre from "hardhat";
import { upgrades as makeUpgrades } from "@openzeppelin/hardhat-upgrades";

const connection = await hre.network.connect();
const { ethers, networkHelpers } = connection;
const ozUpgrades = await makeUpgrades(hre, connection);

describe("OpalGovernanceUpgradeable", function () {
    let governance;
    let owner, actor1, actor2, actor3, nonActor;

    beforeEach(async function () {
        [owner, actor1, actor2, actor3, nonActor] = await ethers.getSigners();

        const OpalGov = await ethers.getContractFactory("OpalGovernanceUpgradeable");
        governance = await ozUpgrades.deployProxy(OpalGov, [owner.address, 2], { kind: "uups" });
        await governance.waitForDeployment();
    });

    // =========================================================================
    //                         INITIALIZATION
    // =========================================================================
    describe("Initialization", function () {
        it("should set correct owner", async function () {
            expect(await governance.owner()).to.equal(owner.address);
        });

        it("should set initial quorum", async function () {
            expect(await governance.quorum()).to.equal(2);
        });

        it("should register owner as first governance actor", async function () {
            const actor = await governance.getGovernanceActor(owner.address);
            expect(actor.isActive).to.be.true;
            expect(actor.name).to.equal("Admin");
            expect(actor.role).to.equal("ADMIN");
        });

        it("should have 1 active actor count", async function () {
            expect(await governance.activeActorCount()).to.equal(1);
        });

        it("should start with 0 proposals", async function () {
            expect(await governance.proposalCount()).to.equal(0);
        });

        it("should revert if quorum < MIN_QUORUM", async function () {
            const OpalGov = await ethers.getContractFactory("OpalGovernanceUpgradeable");
            await expect(
                ozUpgrades.deployProxy(OpalGov, [owner.address, 1], { kind: "uups" })
            ).to.be.revertedWithCustomError(governance, "InvalidQuorum");
        });
    });

    // =========================================================================
    //                      ACTOR MANAGEMENT
    // =========================================================================
    describe("Actor Management", function () {
        it("should add a governance actor", async function () {
            await expect(governance.addGovernanceActor(actor1.address, "Governor1", "GOVERNOR"))
                .to.emit(governance, "GovernanceActorAdded")
                .withArgs(actor1.address, "Governor1", "GOVERNOR");

            const actor = await governance.getGovernanceActor(actor1.address);
            expect(actor.isActive).to.be.true;
            expect(actor.name).to.equal("Governor1");
            expect(await governance.activeActorCount()).to.equal(2);
        });

        it("should revert adding zero address", async function () {
            await expect(
                governance.addGovernanceActor(ethers.ZeroAddress, "Zero", "ADMIN")
            ).to.be.revertedWithCustomError(governance, "InvalidAddress");
        });

        it("should revert adding already active actor", async function () {
            await governance.addGovernanceActor(actor1.address, "Governor1", "GOVERNOR");
            await expect(
                governance.addGovernanceActor(actor1.address, "Governor1-dup", "GOVERNOR")
            ).to.be.revertedWithCustomError(governance, "ActorAlreadyRegistered");
        });

        it("should revert if not owner", async function () {
            await expect(
                governance.connect(actor1).addGovernanceActor(actor2.address, "G2", "GOVERNOR")
            ).to.be.revertedWithCustomError(governance, "OwnableUnauthorizedAccount");
        });

        it("should reactivate a previously removed actor", async function () {
            await governance.addGovernanceActor(actor1.address, "Gov1", "GOVERNOR");
            await governance.addGovernanceActor(actor2.address, "Gov2", "GOVERNOR");
            await governance.removeGovernanceActor(actor1.address);

            // Re-add
            await governance.addGovernanceActor(actor1.address, "Gov1-reactivated", "GOVERNOR");
            const actor = await governance.getGovernanceActor(actor1.address);
            expect(actor.isActive).to.be.true;
        });

        it("should remove a governance actor", async function () {
            await governance.addGovernanceActor(actor1.address, "Gov1", "GOVERNOR");
            await governance.addGovernanceActor(actor2.address, "Gov2", "GOVERNOR");

            await expect(governance.removeGovernanceActor(actor1.address))
                .to.emit(governance, "GovernanceActorRemoved")
                .withArgs(actor1.address);

            const actor = await governance.getGovernanceActor(actor1.address);
            expect(actor.isActive).to.be.false;
            expect(await governance.activeActorCount()).to.equal(2);
        });

        it("should revert removing if would go below quorum", async function () {
            await governance.addGovernanceActor(actor1.address, "Gov1", "GOVERNOR");
            // 2 actors, quorum=2, removing one would leave 1 < 2
            await expect(
                governance.removeGovernanceActor(actor1.address)
            ).to.be.revertedWithCustomError(governance, "CannotRemoveBelowQuorum");
        });

        it("should revert removing inactive actor", async function () {
            await expect(
                governance.removeGovernanceActor(actor1.address)
            ).to.be.revertedWithCustomError(governance, "ActorNotRegistered");
        });

        it("should enforce MAX_ACTORS limit", async function () {
            const signers = await ethers.getSigners();
            // Owner is already actor 1, add 19 more to reach MAX_ACTORS=20
            for (let i = 1; i <= 19; i++) {
                await governance.addGovernanceActor(signers[i].address, `Actor-${i}`, "GOVERNOR");
            }
            // Generate random wallet for the 21st address
            const extraWallet = ethers.Wallet.createRandom();
            await expect(
                governance.addGovernanceActor(extraWallet.address, "Actor-20", "GOVERNOR")
            ).to.be.revertedWithCustomError(governance, "MaxActorsReached");
        });

        it("should return actor list", async function () {
            await governance.addGovernanceActor(actor1.address, "Gov1", "GOVERNOR");
            const list = await governance.getActorList();
            expect(list.length).to.equal(2);
        });
    });

    // =========================================================================
    //                       QUORUM UPDATE
    // =========================================================================
    describe("Quorum Update", function () {
        beforeEach(async function () {
            await governance.addGovernanceActor(actor1.address, "Gov1", "GOVERNOR");
            await governance.addGovernanceActor(actor2.address, "Gov2", "GOVERNOR");
            // Now 3 active actors
        });

        it("should update quorum", async function () {
            await expect(governance.updateQuorum(3))
                .to.emit(governance, "QuorumUpdated")
                .withArgs(2, 3);
            expect(await governance.quorum()).to.equal(3);
        });

        it("should revert quorum < MIN_QUORUM", async function () {
            await expect(governance.updateQuorum(1))
                .to.be.revertedWithCustomError(governance, "InvalidQuorum");
        });

        it("should revert quorum > activeActorCount", async function () {
            await expect(governance.updateQuorum(4))
                .to.be.revertedWithCustomError(governance, "InvalidQuorum");
        });

        it("should revert if not owner", async function () {
            await expect(
                governance.connect(actor1).updateQuorum(3)
            ).to.be.revertedWithCustomError(governance, "OwnableUnauthorizedAccount");
        });
    });

    // =========================================================================
    //                     PROPOSAL LIFECYCLE
    // =========================================================================
    describe("Proposal Lifecycle", function () {
        beforeEach(async function () {
            await governance.addGovernanceActor(actor1.address, "Gov1", "GOVERNOR");
            await governance.addGovernanceActor(actor2.address, "Gov2", "GOVERNOR");
        });

        it("should create a proposal", async function () {
            // ProposalType.PARAMETER_CHANGE = 1
            await expect(
                governance.connect(owner).createProposal(1, "Change threshold", "0x", "SN-TH", ethers.ZeroAddress)
            ).to.emit(governance, "ProposalCreated");

            const proposal = await governance.getProposal(0);
            expect(proposal.proposer).to.equal(owner.address);
            expect(proposal.description).to.equal("Change threshold");
            expect(proposal.signatureCount).to.equal(1); // auto-signed by proposer
            expect(proposal.status).to.equal(0); // PENDING
        });

        it("should set 24h deadline for normal proposals", async function () {
            // ProposalType.PARAMETER_CHANGE = 1 → DEFAULT_DEADLINE = 24h
            await governance.connect(owner).createProposal(1, "Normal", "0x", "", ethers.ZeroAddress);
            const proposal = await governance.getProposal(0);
            const expectedDeadline = proposal.createdAt + BigInt(24 * 3600);
            expect(proposal.deadline).to.equal(expectedDeadline);
        });

        it("should set 4h deadline for emergency proposals", async function () {
            // ProposalType.EMERGENCY_TRIGGER = 0 → EMERGENCY_DEADLINE = 4h
            await governance.connect(owner).createProposal(0, "Emergency", "0x", "SN-TH", ethers.ZeroAddress);
            const proposal = await governance.getProposal(0);
            const expectedDeadline = proposal.createdAt + BigInt(4 * 3600);
            expect(proposal.deadline).to.equal(expectedDeadline);
        });

        it("should revert proposal creation by non-actor", async function () {
            await expect(
                governance.connect(nonActor).createProposal(1, "Unauthorized", "0x", "", ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(governance, "NotGovernanceActor");
        });

        it("should sign a proposal", async function () {
            await governance.connect(owner).createProposal(1, "Test", "0x", "", ethers.ZeroAddress);

            await expect(governance.connect(actor1).signProposal(0))
                .to.emit(governance, "ProposalSigned")
                .withArgs(0, actor1.address, 2);

            expect(await governance.hasSignedProposal(0, actor1.address)).to.be.true;
        });

        it("should revert signing non-pending proposal", async function () {
            await governance.connect(owner).createProposal(1, "Test", "0x", "", ethers.ZeroAddress);
            await governance.connect(actor1).signProposal(0);
            // M-10: advance time past timelock before executing
            await networkHelpers.time.increase(3601);
            await governance.connect(actor2).executeProposal(0);

            await expect(
                governance.connect(actor2).signProposal(0)
            ).to.be.revertedWithCustomError(governance, "ProposalNotPending");
        });

        it("should revert double signing", async function () {
            await governance.connect(owner).createProposal(1, "Test", "0x", "", ethers.ZeroAddress);
            await expect(
                governance.connect(owner).signProposal(0)
            ).to.be.revertedWithCustomError(governance, "AlreadySigned");
        });

        it("should revert signing expired proposal", async function () {
            await governance.connect(owner).createProposal(1, "Test", "0x", "", ethers.ZeroAddress);
            // Advance 25 hours
            await networkHelpers.time.increase(25 * 3600);
            await expect(
                governance.connect(actor1).signProposal(0)
            ).to.be.revertedWithCustomError(governance, "ProposalIsExpired");
        });

        it("should execute proposal when quorum met", async function () {
            await governance.connect(owner).createProposal(1, "Test exec", "0x", "SN-TH", ethers.ZeroAddress);
            await governance.connect(actor1).signProposal(0); // 2 signatures = quorum

            // M-10: advance time past timelock before executing
            await networkHelpers.time.increase(3601);

            await expect(governance.connect(actor2).executeProposal(0))
                .to.emit(governance, "ProposalExecuted")
                .withArgs(0, actor2.address);

            const proposal = await governance.getProposal(0);
            expect(proposal.status).to.equal(2); // EXECUTED
            expect(proposal.executedAt).to.be.gt(0);
        });

        it("should revert execution with insufficient signatures", async function () {
            await governance.connect(owner).createProposal(1, "Test", "0x", "", ethers.ZeroAddress);
            // Only 1 signature, quorum is 2
            await expect(
                governance.connect(owner).executeProposal(0)
            ).to.be.revertedWithCustomError(governance, "InsufficientSignatures");
        });

        it("should revert executing expired proposal", async function () {
            await governance.connect(owner).createProposal(1, "Test", "0x", "", ethers.ZeroAddress);
            await governance.connect(actor1).signProposal(0);
            await networkHelpers.time.increase(25 * 3600);
            await expect(
                governance.connect(owner).executeProposal(0)
            ).to.be.revertedWithCustomError(governance, "ProposalIsExpired");
        });

        it("should reject a proposal (owner only)", async function () {
            await governance.connect(owner).createProposal(1, "Reject me", "0x", "", ethers.ZeroAddress);
            await expect(governance.rejectProposal(0))
                .to.emit(governance, "ProposalRejected")
                .withArgs(0, owner.address);

            const proposal = await governance.getProposal(0);
            expect(proposal.status).to.equal(3); // REJECTED
        });

        it("should revert reject by non-governance actor", async function () {
            await governance.connect(owner).createProposal(1, "Test", "0x", "", ethers.ZeroAddress);
            await expect(
                governance.connect(nonActor).rejectProposal(0)
            ).to.be.revertedWithCustomError(governance, "NotGovernanceActor");
        });

        it("should expire a stale proposal", async function () {
            await governance.connect(owner).createProposal(1, "Stale", "0x", "", ethers.ZeroAddress);
            await networkHelpers.time.increase(25 * 3600);
            await expect(governance.expireProposal(0))
                .to.emit(governance, "ProposalExpired")
                .withArgs(0);

            const proposal = await governance.getProposal(0);
            expect(proposal.status).to.equal(4); // EXPIRED
        });

        it("should revert expireProposal if not expired yet", async function () {
            await governance.connect(owner).createProposal(0, "Fresh", "0x", "", ethers.ZeroAddress);
            await expect(governance.expireProposal(0)).to.revert(ethers);
        });
    });

    // =========================================================================
    //                      CONFIGURATION
    // =========================================================================
    describe("Configuration", function () {
        it("should set flood prediction contract address", async function () {
            // M-08: setFloodPredictionContract now requires code.length > 0, use a deployed contract
            const OpalGov = await ethers.getContractFactory("OpalGovernanceUpgradeable");
            const dummy = await ozUpgrades.deployProxy(OpalGov, [owner.address, 2], { kind: "uups" });
            await dummy.waitForDeployment();
            await governance.setFloodPredictionContract(dummy.target);
            expect(await governance.floodPredictionContract()).to.equal(dummy.target);
        });

        it("should revert setting zero address", async function () {
            await expect(
                governance.setFloodPredictionContract(ethers.ZeroAddress)
            ).to.revert(ethers);
        });

        it("should revert if not owner", async function () {
            const OpalGov = await ethers.getContractFactory("OpalGovernanceUpgradeable");
            const dummy = await ozUpgrades.deployProxy(OpalGov, [owner.address, 2], { kind: "uups" });
            await dummy.waitForDeployment();
            await expect(
                governance.connect(actor1).setFloodPredictionContract(dummy.target)
            ).to.be.revertedWithCustomError(governance, "OwnableUnauthorizedAccount");
        });
    });

    // =========================================================================
    //                      VIEW FUNCTIONS / STATS
    // =========================================================================
    describe("View Functions", function () {
        beforeEach(async function () {
            await governance.addGovernanceActor(actor1.address, "Gov1", "GOVERNOR");
            await governance.addGovernanceActor(actor2.address, "Gov2", "GOVERNOR");
        });

        it("should return governance stats", async function () {
            await governance.connect(owner).createProposal(0, "P1", "0x", "", ethers.ZeroAddress);
            await governance.connect(actor1).signProposal(0);

            // M-10: advance time past timelock before executing
            await networkHelpers.time.increase(3601);

            await governance.connect(actor2).executeProposal(0);

            const [totalProposals, executed, actors_, currentQuorum] = await governance.getStats();
            expect(totalProposals).to.equal(1);
            expect(executed).to.equal(1);
            expect(actors_).to.equal(3);
            expect(currentQuorum).to.equal(2);
        });

        it("should return quorum", async function () {
            expect(await governance.getQuorum()).to.equal(2);
        });

        it("should return active actor count", async function () {
            expect(await governance.getActiveActorCount()).to.equal(3);
        });
    });
});
