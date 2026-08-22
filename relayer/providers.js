import { getConfig, getSdkProviderNames } from './config.js';
// A58 fix: sanitizeForLogging was imported here but never called — this module only
// ever hands scalars (paymentId, provider, amount, status) to the audit logger, so the
// import advertised a protection that was not in force. It is applied in service.js,
// where beneficiary phone numbers actually flow.
import { validateTLSCertificate, hashSensitiveData } from './crypto.js';
import {
  auditLogger,
  certificateMonitor,
  anomalyDetector,
  rateLimitTracker,
} from './security.js';
import { sanitizeForLogging } from './crypto.js';

/**
 * A71 fix: build the provider idempotency key from paymentId AND retryCount.
 *
 * The A45 fix had pinned it to paymentId alone, to stop a network resend being treated
 * as a fresh request and double-disbursing. But retryPayment() reuses the same
 * paymentId by design, so a deliberate retry became byte-identical to the attempt that
 * had just failed: an idempotent endpoint replays its cached response, the retry never
 * executes, and depending on the status returned the relayer may confirm on-chain a
 * transfer that never happened.
 *
 * Composing the two satisfies both requirements at once — a resend within one attempt
 * keeps its key and stays deduplicated, while a new attempt opens a new key.
 */
export function idempotencyKey(paymentRequest) {
  return `${paymentRequest.paymentId}-${paymentRequest.retryCount ?? 0}`;
}

/**
 * A72 fix: capture the provider's error body instead of discarding it.
 *
 * The Orange and Wave adapters read `await response.text()` into a variable they never
 * used, so the single most useful diagnostic — the provider's stated reason for
 * refusing — was consumed and thrown away; Free Money and E-Money never read it at
 * all. The body is run through sanitizeForLogging because an error payload can echo
 * back the MSISDN.
 */
export async function describeFailure(providerLabel, response) {
  let body = '';
  try {
    body = await response.text();
  } catch {
    body = '<unreadable>';
  }
  const safe = typeof body === 'string' ? body.slice(0, 500) : '';
  await auditLogger.logSecurityEvent(
    'PROVIDER_REJECTED', 'WARNING',
    `${providerLabel} returned ${response.status}`,
    sanitizeForLogging({ status: response.status, body: safe })
  );
  return safe
    ? `${providerLabel} returned ${response.status}: ${safe}`
    : `${providerLabel} returned ${response.status}`;
}

/**
 * Orange Money Sandbox Adapter
 * API: https://developers.orange.com/products/orange-money-api
 */
class OrangeMoneyAdapter {
  constructor(config) {
    this.apiUrl = config.providerUrls.ORANGE_MONEY;
    this.apiKey = config.providerApiKeys.ORANGE_MONEY;
    this.merchantId = process.env.ORANGE_MONEY_MERCHANT_ID;
    this.validateConfig();
  }

  validateConfig() {
    if (!this.apiUrl || !this.apiKey || !this.merchantId) {
      console.warn('[providers] Orange Money not fully configured (skipping validation for simulation mode)');
      return;
    }
    validateTLSCertificate(this.apiUrl);
    // A8-10 fix: register the endpoint so the six-hourly expiry check has something to
    // inspect. It previously iterated a map no code path ever wrote to.
    certificateMonitor.registerEndpoint('ORANGE_MONEY', this.apiUrl);
  }

