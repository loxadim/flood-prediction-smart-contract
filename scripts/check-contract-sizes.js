/**
 * @title EIP-170 bytecode size guard
 * @description A60 fix. FloodPredictionContract sits at ~92% of the 24,576-byte deployed
 * bytecode limit, so an ordinary-looking change can silently make it undeployable — the
 * failure surfaces only at deploy time, on a live network. This script fails the build
 * once any contract crosses WARN_RATIO, well before the hard ceiling.
 *
 * Usage: npm run size
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EIP170_LIMIT = 24576;
const WARN_RATIO = 0.90;  // report as tight
const FAIL_RATIO = 0.957; // ~23,520 bytes — fail the build

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = path.resolve(__dirname, '..', 'artifacts', 'contracts');

function collectArtifacts(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectArtifacts(full, out);
    else if (entry.name.endsWith('.json') && !entry.name.endsWith('.dbg.json')) out.push(full);
  }
  return out;
}

function deployedSize(artifact) {
  let bytecode = artifact.deployedBytecode;
  if (bytecode && typeof bytecode === 'object') bytecode = bytecode.object;
  if (!bytecode || bytecode === '0x') return 0;
  return (bytecode.length - 2) / 2;
}

const rows = [];
for (const file of collectArtifacts(ARTIFACTS_DIR)) {
  let artifact;
  try {
    artifact = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    continue;
  }
  const size = deployedSize(artifact);
  if (size === 0) continue;
  rows.push({ name: artifact.contractName ?? path.basename(file, '.json'), size });
}

if (rows.length === 0) {
  console.error('No compiled artifacts found — run `npx hardhat compile` first.');
  process.exit(1);
}

rows.sort((a, b) => b.size - a.size);

console.log(`\nDeployed bytecode size (EIP-170 limit: ${EIP170_LIMIT} bytes)\n`);
let failures = 0;
let warnings = 0;

for (const { name, size } of rows) {
  const ratio = size / EIP170_LIMIT;
  const pct = (ratio * 100).toFixed(1).padStart(5);
  let mark = '  ';
  if (ratio >= FAIL_RATIO) {
    mark = '❌';
    failures++;
  } else if (ratio >= WARN_RATIO) {
    mark = '⚠️ ';
    warnings++;
  }
  const remaining = EIP170_LIMIT - size;
  console.log(
    `${mark} ${name.padEnd(30)} ${String(size).padStart(6)} bytes  ${pct}%  ` +
    `(${remaining} left)`
  );
}

console.log('');
if (failures > 0) {
  console.error(
    `${failures} contract(s) above ${(FAIL_RATIO * 100).toFixed(1)}% of the EIP-170 limit.\n` +
    `Shrink the contract before merging — options: move batch logic into an external\n` +
    `library, drop auto-getters in favour of explicit view functions, or split the contract.\n`
  );
  process.exit(1);
}
if (warnings > 0) {
  console.log(`${warnings} contract(s) above ${(WARN_RATIO * 100).toFixed(0)}% — headroom is tight.\n`);
}
