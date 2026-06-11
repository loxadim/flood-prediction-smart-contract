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
function findLatestDeployment() {
    const root = path.join(import.meta.dirname, "..");
    const files = fs.readdirSync(root)
        .filter(f => f.startsWith("deployment-") && f.endsWith(".json"))
        .sort()
        .reverse();

    if (files.length === 0) {
        console.error("  ❌ No deployment-*.json file found in project root.");
        process.exit(1);
    }

    const filePath = path.join(root, files[0]);
    console.log(`  📄 Using deployment file: ${files[0]}`);
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
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
    const flood = await ethers.getContractAt("FloodPredictionContract", floodAddr);

    const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
    const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE"));
    const UPGRADER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("UPGRADER_ROLE"));
    const PAUSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE"));
    const DEFAULT_ADMIN = ethers.ZeroHash;

    const deployer = deployment.deployer;
    for (const [roleName, roleHash] of [
        ["DEFAULT_ADMIN_ROLE", DEFAULT_ADMIN],
        ["ADMIN_ROLE", ADMIN_ROLE],
    ]) {
        const has = await flood.hasRole(roleHash, deployer);
        if (has) ok(`Deployer has ${roleName}`);
        else fail(`Deployer missing ${roleName}`, deployer);
    }

    // Check that at least one OPERATOR exists
    for (const [roleName, roleHash] of [
        ["OPERATOR_ROLE", OPERATOR_ROLE],
        ["UPGRADER_ROLE", UPGRADER_ROLE],
        ["PAUSER_ROLE", PAUSER_ROLE],
    ]) {
        // We can only check deployer — real operator may differ
        const has = await flood.hasRole(roleHash, deployer);
        if (has) ok(`Deployer has ${roleName}`);
        else warn(roleName, `Deployer does not have ${roleName} — may be assigned to another address`);
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

        if (Number(actorCount) < Number(quorum)) {
            warn("Governance", `Only ${actorCount} actors but quorum requires ${quorum}`);
        }
    } catch (e) {
        fail("Governance config", e.message);
    }
} else {
    warn("Governance", "OpalGovernanceProxy not in deployment file");
}

// ========================================
// 6. MultiOracle
// ========================================
console.log("\n─── 7. MultiOracle ───");
const oracleAddr = contracts.MultiOracle;
if (oracleAddr) {
    const oracle = await ethers.getContractAt("MultiOracle", oracleAddr);
    try {
        const oracleCount = await oracle.getOracleCount();
        const threshold = await oracle.consensusThreshold();
        ok(`Oracles: ${oracleCount}, Consensus threshold: ${threshold}%`);
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