  async execute(paymentRequest) {
    // A40 fix: in production mode (simulatePayments=false) an unconfigured provider
    // must FAIL the payment, never fake a success — the previous `X-SIM` fallback
    // confirmed payments on-chain that were never executed off-chain.
    if (!this.apiUrl || !this.apiKey || !this.merchantId) {
      await auditLogger.logSecurityEvent(
        'PROVIDER_NOT_CONFIGURED', 'ERROR',
        'Orange Money adapter called in production mode without full configuration'
      );
      return { success: false, reason: 'PROVIDER_NOT_CONFIGURED' };
    }

    if (rateLimitTracker.isRateLimited('ORANGE_MONEY', 100, 60000)) {
      await auditLogger.logSecurityEvent('RATE_LIMIT', 'WARNING', 'Orange Money rate limit reached');
      return { success: false, reason: 'RATE_LIMIT_EXCEEDED' };
    }

    const body = {
      amount: paymentRequest.amount,
      currency: 'XOF',
      orderRef: paymentRequest.paymentId,
      subscriberMsisdn: paymentRequest.phoneNumber,
      merchantId: this.merchantId,
      description: `Payment for beneficiary ${hashSensitiveData(paymentRequest.beneficiaryHash)}`,
    };

    // A8-10 fix: only advertise a callback URL when one is actually configured. The field
    // used to be sent as an explicit `null`, which announces a receiver this service does
    // not run — there is no HTTP listener anywhere in the relayer. Asking a provider to
    // call back into nothing invites a settlement that never arrives; omitting the field
    // keeps the exchange synchronous, which is what the code actually implements.
    const callbackUrl = process.env.ORANGE_MONEY_CALLBACK_URL;
    if (callbackUrl) body.callbackUrl = callbackUrl;

    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      // A45 fix: never Date.now() — that made every resend a new request for Orange's
      // dedup and allowed duplicate disbursements.
      // A71 fix: paymentId + retryCount, so a deliberate retry is a new request while
      // a resend of the same attempt stays deduplicated.
      'X-Request-ID': idempotencyKey(paymentRequest),
    };

    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000), // A43 fix: undici fetch ignores the 'timeout' option
      });

      await auditLogger.logAuthAttempt('ORANGE_MONEY', response.ok, response.status);

      if (!response.ok) {
        const reason = await describeFailure('Orange Money', response); // A72 fix
        await auditLogger.logPaymentRequest(paymentRequest.paymentId, 'ORANGE_MONEY', paymentRequest.amount, 'FAILED');
        anomalyDetector.recordRequest('ORANGE_MONEY', 'failed');
        return { success: false, reason };
      }

      const payload = await response.json();
      const transactionRef = payload.transactionRef || payload.requestId || `ORANGE-${Date.now()}`;

      await auditLogger.logPaymentRequest(paymentRequest.paymentId, 'ORANGE_MONEY', paymentRequest.amount, 'SUCCESS');
      anomalyDetector.recordRequest('ORANGE_MONEY', 'success');

      return { success: true, transactionRef };
    } catch (error) {
      await auditLogger.logSecurityEvent('API_ERROR', 'ERROR', `Orange Money API error: ${error.message}`);
      anomalyDetector.recordRequest('ORANGE_MONEY', 'failed');
      return { success: false, reason: error.message };
    }
  }
}

/**
 * Wave Sandbox Adapter
 * API: https://developer.sendwave.com (fictional, adapt for real Wave API)
 */
class WaveAdapter {
  constructor(config) {
    this.apiUrl = config.providerUrls.WAVE;
    this.apiKey = config.providerApiKeys.WAVE;
    this.validateConfig();
  }

  validateConfig() {
    if (!this.apiUrl || !this.apiKey) {
      console.warn('[providers] Wave not fully configured (skipping validation for simulation mode)');
      return;
    }
    validateTLSCertificate(this.apiUrl);
    certificateMonitor.registerEndpoint('WAVE', this.apiUrl);  // A8-10 fix
  }

  async execute(paymentRequest) {
    // A40 fix: never fake a success when unconfigured in production mode.
    if (!this.apiUrl || !this.apiKey) {
      await auditLogger.logSecurityEvent(
        'PROVIDER_NOT_CONFIGURED', 'ERROR',
        'Wave adapter called in production mode without full configuration'
      );
      return { success: false, reason: 'PROVIDER_NOT_CONFIGURED' };
    }

    if (rateLimitTracker.isRateLimited('WAVE', 100, 60000)) {
      await auditLogger.logSecurityEvent('RATE_LIMIT', 'WARNING', 'Wave rate limit reached');
      return { success: false, reason: 'RATE_LIMIT_EXCEEDED' };
    }

    const body = {
      amount: paymentRequest.amount,
      currency: 'XOF',
      reference: paymentRequest.paymentId,
      recipient: {
        msisdn: paymentRequest.phoneNumber,
      },
      metadata: {
        beneficiaryHash: hashSensitiveData(paymentRequest.beneficiaryHash),
        region: paymentRequest.region,
      },
    };

    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      'X-Idempotency-Key': idempotencyKey(paymentRequest), // A71 fix
    };

    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000), // A43 fix: undici fetch ignores the 'timeout' option
      });

      await auditLogger.logAuthAttempt('WAVE', response.ok, response.status);

      if (!response.ok) {
        const reason = await describeFailure('Wave', response); // A72 fix
        await auditLogger.logPaymentRequest(paymentRequest.paymentId, 'WAVE', paymentRequest.amount, 'FAILED');
        anomalyDetector.recordRequest('WAVE', 'failed');
        return { success: false, reason };
      }

      const payload = await response.json();
      const transactionRef = payload.transactionId || payload.id || `WAVE-${Date.now()}`;

      await auditLogger.logPaymentRequest(paymentRequest.paymentId, 'WAVE', paymentRequest.amount, 'SUCCESS');
      anomalyDetector.recordRequest('WAVE', 'success');

      return { success: true, transactionRef };
    } catch (error) {
      await auditLogger.logSecurityEvent('API_ERROR', 'ERROR', `Wave API error: ${error.message}`);
      anomalyDetector.recordRequest('WAVE', 'failed');
      return { success: false, reason: error.message };
    }
  }
}

