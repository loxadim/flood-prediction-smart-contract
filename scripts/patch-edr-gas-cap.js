/**
 * Post-install patch for Hardhat 3 EDR provider.
 *
 * Hardhat 3's EDR enforces EIP-7825 (Osaka) per-transaction gas cap of 16 MiB
 * (2^24 = 16,777,216). The EDR ProviderConfig supports `transactionGasCap` to
 * override this, but HH3 does not expose it in user config.
 *
 * This script patches the compiled edr-provider.js to set transactionGasCap
 * equal to blockGasLimit, restoring HH2 behavior where transactions could use
 * the full block gas limit.
 *
 * See: https://eips.ethereum.org/EIPS/eip-7825
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const target = resolve(
  __dirname,
  "../node_modules/hardhat/dist/src/internal/builtin-plugins/network-manager/edr/edr-provider.js",
);

const needle = "precompileOverrides: [],";
const replacement =
  "precompileOverrides: [],\n        transactionGasCap: networkConfig.blockGasLimit,";

try {
  const src = readFileSync(target, "utf8");

  if (src.includes("transactionGasCap")) {
    console.log("[patch-edr-gas-cap] Already patched — skipping.");
    process.exit(0);
  }

  if (!src.includes(needle)) {
    console.error(
      "[patch-edr-gas-cap] Target string not found — HH3 may have been updated. Patch skipped.",
    );
    process.exit(0);
  }

  writeFileSync(target, src.replace(needle, replacement), "utf8");
  console.log(
    "[patch-edr-gas-cap] Patched transactionGasCap = blockGasLimit ✓",
  );
} catch (err) {
  console.error("[patch-edr-gas-cap] Patch failed:", err.message);
  process.exit(0); // Non-fatal — don't break npm install
}
