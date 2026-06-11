import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROVIDER_NAMES = ['ORANGE_MONEY', 'WAVE', 'FREE_MONEY', 'EMONEY'];

const DEFAULT_REGISTRY_PATH = './relayer/beneficiaries.json';

export function getConfig() {
  const env = process.env;

  const config = {
    rpcUrl: env.RPC_URL || env.LOCALHOST_RPC_URL || 'http://127.0.0.1:8545',
    privateKey: env.PRIVATE_KEY,
    mobileMoneyProviderAddress: env.MOBILE_MONEY_PROVIDER_ADDRESS,
    wasdiOracleConnectorAddress: env.WASDI_ORACLE_CONNECTOR_ADDRESS || null,
    beneficiaryRegistryPath: env.BENEFICIARY_REGISTRY_PATH || DEFAULT_REGISTRY_PATH,
    simulatePayments: env.SIMULATE_PAYMENTS === 'true' || false,
    providerApiKeys: {
      ORANGE_MONEY: env.ORANGE_MONEY_API_KEY || null,
      WAVE: env.WAVE_API_KEY || null,
      FREE_MONEY: env.FREE_MONEY_API_KEY || null,
      EMONEY: env.EMONEY_API_KEY || null,
    },
    providerUrls: {
      ORANGE_MONEY: env.ORANGE_MONEY_API_URL || null,
      WAVE: env.WAVE_API_URL || null,
      FREE_MONEY: env.FREE_MONEY_API_URL || null,
      EMONEY: env.EMONEY_API_URL || null,
    },
  };

  if (!config.privateKey) {
    throw new Error('PRIVATE_KEY must be set in the environment');
  }
  if (!config.mobileMoneyProviderAddress) {
    throw new Error('MOBILE_MONEY_PROVIDER_ADDRESS must be set in the environment');
  }

  return config;
}

export function providerNameFromIndex(index) {
  const numericIndex = Number(index);
  if (Number.isNaN(numericIndex) || numericIndex < 0 || numericIndex >= PROVIDER_NAMES.length) {
    return 'UNKNOWN_PROVIDER';
  }
  return PROVIDER_NAMES[numericIndex];
}

export function providerIndexFromName(provider) {
  const normalized = String(provider).toUpperCase();
  const index = PROVIDER_NAMES.indexOf(normalized);
  if (index === -1) {
    throw new Error(`Unknown provider name: ${provider}. Supported: ${PROVIDER_NAMES.join(', ')}`);
  }
  return index;
}

export function getSdkProviderNames() {
  return [...PROVIDER_NAMES];
}

export function resolvePath(relativePath) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  return path.resolve(__dirname, '..', relativePath);
}
