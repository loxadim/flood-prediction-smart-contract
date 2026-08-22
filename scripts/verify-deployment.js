/**
 * verify-deployment.js — Post-Deployment Verification Script
 * DPA Foundation — OPAL Platform
 *
 * Reads the latest deployment JSON, then checks:
 *   1. All contracts have on-chain bytecode
 *   2. FloodPrediction roles are correctly assigned
 *   3. Contract addresses are wired (multiOracle, governance, targeting, mobileMoney)
 *   4. Regions have allocated budgets
 *   5. OpalGovernance quorum & actors
 *   6. MultiOracle is functional
 *   7. System stats are coherent
 *
 * Usage:
 *   npx hardhat run scripts/verify-deployment.js --network amoy
 *   npx hardhat run scripts/verify-deployment.js   # uses latest deployment-*.json
 */

import hre from "hardhat";
import fs from "fs";
import path from "path";

const { ethers } = await hre.network.connect();

// ========================================
// Find deployment file
// ========================================
// A74 fix: pick the manifest belonging to the CONNECTED chain, and order candidates by
// their real timestamp.
//
// The previous implementation sorted filenames lexicographically and took the first in
// reverse order. Filenames are `deployment-<network>-<ms>.json`, so the sort was
// dominated by the NETWORK NAME, not the timestamp: with both an amoy and a hardhat
// manifest present, `deployment-hardhat-...` always won because "h" > "a". Running
// `--network amoy` therefore verified a local hardhat deployment's addresses against
// Amoy, and printed that local manifest's network/chainId in the header — reporting on
// a chain the script was not talking to. Verification silently answered the wrong
// question, which is worse than not running.
// A75 fix: this is the first RPC request the script makes, so it is also where an
// unreachable node, a bad RPC URL or a DNS failure surfaces. Unguarded, it produced a
// raw Hardhat stack trace instead of naming the problem.
let connectedChainId;
try {
    connectedChainId = Number((await ethers.provider.getNetwork()).chainId);
} catch (e) {
    const cause = e?.cause?.cause?.message ?? e?.cause?.message ?? e.message;
    console.error("\n  ❌ Cannot reach the configured RPC endpoint — nothing can be verified.");
    console.error(`     ${cause}`);
    console.error("     Check the network's RPC URL (e.g. AMOY_RPC_URL) and your connectivity.\n");
    process.exit(1);
}

function findLatestDeployment() {
    const root = path.join(import.meta.dirname, "..");
    const candidates = fs.readdirSync(root)
        .filter(f => f.startsWith("deployment-") && f.endsWith(".json"))
        .map(f => {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(root, f), "utf8"));
                // The trailing millisecond stamp in the filename is the one ordering key
                // present in every generation of the manifest format (the `timestamp`
                // field has been both an ISO string and an epoch number).
                const stamp = Number(f.match(/-(\d+)\.json$/)?.[1] ?? 0);
                return { file: f, data, stamp };
            } catch (e) {
                console.log(`  ⚠️  Skipping unreadable manifest ${f}: ${e.message}`);
                return null;
            }
        })
        .filter(Boolean)
        .sort((a, b) => b.stamp - a.stamp);

    if (candidates.length === 0) {
        console.error("  ❌ No readable deployment-*.json file found in project root.");
        process.exit(1);
    }

    const matching = candidates.filter(c => Number(c.data.chainId) === connectedChainId);
    if (matching.length === 0) {
        console.error(
            `  ❌ No deployment manifest matches the connected chain (${connectedChainId}).`
        );
        console.error(`     Available: ${candidates.map(c => `${c.file} (chain ${c.data.chainId})`).join(", ")}`);
        console.error("     Verifying a manifest from another chain would report on the wrong addresses.");
        process.exit(1);
    }

    const chosen = matching[0];
    console.log(`  📄 Using deployment file: ${chosen.file} (chain ${chosen.data.chainId})`);
    if (matching.length > 1) {
        console.log(`     ${matching.length - 1} older manifest(s) for this chain ignored.`);
    }
    return chosen.data;
}