/**
 * Free Money Sandbox Adapter
 */
class FreeMoneyAdapter {
  constructor(config) {
    this.apiUrl = config.providerUrls.FREE_MONEY;
    this.apiKey = config.providerApiKeys.FREE_MONEY;
    this.validateConfig();
  }

  validateConfig() {
    if (!this.apiUrl || !this.apiKey) {
      console.warn('[providers] Free Money not fully configured (skipping validation for simulation mode)');
      return;
    }
    validateTLSCertificate(this.apiUrl);
    certificateMonitor.registerEndpoint('FREE_MONEY', this.apiUrl);  // A8-10 fix
  }

  async execute(paymentRequest) {
    // A40 fix: never fake a success when unconfigured in production mode.
    if (!this.apiUrl || !this.apiKey) {
      await auditLogger.logSecurityEvent(
        'PROVIDER_NOT_CONFIGURED', 'ERROR',
        'Free Money adapter called in production mode without full configuration'
      );
      return { success: false, reason: 'PROVIDER_NOT_CONFIGURED' };
    }

    if (rateLimitTracker.isRateLimited('FREE_MONEY', 100, 60000)) {
      await auditLogger.logSecurityEvent('RATE_LIMIT', 'WARNING', 'Free Money rate limit reached');
      return { success: false, reason: 'RATE_LIMIT_EXCEEDED' };
    }

    const body = {
      amount: paymentRequest.amount,
      currency: 'XOF',
      txRef: paymentRequest.paymentId,
      phone: paymentRequest.phoneNumber,
    };

    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      'X-Idempotency-Key': idempotencyKey(paymentRequest), // A71 fix
    };

    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000), // A43 fix: undici fetch ignores the 'timeout' option
      });

      await auditLogger.logAuthAttempt('FREE_MONEY', response.ok, response.status);

      if (!response.ok) {
        const reason = await describeFailure('Free Money', response); // A72 fix
        await auditLogger.logPaymentRequest(paymentRequest.paymentId, 'FREE_MONEY', paymentRequest.amount, 'FAILED');
        anomalyDetector.recordRequest('FREE_MONEY', 'failed');
        return { success: false, reason };
      }

      const payload = await response.json();
      const transactionRef = payload.transactionId || payload.ref || `FREEMONEY-${Date.now()}`;

      await auditLogger.logPaymentRequest(paymentRequest.paymentId, 'FREE_MONEY', paymentRequest.amount, 'SUCCESS');
      anomalyDetector.recordRequest('FREE_MONEY', 'success');

      return { success: true, transactionRef };
    } catch (error) {
      await auditLogger.logSecurityEvent('API_ERROR', 'ERROR', `Free Money API error: ${error.message}`);
      anomalyDetector.recordRequest('FREE_MONEY', 'failed');
      return { success: false, reason: error.message };
    }
  }
}

/**
 * E-Money Sandbox Adapter
 */
class EmoneyAdapter {
  constructor(config) {
    this.apiUrl = config.providerUrls.EMONEY;
    this.apiKey = config.providerApiKeys.EMONEY;
    this.validateConfig();
  }

  validateConfig() {
    if (!this.apiUrl || !this.apiKey) {
      console.warn('[providers] E-Money not fully configured (skipping validation for simulation mode)');
      return;
    }
    validateTLSCertificate(this.apiUrl);
    certificateMonitor.registerEndpoint('EMONEY', this.apiUrl);  // A8-10 fix
  }

