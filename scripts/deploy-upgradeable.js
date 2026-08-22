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
// ARCH-01 fix: bind the provider to the FloodPrediction ledger. Without this the
// relayer whitelist IS the spending authority — any whitelisted key (including the
// relayer's hot wallet) could mint payment orders with no trigger, Merkle proof, KYC
// check or budget behind them. Bound, every order must match an on-chain PaymentRecord.
await (await mobileMoney.setFloodPredictionContract(floodPredictionAddr)).wait();
// A29 fix: authorize the off-chain relayer service wallet so it can call the
// settlement functions (confirmPayment/failPayment/batchConfirmPayments) and
// submitSatelliteData on WASDI. RELAYER_ADDRESS env, or a local signer fallback.
const relayerServiceAddr = process.env.RELAYER_ADDRESS || (otherSigners[3] && otherSigners[3].address);
if (relayerServiceAddr) {
    await (await mobileMoney.addRelayer(relayerServiceAddr)).wait();
    await (await wasdiOracle.addRelayer(relayerServiceAddr)).wait();
}
// V-07 fix: the deployer is registered as the initial MMP relayer in the
// constructor. Once FloodPrediction is wired in as a relayer, the deployer
// no longer needs (and should not retain) relayer privileges.
await (await mobileMoney.removeRelayer(deployer.address)).wait();
await (await kyc.authorizeContract(floodPredictionAddr)).wait();

// A8-03 fix: register a second compliance officer, or the KYC pipeline is inert.
// KYCAMLCompliance's constructor registers the deployer as the ONLY officer, and
// approveAttestation() enforces four eyes (H-04): the approver must differ from the
// submitter. With one officer that is unsatisfiable — no attestation ever reaches
// VERIFIED, batchCheckCompliance() returns false for everyone, and every payment batch
// reverts with KYCCheckFailed. The deployment reported success and could not pay anyone.
const complianceOfficers = (process.env.COMPLIANCE_OFFICERS || "")
    .split(",").map((a) => a.trim()).filter(Boolean);
for (const [i, addr] of complianceOfficers.entries()) {
    if (!ethers.isAddress(addr)) {
        throw new Error(`COMPLIANCE_OFFICERS[${i}]="${addr}" is not a valid address`);
    }
    await (await kyc.addComplianceOfficer(addr)).wait();
    console.log(`   officier de conformité enregistré : ${addr}`);
}
// Local fallback so `npm run deploy:local` stays usable without extra configuration.
if ((await kyc.officerCount()) < 2n && isLocalNetwork && otherSigners[4]) {
    await (await kyc.addComplianceOfficer(otherSigners[4].address)).wait();
    console.log(`   officier de conformité (signataire local) : ${otherSigners[4].address}`);
}
const kycOfficerCount = await kyc.officerCount();
if (kycOfficerCount < 2n) {
    throw new Error(
        `Seulement ${kycOfficerCount} officier(s) de conformité. approveAttestation() exige ` +
        `un approbateur distinct du soumissionnaire : aucune attestation KYC ne pourrait ` +
        `être approuvée et AUCUN bénéficiaire ne pourrait être payé.\n` +
        `     Renseigner COMPLIANCE_OFFICERS avec au moins une adresse distincte du déployeur.`
    );
}
console.log(`   ✅ ${kycOfficerCount} officiers de conformité (règle des 4 yeux satisfiable)`);

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

// A65 fix: grant the governance PROXY the FloodPrediction roles that the whitelisted
// selectors require. Without this, every proposal targeting FloodPredictionContract
// reverts with AccessControlUnauthorizedAccount — the whole multi-sig + quorum +
// timelock + selector-whitelist apparatus terminated in a call that could not pass,
// and the emergency-response path was unavailable precisely when it was needed.
//   ADMIN_ROLE  -> createGovernanceOverrideTrigger, activateEmergencyMode,
//                  deactivateEmergencyMode, setRegionEmergency, updateRiskThreshold
//   PAUSER_ROLE -> pause, unpause
const FPC_ADMIN_ROLE = await floodPrediction.ADMIN_ROLE();
const FPC_PAUSER_ROLE = await floodPrediction.PAUSER_ROLE();
await (await floodPrediction.grantRole(FPC_ADMIN_ROLE, governanceAddr)).wait();
await (await floodPrediction.grantRole(FPC_PAUSER_ROLE, governanceAddr)).wait();
console.log("   Governance granted ADMIN_ROLE + PAUSER_ROLE on FloodPrediction");

