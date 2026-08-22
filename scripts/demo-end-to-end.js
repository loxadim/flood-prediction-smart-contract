/**
 * @title Démonstration bout en bout — OPAL Platform
 * @description Déroule un scénario d'inondation complet à Thiès (SN-TH), de la donnée
 * satellite jusqu'au paiement Mobile Money confirmé, en exerçant les 7 contrats de
 * production et le service relayer.
 *
 * Étapes jouées :
 *   0. Déploiement et câblage des 7 contrats (rôles gouvernance inclus)
 *   1. Soumission d'une observation satellite (WASDIOracleConnector)
 *   2. Consensus multi-oracles avec médiane et détection d'aberrants (MultiOracle)
 *   3. Ciblage des bénéficiaires par arbre de Merkle + attestations KYC 4-eyes
 *   4. Déclenchement paramétrique contre-vérifié par le consensus (FloodPredictionContract)
 *   5. Vérification des preuves, paiement du lot, ordres Mobile Money
 *   6. Exécution hors chaîne par le relayer (mode simulation)
 *   7. Règlement on-chain (batchConfirmPayments)
 *   8. État final et piste d'audit
 *
 * Réseaux locaux uniquement — le script déploie et émet de nombreuses transactions.
 *
 * Usage :
 *   npm run demo
 *   npx hardhat run scripts/demo-end-to-end.js
 */
import hre from "hardhat";
import fs from "node:fs/promises";
import { MerkleTree } from "merkletreejs";
import { createRequire } from "module";
import { upgrades as makeUpgrades } from "@openzeppelin/hardhat-upgrades";

const require = createRequire(import.meta.url);
const keccak256lib = require("keccak256");

const connection = await hre.network.connect();
const { ethers } = connection;
const ozUpgrades = await makeUpgrades(hre, connection);

// Ce script déploie et dépense : réseaux locaux uniquement.
// La lecture du réseau est encadrée (même raison que le correctif A75 dans
// verify-deployment.js) : c'est la première requête RPC, donc l'endroit où se manifeste
// un nœud injoignable — sans garde, on obtient une trace Hardhat au lieu de la cause.
const LOCAL_CHAIN_IDS = [1337n, 31337n];
let chainId;
try {
    ({ chainId } = await ethers.provider.getNetwork());
} catch (e) {
    const cause = e?.cause?.cause?.message ?? e?.cause?.message ?? e.message;
    console.error("\n  ❌ Nœud injoignable — impossible de déterminer le réseau.");
    console.error(`     ${cause}\n`);
    process.exit(1);
}
if (!LOCAL_CHAIN_IDS.includes(chainId)) {
    console.error(`\n  ❌ Refus d'exécution : chainId ${chainId} n'est pas un réseau local.`);
    console.error("     Cette démonstration déploie 7 contrats et émet de nombreuses transactions.\n");
    process.exit(1);
}

// ---------------------------------------------------------------------
// Présentation
// ---------------------------------------------------------------------
const RULE = (n) => "─".repeat(n);
const step = (n, t) => console.log(`\n\x1b[1m${RULE(2)} ${n}. ${t} ${RULE(Math.max(2, 62 - t.length))}\x1b[0m`);
const say = (m) => console.log(`   ${m}`);
const bold = (m) => `\x1b[1m${m}\x1b[0m`;
const fcfa = (n) => Number(n).toLocaleString("fr-FR") + " FCFA";

const TRIGGER_STATUS = ["INACTIVE", "PENDING", "ACTIVE", "VALIDATED", "PAID", "EXPIRED", "CANCELLED"];
const RISK_LEVEL = ["LOW", "MODERATE", "HIGH", "CRITICAL"];
const PAYMENT_STATUS = ["PENDING", "CONFIRMED", "FAILED", "EXPIRED", "CANCELLED"];
const PROVIDERS = ["ORANGE_MONEY", "WAVE", "FREE_MONEY", "EMONEY"];

const REGION = "SN-TH";
const REGION_BUDGET = 100_000_000n;
const hash = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));

const signers = await ethers.getSigners();
const [admin, operator, upgrader, pauser, officerA, officerB,
       o1, o2, o3, o4, relayerWallet, governor2] = signers;

