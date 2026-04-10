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

const [deployer] = await ethers.getSigners();
const balance = await ethers.provider.getBalance(deployer.address);

console.log(`\n  Network:  ${networkName} (chainId: ${networkChainId})`);
console.log(`  Deployer: ${deployer.address}`);
console.log(`  Balance:  ${ethers.formatEther(balance)} MATIC`);

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
            [deployer.address, deployer.address, deployer.address, deployer.address],
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

    // Grant roles
    if (!steps.rolesGranted) {
        logStep("🔧", "Granting OPERATOR_ROLE to deployer...");
        const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE"));
        const tx1 = await floodPred.grantRole(OPERATOR_ROLE, deployer.address);
        await tx1.wait();

        logStep("🔧", "Granting PAUSER_ROLE to deployer...");
        const PAUSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE"));
        const tx2 = await floodPred.grantRole(PAUSER_ROLE, deployer.address);
        await tx2.wait();
        steps.rolesGranted = true;
        saveProgress(progress);
        logStep("✅", "Roles granted");
    } else {
        logStep("⏭️", "Roles already granted — skipping");
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

        // Whitelist selectors for governance proposals
        const selectors = [
            floodPred.interface.getFunction("createGovernanceOverrideTrigger").selector,
            floodPred.interface.getFunction("pause").selector,
            floodPred.interface.getFunction("unpause").selector,
        ];
        const allowed = selectors.map(() => true);
        const tx2 = await opalGov.setAllowedSelectorBatch(selectors, allowed);
        await tx2.wait();
        logStep("  ✅", `${selectors.length} selectors whitelisted on governance`);

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