// A76 fix: register enough governance actors to make the quorum reachable.
// initialize() registers only the owner, so a quorum of 2 left activeActorCount (1)
// permanently below it: the proposer auto-signs, no second active actor exists to sign,
// and executeProposal()'s active-signature recount can never reach requiredSignatures.
// Granting the roles (A65) was necessary but not sufficient — without a second actor the
// emergency-response path is still unreachable after a fresh deployment.
const GOVERNANCE_QUORUM = 2;
const envActors = (process.env.GOVERNANCE_ACTORS || "")
    .split(",").map(a => a.trim()).filter(Boolean);
const actorAddresses = envActors.length > 0
    ? envActors
    : (isLocalNetwork ? otherSigners.slice(4, 4 + GOVERNANCE_QUORUM - 1).map(s => s.address) : []);

for (const [i, addr] of actorAddresses.entries()) {
    if (!ethers.isAddress(addr)) throw new Error(`GOVERNANCE_ACTORS[${i}]="${addr}" is not a valid address`);
    await (await governance.addGovernanceActor(addr, `Governor-${i + 1}`, "GOVERNOR")).wait();
    console.log(`   Governance actor registered: ${addr}`);
}
const activeActors = await governance.getActiveActorCount();
if (activeActors < BigInt(GOVERNANCE_QUORUM)) {
    console.log(`   ⚠️  Only ${activeActors} governance actor(s) for a quorum of ${GOVERNANCE_QUORUM} —`);
    console.log("      NO proposal can ever execute. Set GOVERNANCE_ACTORS to add signers.");
} else {
    console.log(`   Governance: ${activeActors} active actors ≥ quorum ${GOVERNANCE_QUORUM} — proposals can execute`);
}

// A77 fix: register oracles. This script wired MultiOracle in but never registered a
// single oracle, so activeOracleCount stayed 0 — below MIN_ORACLE_COUNT (4) — meaning
// consensus could never be computed and every trigger ran the cold-start path where the
// operator's riskScore is accepted with no oracle cross-check. deploy-amoy.js already
// registered oracles; the local script silently did not, so the local stack could not
// exercise the oracle path at all and verify-deployment.js always reported a failure.
const MIN_ORACLES = Number(await multiOracle.MIN_ORACLE_COUNT());
const envOracles = (process.env.ORACLE_ADDRESSES || "")
    .split(",").map(a => a.trim()).filter(Boolean);
const oracleAddresses = envOracles.length > 0
    ? envOracles
    : (isLocalNetwork ? otherSigners.slice(6, 6 + MIN_ORACLES).map(s => s.address) : []);

for (const [i, addr] of oracleAddresses.entries()) {
    if (!ethers.isAddress(addr)) throw new Error(`ORACLE_ADDRESSES[${i}]="${addr}" is not a valid address`);
    await (await multiOracle.registerOracle(addr, `Oracle-${i + 1}`)).wait();
    console.log(`   Oracle registered: ${addr}`);
}
const activeOracles = await multiOracle.getActiveOracleCount();
if (activeOracles < BigInt(MIN_ORACLES)) {
    console.log(`   ⚠️  Only ${activeOracles}/${MIN_ORACLES} active oracles — consensus is unreachable,`);
    console.log("      so createFloodTrigger() accepts any operator riskScore. Set ORACLE_ADDRESSES.");
} else {
    console.log(`   MultiOracle: ${activeOracles}/${MIN_ORACLES} active oracles — cross-check enforced`);
}

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
    // ARCH-01 fix: a daily ceiling bounds the blast radius of any compromise on the
    // payment rail. The default was 0, which MobileMoneyProvider reads as UNLIMITED,
    // and no script ever called setDailyLimit — so the only quantitative brake on
    // disbursement did not exist. The region's own allocation is the natural cap: a
    // region can never legitimately pay out more in a day than it was ever granted.
    await (await mobileMoney.setDailyLimit(region.code, region.budget)).wait();
    console.log(`   ${region.code}: ${region.budget} CFA (plafond journalier identique)`);
}

