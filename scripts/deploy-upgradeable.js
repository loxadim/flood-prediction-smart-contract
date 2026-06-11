/**
 * @title OPAL Flood Prediction - UUPS Proxy Deployment
 * @description Deploys and wires the current production contract set.
 * @network Hardhat local / Polygon Amoy / Polygon Mainnet
 */
import hre from "hardhat";
import fs from "fs";
import { upgrades as makeUpgrades } from "@openzeppelin/hardhat-upgrades";

const connection = await hre.network.connect();
const { ethers } = connection;
const ozUpgrades = await makeUpgrades(hre, connection);

const [deployer, ...otherSigners] = await ethers.getSigners();
const network = await ethers.provider.getNetwork();

// V-06 fix: resolve OPERATOR/UPGRADER/PAUSER to addresses distinct from the
// deployer (ADMIN). Reusing deployer.address for every role collapses RBAC
// separation-of-duties — one compromised key would hold all privileges.
// On local networks fall back to additional Hardhat signers; on any other
// network these env vars are required.
const isLocalNetwork = network.chainId === 1337n || network.chainId === 31337n;

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
        `${envVar} must be set to a distinct address for ${roleName} on network "${network.name}" (chainId ${network.chainId})`
    );
}

const operatorAddress = resolveRoleAddress("OPERATOR_ADDRESS", otherSigners[0], "OPERATOR_ROLE");
const upgraderAddress = resolveRoleAddress("UPGRADER_ADDRESS", otherSigners[1], "UPGRADER_ROLE");
const pauserAddress = resolveRoleAddress("PAUSER_ADDRESS", otherSigners[2], "PAUSER_ROLE");

