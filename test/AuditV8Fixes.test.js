/**
 * @title Audit Round 8 — Regression Tests
 * @description Locks in the fixes for the round-8 findings:
 *  - A8-01: no gas floor before the Mobile Money dispatch, so a caller's gas shortfall
 *           was recorded as a provider failure — beneficiary paid, budget debited,
 *           no transfer order in existence
 *  - A8-02: the ARCH-01 ledger check proved an order was backed, never that it was new,
 *           so a whitelisted relayer could replay one entitlement into many payouts
 *  - A8-03: a single compliance officer makes the four-eyes rule unsatisfiable, so no
 *           attestation can be approved and no beneficiary can be paid
 *  - A8-05: simulation mode was inferred from a missing API key instead of chosen
 *  - A8-06: payments were executed without checking they were still PENDING on-chain
 *  - A8-10: the TLS certificate monitor had no endpoints registered and ran empty
 */
import { expect } from "chai";
import hre from "hardhat";
import { MerkleTree } from "merkletreejs";
import { createRequire } from "module";
import { upgrades as makeUpgrades } from "@openzeppelin/hardhat-upgrades";
import { assertPaymentModeConfigured, assertSimulationAllowed } from "../relayer/config.js";
import { certificateMonitor } from "../relayer/security.js";

const require = createRequire(import.meta.url);
const keccak256lib = require("keccak256");

const connection = await hre.network.connect();
const { ethers } = connection;
const ozUpgrades = await makeUpgrades(hre, connection);

const hash = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
const REGION = "SN-TH";
const paymentKey = (eventId, beneficiaryHash) => ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32"], [eventId, beneficiaryHash]));

async function deployStack({ bindLedger = true } = {}) {
    const [admin, operator, upgrader, pauser, officerA, officerB, relayer] = await ethers.getSigners();

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
    await fp.allocateBudget(REGION, 1_000_000_000n);

    return { fp, fpAddr, mmp, kyc, targeting, governance, admin, operator, relayer, officerA, officerB };
}

function buildTree(bens) {
    const leaves = bens.map(b => ethers.keccak256(ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [b.hash, b.amount]))));
    const tree = new MerkleTree(leaves, keccak256lib, { sortPairs: true });
    return { leaves, tree, root: tree.getHexRoot() };
}

/** Prepares a trigger ready to pay and returns the call arguments for one batch. */
async function prepare(ctx, bens) {
    const { leaves, tree, root } = buildTree(bens);
    await ctx.targeting.updateMerkleRoot(REGION, root, bens.length);
    await ctx.kyc.addComplianceOfficer(ctx.officerA.address);
    await ctx.kyc.addComplianceOfficer(ctx.officerB.address);
    for (const b of bens) {
        await ctx.kyc.connect(ctx.officerA).submitAttestation(b.hash, hash("id" + b.hash), hash("doc"), REGION);
        await ctx.kyc.connect(ctx.officerB).approveAttestation(b.hash, 0, 0);
    }
    const total = bens.reduce((s, b) => s + b.amount, 0n);
    await ctx.fp.connect(ctx.operator).createFloodTrigger(REGION, 80, root, total, bens.length);
    const eventId = await ctx.fp.triggerIds((await ctx.fp.triggerCount()) - 1n);
    const args = [eventId, bens.map(b => b.hash), bens.map(b => b.amount),
                  leaves.map(l => tree.getHexProof(l)), bens.map(b => hash("p" + b.hash)), bens.map(() => 0)];
    return { eventId, args };
}