// =====================================================================
step(0, "Déploiement et câblage");
// =====================================================================
const deploy = async (name) => {
    const c = await (await ethers.getContractFactory(name)).deploy();
    await c.waitForDeployment();
    return c;
};
const multiOracle = await deploy("MultiOracle");
const wasdi = await deploy("WASDIOracleConnector");
const targeting = await deploy("JokalanteTargeting");
const mmp = await deploy("MobileMoneyProvider");
const kyc = await deploy("KYCAMLCompliance");

const gov = await ozUpgrades.deployProxy(
    await ethers.getContractFactory("OpalGovernanceUpgradeable"),
    [admin.address, 2], { kind: "uups" });
await gov.waitForDeployment();

// V-02 : quatre rôles, quatre adresses distinctes — initialize() l'impose.
const fp = await ozUpgrades.deployProxy(
    await ethers.getContractFactory("FloodPredictionContract"),
    [admin.address, operator.address, upgrader.address, pauser.address], { kind: "uups" });
await fp.waitForDeployment();
const fpAddr = await fp.getAddress();

await (await fp.setContractAddresses(
    await multiOracle.getAddress(), await gov.getAddress(),
    await targeting.getAddress(), await mmp.getAddress(), await kyc.getAddress())).wait();
await (await targeting.addAuthorizedCaller(fpAddr)).wait();
await (await mmp.addRelayer(fpAddr)).wait();
await (await mmp.addRelayer(relayerWallet.address)).wait();
// ARCH-01 : sans cette liaison, la liste blanche des relayers est une autorité de
// dépense illimitée. Liée, chaque ordre doit correspondre à un PaymentRecord on-chain.
await (await mmp.setFloodPredictionContract(fpAddr)).wait();
await (await mmp.setDailyLimit(REGION, REGION_BUDGET)).wait();
await (await wasdi.addRelayer(relayerWallet.address)).wait();
await (await kyc.authorizeContract(fpAddr)).wait();
await (await gov.setFloodPredictionContract(fpAddr)).wait();
await (await gov.addGovernanceActor(governor2.address, "Gov-2", "GOVERNOR")).wait();
// A65 : sans ces rôles, toute proposition de gouvernance vers FPC reverte.
await (await fp.grantRole(await fp.ADMIN_ROLE(), await gov.getAddress())).wait();
await (await fp.grantRole(await fp.PAUSER_ROLE(), await gov.getAddress())).wait();
say("7 contrats déployés et câblés (rôles gouvernance inclus — correctif A65)");
say("Rail de paiement lié au registre FloodPrediction + plafond journalier (ARCH-01)");

await (await fp.allocateBudget(REGION, REGION_BUDGET)).wait();
say(`Budget alloué à ${REGION} : ${fcfa(REGION_BUDGET)}`);

// =====================================================================
step(1, "Donnée satellite (WASDI)");
// =====================================================================
await (await wasdi.connect(relayerWallet).submitSatelliteData(
    REGION, 88, 185, 96, 340, "Sentinel-1")).wait();
const sat = await wasdi.getLatestData(REGION);
say(`Source ${sat.satelliteSource} — pluie ${sat.rainfall} mm, sol ${sat.soilMoisture} %, eau ${sat.waterLevel} cm`);
say(`Score de risque satellite : ${sat.riskScore}/100   (donnée fraîche : ${await wasdi.isDataFresh(REGION)})`);
say(`Seuil d'alerte ${await wasdi.riskAlertThreshold()} franchi → HighRiskDetected émis`);

// =====================================================================
step(2, "Consensus multi-oracles");
// =====================================================================
for (const [o, n] of [[o1, "WASDI-node"], [o2, "CHIRPS-node"], [o3, "GFS-node"], [o4, "ANACIM-node"]]) {
    await (await multiOracle.registerOracle(o.address, n)).wait();
}
say(`4 oracles actifs (minimum requis : ${await multiOracle.MIN_ORACLE_COUNT()})`);
say(`Quorum : ${await multiOracle.getRequiredSubmissions()} soumissions sur ${await multiOracle.getActiveOracleCount()} (seuil ${await multiOracle.consensusThreshold()} %)`);