console.log("=== OPAL Flood Prediction - Upgradeable Deployment ===");
console.log(`Deployer (ADMIN): ${deployer.address}`);
console.log(`OPERATOR_ROLE:    ${operatorAddress}`);
console.log(`UPGRADER_ROLE:    ${upgraderAddress}`);
console.log(`PAUSER_ROLE:      ${pauserAddress}`);
console.log(`Balance: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);
console.log(`Network: ${network.name} (chainId: ${network.chainId})`);
console.log("");

async function deployContract(name) {
    console.log(`Deploying ${name}...`);
    const Factory = await ethers.getContractFactory(name);
    const instance = await Factory.deploy();
    await instance.waitForDeployment();
    const address = await instance.getAddress();
    console.log(`   ${name}: ${address}`);
    return { instance, address };
}

const { instance: multiOracle, address: multiOracleAddr } = await deployContract("MultiOracle");
const { instance: wasdiOracle, address: wasdiOracleAddr } = await deployContract("WASDIOracleConnector");
const { instance: targeting, address: targetingAddr } = await deployContract("JokalanteTargeting");
const { instance: mobileMoney, address: mobileMoneyAddr } = await deployContract("MobileMoneyProvider");
const { instance: kyc, address: kycAddr } = await deployContract("KYCAMLCompliance");

console.log("Deploying OpalGovernanceUpgradeable (UUPS Proxy)...");
const OpalGovernance = await ethers.getContractFactory("OpalGovernanceUpgradeable");
const governance = await ozUpgrades.deployProxy(
    OpalGovernance,
    [deployer.address, 2],
    { kind: "uups", timeout: 60000, pollingInterval: 500 }
);
await governance.waitForDeployment();
const governanceAddr = await governance.getAddress();
const governanceImplAddr = await ozUpgrades.erc1967.getImplementationAddress(governanceAddr);
console.log(`   OpalGovernance proxy: ${governanceAddr}`);
console.log(`   OpalGovernance impl:  ${governanceImplAddr}`);

console.log("Deploying FloodPredictionContract (UUPS Proxy)...");
const FloodPrediction = await ethers.getContractFactory("FloodPredictionContract");
const floodPrediction = await ozUpgrades.deployProxy(
    FloodPrediction,
    [deployer.address, operatorAddress, upgraderAddress, pauserAddress],
    { kind: "uups", timeout: 60000, pollingInterval: 500 }
);
await floodPrediction.waitForDeployment();
const floodPredictionAddr = await floodPrediction.getAddress();
const floodPredictionImplAddr = await ozUpgrades.erc1967.getImplementationAddress(floodPredictionAddr);
console.log(`   FloodPrediction proxy: ${floodPredictionAddr}`);
console.log(`   FloodPrediction impl:  ${floodPredictionImplAddr}`);

console.log("\nWiring contracts together...");
await (await floodPrediction.setContractAddresses(
    multiOracleAddr,
    governanceAddr,
    targetingAddr,
    mobileMoneyAddr,
    kycAddr
)).wait();
await (await governance.setFloodPredictionContract(floodPredictionAddr)).wait();
await (await multiOracle.setGovernance(governanceAddr)).wait();
await (await targeting.addAuthorizedCaller(floodPredictionAddr)).wait();
await (await mobileMoney.addRelayer(floodPredictionAddr)).wait();
// V-07 fix: the deployer is registered as the initial MMP relayer in the
// constructor. Once FloodPrediction is wired in as a relayer, the deployer
// no longer needs (and should not retain) relayer privileges.
await (await mobileMoney.removeRelayer(deployer.address)).wait();
await (await kyc.authorizeContract(floodPredictionAddr)).wait();

// H12-GOV fix: EMERGENCY_TRIGGER proposals may only call selectors from
// emergencyAllowedSelectors, a whitelist disjoint from allowedSelectors.
// Only genuine, time-critical emergency-response functions go here — they
// execute immediately on quorum, bypassing the EXECUTION_DELAY owner-veto
// window that protects PARAMETER_CHANGE/BUDGET_ALLOCATION/UPGRADE/ORACLE_OVERRIDE.
const emergencyAllowedSelectors = [
    floodPrediction.interface.getFunction("createGovernanceOverrideTrigger").selector,
    floodPrediction.interface.getFunction("pause").selector,
    floodPrediction.interface.getFunction("unpause").selector,
    floodPrediction.interface.getFunction("activateEmergencyMode").selector,
    floodPrediction.interface.getFunction("deactivateEmergencyMode").selector,
    floodPrediction.interface.getFunction("setRegionEmergency").selector,
];
await (await governance.setEmergencyAllowedSelectorBatch(
    emergencyAllowedSelectors,
    emergencyAllowedSelectors.map(() => true)
)).wait();

// Parameter-tuning selectors for PARAMETER_CHANGE/ORACLE_OVERRIDE proposals —
// these always go through the 24h deadline + 1h EXECUTION_DELAY review window.
const allowedSelectors = [
    floodPrediction.interface.getFunction("updateRiskThreshold").selector,
    multiOracle.interface.getFunction("setConsensusThreshold").selector,
    multiOracle.interface.getFunction("setDataFreshnessThreshold").selector,
    multiOracle.interface.getFunction("setMaxConsecutiveOutliers").selector,
];
await (await governance.setAllowedSelectorBatch(
    allowedSelectors,
    allowedSelectors.map(() => true)
)).wait();
// V-04 fix: setFloodPredictionContract() above already whitelists
// floodPredictionAddr as an allowed proposal target. The selector batches also
// include MultiOracle selectors, so MultiOracle must be whitelisted too or
// governance proposals targeting it will revert with TargetNotWhitelisted.
await (await governance.setAllowedTarget(multiOracleAddr, true)).wait();
console.log("   Contract addresses, relayers, auth, and governance selectors configured");

console.log("\nConfiguring sample regional budgets...");
const regions = [
    { code: "SN-TH", budget: 100_000_000n },
    { code: "SN-DK", budget: 200_000_000n },
    { code: "SN-SL", budget: 150_000_000n },
    { code: "SN-ZG", budget: 120_000_000n },
    { code: "SN-KL", budget: 80_000_000n },
    { code: "SN-TC", budget: 60_000_000n },
];
for (const region of regions) {
    await (await floodPrediction.allocateBudget(region.code, region.budget)).wait();
    console.log(`   ${region.code}: ${region.budget} CFA`);
}

const addresses = {
    MultiOracle: multiOracleAddr,
    WASDIOracleConnector: wasdiOracleAddr,
    JokalanteTargeting: targetingAddr,
    MobileMoneyProvider: mobileMoneyAddr,
    KYCAMLCompliance: kycAddr,
    OpalGovernanceProxy: governanceAddr,
    OpalGovernanceImpl: governanceImplAddr,
    FloodPredictionProxy: floodPredictionAddr,
    FloodPredictionImpl: floodPredictionImplAddr,
};

console.log("\n=== Deployment Summary ===");
for (const [name, addr] of Object.entries(addresses)) {
    console.log(`  ${name}: ${addr}`);
}

const deploymentInfo = {
    network: network.name,
    chainId: Number(network.chainId),
    deployer: deployer.address,
    roles: {
        admin: deployer.address,
        operator: operatorAddress,
        upgrader: upgraderAddress,
        pauser: pauserAddress,
    },
    timestamp: new Date().toISOString(),
    contracts: addresses,
    config: {
        regions: regions.map((r) => r.code),
        governanceQuorum: 2,
    },
};
const filename = `deployment-${network.name}-${Date.now()}.json`;
fs.writeFileSync(filename, JSON.stringify(deploymentInfo, null, 2));
console.log(`\nDeployment saved to ${filename}`);