const deployment = findLatestDeployment();
const contracts = deployment.contracts;
const resolveContract = (...names) => {
    for (const name of names) {
        if (contracts[name]) return contracts[name];
    }
    return undefined;
};

let passed = 0;
let failed = 0;
let warnings = 0;

function ok(label) {
    passed++;
    console.log(`  ✅ ${label}`);
}

function fail(label, detail) {
    failed++;
    console.error(`  ❌ ${label}: ${detail}`);
}

function warn(label, detail) {
    warnings++;
    console.log(`  ⚠️  ${label}: ${detail}`);
}

// ========================================
// 1. Bytecode presence
// ========================================
console.log("\n╔══════════════════════════════════════════════╗");
console.log("║   OPAL Post-Deployment Verification          ║");
console.log("╚══════════════════════════════════════════════╝");
console.log(`\n  Network: ${deployment.network} (chain ${deployment.chainId})`);
console.log(`  Deployer: ${deployment.deployer}`);
console.log(`  Timestamp: ${deployment.timestamp}\n`);

console.log("─── 1. Contract Bytecode ───");
for (const [name, address] of Object.entries(contracts)) {
    if (typeof address !== "string" || !ethers.isAddress(address)) {
        warn(name, `Skipping non-address value: ${address}`);
        continue;
    }
    try {
        const code = await ethers.provider.getCode(address);
        if (code && code.length > 2) {
            ok(`${name} @ ${address} has bytecode (${code.length} chars)`);
        } else {
            fail(name, `No bytecode at ${address}`);
        }
    } catch (e) {
        fail(name, e.message);
    }
}

