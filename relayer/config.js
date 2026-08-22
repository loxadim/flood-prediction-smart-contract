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
    // A8-05 fix: simulation is now an explicit opt-in, never an inferred fallback.
    //
    // The A30 default flipped to simulation whenever no provider key was present. The
    // intent was convenience while the Orange Money / Wave contracts were being
    // negotiated, but the trigger was an ABSENCE: a secret that failed to mount, a
    // renamed variable, a container redeployed without its env file all silently put a
    // production relayer into make-believe mode — while it kept writing real
    // confirmPayment transactions on-chain, marking payments CONFIRMED and inflating
    // totalDisbursed for transfers that never happened. A mode that moves money on paper
    // must be chosen, not inherited from a missing string.
    simulatePayments: env.SIMULATE_PAYMENTS === 'true',
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

/**
 * A8-05 fix: refuse to start in the state that used to be the silent default — no
 * provider credentials and no explicit simulation flag.
 *
 * Deliberately separate from getConfig(), which is called on every payment: this is a
 * startup policy check, not a per-call one, and the adapters have their own
 * PROVIDER_NOT_CONFIGURED path for an individual provider that is missing credentials
 * (A40). Failing here is loud and recoverable; starting is not.
 *
 * @param {object} config Result of getConfig()
 */
export function assertPaymentModeConfigured(config) {
  const hasAnyProviderKey = PROVIDER_NAMES.some((name) => config.providerApiKeys[name]);
  if (!config.simulatePayments && !hasAnyProviderKey) {
    throw new Error(
      'No Mobile Money provider is configured and SIMULATE_PAYMENTS is not set to "true". ' +
      'Set at least one of ORANGE_MONEY_API_KEY / WAVE_API_KEY / FREE_MONEY_API_KEY / ' +
      'EMONEY_API_KEY, or set SIMULATE_PAYMENTS=true to run against no real provider. ' +
      'Refusing to start: a relayer with neither would confirm payments on-chain that ' +
      'were never executed.'
    );
  }
}

/** Chain IDs on which simulated payments are acceptable (local development only). */
const SIMULATION_ALLOWED_CHAIN_IDS = new Set([1337n, 31337n]);

/**
 * A8-05 fix: simulation confirms payments on-chain without moving money. That is a
 * legitimate development aid and a dangerous production state, so it is refused anywhere
 * but a local chain. Checked at connection time because the chain ID is only known then.
 *
 * @param {bigint} chainId Chain ID reported by the connected provider
 * @param {boolean} simulatePayments Whether simulation mode is active
 */
export function assertSimulationAllowed(chainId, simulatePayments) {
  if (!simulatePayments) return;
  if (!SIMULATION_ALLOWED_CHAIN_IDS.has(BigInt(chainId))) {
    throw new Error(
      `SIMULATE_PAYMENTS=true on chain ${chainId}, which is not a local network. ` +
      'Simulated payments are confirmed on-chain as if they had been executed, so they ' +
      'must never run against a public network. Configure real provider credentials.'
    );
  }
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