describe("Audit Round 8 — Regression", function () {

    // =====================================================================
    //  A8-01 — plancher de gaz sur le chemin de l'argent
    // =====================================================================
    describe("A8-01 — dépêche Mobile Money et manque de gaz", function () {

        it("un gaz insuffisant reverte au lieu de perdre l'ordre en silence", async function () {
            const ctx = await deployStack();
            const bens = [{ hash: hash("ben-1"), amount: 500_000n }];
            const { eventId, args } = await prepare(ctx, bens);

            // 814 496 était l'estimation produite AVANT le correctif : le montant exact
            // qui laissait l'appel interne manquer de gaz. La règle EIP-150 ne transmet
            // que 63/64 du reliquat, et un appelé qui épuise son allocation la consomme
            // entièrement — c'est ce qui distingue un manque de gaz d'une panne métier.
            await expect(
                ctx.fp.connect(ctx.operator).validateAndProcessPayments(...args, { gasLimit: 814_496n })
            ).to.be.revertedWithCustomError(ctx.fp, "InsufficientDispatchGas");

            // L'état est intact : ni bénéficiaire marqué payé, ni budget débité, ni ordre.
            expect(await ctx.fp.isBeneficiaryPaid(eventId, bens[0].hash)).to.equal(false);
            expect(await ctx.fp.totalAmountDisbursed()).to.equal(0n);
            expect(await ctx.mmp.totalPaymentsInitiated()).to.equal(0n);
        });

        it("l'estimation de gaz redevient fiable : l'envoi par défaut aboutit", async function () {
            const ctx = await deployStack();
            const bens = [{ hash: hash("ben-1"), amount: 500_000n }];
            const { eventId, args } = await prepare(ctx, bens);

            // Effet de bord du correctif, et le plus utile : tant que le catch avalait le
            // manque de gaz, la transaction « réussissait » à bas gaz et la recherche
            // binaire de l'estimateur convergeait vers ce chemin dégradé. Maintenant qu'il
            // reverte, l'estimateur est contraint de trouver un plafond où la dépêche
            // aboutit réellement — le flux ethers par défaut redevient correct.
            const est = await ctx.fp.connect(ctx.operator).validateAndProcessPayments.estimateGas(...args);
            expect(est).to.be.greaterThan(814_496n);

            await ctx.fp.connect(ctx.operator).validateAndProcessPayments(...args, { gasLimit: est });
            expect(await ctx.mmp.totalPaymentsInitiated()).to.equal(1n);
            expect(await ctx.fp.mobileMoneyDispatched(paymentKey(eventId, bens[0].hash))).to.equal(true);
        });

        it("avec une marge de gaz, la dépêche aboutit normalement", async function () {
            const ctx = await deployStack();
            const bens = [{ hash: hash("ben-1"), amount: 500_000n }];
            const { eventId, args } = await prepare(ctx, bens);
            const est = await ctx.fp.connect(ctx.operator).validateAndProcessPayments.estimateGas(...args);

            await ctx.fp.connect(ctx.operator).validateAndProcessPayments(
                ...args, { gasLimit: (est * 125n) / 100n });

            expect(await ctx.mmp.totalPaymentsInitiated()).to.equal(1n);
            expect(await ctx.fp.mobileMoneyDispatched(paymentKey(eventId, bens[0].hash))).to.equal(true);
        });

        it("une panne métier du fournisseur reste absorbée, sans reverter la transaction", async function () {
            const ctx = await deployStack();
            // Plafond journalier sous le total du lot : MobileMoneyProvider reverte avec
            // DailyLimitExceeded. C'est une vraie panne opérateur, pas un manque de gaz —
            // le découplage H-03 doit continuer de s'appliquer.
            await ctx.mmp.setDailyLimit(REGION, 100_000n);
            const bens = [{ hash: hash("ben-1"), amount: 500_000n }];
            const { eventId, args } = await prepare(ctx, bens);

            await expect(ctx.fp.connect(ctx.operator).validateAndProcessPayments(
                ...args, { gasLimit: 3_000_000n })
            ).to.emit(ctx.fp, "MobileMoneyPaymentsFailed");

            // Le registre est finalisé, la dépêche non — c'est l'état que
            // retryMobileMoneyDispatch sait rattraper.
            expect(await ctx.fp.isBeneficiaryPaid(eventId, bens[0].hash)).to.equal(true);
            expect(await ctx.fp.mobileMoneyDispatched(paymentKey(eventId, bens[0].hash))).to.equal(false);
        });
    });

    // =====================================================================
    //  A8-02 — un ordre adossé n'est pas un ordre neuf
    // =====================================================================
    describe("A8-02 — rejeu d'un ordre de paiement", function () {

        it("un relayeur ne peut pas rejouer un PaymentRecord déjà servi", async function () {
            const ctx = await deployStack();
            const bens = [{ hash: hash("ben-1"), amount: 500_000n }];
            const { eventId } = await prepare(ctx, bens);
            await ctx.fp.connect(ctx.operator).validateAndProcessPayments(
                eventId, [bens[0].hash], [bens[0].amount],
                [buildTree(bens).tree.getHexProof(buildTree(bens).leaves[0])],
                [hash("p" + bens[0].hash)], [0], { gasLimit: 2_000_000n });

            expect(await ctx.mmp.totalPaymentsInitiated()).to.equal(1n);
            await expect(
                ctx.mmp.connect(ctx.relayer).batchInitiatePayments(
                    [bens[0].hash], [500_000n], [hash("tel")], REGION, [0], eventId)
            ).to.be.revertedWithCustomError(ctx.mmp, "OrderAlreadyPlaced");
            expect(await ctx.mmp.totalPaymentsInitiated()).to.equal(1n);
        });

        it("le verrou est enregistré on-chain et consultable", async function () {
            const ctx = await deployStack();
            const bens = [{ hash: hash("ben-1"), amount: 500_000n }];
            const { eventId } = await prepare(ctx, bens);
            const ref = paymentKey(eventId, bens[0].hash);
            expect(await ctx.mmp.orderPlaced(ref)).to.equal(false);

            const t = buildTree(bens);
            await ctx.fp.connect(ctx.operator).validateAndProcessPayments(
                eventId, [bens[0].hash], [bens[0].amount], [t.tree.getHexProof(t.leaves[0])],
                [hash("p" + bens[0].hash)], [0], { gasLimit: 2_000_000n });

            expect(await ctx.mmp.orderPlaced(ref)).to.equal(true);
        });

        it("RÉGRESSION : une dépêche échouée reste rattrapable par retryMobileMoneyDispatch", async function () {
            const ctx = await deployStack();
            // Le plafond journalier fait échouer la première dépêche.
            await ctx.mmp.setDailyLimit(REGION, 100_000n);
            const bens = [{ hash: hash("ben-1"), amount: 500_000n }];
            const { eventId, args } = await prepare(ctx, bens);
            await ctx.fp.connect(ctx.operator).validateAndProcessPayments(...args, { gasLimit: 3_000_000n });

            // Le verrou A8-02 a été annulé avec le reste de l'appel : il ne bloque pas la reprise.
            expect(await ctx.mmp.orderPlaced(paymentKey(eventId, bens[0].hash))).to.equal(false);

            await ctx.mmp.setDailyLimit(REGION, 10_000_000n);   // panne corrigée
            await ctx.fp.connect(ctx.operator).retryMobileMoneyDispatch(
                eventId, [bens[0].hash], [bens[0].amount], [hash("p" + bens[0].hash)], [0]);

            expect(await ctx.mmp.totalPaymentsInitiated()).to.equal(1n);
            expect(await ctx.fp.mobileMoneyDispatched(paymentKey(eventId, bens[0].hash))).to.equal(true);
        });

        it("une seconde reprise après succès reste refusée des deux côtés", async function () {
            const ctx = await deployStack();
            await ctx.mmp.setDailyLimit(REGION, 100_000n);
            const bens = [{ hash: hash("ben-1"), amount: 500_000n }];
            const { eventId, args } = await prepare(ctx, bens);
            await ctx.fp.connect(ctx.operator).validateAndProcessPayments(...args, { gasLimit: 3_000_000n });
            await ctx.mmp.setDailyLimit(REGION, 10_000_000n);
            await ctx.fp.connect(ctx.operator).retryMobileMoneyDispatch(
                eventId, [bens[0].hash], [bens[0].amount], [hash("p" + bens[0].hash)], [0]);

            // Côté hub : garde-fou V-05.
            await expect(ctx.fp.connect(ctx.operator).retryMobileMoneyDispatch(
                eventId, [bens[0].hash], [bens[0].amount], [hash("p" + bens[0].hash)], [0])
            ).to.be.revertedWithCustomError(ctx.fp, "PaymentAlreadyDispatched");

            // Côté rail : garde-fou A8-02, atteignable même en contournant le hub.
            await expect(ctx.mmp.connect(ctx.relayer).batchInitiatePayments(
                [bens[0].hash], [500_000n], [hash("tel")], REGION, [0], eventId)
            ).to.be.revertedWithCustomError(ctx.mmp, "OrderAlreadyPlaced");
        });

        it("un déploiement non lié au registre conserve son comportement historique", async function () {
            const ctx = await deployStack({ bindLedger: false });
            // Sans liaison, aucun eventId à indexer : le verrou ne s'applique pas.
            await expect(ctx.mmp.connect(ctx.relayer).batchInitiatePayments(
                [hash("libre")], [500_000n], [hash("tel")], REGION, [0], "")
            ).to.emit(ctx.mmp, "PaymentInitiated");
            await expect(ctx.mmp.connect(ctx.relayer).batchInitiatePayments(
                [hash("libre")], [500_000n], [hash("tel")], REGION, [0], "")
            ).to.emit(ctx.mmp, "PaymentInitiated");
        });
    });

    // =====================================================================
    //  A8-08 — l'instantané Merkle protège aussi la disponibilité
    // =====================================================================
    describe("A8-08 — rotation de la liste de bénéficiaires", function () {

        it("publier une nouvelle liste ne bloque plus les lots restants d'un événement en cours", async function () {
            const ctx = await deployStack();
            const bens = [{ hash: hash("b1"), amount: 500_000n },
                          { hash: hash("b2"), amount: 500_000n }];
            const { leaves, tree, root } = buildTree(bens);
            await ctx.targeting.updateMerkleRoot(REGION, root, 2);
            await ctx.kyc.addComplianceOfficer(ctx.officerA.address);
            await ctx.kyc.addComplianceOfficer(ctx.officerB.address);
            for (const b of bens) {
                await ctx.kyc.connect(ctx.officerA).submitAttestation(b.hash, hash("id" + b.hash), hash("doc"), REGION);
                await ctx.kyc.connect(ctx.officerB).approveAttestation(b.hash, 0, 0);
            }
            await ctx.fp.connect(ctx.operator).createFloodTrigger(REGION, 80, root, 1_000_000n, 2);
            const eventId = await ctx.fp.triggerIds((await ctx.fp.triggerCount()) - 1n);

            await ctx.fp.connect(ctx.operator).validateAndProcessPayments(
                eventId, [bens[0].hash], [bens[0].amount], [tree.getHexProof(leaves[0])],
                [hash("t1")], [0], { gasLimit: 2_000_000n });

            // Nouvelle liste publiée pour la région pendant que l'événement est en cours.
            const other = buildTree([{ hash: hash("b9"), amount: 500_000n }]);
            await ctx.targeting.updateMerkleRoot(REGION, other.root, 1);

            // La preuve reste valide contre l'instantané figé à la création (A20).
            await ctx.fp.connect(ctx.operator).processBatchPayment(
                eventId, [bens[1].hash], [bens[1].amount], [tree.getHexProof(leaves[1])],
                [hash("t2")], [0], { gasLimit: 2_000_000n });

            expect(await ctx.fp.isBeneficiaryPaid(eventId, bens[1].hash)).to.equal(true);
            expect((await ctx.fp.getFloodTrigger(eventId)).status).to.equal(4); // PAID
        });

        it("une preuve étrangère à l'instantané reste rejetée", async function () {
            const ctx = await deployStack();
            const bens = [{ hash: hash("vrai"), amount: 500_000n }];
            const { eventId } = await prepare(ctx, bens);

            // L'intrus est mis en conformité KYC, pour que le test isole bien la
            // vérification Merkle et n'échoue pas plus tôt sur le contrôle de conformité.
            const intrus = hash("intrus");
            await ctx.kyc.connect(ctx.officerA).submitAttestation(intrus, hash("id-intrus"), hash("doc"), REGION);
            await ctx.kyc.connect(ctx.officerB).approveAttestation(intrus, 0, 0);

            const forged = buildTree([{ hash: intrus, amount: 500_000n }]);
            await expect(ctx.fp.connect(ctx.operator).validateAndProcessPayments(
                eventId, [intrus], [500_000n], [forged.tree.getHexProof(forged.leaves[0])],
                [hash("t")], [0], { gasLimit: 2_000_000n })
            ).to.be.revertedWithCustomError(ctx.fp, "InvalidMerkleProof");
        });

        it("désactiver une région bloque toujours les paiements (garde conservée)", async function () {
            const ctx = await deployStack();
            const bens = [{ hash: hash("c1"), amount: 500_000n },
                          { hash: hash("c2"), amount: 500_000n }];
            const { leaves, tree, root } = buildTree(bens);
            await ctx.targeting.updateMerkleRoot(REGION, root, 2);
            await ctx.kyc.addComplianceOfficer(ctx.officerA.address);
            await ctx.kyc.addComplianceOfficer(ctx.officerB.address);
            for (const b of bens) {
                await ctx.kyc.connect(ctx.officerA).submitAttestation(b.hash, hash("id" + b.hash), hash("doc"), REGION);
                await ctx.kyc.connect(ctx.officerB).approveAttestation(b.hash, 0, 0);
            }
            await ctx.fp.connect(ctx.operator).createFloodTrigger(REGION, 80, root, 1_000_000n, 2);
            const eventId = await ctx.fp.triggerIds((await ctx.fp.triggerCount()) - 1n);
            await ctx.fp.connect(ctx.operator).validateAndProcessPayments(
                eventId, [bens[0].hash], [bens[0].amount], [tree.getHexProof(leaves[0])],
                [hash("t1")], [0], { gasLimit: 2_000_000n });

            // Désactiver une région est une décision d'administration délibérée : elle
            // DOIT arrêter les versements, contrairement à une rotation de liste.
            await ctx.targeting.deactivateRegion(REGION);
            await expect(ctx.fp.connect(ctx.operator).processBatchPayment(
                eventId, [bens[1].hash], [bens[1].amount], [tree.getHexProof(leaves[1])],
                [hash("t2")], [0], { gasLimit: 2_000_000n })
            ).to.be.revertedWithCustomError(ctx.fp, "RegionNotActive");
        });
    });

    // =====================================================================
    //  A8-03 — la règle des quatre yeux doit être satisfiable
    // =====================================================================
    describe("A8-03 — officiers de conformité", function () {

        it("un officier unique rend toute approbation impossible (état à corriger au déploiement)", async function () {
            const kyc = await (await ethers.getContractFactory("KYCAMLCompliance")).deploy();
            await kyc.waitForDeployment();
            expect(await kyc.officerCount()).to.equal(1n);

            const b = hash("ben-seul");
            await kyc.submitAttestation(b, hash("id"), hash("doc"), REGION);
            await expect(kyc.approveAttestation(b, 0, 0))
                .to.be.revertedWithCustomError(kyc, "SelfApprovalNotAllowed");
        });

        it("avec deux officiers, le cycle complet aboutit", async function () {
            const [, , , , officerA] = await ethers.getSigners();
            const kyc = await (await ethers.getContractFactory("KYCAMLCompliance")).deploy();
            await kyc.waitForDeployment();
            await kyc.addComplianceOfficer(officerA.address);
            expect(await kyc.officerCount()).to.equal(2n);

            const b = hash("ben-ok");
            await kyc.connect(officerA).submitAttestation(b, hash("id"), hash("doc"), REGION);
            await kyc.approveAttestation(b, 0, 0);
            expect((await kyc.getAttestation(b)).status).to.equal(2); // VERIFIED
        });
    });

    // =====================================================================
    //  A8-05 / A8-06 / A8-10 — garde-fous du relayeur
    // =====================================================================
    describe("A8-05 — le mode de paiement est choisi, jamais déduit", function () {

        it("aucune clé opérateur et pas de drapeau explicite : démarrage refusé", function () {
            expect(() => assertPaymentModeConfigured({
                simulatePayments: false,
                providerApiKeys: { ORANGE_MONEY: null, WAVE: null, FREE_MONEY: null, EMONEY: null },
            })).to.throw(/SIMULATE_PAYMENTS is not set/);
        });

        it("une clé opérateur suffit à démarrer en mode réel", function () {
            expect(() => assertPaymentModeConfigured({
                simulatePayments: false,
                providerApiKeys: { ORANGE_MONEY: "k", WAVE: null, FREE_MONEY: null, EMONEY: null },
            })).to.not.throw();
        });

        it("la simulation explicite est acceptée sans clé", function () {
            expect(() => assertPaymentModeConfigured({
                simulatePayments: true,
                providerApiKeys: { ORANGE_MONEY: null, WAVE: null, FREE_MONEY: null, EMONEY: null },
            })).to.not.throw();
        });

        it("la simulation est refusée hors d'une chaîne locale", function () {
            expect(() => assertSimulationAllowed(31337n, true)).to.not.throw();
            expect(() => assertSimulationAllowed(1337n, true)).to.not.throw();
            expect(() => assertSimulationAllowed(80002n, true)).to.throw(/not a local network/);
            expect(() => assertSimulationAllowed(137n, true)).to.throw(/not a local network/);
        });

        it("le mode réel n'est jamais bloqué par la garde de chaîne", function () {
            expect(() => assertSimulationAllowed(137n, false)).to.not.throw();
        });
    });

    describe("A8-10 — la surveillance TLS a des points à inspecter", function () {

        it("registerEndpoint alimente le moniteur, qui n'itérait rien auparavant", async function () {
            certificateMonitor.registerEndpoint("TEST_PROVIDER", "https://127.0.0.1:1/api");
            expect(certificateMonitor.endpoints.TEST_PROVIDER).to.equal("https://127.0.0.1:1/api");

            // Point injoignable : le moniteur le signale au lieu de rester muet.
            const warnings = await certificateMonitor.checkCertificates();
            const warn = warnings.find((w) => w.provider === "TEST_PROVIDER");
            expect(warn, "un point injoignable doit produire un avertissement").to.exist;
            delete certificateMonitor.endpoints.TEST_PROVIDER;
        });
    });
});
