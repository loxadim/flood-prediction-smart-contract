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
    // Regions to pre-configure
    regions: [
        { code: "SN-TH", name: "Thies", budget: ethers.parseEther("1000000") },
        { code: "SN-DK", name: "Dakar", budget: ethers.parseEther("2000000") },
        { code: "SN-SL", name: "Saint-Louis", budget: ethers.parseEther("1500000") },
        { code: "SN-ZG", name: "Ziguinchor", budget: ethers.parseEther("1200000") },
        { code: "SN-KL", name: "Kaolack", budget: ethers.parseEther("800000") },
        { code: "SN-TC", name: "Tambacounda", budget: ethers.parseEther("600000") },
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
        const tx1 = await mobileMoney.addRelayer(deployed.FloodPredictionProxy);
        await tx1.wait();
        logStep("  ✅", "FloodPrediction authorized as MMP relayer");

        const tx2 = await mobileMoney.removeRelayer(deployer.address);
        await tx2.wait();
        logStep("  ✅", "Deployer relayer privileges revoked");

        steps.relayerConfigured = true;
        saveProgress(progress);
    } else {
        logStep("⏭️", "MMP relayers already configured — skipping");
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
            logStep("  💰", `${region.code} (${region.name}): ${ethers.formatEther(region.budget)} CFA`);
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

        steps.governanceConfigured = true;
        saveProgress(progress);
        logStep("✅", "OpalGovernance configured");
    } else {
        logStep("⏭️", "OpalGovernance already configured — skipping");
    }

    // Register deployer as oracle in MultiOracle
    if (!steps.oracleRegistered) {
        logStep("🔧", "Registering deployer as oracle...");
        const tx = await multiOracle.registerOracle(deployer.address, "Deployer Oracle");
        await tx.wait();
        steps.oracleRegistered = true;
        saveProgress(progress);
        logStep("✅", "Deployer registered as oracle (active by default)");
    } else {
        logStep("⏭️", "Oracle already registered — skipping");
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