for (const [o, score, src] of [[o1, 82, "WASDI"], [o2, 86, "CHIRPS"], [o3, 84, "GFS"]]) {
    await (await multiOracle.connect(o).submitData(REGION, score, src)).wait();
    say(`  ${src.padEnd(7)} soumet ${score}`);
}
const consensus = await multiOracle.getConsensus(REGION);
say(`→ Consensus atteint : ${bold(consensus.consensusRiskScore)} (médiane de 82/84/86), ` +
    `${consensus.participantCount} participants, ${consensus.outlierCount} aberrant(s)`);

// =====================================================================
step(3, "Ciblage Merkle et conformité KYC");
// =====================================================================
const beneficiaries = [
    { label: "Aïssatou D.", hash: hash("ben-aissatou-diop"), amount: 75_000n, provider: 0 },
    { label: "Moussa F.",   hash: hash("ben-moussa-fall"),   amount: 50_000n, provider: 1 },
    { label: "Fatou S.",    hash: hash("ben-fatou-sarr"),    amount: 60_000n, provider: 0 },
];
// V-01 : double hachage (standard OpenZeppelin) contre les attaques de seconde préimage.
// H-07 : la feuille engage (beneficiaryHash, montant).
const leaves = beneficiaries.map(b => ethers.keccak256(ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [b.hash, b.amount]))));
const tree = new MerkleTree(leaves, keccak256lib, { sortPairs: true });
const root = tree.getHexRoot();
say(`Arbre de Merkle de ${beneficiaries.length} bénéficiaires — racine ${root.slice(0, 18)}…`);
say("Aucune donnée personnelle on-chain : seuls des hachages et la racine");

await (await targeting.updateMerkleRoot(REGION, root, beneficiaries.length)).wait();
say(`Racine publiée sur JokalanteTargeting pour ${REGION}`);

await (await kyc.addComplianceOfficer(officerA.address)).wait();
await (await kyc.addComplianceOfficer(officerB.address)).wait();
for (const b of beneficiaries) {
    await (await kyc.connect(officerA).submitAttestation(
        b.hash, hash("id-" + b.label), hash("doc-" + b.label), REGION)).wait();
    // H-04 : l'approbateur doit différer du soumetteur (contrôle des quatre yeux).
    await (await kyc.connect(officerB).approveAttestation(b.hash, 0, 0)).wait();
    say(`  ${b.label.padEnd(13)} soumise par l'agent A, approuvée par l'agent B  (4-eyes)`);
}

// =====================================================================
step(4, "Déclenchement du paiement paramétrique");
// =====================================================================
const total = beneficiaries.reduce((s, b) => s + b.amount, 0n);
await (await fp.connect(operator).createFloodTrigger(
    REGION, consensus.consensusRiskScore, root, total, beneficiaries.length)).wait();

// FloodTriggerCreated déclare eventId en `indexed string` : le log ne porte que son
// hachage. La chaîne réelle se lit dans le tableau triggerIds.
const eventId = await fp.triggerIds((await fp.triggerCount()) - 1n);

say(`Score opérateur ${consensus.consensusRiskScore} — contre-vérifié contre le consensus ` +
    `(tolérance ${await fp.oracleTolerance()} : égalité stricte)`);
say(`eventId : ${bold(eventId)}`);
const trig = await fp.getFloodTrigger(eventId);
say(`Niveau ${RISK_LEVEL[Number(trig.riskLevel)]} — statut ${TRIGGER_STATUS[Number(trig.status)]} — total ${fcfa(total)}`);
say(`Budget engagé : ${fcfa(await fp.committedBudget(REGION))}  |  disponible : ${fcfa(await fp.getRegionBudgetRemaining(REGION))}`);

// =====================================================================
step(5, "Validation, preuves et paiement du lot");
// =====================================================================
const payRc = await (await fp.connect(operator).validateAndProcessPayments(
    eventId,
    beneficiaries.map(b => b.hash),
    beneficiaries.map(b => b.amount),
    leaves.map(l => tree.getHexProof(l)),
    beneficiaries.map(b => hash("phone-" + b.label)),
    beneficiaries.map(b => b.provider)
)).wait();

// parseLog() renvoie null (sans lever) quand le log n'appartient pas à l'interface.
const events = payRc.logs.map(l => {
    for (const c of [fp, mmp]) {
        try { const e = c.interface.parseLog(l); if (e) return e; } catch { /* autre interface */ }
    }
    return null;
}).filter(e => e !== null);