// ========================================
// 2. FloodPrediction roles
// ========================================
console.log("\n─── 2. FloodPrediction Roles ───");
const floodAddr = resolveContract("FloodPredictionProxy", "FloodPredictionContractV3", "FloodPrediction");
if (floodAddr) {
    let flood;
    try {
        flood = await ethers.getContractAt("FloodPredictionContract", floodAddr);
    } catch (e) {
        fail("FloodPrediction", `cannot bind contract at ${floodAddr}: ${e.message}`);
        flood = null;
    }
    if (flood) {

    const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
    const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE"));
    const UPGRADER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("UPGRADER_ROLE"));
    const PAUSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE"));
    const DEFAULT_ADMIN = ethers.ZeroHash;

    const deployer = deployment.deployer;
    // A75 fix: every hasRole() call is guarded. These loops used to call the RPC
    // unprotected, so a single unreachable-node or rate-limit error threw straight out
    // of the script — past the summary block and past the exit-code logic — turning a
    // transient network problem into a stack trace with no verdict. Worse, the
    // governance-authority check added just below (A65) sits in the same region and was
    // therefore skipped entirely whenever this happened.
    // A8-04 fix: this loop used to assert that the DEPLOYER holds DEFAULT_ADMIN_ROLE and
    // record that as correct — ratifying the very centralisation ARCH-02 set out to remove
    // from the spokes. A single EOA holding the hub's role admin can repoint kycCompliance
    // at a permissive contract, rewire the oracle or the targeting module, and grant itself
    // any role, all without quorum or delay. The expected end state is the opposite:
    // governance holds the admin roles, the deployer holds none.
    const govAddress = contracts.OpalGovernanceProxy || contracts.OpalGovernance;
    for (const [roleName, roleHash] of [
        ["DEFAULT_ADMIN_ROLE", DEFAULT_ADMIN],
        ["ADMIN_ROLE", ADMIN_ROLE],
    ]) {
        try {
            const deployerHas = await flood.hasRole(roleHash, deployer);
            const govHas = govAddress ? await flood.hasRole(roleHash, govAddress) : false;

            if (govHas && !deployerHas) {
                ok(`${roleName} held by governance only`);
            } else if (govHas && deployerHas) {
                fail(
                    `${roleName} still held by the deployer alongside governance`,
                    `${deployer} — run the hub handover, or the multi-sig is bypassable by one key`
                );
            } else if (deployerHas) {
                fail(
                    `${roleName} held by a single EOA, governance has none`,
                    `${deployer} — set TRANSFER_HUB_TO_GOVERNANCE=true when deploying`
                );
            } else {
                fail(`${roleName} held by nobody`, "contract is unadministrable");
            }
        } catch (e) {
            fail(`${roleName}`, `cannot read: ${e.message}`);
        }
    }

    // Check that at least one OPERATOR exists
    for (const [roleName, roleHash] of [
        ["OPERATOR_ROLE", OPERATOR_ROLE],
        ["UPGRADER_ROLE", UPGRADER_ROLE],
        ["PAUSER_ROLE", PAUSER_ROLE],
    ]) {
        // We can only check deployer — real operator may differ
        try {
            const has = await flood.hasRole(roleHash, deployer);
            if (has) ok(`Deployer has ${roleName}`);
            else warn(roleName, `Deployer does not have ${roleName} — may be assigned to another address`);
        } catch (e) {
            fail(`Deployer ${roleName}`, `cannot read: ${e.message}`);
            continue;
        }
    }

    // ========================================
    // A65 fix: governance must actually HOLD the roles its whitelisted selectors need
    // ========================================
    // The deploy scripts whitelist FloodPrediction selectors on OpalGovernance and
    // register it as an allowed target, but whitelisting grants no authority. If the
    // governance proxy holds neither ADMIN_ROLE nor PAUSER_ROLE, every proposal
    // targeting FloodPrediction reverts with AccessControlUnauthorizedAccount and the
    // emergency-response path is dead. Checking hasRole for the deployer alone (above)
    // cannot detect that, which is how it went unnoticed.
    console.log("\n─── 2b. Governance authority on FloodPrediction ───");
    const govProxyAddr = resolveContract("OpalGovernanceProxy", "OpalGovernance");
    if (govProxyAddr) {
        for (const [roleName, roleHash, selectors] of [
            ["ADMIN_ROLE", ADMIN_ROLE,
                "createGovernanceOverrideTrigger, activateEmergencyMode, deactivateEmergencyMode, setRegionEmergency, updateRiskThreshold"],
            ["PAUSER_ROLE", PAUSER_ROLE, "pause, unpause"],
        ]) {
            try {
                const has = await flood.hasRole(roleHash, govProxyAddr);
                if (has) {
                    ok(`Governance holds ${roleName} on FloodPrediction`);
                } else {
                    fail(
                        `Governance missing ${roleName} on FloodPrediction`,
                        `proposals calling ${selectors} will revert with ` +
                        `AccessControlUnauthorizedAccount. Run: ` +
                        `floodPrediction.grantRole(${roleName}, ${govProxyAddr})`
                    );
                }
            } catch (e) {
                // A75 fix: an unreadable role must be a recorded failure, never an
                // uncaught throw that skips the rest of the verification.
                fail(`Governance ${roleName} on FloodPrediction`, `cannot read: ${e.message}`);
            }
        }
    } else {
        warn("Governance authority", "OpalGovernance address not in deployment file");
    }

    // ========================================
    // 3. Contract wiring
    // ========================================
    console.log("\n─── 3. Contract Wiring ───");
    const wiring = {
        multiOracle: contracts.MultiOracle,
        governance: resolveContract("OpalGovernanceProxy", "OpalGovernance"),
        jokalanteTargeting: contracts.JokalanteTargeting,
        mobileMoneyProvider: contracts.MobileMoneyProvider,
    };

    for (const [varName, expectedAddr] of Object.entries(wiring)) {
        if (!expectedAddr) {
            warn(varName, "Address not in deployment file");
            continue;
        }
        try {
            const actual = await flood[varName]();
            if (actual.toLowerCase() === expectedAddr.toLowerCase()) {
                ok(`${varName} → ${actual}`);
            } else if (actual === ethers.ZeroAddress) {
                fail(varName, `Not set (still zero address)`);
            } else {
                fail(varName, `Mismatch — expected ${expectedAddr}, got ${actual}`);
            }
        } catch (e) {
            fail(varName, `Cannot read: ${e.message}`);
        }
    }

    // KYC wiring (optional)
    if (contracts.KYCAMLCompliance) {
        try {
            const kycAddr = await flood.kycCompliance();
            if (kycAddr.toLowerCase() === contracts.KYCAMLCompliance.toLowerCase()) {
                ok(`kycCompliance → ${kycAddr}`);
            } else if (kycAddr === ethers.ZeroAddress) {
                warn("kycCompliance", "Not set (optional)");
            } else {
                warn("kycCompliance", `Different address: ${kycAddr}`);
            }
        } catch {
            warn("kycCompliance", "Field not readable — may not exist");
        }
    }

    // ========================================
    // 4. Regional budgets
    // ========================================
    console.log("\n─── 4. Regional Budgets ───");
    const regions = deployment.config?.regions ?? ["SN-TH", "SN-DK", "SN-SL", "SN-ZG", "SN-KL", "SN-TC"];
    for (const region of regions) {
        try {
            const budget = await flood.getRegionBudgetRemaining(region);
            if (budget > 0n) {
                ok(`${region}: ${budget} CFA budget available`);
            } else {
                warn(region, "No budget allocated (0)");
            }
        } catch (e) {
            fail(region, `Cannot read budget: ${e.message}`);
        }
    }

    // ========================================
    // 7. System stats
    // ========================================
    console.log("\n─── 5. System Stats ───");
    try {
        const stats = await flood.getSystemStats();
        ok(`Triggers: ${stats[0]}, Payments: ${stats[1]}, Disbursed: ${stats[2]} CFA`);
        ok(`Total Budget: ${stats[3]} CFA, Total Spent: ${stats[4]} CFA, Version: V${stats[5]}`);
    } catch (e) {
        fail("getSystemStats()", e.message);
    }
    } // end: if (flood) — A75 fix guard
} else {
    fail("FloodPrediction", "FloodPredictionProxy not found in deployment file");
}