// ARCH-02 fix: hand the five non-upgradeable contracts to governance.
// They were left under the deployer EOA — 44 onlyOwner functions outside the multi-sig
// perimeter, including addRelayer (which re-opens ARCH-01), updateMerkleRoot (redefines
// who is eligible) and addComplianceOfficer (self-approve KYC). Ownable2Step makes the
// handover safe: governance must explicitly accept, so a wrong address cannot strand
// the contracts. Acceptance is a governance proposal — see the whitelist below.
const spokes = [
    ["MultiOracle", multiOracle],
    ["WASDIOracleConnector", wasdiOracle],
    ["JokalanteTargeting", targeting],
    ["MobileMoneyProvider", mobileMoney],
    ["KYCAMLCompliance", kyc],
];
if ((process.env.TRANSFER_SPOKES_TO_GOVERNANCE ?? "true") === "true") {
    // R7-01 fix: whitelist EVERY owner-gated selector of the spokes before handing them
    // over. Transferring ownership without this bricks the contracts: the deployer loses
    // the right to call them, and governance cannot call them either because
    // executeProposal rejects any non-whitelisted selector. On the first pass only
    // acceptOwnership was whitelisted, which left 36 of the 37 admin functions
    // permanently unreachable — including JokalanteTargeting.updateMerkleRoot, without
    // which no new beneficiary list can ever be published again.
    //
    // Named explicitly rather than derived: getFunction() throws if a name disappears,
    // so a renamed function breaks the deployment instead of silently stranding it.
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
    // pause/unpause are time-critical containment actions: they belong on the emergency
    // whitelist so they execute immediately on quorum, not after the 1h review window.
    const EMERGENCY_SPOKE_SELECTORS = {
        MultiOracle: ["pause", "unpause"],
        WASDIOracleConnector: ["pause", "unpause"],
        MobileMoneyProvider: ["pause", "unpause"],
    };

    const spokeSelectors = new Set();
    const spokeEmergencySelectors = new Set();
    for (const [name, c] of spokes) {
        for (const fn of OWNER_SELECTORS[name] ?? []) {
            spokeSelectors.add(c.interface.getFunction(fn).selector);
        }
        for (const fn of EMERGENCY_SPOKE_SELECTORS[name] ?? []) {
            spokeEmergencySelectors.add(c.interface.getFunction(fn).selector);
        }
    }
    spokeSelectors.add(spokes[0][1].interface.getFunction("acceptOwnership").selector);

    const selList = [...spokeSelectors];
    await (await governance.setAllowedSelectorBatch(selList, selList.map(() => true))).wait();
    const emgList = [...spokeEmergencySelectors];
    await (await governance.setEmergencyAllowedSelectorBatch(emgList, emgList.map(() => true))).wait();
    console.log(`   ${selList.length} sélecteurs d'administration + ${emgList.length} d'urgence whitelistés pour les spokes`);

    for (const [name, c] of spokes) {
        const addr = await c.getAddress();
        await (await governance.setAllowedTarget(addr, true)).wait();
        await (await c.transferOwnership(governanceAddr)).wait();
        console.log(`   ${name}: propriété transférée à la gouvernance (acceptation en attente)`);
    }
    console.log("   ⚠️  Finaliser avec `npm run accept-ownership` (une proposition par spoke).");
    console.log("   ⚠️  updateMerkleRoot passe désormais par la gouvernance : publier les listes");
    console.log("      de bénéficiaires EN AMONT de la saison, pas pendant un événement.");
} else {
    console.log("   ⚠️  TRANSFER_SPOKES_TO_GOVERNANCE=false — les 5 spokes restent sous la clé du déployeur.");
}