for (const b of beneficiaries) {
    say(`  ${b.label.padEnd(13)} preuve Merkle vérifiée contre la racine figée + KYC conforme`);
}
const initiated = events.filter(e => e.name === "PaymentInitiated");
say(`→ ${initiated.length} ordres PaymentInitiated émis (un par bénéficiaire — correctif A18)`);
const after = await fp.getFloodTrigger(eventId);
say(`Statut du trigger : ${bold(TRIGGER_STATUS[Number(after.status)])}  ` +
    `(${await fp.triggerPaidCount(eventId)}/${after.beneficiaryCount} payés)`);
say(`Budget dépensé ${fcfa(await fp.totalAmountDisbursed())} — engagé restant ${fcfa(await fp.committedBudget(REGION))}`);

// =====================================================================
step(6, "Exécution hors chaîne (relayer → Orange Money / Wave)");
// =====================================================================
// Mode simulation : les API opérateurs sont encore en cours de négociation.
process.env.SIMULATE_PAYMENTS = "true";
process.env.PRIVATE_KEY ??= "0x" + "11".repeat(32);
process.env.MOBILE_MONEY_PROVIDER_ADDRESS ??= await mmp.getAddress();

const { executeProviderPayment } = await import("../relayer/providers.js");
const { auditLogger } = await import("../relayer/security.js");
// A70 : sans cette initialisation, toute la piste d'audit serait signalée non persistée.
await auditLogger.initialize();
say(`Journal d'audit : ${auditLogger.logFile.replace(process.cwd() + "/", "")}`);

const settlements = [];
for (const [i, ev] of initiated.entries()) {
    const paymentId = ev.args[0];
    const providerName = PROVIDERS[Number(ev.args[4])];
    const result = await executeProviderPayment(providerName, {
        paymentId,
        amount: ev.args[2].toString(),
        phoneNumber: "+2217xxxxxxx",       // résolu par le relayer depuis son registre local
        beneficiaryHash: ev.args[1],
        retryCount: 0,                      // A71 : entre dans la clé d'idempotence
    });
    say(`  ${beneficiaries[i].label.padEnd(13)} ${providerName.padEnd(12)} ${fcfa(ev.args[2])} → ` +
        `${result.success ? "OK" : "ÉCHEC"}  ref ${result.transactionRef?.slice(0, 22)}…`);
    settlements.push({ paymentId, ref: result.transactionRef });
}

// =====================================================================
step(7, "Règlement on-chain");
// =====================================================================
await (await mmp.connect(relayerWallet).batchConfirmPayments(
    settlements.map(s => s.paymentId), settlements.map(s => s.ref))).wait();
for (const [i, s] of settlements.entries()) {
    say(`  ${beneficiaries[i].label.padEnd(13)} ${PAYMENT_STATUS[Number(await mmp.getPaymentStatus(s.paymentId))]}`);
}
say(`Total décaissé (confirmé) : ${bold(fcfa(await mmp.getTotalDisbursed()))}`);
say(`Paiements en attente : ${await mmp.getPendingPaymentCount()}`);

// =====================================================================
step(8, "État final et traçabilité");
// =====================================================================
const stats = await fp.getSystemStats();
say(`Triggers ${stats[0]} | paiements ${stats[1]} | décaissé ${fcfa(stats[2])} | version V${stats[5]}`);
say(`Budget ${REGION} : alloué ${fcfa(REGION_BUDGET)} — dépensé ${fcfa(stats[4])} — disponible ${fcfa(await fp.getRegionBudgetRemaining(REGION))}`);
for (const b of beneficiaries) {
    const rec = await fp.getPaymentRecord(eventId, b.hash);
    say(`  ${b.label.padEnd(13)} ${fcfa(rec.amount)} — vérifié ${rec.verified} — ` +
        `payé le ${new Date(Number(rec.paidAt) * 1000).toISOString().slice(0, 19).replace("T", " ")}`);
}

const auditLines = (await fs.readFile(auditLogger.logFile, "utf8")).trim().split("\n");
say(`Piste d'audit : ${auditLines.length} entrées écrites, dernière →`);
say(`  ${auditLines[auditLines.length - 1].slice(0, 150)}`);
console.log("");
