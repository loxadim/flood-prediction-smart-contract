/**
 * validate-upgrade-safety.js — UUPS storage-layout validation
 * DPA Foundation — OPAL Platform
 *
 * Usage:
 *   npx hardhat run scripts/validate-upgrade-safety.js
 *
 * A8-12 fix. FloodPredictionContract and OpalGovernanceUpgradeable sit behind UUPS
 * proxies with a reserved __gap. A storage-layout mistake — a variable inserted without
 * shrinking the gap, a type widened, a base contract reordered — is invisible until
 * someone runs an upgrade against a live proxy holding real budget and payment state.
 * The OpenZeppelin plugin already knows how to detect this; it was simply never run
 * outside a deployment. This script asks it the question on every push instead.
 *
 * It validates each upgradeable implementation in isolation: constructor safety,
 * initializer presence, absence of selfdestruct/delegatecall, and a well-formed layout.
 * It does NOT compare against a deployed proxy (no network state in CI) — that check
 * still happens in scripts/upgrade-contract.js at upgrade time.
 */
import hre from "hardhat";
import { upgrades as makeUpgrades } from "@openzeppelin/hardhat-upgrades";

const connection = await hre.network.connect();
const { ethers } = connection;
const ozUpgrades = await makeUpgrades(hre, connection);

const UPGRADEABLE_CONTRACTS = [
    "FloodPredictionContract",
    "OpalGovernanceUpgradeable",
];

console.log("Validation de la compatibilité UUPS (disposition du stockage)\n");

let failures = 0;

for (const name of UPGRADEABLE_CONTRACTS) {
    process.stdout.write(`  ${name.padEnd(32)}`);
    try {
        const factory = await ethers.getContractFactory(name);
        await ozUpgrades.validateImplementation(factory, { kind: "uups" });
        console.log("✅ conforme");
    } catch (error) {
        console.log("❌ NON CONFORME");
        console.log(`     ${(error.message || String(error)).split("\n").join("\n     ")}`);
        failures++;
    }
}

console.log("");
if (failures > 0) {
    console.error(`${failures} implémentation(s) non conforme(s) — une mise à niveau corromprait le stockage du proxy.`);
    process.exit(1);
}
console.log("Toutes les implémentations sont sûres pour une mise à niveau.");