// ========================================
// 5. OpalGovernance
// ========================================
console.log("\n─── 6. Governance ───");
const govAddr = resolveContract("OpalGovernanceProxy", "OpalGovernance");
if (govAddr) {
    const gov = await ethers.getContractAt("OpalGovernanceUpgradeable", govAddr);
    try {
        const quorum = await gov.getQuorum();
        const actorCount = await gov.getActiveActorCount();
        ok(`Quorum: ${quorum} signatures required, ${actorCount} actors registered`);

        // A78 fix: fewer active actors than the quorum is a hard blocker, not a warning.
        // The maximum signatures a proposal can collect is the number of active actors,
        // so below quorum NO proposal can ever execute — including every emergency
        // proposal, and the UPGRADE proposal that is the only sanctioned upgrade route.
        // Reporting it as a warning let a deployment be declared healthy while its
        // governance was inert.
        if (Number(actorCount) < Number(quorum)) {
            fail(
                "Governance quorum unreachable",
                `only ${actorCount} active actor(s) for a quorum of ${quorum} — no proposal ` +
                `can ever reach quorum, so emergency and upgrade paths are both inert. ` +
                `Add actors with addGovernanceActor(), or lower the quorum with updateQuorum().`
            );
        }

        // A78 fix: actorList is what executeProposal() iterates when recounting active
        // signatures (A25). If it has drifted below activeActorCount, signatures from the
        // missing actors are invisible and the effective ceiling is actorList.length.
        try {
            const listLength = (await gov.getActorList()).length;
            if (listLength !== Number(actorCount)) {
                fail(
                    "Governance actorList drift",
                    `actorList holds ${listLength} entries but activeActorCount is ${actorCount} — ` +
                    `executeProposal() recounts over actorList, so the effective signature ceiling ` +
                    `is ${listLength}. See the A49 fix in addGovernanceActor().`
                );
            } else {
                ok(`actorList consistent with activeActorCount (${listLength})`);
            }
        } catch (e) {
            fail("Governance actorList", `cannot read: ${e.message}`);
        }
    } catch (e) {
        fail("Governance config", e.message);
    }
} else {
    warn("Governance", "OpalGovernanceProxy not in deployment file");
}

