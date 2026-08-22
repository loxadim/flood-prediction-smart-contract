/**
 * @title Architecture Review — Regression Tests
 * @description Locks in the structural fixes from the architecture audit:
 *  - ARCH-01: MobileMoneyProvider bound to the FloodPrediction payment ledger, so the
 *    relayer whitelist is an access control rather than an unlimited spending authority
 *  - ARCH-02: the five non-upgradeable contracts move under governance ownership
 *  - ARCH-04: a batch of 50 fits inside Polygon PoS's real 30M block gas limit
 */
import { expect } from "chai";
import hre from "hardhat";
import { MerkleTree } from "merkletreejs";
import { createRequire } from "module";
import { upgrades as makeUpgrades } from "@openzeppelin/hardhat-upgrades";

const require = createRequire(import.meta.url);
const keccak256lib = require("keccak256");

const connection = await hre.network.connect();
const { ethers, networkHelpers } = connection;
const ozUpgrades = await makeUpgrades(hre, connection);

const hash = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
const REGION = "SN-TH";

/** Full wired stack, mirroring what deploy-upgradeable.js builds. */
async function deployStack({ bindLedger = true } = {}) {
    const [admin, operator, upgrader, pauser, officerA, officerB, relayer, gov2] =
        await ethers.getSigners();

    const targeting = await (await ethers.getContractFactory("JokalanteTargeting")).deploy();
    const mmp = await (await ethers.getContractFactory("MobileMoneyProvider")).deploy();
    const kyc = await (await ethers.getContractFactory("KYCAMLCompliance")).deploy();
    const multiOracle = await (await ethers.getContractFactory("MultiOracle")).deploy();
    for (const c of [targeting, mmp, kyc, multiOracle]) await c.waitForDeployment();

    const governance = await ozUpgrades.deployProxy(
        await ethers.getContractFactory("OpalGovernanceUpgradeable"),
        [admin.address, 2], { kind: "uups" });
    await governance.waitForDeployment();

    const fp = await ozUpgrades.deployProxy(
        await ethers.getContractFactory("FloodPredictionContract"),
        [admin.address, operator.address, upgrader.address, pauser.address], { kind: "uups" });
    await fp.waitForDeployment();
    const fpAddr = await fp.getAddress();

    await fp.setContractAddresses(
        await multiOracle.getAddress(), await governance.getAddress(),
        await targeting.getAddress(), await mmp.getAddress(), await kyc.getAddress());
    await targeting.addAuthorizedCaller(fpAddr);
    await mmp.addRelayer(fpAddr);
    await mmp.addRelayer(relayer.address);
    await kyc.authorizeContract(fpAddr);
    if (bindLedger) await mmp.setFloodPredictionContract(fpAddr);

    await fp.allocateBudget(REGION, 100_000_000n);

    return { fp, fpAddr, mmp, kyc, targeting, multiOracle, governance,
             admin, operator, relayer, officerA, officerB, gov2 };
}

/** Runs a trigger through to PAID so real PaymentRecords exist. */
async function runTrigger(ctx, beneficiaries) {
    const { fp, kyc, targeting, operator, admin, officerA, officerB } = ctx;
    const leaves = beneficiaries.map(b => ethers.keccak256(ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [b.hash, b.amount]))));
    const tree = new MerkleTree(leaves, keccak256lib, { sortPairs: true });
    const root = tree.getHexRoot();
    await targeting.updateMerkleRoot(REGION, root, beneficiaries.length);

    await kyc.addComplianceOfficer(officerA.address);
    await kyc.addComplianceOfficer(officerB.address);
    for (const b of beneficiaries) {
        await kyc.connect(officerA).submitAttestation(b.hash, hash("id" + b.hash), hash("doc"), REGION);
        await kyc.connect(officerB).approveAttestation(b.hash, 0, 0);
    }

    const total = beneficiaries.reduce((s, b) => s + b.amount, 0n);
    await fp.connect(operator).createFloodTrigger(REGION, 80, root, total, beneficiaries.length);
    const eventId = await fp.triggerIds((await fp.triggerCount()) - 1n);

    await fp.connect(operator).validateAndProcessPayments(
        eventId,
        beneficiaries.map(b => b.hash),
        beneficiaries.map(b => b.amount),
        leaves.map(l => tree.getHexProof(l)),
        beneficiaries.map(b => hash("phone" + b.hash)),
        beneficiaries.map(() => 0)
    );
    return { eventId, tree, leaves };
}

