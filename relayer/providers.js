import { getConfig } from './config.js';
import { validateTLSCertificate, sanitizeForLogging, hashSensitiveData } from './crypto.js';
import {
  auditLogger,
  certificateMonitor,
  anomalyDetector,
  rateLimitTracker,
} from './security.js';

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
      callbackUrl: process.env.ORANGE_MONEY_CALLBACK_URL || null,
    };

    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      // A45 fix: keyed on paymentId alone — appending Date.now() made every retry a
      // new request for Orange's dedup, allowing duplicate disbursements on retry.
      'X-Request-ID': paymentRequest.paymentId,
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
        const text = await response.text();
        await auditLogger.logPaymentRequest(paymentRequest.paymentId, 'ORANGE_MONEY', paymentRequest.amount, 'FAILED');
        anomalyDetector.recordRequest('ORANGE_MONEY', 'failed');
        return {
          success: false,
          reason: `Orange Money returned ${response.status}`,
        };
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
      'X-Idempotency-Key': paymentRequest.paymentId,
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
        const text = await response.text();
        await auditLogger.logPaymentRequest(paymentRequest.paymentId, 'WAVE', paymentRequest.amount, 'FAILED');
        anomalyDetector.recordRequest('WAVE', 'failed');
        return {
          success: false,
          reason: `Wave returned ${response.status}`,
        };
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
        await auditLogger.logPaymentRequest(paymentRequest.paymentId, 'FREE_MONEY', paymentRequest.amount, 'FAILED');
        anomalyDetector.recordRequest('FREE_MONEY', 'failed');
        return { success: false, reason: `Free Money returned ${response.status}` };
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
        await auditLogger.logPaymentRequest(paymentRequest.paymentId, 'EMONEY', paymentRequest.amount, 'FAILED');
        anomalyDetector.recordRequest('EMONEY', 'failed');
        return { success: false, reason: `E-Money returned ${response.status}` };
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