// ========================================
// 6b. Payment rail integrity (ARCH-01 / ARCH-02)
// ========================================
console.log("\n─── 7. Intégrité du rail de paiement ───");
if (contracts.MobileMoneyProvider) {
    try {
        const mmp = await ethers.getContractAt("MobileMoneyProvider", contracts.MobileMoneyProvider);

        // ARCH-01: unbound, the relayer whitelist IS an unlimited spending authority.
        const ledger = await mmp.floodPrediction();
        if (floodAddr && ledger.toLowerCase() === floodAddr.toLowerCase()) {
            ok(`MobileMoneyProvider lié au registre FloodPrediction`);
        } else if (ledger === ethers.ZeroAddress) {
            fail(
                "MobileMoneyProvider non lié",
                "batchInitiatePayments n'est protégé que par onlyRelayer — toute clé de la " +
                "liste blanche (dont le portefeuille chaud du relayer) peut émettre des ordres " +
                "sans trigger, preuve Merkle, KYC ni budget. Appeler setFloodPredictionContract()."
            );
        } else {
            fail("MobileMoneyProvider lié au mauvais registre", `attendu ${floodAddr}, obtenu ${ledger}`);
        }

        // ARCH-01: a 0 daily limit reads as UNLIMITED.
        const regionsToCheck = deployment.config?.regions ?? [];
        let unlimited = [];
        for (const region of regionsToCheck) {
            if ((await mmp.regionDailyLimit(region)) === 0n) unlimited.push(region);
        }
        if (regionsToCheck.length === 0) {
            warn("Plafonds journaliers", "aucune région dans le manifeste — contrôle ignoré");
        } else if (unlimited.length > 0) {
            fail(
                "Plafonds journaliers absents",
                `${unlimited.length}/${regionsToCheck.length} région(s) sans plafond (0 = illimité) : ` +
                `${unlimited.join(", ")}. Appeler setDailyLimit() pour borner le rail de paiement.`
            );
        } else {
            ok(`Plafond journalier fixé sur les ${regionsToCheck.length} régions`);
        }
    } catch (e) {
        fail("Rail de paiement", `lecture impossible : ${e.message}`);
    }
} else {
    warn("MobileMoneyProvider", "absent du manifeste");
}

// ARCH-02: the five non-upgradeable contracts must not stay under an EOA.
const govProxy = resolveContract("OpalGovernanceProxy", "OpalGovernance");
for (const name of ["MultiOracle", "WASDIOracleConnector", "JokalanteTargeting",
                    "MobileMoneyProvider", "KYCAMLCompliance"]) {
    if (!contracts[name]) continue;
    try {
        // Chaque spoke hérite d'Ownable2Step, mais l'artefact doit être résolu par le
        // nom réel du contrat — "Ownable2Step" seul n'est pas un artefact compilé ici.
        const c = await ethers.getContractAt(name, contracts[name]);
        const currentOwner = await c.owner();
        const pending = await c.pendingOwner();
        if (govProxy && currentOwner.toLowerCase() === govProxy.toLowerCase()) {
            ok(`${name} appartient à la gouvernance`);
        } else if (govProxy && pending.toLowerCase() === govProxy.toLowerCase()) {
            warn(name, `transfert vers la gouvernance en attente — exécuter une proposition acceptOwnership()`);
        } else {
            fail(
                `${name} sous clé unique`,
                `propriétaire ${currentOwner} hors du périmètre multi-signatures — ` +
                `cette clé peut à elle seule rouvrir le rail de paiement, réécrire une racine Merkle ` +
                `ou approuver un KYC. Transférer la propriété à la gouvernance.`
            );
        }
    } catch (e) {
        fail(`${name} propriété`, `lecture impossible : ${e.message}`);
    }
}