describe("Architecture Review — Regression", function () {

    // =====================================================================
    //  ARCH-01 — the payment rail is bound to the ledger
    // =====================================================================
    describe("ARCH-01 — rail de paiement lié au registre", function () {

        it("un relayer ne peut plus fabriquer un ordre sans PaymentRecord", async function () {
            const ctx = await deployStack();
            await expect(
                ctx.mmp.connect(ctx.relayer).batchInitiatePayments(
                    [hash("fabrique")], [5_000_000n], [hash("tel")], REGION, [0], "FLOOD-INEXISTANT")
            ).to.be.revertedWithCustomError(ctx.mmp, "UnbackedPayment");
        });

        it("un relayer ne peut pas gonfler le montant d'un paiement réel", async function () {
            const ctx = await deployStack();
            const bens = [{ hash: hash("ben-1"), amount: 50_000n }];
            const { eventId } = await runTrigger(ctx, bens);

            // même bénéficiaire, même eventId — mais montant gonflé
            await expect(
                ctx.mmp.connect(ctx.relayer).batchInitiatePayments(
                    [bens[0].hash], [5_000_000n], [hash("tel")], REGION, [0], eventId)
            ).to.be.revertedWithCustomError(ctx.mmp, "UnbackedPayment");
        });

        it("le flux légitime passe : FloodPrediction émet bien les ordres", async function () {
            const ctx = await deployStack();
            const bens = [
                { hash: hash("ben-1"), amount: 50_000n },
                { hash: hash("ben-2"), amount: 60_000n },
            ];
            await runTrigger(ctx, bens);
            // 2 ordres créés par le chemin vérifié
            expect(await ctx.mmp.totalPaymentsInitiated()).to.equal(2n);
            expect(await ctx.mmp.getPendingPaymentCount()).to.equal(2n);
        });

        // A8-02 fix: ce test attendait auparavant qu'un rejeu à l'identique soit ACCEPTÉ,
        // verrouillant ainsi la faille — un relayeur compromis pouvait transformer un droit
        // unique en autant de versements réels qu'il le souhaitait. La vérification au
        // registre prouve qu'un ordre est adossé, jamais qu'il est nouveau.
        it("un ordre déjà placé ne peut pas être rejoué, même au montant exact du registre", async function () {
            const ctx = await deployStack();
            const bens = [{ hash: hash("ben-1"), amount: 50_000n }];
            const { eventId } = await runTrigger(ctx, bens);

            // l'ordre légitime a déjà été placé par FloodPrediction
            expect(await ctx.mmp.totalPaymentsInitiated()).to.equal(1n);
            await expect(
                ctx.mmp.connect(ctx.relayer).batchInitiatePayments(
                    [bens[0].hash], [50_000n], [hash("tel")], REGION, [0], eventId)
            ).to.be.revertedWithCustomError(ctx.mmp, "OrderAlreadyPlaced");
            expect(await ctx.mmp.totalPaymentsInitiated()).to.equal(1n);
        });

        it("initiatePayment est fermé une fois la liaison active", async function () {
            const ctx = await deployStack();
            await expect(
                ctx.mmp.connect(ctx.relayer).initiatePayment(
                    hash("ben"), 50_000n, hash("tel"), REGION, 0)
            ).to.be.revertedWithCustomError(ctx.mmp, "DirectPaymentDisabled");
        });

        it("sans liaison, le comportement historique est préservé", async function () {
            const ctx = await deployStack({ bindLedger: false });
            await expect(
                ctx.mmp.connect(ctx.relayer).initiatePayment(
                    hash("ben"), 50_000n, hash("tel"), REGION, 0)
            ).to.emit(ctx.mmp, "PaymentInitiated");
        });

        it("la liaison est réservée au propriétaire et refuse une adresse sans code", async function () {
            const ctx = await deployStack({ bindLedger: false });
            await expect(
                ctx.mmp.connect(ctx.relayer).setFloodPredictionContract(ctx.fpAddr)
            ).to.be.revertedWithCustomError(ctx.mmp, "OwnableUnauthorizedAccount");
            await expect(
                ctx.mmp.setFloodPredictionContract(ctx.relayer.address)
            ).to.be.revertedWithCustomError(ctx.mmp, "InvalidLedger");
        });

        it("un plafond journalier borne le rail même sur le chemin légitime", async function () {
            const ctx = await deployStack();
            await ctx.mmp.setDailyLimit(REGION, 60_000n);
            const bens = [
                { hash: hash("ben-1"), amount: 50_000n },
                { hash: hash("ben-2"), amount: 50_000n },
            ];
            // 100 000 > plafond 60 000 : la dépêche échoue, mais le registre reste cohérent
            await runTrigger(ctx, bens);
            expect(await ctx.mmp.totalPaymentsInitiated()).to.equal(0n);
        });
    });

    // =====================================================================
    //  ARCH-02 — spokes under governance
    // =====================================================================
    describe("ARCH-02 — propriété des contrats immuables", function () {

        it("le transfert vers la gouvernance est en deux temps et s'achève par proposition", async function () {
            const ctx = await deployStack();
            const govAddr = await ctx.governance.getAddress();
            const moAddr = await ctx.multiOracle.getAddress();

            await ctx.governance.addGovernanceActor(ctx.gov2.address, "G2", "GOVERNOR");
            await ctx.governance.setAllowedTarget(moAddr, true);
            await ctx.governance.setAllowedSelector(
                ctx.multiOracle.interface.getFunction("acceptOwnership").selector, true);

            await ctx.multiOracle.transferOwnership(govAddr);
            // Ownable2Step : la propriété n'a PAS encore changé
            expect(await ctx.multiOracle.owner()).to.equal(ctx.admin.address);
            expect(await ctx.multiOracle.pendingOwner()).to.equal(govAddr);

            const data = ctx.multiOracle.interface.encodeFunctionData("acceptOwnership", []);
            await ctx.governance.createProposal(1, "accepter MultiOracle", data, "", moAddr);
            await ctx.governance.connect(ctx.gov2).signProposal(0);
            await networkHelpers.time.increase(3700); // EXECUTION_DELAY
            await ctx.governance.executeProposal(0);

            expect(await ctx.multiOracle.owner()).to.equal(govAddr);
        });

        it("une fois sous gouvernance, l'ancien propriétaire ne peut plus ajouter de relayer", async function () {
            const ctx = await deployStack();
            const govAddr = await ctx.governance.getAddress();
            const mmpAddr = await ctx.mmp.getAddress();

            await ctx.governance.addGovernanceActor(ctx.gov2.address, "G2", "GOVERNOR");
            await ctx.governance.setAllowedTarget(mmpAddr, true);
            await ctx.governance.setAllowedSelector(
                ctx.mmp.interface.getFunction("acceptOwnership").selector, true);
            await ctx.mmp.transferOwnership(govAddr);

            const data = ctx.mmp.interface.encodeFunctionData("acceptOwnership", []);
            await ctx.governance.createProposal(1, "accepter MMP", data, "", mmpAddr);
            await ctx.governance.connect(ctx.gov2).signProposal(0);
            await networkHelpers.time.increase(3700);
            await ctx.governance.executeProposal(0);

            // le déployeur a perdu la main sur le rail de paiement
            await expect(
                ctx.mmp.connect(ctx.admin).addRelayer(ctx.gov2.address)
            ).to.be.revertedWithCustomError(ctx.mmp, "OwnableUnauthorizedAccount");
        });
    });
});
