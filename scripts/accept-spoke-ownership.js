/**
 * @title Finalisation du transfert de propriété des contrats immuables
 * @description Second temps du correctif ARCH-02.
 *
 * `deploy-upgradeable.js` / `deploy-amoy.js` appellent `transferOwnership(governance)` sur
 * les cinq contrats non-upgradables. Ownable2Step étant en deux temps, la propriété ne
 * change qu'après un `acceptOwnership()` émis PAR la gouvernance — c'est-à-dire par une
 * proposition multi-signatures. Sans ce second temps, les spokes restent sous la clé du
 * déployeur et `verify-deployment.js` signale le transfert comme en attente.
 *
 * Ce script crée, fait signer et exécute une proposition `acceptOwnership()` par spoke.
 *
 * Prérequis :
 *   - le déployeur (signataire courant) est acteur de gouvernance
 *   - GOVERNANCE_SIGNER_KEYS : clés privées d'acteurs supplémentaires, séparées par des
 *     virgules, en nombre suffisant pour atteindre le quorum
 *   - les spokes et le sélecteur acceptOwnership sont sur les listes blanches
 *     (posé par les scripts de déploiement)
 *
 * Usage :
 *   GOVERNANCE_SIGNER_KEYS=0x...,0x... npx hardhat run scripts/accept-spoke-ownership.js --network localhost
 */
import hre from "hardhat";
import fs from "node:fs";
import path from "node:path";

const connection = await hre.network.connect();
const { ethers, networkHelpers } = connection;

const SPOKES = [
    "MultiOracle",
    "WASDIOracleConnector",
    "JokalanteTargeting",
    "MobileMoneyProvider",
    "KYCAMLCompliance",
];

// Même raison que le correctif A75 : la première requête RPC est l'endroit où se
// manifeste un nœud injoignable.
let chainId;
try {
    chainId = Number((await ethers.provider.getNetwork()).chainId);
} catch (e) {
    const cause = e?.cause?.cause?.message ?? e?.cause?.message ?? e.message;
    console.error(`\n  ❌ Nœud injoignable — ${cause}\n`);
    process.exit(1);
}

// Sélection du manifeste par chainId (même logique que le correctif A74).
const root = path.join(import.meta.dirname, "..");
const manifest = fs.readdirSync(root)
    .filter(f => f.startsWith("deployment-") && f.endsWith(".json"))
    .map(f => {
        try {
            return { f, data: JSON.parse(fs.readFileSync(path.join(root, f), "utf8")),
                     stamp: Number(f.match(/-(\d+)\.json$/)?.[1] ?? 0) };
        } catch { return null; }
    })
    .filter(c => c && Number(c.data.chainId) === chainId)
    .sort((a, b) => b.stamp - a.stamp)[0];

if (!manifest) {
    console.error(`\n  ❌ Aucun manifeste de déploiement pour la chaîne ${chainId}.\n`);
    process.exit(1);
}
console.log(`\n  📄 Manifeste : ${manifest.f} (chaîne ${chainId})\n`);

const contracts = manifest.data.contracts;
const govAddr = contracts.OpalGovernanceProxy ?? contracts.OpalGovernance;
if (!govAddr) {
    console.error("  ❌ OpalGovernanceProxy absent du manifeste.\n");
    process.exit(1);
}
const governance = await ethers.getContractAt("OpalGovernanceUpgradeable", govAddr);

// Signataires additionnels pour atteindre le quorum.
const extraKeys = (process.env.GOVERNANCE_SIGNER_KEYS || "")
    .split(",").map(k => k.trim()).filter(Boolean);
const cosigners = extraKeys.map(k => new ethers.Wallet(k, ethers.provider));

const quorum = Number(await governance.getQuorum());
const availableSigners = 1 + cosigners.length; // le proposeur auto-signe
if (availableSigners < quorum) {
    console.error(
        `  ❌ ${availableSigners} signataire(s) disponible(s) pour un quorum de ${quorum}.\n` +
        `     Renseigner GOVERNANCE_SIGNER_KEYS avec ${quorum - availableSigners} clé(s) d'acteur en plus.\n`
    );
    process.exit(1);
}

const EXECUTION_DELAY = Number(await governance.EXECUTION_DELAY());
const isLocal = chainId === 1337 || chainId === 31337;

let accepted = 0, skipped = 0, failed = 0;

for (const name of SPOKES) {
    const addr = contracts[name];
    if (!addr) { console.log(`  ⏭️  ${name} : absent du manifeste`); skipped++; continue; }

    const spoke = await ethers.getContractAt(name, addr);
    const owner = await spoke.owner();
    const pending = await spoke.pendingOwner();

    if (owner.toLowerCase() === govAddr.toLowerCase()) {
        console.log(`  ⏭️  ${name} : déjà détenu par la gouvernance`);
        skipped++;
        continue;
    }
    if (pending.toLowerCase() !== govAddr.toLowerCase()) {
        console.error(`  ❌ ${name} : aucun transfert en attente vers la gouvernance (pendingOwner=${pending})`);
        failed++;
        continue;
    }

    try {
        const data = spoke.interface.encodeFunctionData("acceptOwnership", []);
        // ProposalType.PARAMETER_CHANGE = 1 — EMERGENCY_TRIGGER exigerait la liste
        // blanche d'urgence, et UPGRADE est lié au seul sélecteur approveUpgrade (A24).
        await (await governance.createProposal(1, `acceptOwnership ${name}`, data, "", addr)).wait();
        const proposalId = (await governance.proposalCount()) - 1n;

        for (const signer of cosigners) {
            if (Number(await governance.proposalCount()) === 0) break;
            await (await governance.connect(signer).signProposal(proposalId)).wait();
        }

        if (isLocal) {
            await networkHelpers.time.increase(EXECUTION_DELAY + 60);
        } else {
            console.log(`     ⏳ proposition ${proposalId} créée et signée — exécuter après le timelock ` +
                        `de ${EXECUTION_DELAY / 3600} h : governance.executeProposal(${proposalId})`);
            continue;
        }

        await (await governance.executeProposal(proposalId)).wait();
        const newOwner = await spoke.owner();
        if (newOwner.toLowerCase() === govAddr.toLowerCase()) {
            console.log(`  ✅ ${name} : propriété acceptée par la gouvernance`);
            accepted++;
        } else {
            console.error(`  ❌ ${name} : propriétaire toujours ${newOwner}`);
            failed++;
        }
    } catch (e) {
        console.error(`  ❌ ${name} : ${e.shortMessage ?? e.message}`);
        failed++;
    }
}

console.log(`\n  ${accepted} acceptée(s) · ${skipped} ignorée(s) · ${failed} en échec\n`);
if (failed > 0) process.exit(1);