// R7-01: owning a contract is useless if governance cannot call it. executeProposal
// rejects any non-whitelisted selector, so a spoke handed to governance without its
// admin selectors whitelisted is permanently frozen — nobody can call those functions
// ever again. This check pairs with the ownership check above: transfer AND reachability.
const SPOKE_CRITICAL_SELECTORS = {
    JokalanteTargeting: ["updateMerkleRoot", "addAuthorizedCaller"],
    MobileMoneyProvider: ["addRelayer", "setDailyLimit", "setFloodPredictionContract"],
    KYCAMLCompliance: ["addComplianceOfficer", "authorizeContract"],
    WASDIOracleConnector: ["addRelayer"],
    MultiOracle: ["registerOracle", "deregisterOracle"],
};
if (govAddr) {
    try {
        const gov = await ethers.getContractAt("OpalGovernanceUpgradeable", govAddr);
        let frozen = [];
        for (const [name, fns] of Object.entries(SPOKE_CRITICAL_SELECTORS)) {
            if (!contracts[name]) continue;
            const spoke = await ethers.getContractAt(name, contracts[name]);
            // only meaningful once the spoke is actually governance-owned
            if ((await spoke.owner()).toLowerCase() !== govAddr.toLowerCase()) continue;
            if (!(await gov.allowedTargets(contracts[name]))) {
                frozen.push(`${name} (cible non whitelistée)`);
                continue;
            }
            for (const fn of fns) {
                const sel = spoke.interface.getFunction(fn).selector;
                const allowed = (await gov.allowedSelectors(sel)) || (await gov.emergencyAllowedSelectors(sel));
                if (!allowed) frozen.push(`${name}.${fn}()`);
            }
        }
        if (frozen.length > 0) {
            fail(
                "Fonctions d'administration inatteignables",
                `${frozen.length} fonction(s) détenue(s) par la gouvernance mais non whitelistée(s) — ` +
                `plus personne ne peut les appeler : ${frozen.join(", ")}`
            );
        } else {
            ok("Les fonctions d'administration des spokes sont atteignables par la gouvernance");
        }
    } catch (e) {
        fail("Atteignabilité des spokes", `contrôle impossible : ${e.message}`);
    }
}

