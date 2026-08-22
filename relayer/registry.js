import fs from 'node:fs/promises';
import { resolvePath } from './config.js';

/**
 * Load the beneficiaryHash -> { phoneNumber, externalReference } registry.
 *
 * A69 fix: read errors and parse errors used to share one catch that returned `{}` and
 * warned "not found". A stray comma in the file therefore looked identical to a missing
 * file: the relayer started normally, reported "0 records", then answered every payment
 * with BENEFICIARY_DATA_MISSING and pushed a failPayment on-chain for each one — turning
 * a config typo into a mass on-chain failure, behind a message pointing at the wrong
 * cause. A missing file can be deliberate; an unreadable one is always a defect, so it
 * now throws and the service refuses to start.
 *
 * @param {string} registryPath Path to the registry JSON, relative to the project root
 * @returns {Promise<Object>} The registry map, or {} when the file does not exist
 * @throws when the file exists but cannot be read or parsed, or is not a JSON object
 */
export async function loadBeneficiaryRegistry(registryPath) {
  const path = resolvePath(registryPath);

  let raw;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.warn(`[relayer] beneficiary registry not found at ${path}, continuing without mapping`);
      return {};
    }
    throw new Error(`Beneficiary registry at ${path} could not be read: ${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Beneficiary registry at ${path} is not valid JSON: ${error.message}. ` +
      `Fix the file — starting with an empty registry would fail every payment on-chain.`
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Beneficiary registry at ${path} must be a JSON object keyed by beneficiaryHash.`);
  }

  return parsed;
}

export function findBeneficiary(registry, beneficiaryHash) {
  if (!registry || typeof registry !== 'object') {
    return null;
  }

  const key = beneficiaryHash.toString();
  // A69 fix: hex hashes are case-insensitive, but the lookup was not. ethers renders
  // them lowercase while a hand-maintained registry may hold uppercase or mixed case,
  // in which case every lookup silently missed. Try the exact key first (fast path),
  // then fall back to a case-insensitive match.
  if (registry[key] !== undefined) return registry[key];

  const lowered = key.toLowerCase();
  for (const [candidate, value] of Object.entries(registry)) {
    if (candidate.toLowerCase() === lowered) return value;
  }
  return null;
}