  async execute(paymentRequest) {
    // A40 fix: never fake a success when unconfigured in production mode.
    if (!this.apiUrl || !this.apiKey) {
      await auditLogger.logSecurityEvent(
        'PROVIDER_NOT_CONFIGURED', 'ERROR',
        'E-Money adapter called in production mode without full configuration'
      );
      return { success: false, reason: 'PROVIDER_NOT_CONFIGURED' };
    }

    if (rateLimitTracker.isRateLimited('EMONEY', 100, 60000)) {
      await auditLogger.logSecurityEvent('RATE_LIMIT', 'WARNING', 'E-Money rate limit reached');
      return { success: false, reason: 'RATE_LIMIT_EXCEEDED' };
    }

    const body = {
      amount: paymentRequest.amount,
      currency: 'XOF',
      orderId: paymentRequest.paymentId,
      phoneNumber: paymentRequest.phoneNumber,
    };

    const headers = {
      'Content-Type': 'application/json',
      'X-API-Key': this.apiKey,
      'X-Idempotency-Key': idempotencyKey(paymentRequest), // A71 fix
    };

    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000), // A43 fix: undici fetch ignores the 'timeout' option
      });

      await auditLogger.logAuthAttempt('EMONEY', response.ok, response.status);

      if (!response.ok) {
        const reason = await describeFailure('E-Money', response); // A72 fix
        await auditLogger.logPaymentRequest(paymentRequest.paymentId, 'EMONEY', paymentRequest.amount, 'FAILED');
        anomalyDetector.recordRequest('EMONEY', 'failed');
        return { success: false, reason };
      }

      const payload = await response.json();
      const transactionRef = payload.transactionRef || payload.txnId || `EMONEY-${Date.now()}`;

      await auditLogger.logPaymentRequest(paymentRequest.paymentId, 'EMONEY', paymentRequest.amount, 'SUCCESS');
      anomalyDetector.recordRequest('EMONEY', 'success');

      return { success: true, transactionRef };
    } catch (error) {
      await auditLogger.logSecurityEvent('API_ERROR', 'ERROR', `E-Money API error: ${error.message}`);
      anomalyDetector.recordRequest('EMONEY', 'failed');
      return { success: false, reason: error.message };
    }
  }
}

const adapterCache = {};

function getAdapter(providerName, config) {
  if (adapterCache[providerName]) {
    return adapterCache[providerName];
  }

  let adapter;
  switch (providerName) {
    case 'ORANGE_MONEY':
      adapter = new OrangeMoneyAdapter(config);
      break;
    case 'WAVE':
      adapter = new WaveAdapter(config);
      break;
    case 'FREE_MONEY':
      adapter = new FreeMoneyAdapter(config);
      break;
    case 'EMONEY':
      adapter = new EmoneyAdapter(config);
      break;
    default:
      throw new Error(`Unknown provider: ${providerName}`);
  }

  adapterCache[providerName] = adapter;
  return adapter;
}

export async function executeProviderPayment(providerName, paymentRequest) {
  const config = getConfig();

  if (config.simulatePayments) {
    // A73 fix: validate the provider name even in simulation mode. providerNameFromIndex
    // returns 'UNKNOWN_PROVIDER' for an out-of-range enum value, and simulation used to
    // report success for it — confirming on-chain a payment no adapter could ever route.
    if (!getSdkProviderNames().includes(providerName)) {
      await auditLogger.logSecurityEvent(
        'UNKNOWN_PROVIDER', 'ERROR',
        `Refusing to simulate a payment for unknown provider "${providerName}"`
      );
      return { success: false, reason: `UNKNOWN_PROVIDER:${providerName}` };
    }
    await auditLogger.logPaymentRequest(paymentRequest.paymentId, providerName, paymentRequest.amount, 'SIMULATED');
    return {
      success: true,
      transactionRef: `SIMULATED-${paymentRequest.paymentId.slice(0, 10)}-${Date.now()}`,
    };
  }

  try {
    const adapter = getAdapter(providerName, config);
    const result = await adapter.execute(paymentRequest);
    return result;
  } catch (error) {
    await auditLogger.logSecurityEvent('PROVIDER_ERROR', 'ERROR', `Failed to get adapter for ${providerName}: ${error.message}`);
    return { success: false, reason: error.message };
  }
}

export async function initializeProviders() {
  await auditLogger.initialize();
  console.log('[providers] initialized with audit logging');
}