// A8-04 + R7-01: the same reachability question, now for the HUB. Moving
// DEFAULT_ADMIN_ROLE to governance is irreversible — the deployer renounces it — so a
// selector that was not whitelisted first is unreachable forever: the deployer may no
// longer call it and executeProposal rejects it. The spokes at least have Ownable2Step's
// pending-acceptance window; AccessControl has no such grace period.
const HUB_CRITICAL_SELECTORS = [
    "allocateBudget", "setContractAddresses", "updateRiskThreshold",
    "cancelTrigger", "grantRole", "revokeRole",
];
if (govAddr && contracts.FloodPredictionProxy) {
    try {
        // `flood` above is block-scoped to the role-check section, so re-attach here.
        const hub = await ethers.getContractAt("FloodPredictionContract", contracts.FloodPredictionProxy);
        const gov = await ethers.getContractAt("OpalGovernanceUpgradeable", govAddr);
        const DEFAULT_ADMIN = ethers.ZeroHash;
        const hubUnderGovernance = await hub.hasRole(DEFAULT_ADMIN, govAddr);

        if (!hubUnderGovernance) {
            warn(
                "Hub non transféré à la gouvernance",
                "FloodPredictionContract garde ses rôles d'administration hors du périmètre " +
                "multi-signatures — une clé unique peut repointer le contrôle KYC ou le ciblage. " +
                "Déployer avec TRANSFER_HUB_TO_GOVERNANCE=true."
            );
        } else if (!(await gov.allowedTargets(contracts.FloodPredictionProxy))) {
            fail("Hub inatteignable", "FloodPrediction n'est pas une cible whitelistée de la gouvernance");
        } else {
            const frozen = [];
            for (const fn of HUB_CRITICAL_SELECTORS) {
                const sel = hub.interface.getFunction(fn).selector;
                const allowed = (await gov.allowedSelectors(sel)) || (await gov.emergencyAllowedSelectors(sel));
                if (!allowed) frozen.push(`FloodPrediction.${fn}()`);
            }
            if (frozen.length > 0) {
                fail(
                    "Fonctions d'administration du hub inatteignables",
                    `${frozen.length} fonction(s) hors de portée après la renonciation du déployeur — ` +
                    `plus personne ne peut les appeler : ${frozen.join(", ")}`
                );
            } else {
                ok("Les fonctions d'administration du hub sont atteignables par la gouvernance");
            }
        }
    } catch (e) {
        fail("Atteignabilité du hub", `contrôle impossible : ${e.message}`);
    }
}

// ========================================
// 6. MultiOracle
// ========================================
console.log("\n─── 8. MultiOracle ───");
const oracleAddr = contracts.MultiOracle;
if (oracleAddr) {
    const oracle = await ethers.getContractAt("MultiOracle", oracleAddr);
    try {
        const oracleCount = await oracle.getOracleCount();
        const threshold = await oracle.consensusThreshold();
        ok(`Oracles: ${oracleCount}, Consensus threshold: ${threshold}%`);

        // A59 fix: consensus needs MIN_ORACLE_COUNT active oracles. Below that,
        // isConsensusReached() can never become true and getConsensus().timestamp stays
        // zero — which puts FloodPredictionContract.createFloodTrigger() on its cold-start
        // path, where the operator's riskScore is accepted with NO oracle cross-check.
        // This is a deployment-blocking condition, not a warning.
        const activeCount = await oracle.getActiveOracleCount();
        const minCount = await oracle.MIN_ORACLE_COUNT();
        if (activeCount < minCount) {
            fail(
                "MultiOracle active oracles",
                `only ${activeCount}/${minCount} active — consensus is unreachable, so ` +
                `createFloodTrigger() accepts any operator-supplied riskScore without ` +
                `oracle cross-check. Register more oracles before going live.`
            );
        } else {
            ok(`Active oracles: ${activeCount}/${minCount} — oracle cross-check is enforced`);
        }
    } catch (e) {
        fail("MultiOracle config", e.message);
    }
} else {
    warn("MultiOracle", "Not in deployment file");
}

// ========================================
// Summary
// ========================================
console.log("\n╔══════════════════════════════════════════════╗");
console.log("║           VERIFICATION SUMMARY               ║");
console.log("╠══════════════════════════════════════════════╣");
console.log(`║  ✅ Passed:    ${String(passed).padStart(3)}                           ║`);
console.log(`║  ❌ Failed:    ${String(failed).padStart(3)}                           ║`);
console.log(`║  ⚠️  Warnings:  ${String(warnings).padStart(3)}                           ║`);
console.log("╚══════════════════════════════════════════════╝");

if (failed > 0) {
    console.log("\n  ⛔ Deployment has FAILURES — investigate before use.\n");
    process.exit(1);
} else if (warnings > 0) {
    console.log("\n  ⚠️  Deployment OK but has warnings — review above.\n");
} else {
    console.log("\n  🎉 All checks passed — deployment is healthy!\n");
}
