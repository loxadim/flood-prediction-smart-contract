import fs from 'node:fs/promises';
import { resolvePath } from './config.js';

export async function loadBeneficiaryRegistry(registryPath) {
  const path = resolvePath(registryPath);
  try {
    const raw = await fs.readFile(path, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    console.warn(`[relayer] beneficiary registry not found at ${path}, continuing without mapping`);
    return {};
  }
}

export function findBeneficiary(registry, beneficiaryHash) {
  if (!registry || typeof registry !== 'object') {
    return null;
  }

  const key = beneficiaryHash.toString();
  return registry[key] || null;
}
