/**
 * deploy-amoy.js — Polygon Amoy Testnet Deployment Script (Resumable)
 * DPA Foundation — OPAL Platform Blockchain Layer
 * 
 * Usage:
 *   npx hardhat run scripts/deploy-amoy.js --network amoy
 * 
 * Features:
 *   - Resumable: saves progress after each step to deployment-amoy-progress.json
 *   - Re-run safely: skips already-deployed contracts
 *   - Deploys 8 contracts + post-deployment wiring + verification
 */

import hre from "hardhat";
import { upgrades as makeUpgrades } from "@openzeppelin/hardhat-upgrades";
import fs from "fs";
import path from "path";

const { ethers } = await hre.network.connect();
const ozUpgrades = await makeUpgrades(hre);

// Derive network name from provider (HH3 compatible)
const _netInfo = await ethers.provider.getNetwork();
const _chainIdMap = { 31337: "localhost", 1337: "hardhat", 80002: "amoy", 137: "polygon" };
const networkName = _chainIdMap[Number(_netInfo.chainId)] ?? _netInfo.name;
const networkChainId = Number(_netInfo.chainId);

// ========================================
// Progress file for resumable deployment
// ========================================
const PROGRESS_FILE = path.join(import.meta.dirname, "..", "deployment-amoy-progress.json");

function loadProgress() {
    try {
        if (fs.existsSync(PROGRESS_FILE)) {
            const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
            // Only resume if same network
            if (data.chainId === networkChainId) return data;
        }
    } catch {}
    return { chainId: networkChainId, contracts: {}, steps: {} };
}