// ============================================================================
// A8-04 fix: le hub lui-même passe sous gouvernance
// ============================================================================
// ARCH-02 a placé les 5 spokes sous gouvernance et laissé sous la clé du déployeur le
// contrat qui décide QUI EST PAYÉ ET COMBIEN. La gouvernance n'avait reçu qu'ADMIN_ROLE
// et PAUSER_ROLE (A65) — des rôles SUBORDONNÉS, révocables à volonté par le
// DEFAULT_ADMIN_ROLE conservé par le déployeur. Avec cette seule clé, sans quorum ni
// délai : repointer kycCompliance vers un contrat permissif, repointer le ciblage ou
// l'oracle, relever oracleTolerance, abaisser riskThreshold, s'attribuer n'importe quel
// rôle. Tout l'appareil multi-signatures protégeait la périphérie, le centre restait à
// une clé de distance.
//
// R7-01 s'applique mot pour mot : whitelister AVANT de renoncer, sinon les fonctions
// deviennent définitivement inatteignables.
if ((process.env.TRANSFER_HUB_TO_GOVERNANCE ?? "true") === "true") {
    console.log("\n=== Transfert du hub à la gouvernance (A8-04) ===");

    const govQuorum = await governance.getQuorum();
    if (activeActors < govQuorum) {
        throw new Error(
            `Transfert du hub impossible : ${activeActors} acteur(s) de gouvernance pour un ` +
            `quorum de ${govQuorum}. Renoncer au DEFAULT_ADMIN_ROLE du déployeur est sans ` +
            `retour — avec un quorum inatteignable, TOUTE fonction d'administration de ` +
            `FloodPredictionContract deviendrait définitivement inaccessible.\n` +
            `     Renseigner GOVERNANCE_ACTORS, ou poser TRANSFER_HUB_TO_GOVERNANCE=false.`
        );
    }

    const HUB_ADMIN_SELECTORS = [
        "allocateBudget", "deactivateBudget", "setContractAddresses",
        "updateRiskThreshold", "setOracleTolerance", "cancelTrigger",
        "grantRole", "revokeRole",
    ];
    const hubSelectors = HUB_ADMIN_SELECTORS.map(
        (fn) => floodPrediction.interface.getFunction(fn).selector);
    await (await governance.setAllowedSelectorBatch(
        hubSelectors, hubSelectors.map(() => true))).wait();
    console.log(`   ${hubSelectors.length} sélecteurs d'administration du hub whitelistés`);

    const DEFAULT_ADMIN = ethers.ZeroHash;
    const adminRole = await floodPrediction.ADMIN_ROLE();

    // Accorder d'abord, renoncer ensuite — ne jamais laisser le contrat sans administrateur.
    await (await floodPrediction.grantRole(DEFAULT_ADMIN, governanceAddr)).wait();
    if (!(await floodPrediction.hasRole(DEFAULT_ADMIN, governanceAddr))) {
        throw new Error("La gouvernance ne détient pas DEFAULT_ADMIN_ROLE — abandon avant renonciation");
    }
    console.log("   gouvernance : DEFAULT_ADMIN_ROLE accordé");

    await (await floodPrediction.renounceRole(adminRole, deployer.address)).wait();
    await (await floodPrediction.renounceRole(DEFAULT_ADMIN, deployer.address)).wait();
    console.log("   déployeur : ADMIN_ROLE et DEFAULT_ADMIN_ROLE abandonnés");
    console.log("   ⚠️  L'allocation de budget et le recâblage des contrats passent désormais");
    console.log("      par une proposition de gouvernance (délai d'exécution d'1 h).");
    console.log("   ⚠️  PAUSER_ROLE reste sur sa propre clé opérationnelle (arrêt immédiat).");
} else {
    console.log("   ⚠️  TRANSFER_HUB_TO_GOVERNANCE=false — le hub reste sous la clé du déployeur.");
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