function saveProgress(progress) {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ========================================
// Configuration
// ========================================
const DEPLOYMENT_CONFIG = {
    // Default risk threshold for flood triggers  
    riskThreshold: 70,
    // Regions to pre-configure.
    // A28 fix: budgets are PLAIN FCFA integers — the contract treats amounts as CFA
    // (MIN_PAYMENT 500, MAX_PAYMENT 5,000,000), NOT wei. parseEther("1000000") = 1e24
    // silently disabled the InsufficientBudget guard and corrupted getRegionBudgetRemaining.
    regions: [
        { code: "SN-TH", name: "Thies", budget: 1_000_000n },
        { code: "SN-DK", name: "Dakar", budget: 2_000_000n },
        { code: "SN-SL", name: "Saint-Louis", budget: 1_500_000n },
        { code: "SN-ZG", name: "Ziguinchor", budget: 1_200_000n },
        { code: "SN-KL", name: "Kaolack", budget: 800_000n },
        { code: "SN-TC", name: "Tambacounda", budget: 600_000n },
    ],
    // Governance configuration
    governance: {
        emergencyQuorum: 3,
        proposalDuration: 7 * 24 * 3600, // 7 days
    },
    // Gas settings for Polygon Amoy
    gasSettings: {
        maxFeePerGas: ethers.parseUnits("50", "gwei"),
        maxPriorityFeePerGas: ethers.parseUnits("30", "gwei"),
    }
};

// ========================================
// Helper Functions
// ========================================
function logSection(title) {
    console.log("\n" + "=".repeat(60));
    console.log(`  ${title}`);
    console.log("=".repeat(60));
}

function logStep(step, message) {
    console.log(`  [${step}] ${message}`);
}

async function verifyContract(address, constructorArguments = []) {
    if (networkName === "hardhat" || networkName === "localhost") return;
    
    console.log(`  Verifying ${address} on Polygonscan...`);
    try {
        await hre.run("verify:verify", {
            address,
            constructorArguments,
        });
        console.log("  ✅ Verified!");
    } catch (error) {
        if (error.message.includes("Already Verified")) {
            console.log("  ✅ Already verified");
        } else {
            console.log(`  ⚠️  Verification failed: ${error.message}`);
        }
    }
}

// ========================================
// Main Deployment
// ========================================
logSection("OPAL Platform — Polygon Amoy Deployment");

const [deployer, ...otherSigners] = await ethers.getSigners();
const balance = await ethers.provider.getBalance(deployer.address);

// V-06 fix: resolve OPERATOR/UPGRADER/PAUSER to addresses distinct from the
// deployer (ADMIN). Reusing deployer.address for every role collapses RBAC
// separation-of-duties — one compromised key would hold all privileges.
// On local networks fall back to additional Hardhat signers; on any other
// network these env vars are required.
const isLocalNetwork = networkName === "hardhat" || networkName === "localhost";

function resolveRoleAddress(envVar, fallbackSigner, roleName) {
    const envAddr = process.env[envVar];
    if (envAddr) {
        if (!ethers.isAddress(envAddr)) {
            throw new Error(`${envVar}="${envAddr}" is not a valid address`);
        }
        return envAddr;
    }
    if (isLocalNetwork && fallbackSigner) {
        return fallbackSigner.address;
    }
    throw new Error(
        `${envVar} must be set to a distinct address for ${roleName} on network "${networkName}" (chainId ${networkChainId})`
    );
}

const operatorAddress = resolveRoleAddress("OPERATOR_ADDRESS", otherSigners[0], "OPERATOR_ROLE");
const upgraderAddress = resolveRoleAddress("UPGRADER_ADDRESS", otherSigners[1], "UPGRADER_ROLE");
const pauserAddress = resolveRoleAddress("PAUSER_ADDRESS", otherSigners[2], "PAUSER_ROLE");
// A29 fix: the off-chain relayer service signs confirmPayment/failPayment/batchConfirmPayments
// (MobileMoneyProvider) and submitSatelliteData (WASDIOracleConnector) with its OWN wallet
// (RELAYER_ADDRESS). Without authorizing it, the entire settlement + satellite-ingestion flow
// reverts UnauthorizedRelayer. This holds even while Orange/Wave APIs are pending (the relayer
// runs in simulation mode but still confirms payments on-chain).
const relayerServiceAddress = resolveRoleAddress("RELAYER_ADDRESS", otherSigners[3], "RELAYER (off-chain service)");

console.log(`\n  Network:  ${networkName} (chainId: ${networkChainId})`);
console.log(`  Deployer: ${deployer.address} (ADMIN)`);
console.log(`  Balance:  ${ethers.formatEther(balance)} MATIC`);
console.log(`  OPERATOR_ROLE: ${operatorAddress}`);
console.log(`  UPGRADER_ROLE: ${upgraderAddress}`);
console.log(`  PAUSER_ROLE:   ${pauserAddress}`);

    if (balance < ethers.parseEther("0.01")) {
        console.error("\n  ❌ Insufficient balance. Need MATIC for deployment.");
        console.error("     Get testnet MATIC: https://faucet.polygon.technology/");
        process.exit(1);
    }

    const progress = loadProgress();
    const deployed = progress.contracts;
    const steps = progress.steps;
    const startTime = Date.now();

    if (Object.keys(deployed).length > 0) {
        logStep("🔄", "Resuming from previous deployment...");
        for (const [name, addr] of Object.entries(deployed)) {
            logStep("  ✅", `${name}: ${addr} (already deployed)`);
        }
    }

    // Helper to deploy or reuse a simple contract
    async function deployOrReuse(stepNum, totalSteps, contractName, key) {
        logSection(`Step ${stepNum}/${totalSteps}: ${contractName}`);
        if (deployed[key]) {
            logStep("⏭️", `${key}: ${deployed[key]} (already deployed — skipping)`);
            return await ethers.getContractAt(contractName, deployed[key]);
        }
        const Factory = await ethers.getContractFactory(contractName);
        const instance = await Factory.deploy();
        await instance.waitForDeployment();
        deployed[key] = await instance.getAddress();
        logStep("✅", `${key}: ${deployed[key]}`);
        saveProgress(progress);
        return instance;
    }

    // ---- Step 1-6: Non-upgradeable contracts ----
    const multiOracle = await deployOrReuse(1, 8, "MultiOracle", "MultiOracle");
    const wasdiOracle = await deployOrReuse(2, 8, "WASDIOracleConnector", "WASDIOracleConnector");
    const jokalante   = await deployOrReuse(3, 8, "JokalanteTargeting", "JokalanteTargeting");
    const mobileMoney = await deployOrReuse(4, 8, "MobileMoneyProvider", "MobileMoneyProvider");
    const kyc         = await deployOrReuse(6, 8, "KYCAMLCompliance", "KYCAMLCompliance");

    // L-2 fix: lock WASDI oracle to production mode so simulation functions are disabled.
    if (!deployed.wasdiProductionLocked) {
        logStep("🔒", "Locking WASDIOracleConnector to production mode...");
        const lockTx = await wasdiOracle.lockProductionMode();
        await lockTx.wait();
        deployed.wasdiProductionLocked = true;
        saveProgress(progress);
        logStep("✅", "WASDIOracleConnector locked — simulateHighRisk/simulateLowRisk disabled");
    } else {
        logStep("⏭️", "WASDIOracleConnector already locked to production mode — skipping");
    }

    // ---- Step 7: OpalGovernance (UUPS Proxy) ----
    logSection("Step 7/8: OpalGovernanceUpgradeable (UUPS Proxy)");
    let opalGov;
    if (deployed.OpalGovernanceProxy) {
        logStep("⏭️", `OpalGovernance Proxy: ${deployed.OpalGovernanceProxy} (already deployed — skipping)`);
        opalGov = await ethers.getContractAt("OpalGovernanceUpgradeable", deployed.OpalGovernanceProxy);
    } else {
        const OpalGov = await ethers.getContractFactory("OpalGovernanceUpgradeable");
        opalGov = await ozUpgrades.deployProxy(
            OpalGov,
            [deployer.address, DEPLOYMENT_CONFIG.governance.emergencyQuorum],
            { kind: "uups" }
        );
        await opalGov.waitForDeployment();
        deployed.OpalGovernanceProxy = await opalGov.getAddress();
        deployed.OpalGovernanceImpl = await ozUpgrades.erc1967.getImplementationAddress(deployed.OpalGovernanceProxy);
        logStep("✅", `OpalGovernance Proxy: ${deployed.OpalGovernanceProxy}`);
        logStep("📋", `OpalGovernance Impl:  ${deployed.OpalGovernanceImpl}`);
        saveProgress(progress);
    }

    // ---- Step 8: FloodPrediction (UUPS Proxy) ----
    logSection("Step 8/8: FloodPredictionContractV3 (UUPS Proxy)");
    let floodPred;
    if (deployed.FloodPredictionProxy) {
        logStep("⏭️", `FloodPrediction Proxy: ${deployed.FloodPredictionProxy} (already deployed — skipping)`);
        floodPred = await ethers.getContractAt("FloodPredictionContract", deployed.FloodPredictionProxy);
    } else {
        const FloodPred = await ethers.getContractFactory("FloodPredictionContract");
        floodPred = await ozUpgrades.deployProxy(
            FloodPred,
            [deployer.address, operatorAddress, upgraderAddress, pauserAddress],
            { kind: "uups" }
        );
        await floodPred.waitForDeployment();
        deployed.FloodPredictionProxy = await floodPred.getAddress();
        deployed.FloodPredictionImpl = await ozUpgrades.erc1967.getImplementationAddress(deployed.FloodPredictionProxy);
        logStep("✅", `FloodPrediction Proxy: ${deployed.FloodPredictionProxy}`);
        logStep("📋", `FloodPrediction Impl:  ${deployed.FloodPredictionImpl}`);
        saveProgress(progress);
    };

    // ----------------------------------------
    // Post-Deployment Wiring
    // ----------------------------------------
    logSection("Post-Deployment Configuration");

    // Wire contract addresses into FloodPrediction
    if (!steps.wired) {
        logStep("🔧", "Wiring contract addresses into FloodPrediction...");
        const wireTx = await floodPred.setContractAddresses(
            deployed.MultiOracle,
            deployed.OpalGovernanceProxy,
            deployed.JokalanteTargeting,
            deployed.MobileMoneyProvider,
            deployed.KYCAMLCompliance
        );
        await wireTx.wait();
        steps.wired = true;
        saveProgress(progress);
        logStep("✅", "Contract addresses set on FloodPrediction");
    } else {
        logStep("⏭️", "Contract addresses already wired — skipping");
    }

    // V-07 fix: authorize FloodPrediction as an MMP relayer, then revoke the
    // deployer's relayer privileges (granted to msg.sender in MMP's constructor).
    if (!steps.relayerConfigured) {
        logStep("🔧", "Configuring MobileMoneyProvider relayers...");
        // FloodPrediction calls batchInitiatePayments (initiation side).
        const tx1 = await mobileMoney.addRelayer(deployed.FloodPredictionProxy);
        await tx1.wait();
        logStep("  ✅", "FloodPrediction authorized as MMP relayer (initiation)");

        // A29 fix: the off-chain relayer service calls confirmPayment/failPayment/
        // batchConfirmPayments/expireStalePayments (settlement side).
        const tx2 = await mobileMoney.addRelayer(relayerServiceAddress);
        await tx2.wait();
        logStep("  ✅", `Relayer service ${relayerServiceAddress} authorized as MMP relayer (settlement)`);

        const tx3 = await mobileMoney.removeRelayer(deployer.address);
        await tx3.wait();
        logStep("  ✅", "Deployer relayer privileges revoked");

        // CA-01 fix: ARCH-01 était appliqué à deploy-upgradeable.js uniquement — le script
        // de PRODUCTION ne liait pas le rail de paiement au registre. Sans cette liaison,
        // toute clé sur la liste blanche des relayers peut fabriquer des ordres de paiement
        // sans trigger, sans preuve Merkle, sans KYC et sans budget.
        const tx4 = await mobileMoney.setFloodPredictionContract(deployed.FloodPredictionProxy);
        await tx4.wait();
        logStep("  ✅", "MobileMoneyProvider lié au registre FloodPrediction (initiatePayment direct fermé)");

        steps.relayerConfigured = true;
        saveProgress(progress);
    } else {
        logStep("⏭️", "MMP relayers already configured — skipping");
    }

    // A29 fix: authorize the relayer service to submit satellite data to WASDI.
    // WASDI's constructor only authorizes the deployer; the off-chain ingestion
    // worker signs submitSatelliteData with RELAYER_ADDRESS.
    if (!steps.wasdiRelayerConfigured) {
        logStep("🔧", "Authorizing relayer service on WASDIOracleConnector...");
        const tx = await wasdiOracle.addRelayer(relayerServiceAddress);
        await tx.wait();
        logStep("  ✅", `Relayer service authorized as WASDI relayer`);
        steps.wasdiRelayerConfigured = true;
        saveProgress(progress);
    } else {
        logStep("⏭️", "WASDI relayer already configured — skipping");
    }

    // Authorize FloodPrediction to call JokalanteTargeting and KYCAMLCompliance
    // (mirrors deploy-upgradeable.js) — without this, processBatchPayment
    // reverts because FloodPrediction cannot read targeting/compliance state.
    if (!steps.complianceAuthorized) {
        logStep("🔧", "Authorizing FloodPrediction on JokalanteTargeting and KYCAMLCompliance...");
        const tx1 = await jokalante.addAuthorizedCaller(deployed.FloodPredictionProxy);
        await tx1.wait();
        logStep("  ✅", "FloodPrediction authorized as caller on JokalanteTargeting");

        const tx2 = await kyc.authorizeContract(deployed.FloodPredictionProxy);
        await tx2.wait();
        logStep("  ✅", "FloodPrediction authorized as caller on KYCAMLCompliance");

        // A8-03 fix: register a second compliance officer, or the KYC pipeline is inert.
        //
        // KYCAMLCompliance's constructor registers the deployer as the ONLY officer, and
        // approveAttestation() enforces the four-eyes rule (H-04 fix): the approver must
        // differ from the submitter. With one officer that condition can never be met, so
        // no attestation ever reaches VERIFIED, batchCheckCompliance() returns false for
        // everyone, and FloodPredictionContract rejects every batch with KYCCheckFailed.
        // The deployment succeeded, reported success, and could not pay a single
        // beneficiary. The oracle count (A47) and governance actors (A76) already had
        // this guard; compliance did not, though its failure mode is more absolute.
        const officers = (process.env.COMPLIANCE_OFFICERS || "")
            .split(",").map(a => a.trim()).filter(Boolean);
        for (const [i, addr] of officers.entries()) {
            if (!ethers.isAddress(addr)) {
                throw new Error(`COMPLIANCE_OFFICERS[${i}]="${addr}" is not a valid address`);
            }
            await (await kyc.addComplianceOfficer(addr)).wait();
            logStep("  ✅", `Compliance officer registered: ${addr}`);
        }
        const officerCount = await kyc.officerCount();
        if (officerCount < 2n) {
            throw new Error(
                `Only ${officerCount} compliance officer(s) registered. approveAttestation() ` +
                `requires the approver to differ from the submitter, so no KYC attestation ` +
                `could ever be approved and NO beneficiary could ever be paid.\n` +
                `     Set COMPLIANCE_OFFICERS to at least one address distinct from the deployer.`
            );
        }
        logStep("  ✅", `Compliance: ${officerCount} officers ≥ 2 (four-eyes satisfiable)`);

        steps.complianceAuthorized = true;
        saveProgress(progress);
    } else {
        logStep("⏭️", "JokalanteTargeting/KYCAMLCompliance authorization already configured — skipping");
    }

    // Configure budgets for regions
    if (!steps.budgetsConfigured) {
        logStep("🔧", "Configuring regional budgets...");
        for (const region of DEPLOYMENT_CONFIG.regions) {
            const tx = await floodPred.allocateBudget(region.code, region.budget);
            await tx.wait();
            // CA-01 fix: un plafond à 0 signifie ILLIMITÉ. Sans cet appel, le seul frein
            // quantitatif du rail de paiement n'existe pas.
            const txLimit = await mobileMoney.setDailyLimit(region.code, region.budget);
            await txLimit.wait();
            logStep("  💰", `${region.code} (${region.name}): ${region.budget.toLocaleString()} CFA (plafond journalier identique)`);
        }
        steps.budgetsConfigured = true;
        saveProgress(progress);
    } else {
        logStep("⏭️", "Regional budgets already configured — skipping");
    }

    // L-01 fix: Configure OpalGovernance post-deployment
    if (!steps.governanceConfigured) {
        logStep("🔧", "Configuring OpalGovernance...");
        const opalGov = await ethers.getContractAt(
            "OpalGovernanceUpgradeable",
            deployed.OpalGovernanceProxy
        );
        
        // Wire governance to FloodPrediction
        const tx1 = await opalGov.setFloodPredictionContract(deployed.FloodPredictionProxy);
        await tx1.wait();
        logStep("  🔗", "FloodPrediction contract set on OpalGovernance");

        // H12-GOV fix: emergency-response selectors go through the disjoint
        // emergencyAllowedSelectors whitelist (immediate execution on quorum,
        // bypassing the EXECUTION_DELAY review window).
        const emergencySelectors = [
            floodPred.interface.getFunction("createGovernanceOverrideTrigger").selector,
            floodPred.interface.getFunction("pause").selector,
            floodPred.interface.getFunction("unpause").selector,
            floodPred.interface.getFunction("activateEmergencyMode").selector,
            floodPred.interface.getFunction("deactivateEmergencyMode").selector,
            floodPred.interface.getFunction("setRegionEmergency").selector,
        ];
        const tx2 = await opalGov.setEmergencyAllowedSelectorBatch(
            emergencySelectors,
            emergencySelectors.map(() => true)
        );
        await tx2.wait();
        logStep("  ✅", `${emergencySelectors.length} emergency selectors whitelisted on governance`);

        // Parameter-tuning selectors for PARAMETER_CHANGE/ORACLE_OVERRIDE
        // proposals — these go through the 24h deadline + 1h EXECUTION_DELAY.
        const paramSelectors = [
            floodPred.interface.getFunction("updateRiskThreshold").selector,
            multiOracle.interface.getFunction("setConsensusThreshold").selector,
            multiOracle.interface.getFunction("setDataFreshnessThreshold").selector,
            multiOracle.interface.getFunction("setMaxConsecutiveOutliers").selector,
        ];
        const tx3 = await opalGov.setAllowedSelectorBatch(
            paramSelectors,
            paramSelectors.map(() => true)
        );
        await tx3.wait();
        logStep("  ✅", `${paramSelectors.length} parameter selectors whitelisted on governance`);

        // V-04 fix: paramSelectors above includes MultiOracle selectors, so
        // MultiOracle must be whitelisted as a proposal target too.
        const tx4 = await opalGov.setAllowedTarget(deployed.MultiOracle, true);
        await tx4.wait();
        logStep("  ✅", "MultiOracle whitelisted as governance proposal target");

        // Wire MultiOracle to governance so the onlyOwnerOrGovernance setters
        // above can be called via governance proposals.
        const tx5 = await multiOracle.setGovernance(deployed.OpalGovernanceProxy);
        await tx5.wait();
        logStep("  ✅", "MultiOracle governance set to OpalGovernance");

        // A65 fix: grant the governance PROXY the FloodPrediction roles that the
        // whitelisted selectors require. Without this, every proposal targeting
        // FloodPredictionContract reverts with AccessControlUnauthorizedAccount — the
        // whole multi-sig + quorum + timelock + selector-whitelist apparatus
        // terminated in a call that could not pass, leaving the emergency-response
        // path unavailable precisely when it was needed.
        //   ADMIN_ROLE  -> createGovernanceOverrideTrigger, activateEmergencyMode,
        //                  deactivateEmergencyMode, setRegionEmergency, updateRiskThreshold
        //   PAUSER_ROLE -> pause, unpause
        const fpcAdminRole = await floodPred.ADMIN_ROLE();
        const fpcPauserRole = await floodPred.PAUSER_ROLE();
        const tx6 = await floodPred.grantRole(fpcAdminRole, deployed.OpalGovernanceProxy);
        await tx6.wait();
        const tx7 = await floodPred.grantRole(fpcPauserRole, deployed.OpalGovernanceProxy);
        await tx7.wait();
        logStep("  ✅", "Governance granted ADMIN_ROLE + PAUSER_ROLE on FloodPrediction");

        // A76 fix: register enough governance actors to make the quorum reachable.
        // initialize() registers only the owner, so a quorum of 2+ left activeActorCount
        // at 1 — permanently below it. The proposer auto-signs, no second active actor
        // exists to sign, and executeProposal()'s active-signature recount can never
        // reach requiredSignatures. Granting the roles (A65) was necessary but not
        // sufficient: without a second actor the emergency path is still unreachable.
        const govActors = (process.env.GOVERNANCE_ACTORS || "")
            .split(",").map(a => a.trim()).filter(Boolean);
        for (const [i, addr] of govActors.entries()) {
            if (!ethers.isAddress(addr)) {
                throw new Error(`GOVERNANCE_ACTORS[${i}]="${addr}" is not a valid address`);
            }
            const txa = await opalGov.addGovernanceActor(addr, `Governor-${i + 1}`, "GOVERNOR");
            await txa.wait();
            logStep("  ✅", `Governance actor registered: ${addr}`);
        }
        const activeActors = await opalGov.getActiveActorCount();
        const govQuorum = await opalGov.getQuorum();
        if (activeActors < govQuorum) {
            logStep("⚠️", `Only ${activeActors} governance actor(s) for a quorum of ${govQuorum} —`);
            logStep("⚠️", "NO proposal can ever execute (emergency AND upgrade paths inert).");
            logStep("⚠️", "Set GOVERNANCE_ACTORS (comma-separated) before production use.");
        } else {
            logStep("  ✅", `Governance: ${activeActors} active actors ≥ quorum ${govQuorum}`);
        }

        // CA-01 fix: ARCH-02 + R7-01 n'existaient que dans deploy-upgradeable.js. Sur le
        // script de PRODUCTION, les 5 contrats immuables restaient sous la clé du déployeur —
        // 44 fonctions d'administration hors du périmètre multi-signatures, dont addRelayer
        // sur MMP qui permet de retomber sur ARCH-01.
        //
        // R7-01 : whitelister les sélecteurs AVANT de transférer. Transférer sans cela gèle
        // définitivement les fonctions — le déployeur perd le droit de les appeler et
        // executeProposal rejette tout sélecteur non whitelisté.
        if ((process.env.TRANSFER_SPOKES_TO_GOVERNANCE ?? "true") === "true") {
            // CA-02 fix: transférer vers une gouvernance qui ne peut pas atteindre son
            // quorum laisse les spokes en limbes — pendingOwner pointe sur la gouvernance,
            // et aucune proposition acceptOwnership() ne pourra jamais s'exécuter. Mieux
            // vaut refuser le transfert que produire un déploiement infinissable.
            // deploy-amoy initialise un quorum de 3 (emergencyQuorum) : il faut donc au
            // moins 2 adresses dans GOVERNANCE_ACTORS, le propriétaire comptant pour 1.
            if (activeActors < govQuorum) {
                throw new Error(
                    `Transfert des spokes impossible : ${activeActors} acteur(s) de gouvernance ` +
                    `pour un quorum de ${govQuorum}. Aucune proposition acceptOwnership() ne pourrait ` +
                    `s'exécuter et les contrats resteraient en transfert non finalisé.\n` +
                    `     Renseigner GOVERNANCE_ACTORS avec ${Number(govQuorum) - Number(activeActors)} ` +
                    `adresse(s) de plus, ou poser TRANSFER_SPOKES_TO_GOVERNANCE=false pour différer.`
                );
            }
            const spokeContracts = {
                MultiOracle: multiOracle,
                WASDIOracleConnector: wasdiOracle,
                JokalanteTargeting: jokalante,
                MobileMoneyProvider: mobileMoney,
                KYCAMLCompliance: kyc,
            };
            const OWNER_SELECTORS = {
                MultiOracle: ["registerOracle", "deactivateOracle", "reactivateOracle",
                              "deregisterOracle", "setGovernance"],
                WASDIOracleConnector: ["addRelayer", "removeRelayer", "addSatelliteSource",
                                       "removeSatelliteSource", "setFreshnessThreshold", "setTestMode",
                                       "lockProductionMode", "setRiskAlertThreshold"],
                JokalanteTargeting: ["updateMerkleRoot", "extendRegionExpiry", "deactivateRegion",
                                     "addAuthorizedCaller", "removeAuthorizedCaller",
                                     "updateDefaultExpiry", "updateMaxBeneficiaries"],
                MobileMoneyProvider: ["addRelayer", "removeRelayer", "setDailyLimit",
                                      "setFloodPredictionContract", "setTimeout"],
                KYCAMLCompliance: ["addComplianceOfficer", "removeComplianceOfficer", "authorizeContract",
                                   "deauthorizeContract", "updateDefaultValidity", "updateFraudThreshold"],
            };
            const EMERGENCY_SPOKE_SELECTORS = {
                MultiOracle: ["pause", "unpause"],
                WASDIOracleConnector: ["pause", "unpause"],
                MobileMoneyProvider: ["pause", "unpause"],
            };

            const sel = new Set(), emg = new Set();
            for (const [name, c] of Object.entries(spokeContracts)) {
                for (const fn of OWNER_SELECTORS[name] ?? []) sel.add(c.interface.getFunction(fn).selector);
                for (const fn of EMERGENCY_SPOKE_SELECTORS[name] ?? []) emg.add(c.interface.getFunction(fn).selector);
            }
            sel.add(multiOracle.interface.getFunction("acceptOwnership").selector);

            const selList = [...sel], emgList = [...emg];
            await (await opalGov.setAllowedSelectorBatch(selList, selList.map(() => true))).wait();
            await (await opalGov.setEmergencyAllowedSelectorBatch(emgList, emgList.map(() => true))).wait();
            logStep("  ✅", `${selList.length} sélecteurs d'administration + ${emgList.length} d'urgence whitelistés`);

            for (const [name, c] of Object.entries(spokeContracts)) {
                const addr = await c.getAddress();
                await (await opalGov.setAllowedTarget(addr, true)).wait();
                await (await c.transferOwnership(deployed.OpalGovernanceProxy)).wait();
                logStep("  ✅", `${name} : propriété transférée à la gouvernance (acceptation en attente)`);
            }
            logStep("⚠️", "Finaliser avec accept-spoke-ownership.js (une proposition par spoke).");
            logStep("⚠️", "updateMerkleRoot passe par la gouvernance : publier les listes EN AMONT de la saison.");
        } else {
            logStep("⚠️", "TRANSFER_SPOKES_TO_GOVERNANCE=false — les spokes restent sous la clé du déployeur.");
        }

        steps.governanceConfigured = true;
        saveProgress(progress);
        logStep("✅", "OpalGovernance configured");
    } else {
        logStep("⏭️", "OpalGovernance already configured — skipping");
    }

    // Register oracles in MultiOracle.
    // A47 fix: consensus requires MIN_ORACLE_COUNT (4) active oracles — with only the
    // deployer registered, isConsensusReached() can never become true and every trigger
    // runs through the cold-start path (operator-supplied score, no oracle cross-check).
    // Additional oracle signer addresses can be provided via ORACLE_ADDRESSES
    // (comma-separated). A warning is printed when the count stays below the minimum.
    if (!steps.oracleRegistered) {
        logStep("🔧", "Registering oracles...");
        const tx = await multiOracle.registerOracle(deployer.address, "Deployer Oracle");
        await tx.wait();
        logStep("  ✅", "Deployer registered as oracle (active by default)");

        const extraOracles = (process.env.ORACLE_ADDRESSES || "")
            .split(",").map(a => a.trim()).filter(Boolean);
        for (const [i, addr] of extraOracles.entries()) {
            if (!ethers.isAddress(addr)) throw new Error(`ORACLE_ADDRESSES[${i}]="${addr}" is not a valid address`);
            const txi = await multiOracle.registerOracle(addr, `Oracle-${i + 1}`);
            await txi.wait();
            logStep("  ✅", `Oracle registered: ${addr}`);
        }

        const activeCount = await multiOracle.getActiveOracleCount();
        const minCount = await multiOracle.MIN_ORACLE_COUNT();
        if (activeCount < minCount) {
            logStep("⚠️", `Only ${activeCount}/${minCount} active oracles — consensus is UNREACHABLE.`);
            logStep("⚠️", "Triggers will rely on the cold-start path (no oracle cross-check).");
            logStep("⚠️", "Register more oracles (multiOracle.registerOracle) before production use.");
        }

        steps.oracleRegistered = true;
        saveProgress(progress);
    } else {
        logStep("⏭️", "Oracles already registered — skipping");
    }

    // ----------------------------------------
    // A8-04 fix: hand the hub itself to governance
    // ----------------------------------------
    // ARCH-02 moved the five immutable spokes under governance and left the contract that
    // decides WHO IS PAID AND HOW MUCH under the deployer's EOA. Governance received
    // ADMIN_ROLE and PAUSER_ROLE (A65) — but only as SUBORDINATE roles, revocable at will
    // by the DEFAULT_ADMIN_ROLE the deployer kept. With that one key, without quorum,
    // delay or proposal, one could repoint kycCompliance at a permissive contract,
    // repoint jokalanteTargeting or multiOracle, raise oracleTolerance, lower
    // riskThreshold, or grant any role to anyone. The multi-sig, the quorum, the execution
    // delay and the selector whitelists all guarded the perimeter while the centre stayed
    // one key away.
    //
    // verify-deployment.js made this invisible: it asserted the deployer HELD
    // DEFAULT_ADMIN_ROLE and recorded that as correct.
    //
    // R7-01 applies verbatim: whitelist every admin selector BEFORE renouncing, or the
    // functions become permanently unreachable — the deployer loses the right to call
    // them and executeProposal rejects any selector that is not whitelisted.
    if (!steps.hubHandover && (process.env.TRANSFER_HUB_TO_GOVERNANCE ?? "true") === "true") {
        logSection("Hub Handover — FloodPrediction under governance");

        const activeActors = await opalGov.getActiveActorCount();
        const govQuorum = await opalGov.getQuorum();
        if (activeActors < govQuorum) {
            throw new Error(
                `Hub handover impossible: ${activeActors} governance actor(s) for a quorum of ` +
                `${govQuorum}. Renouncing the deployer's DEFAULT_ADMIN_ROLE has no undo — with ` +
                `an unreachable quorum, EVERY administrative function of FloodPredictionContract ` +
                `would be permanently unreachable.\n` +
                `     Add addresses to GOVERNANCE_ACTORS, or set ` +
                `TRANSFER_HUB_TO_GOVERNANCE=false to defer.`
            );
        }

        // Non-emergency admin surface — subject to the 1h EXECUTION_DELAY review window.
        const HUB_ADMIN_SELECTORS = [
            "allocateBudget", "deactivateBudget", "setContractAddresses",
            "updateRiskThreshold", "setOracleTolerance", "cancelTrigger",
            "grantRole", "revokeRole",
        ];
        const hubSelectors = HUB_ADMIN_SELECTORS.map(
            fn => floodPred.interface.getFunction(fn).selector);
        await (await opalGov.setAllowedSelectorBatch(
            hubSelectors, hubSelectors.map(() => true))).wait();
        logStep("  ✅", `${hubSelectors.length} hub admin selectors whitelisted on governance`);
        // Emergency selectors (pause, emergency mode, override trigger) were whitelisted
        // in the governance configuration step above.

        const fpcDefaultAdmin = ethers.ZeroHash;
        const fpcAdminRole = await floodPred.ADMIN_ROLE();

        // Grant first, renounce second — never leave the contract without an admin.
        await (await floodPred.grantRole(fpcDefaultAdmin, deployed.OpalGovernanceProxy)).wait();
        logStep("  ✅", "Governance granted DEFAULT_ADMIN_ROLE on FloodPrediction");

        if (!(await floodPred.hasRole(fpcDefaultAdmin, deployed.OpalGovernanceProxy))) {
            throw new Error("Governance does not hold DEFAULT_ADMIN_ROLE — aborting before renounce");
        }

        await (await floodPred.renounceRole(fpcAdminRole, deployer.address)).wait();
        await (await floodPred.renounceRole(fpcDefaultAdmin, deployer.address)).wait();
        logStep("  ✅", "Deployer renounced ADMIN_ROLE and DEFAULT_ADMIN_ROLE");
        logStep("⚠️", "Budget allocation and contract rewiring now require a governance proposal");
        logStep("⚠️", "PAUSER_ROLE stays on its own operational key for immediate containment");

        steps.hubHandover = true;
        saveProgress(progress);
    } else if (steps.hubHandover) {
        logStep("⏭️", "Hub already handed over to governance — skipping");
    } else {
        logStep("⚠️", "TRANSFER_HUB_TO_GOVERNANCE=false — FloodPrediction stays under the deployer key.");
    }

    // ----------------------------------------
    // Verification (if on live network)
    // ----------------------------------------
    if (networkName !== "hardhat" && networkName !== "localhost") {
        logSection("Contract Verification");
        logStep("⏳", "Waiting 30s for Polygonscan indexing...");
        await new Promise(r => setTimeout(r, 30000));

        await verifyContract(deployed.MultiOracle);
        await verifyContract(deployed.WASDIOracleConnector);
        await verifyContract(deployed.JokalanteTargeting);
        await verifyContract(deployed.MobileMoneyProvider);
        await verifyContract(deployed.KYCAMLCompliance);
        await verifyContract(deployed.OpalGovernanceImpl);
        await verifyContract(deployed.FloodPredictionImpl);
    }

    // ----------------------------------------
    // Save deployment manifest
    // ----------------------------------------
    logSection("Deployment Manifest");

    const manifest = {
        network: networkName,
        chainId: networkChainId,
        deployer: deployer.address,
        roles: {
            admin: deployer.address,
            operator: operatorAddress,
            upgrader: upgraderAddress,
            pauser: pauserAddress,
        },
        timestamp: new Date().toISOString(),
        duration: `${((Date.now() - startTime) / 1000).toFixed(1)}s`,
        contracts: deployed,
        config: {
            riskThreshold: DEPLOYMENT_CONFIG.riskThreshold,
            regions: DEPLOYMENT_CONFIG.regions.map(r => r.code),
            governanceQuorum: DEPLOYMENT_CONFIG.governance.emergencyQuorum,
        }
    };

    const manifestFile = path.join(
        import.meta.dirname,
        "..",
        `deployment-${networkName}-${Date.now()}.json`
    );
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    logStep("📄", `Manifest saved: ${manifestFile}`);

    // Clean up progress file on successful completion
    if (fs.existsSync(PROGRESS_FILE)) {
        fs.unlinkSync(PROGRESS_FILE);
        logStep("🧹", "Progress file cleaned up");
    }

    // Print summary
    logSection("Deployment Complete!");
    console.log("\n  Contracts deployed:");
    for (const [name, addr] of Object.entries(deployed)) {
        console.log(`    ${name.padEnd(35)} ${addr}`);
    }

    const endBalance = await ethers.provider.getBalance(deployer.address);
    const gasCost = balance - endBalance;
    console.log(`\n  Gas cost: ${ethers.formatEther(gasCost)} MATIC`);
    console.log(`  Duration: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    console.log(`\n  Explorer: https://amoy.polygonscan.com/address/${deployed.FloodPredictionProxy}`);
    console.log("");
