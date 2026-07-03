import fs from 'node:fs/promises';
import { ethers } from 'ethers';
import { getConfig, providerIndexFromName, providerNameFromIndex, resolvePath } from './config.js';
import { executeProviderPayment, initializeProviders } from './providers.js';
import { loadBeneficiaryRegistry, findBeneficiary } from './registry.js';
import { auditLogger, certificateMonitor, anomalyDetector } from './security.js';

const MOBILE_MONEY_ARTIFACT_PATH = '../artifacts/contracts/MobileMoneyProvider.sol/MobileMoneyProvider.json';
const WASDI_ARTIFACT_PATH = '../artifacts/contracts/WASDIOracleConnector.sol/WASDIOracleConnector.json';

async function loadArtifact(relativePath) {
  const path = resolvePath(relativePath);
  const raw = await fs.readFile(path, 'utf8');
  return JSON.parse(raw);
}

export class RelayerService {
  constructor() {
    this.config = getConfig();
    this.pendingPayments = new Set();
    this.beneficiaryRegistry = {};
  }

  async start() {
    console.log('[relayer] starting service');
    await initializeProviders();
    await this._loadBeneficiaryRegistry();
    await this._connect();
    await this._subscribeToEvents();
    await this._startMonitoring();
    console.log('[relayer] service ready');
  }

  async _startMonitoring() {
    // Check certificates every 6 hours
    setInterval(async () => {
      const warnings = await certificateMonitor.checkCertificates();
      for (const warning of warnings) {
        await auditLogger.logSecurityEvent('CERT_EXPIRY', warning.severity, warning.message, {
          provider: warning.provider,
        });
      }
    }, 6 * 60 * 60 * 1000);

    // Check for anomalies every 1 hour
    setInterval(async () => {
      const anomalies = anomalyDetector.detectAnomalies();
      for (const anomaly of anomalies) {
        await auditLogger.logSecurityEvent('ANOMALY', 'WARNING', anomaly.message, anomaly);
      }
      // A45 fix: reset per-window stats so the failure rate reflects the last hour,
      // not the whole process lifetime (stats otherwise accumulate forever).
      anomalyDetector.reset();
    }, 60 * 60 * 1000);
  }

  async _loadBeneficiaryRegistry() {
    this.beneficiaryRegistry = await loadBeneficiaryRegistry(this.config.beneficiaryRegistryPath);
    const count = Object.keys(this.beneficiaryRegistry).length;
    console.log(`[relayer] loaded beneficiary registry (${count} records)`);
  }

  async _connect() {
    this.provider = new ethers.JsonRpcProvider(this.config.rpcUrl);
    this.wallet = new ethers.Wallet(this.config.privateKey, this.provider);

    const mobileMoneyArtifact = await loadArtifact(MOBILE_MONEY_ARTIFACT_PATH);
    this.mobileMoneyContract = new ethers.Contract(
      this.config.mobileMoneyProviderAddress,
      mobileMoneyArtifact.abi,
      this.wallet
    );

    if (this.config.wasdiOracleConnectorAddress) {
      const wasdiArtifact = await loadArtifact(WASDI_ARTIFACT_PATH);
      this.wasdiConnectorContract = new ethers.Contract(
        this.config.wasdiOracleConnectorAddress,
        wasdiArtifact.abi,
        this.wallet
      );
    }

    console.log('[relayer] connected to network', await this.provider.getNetwork());
    console.log('[relayer] wallet address', this.wallet.address);
  }

  async _subscribeToEvents() {
    const paymentFilter = this.mobileMoneyContract.filters.PaymentInitiated();
    this.mobileMoneyContract.on(paymentFilter, (...args) => this._handlePaymentInitiated(...args));
    console.log('[relayer] subscribed to PaymentInitiated events');

    const batchFilter = this.mobileMoneyContract.filters.BatchPaymentInitiated();
    this.mobileMoneyContract.on(batchFilter, (...args) => this._handleBatchPaymentInitiated(...args));
    console.log('[relayer] subscribed to BatchPaymentInitiated events');

    // A42 fix: retryPayment() puts a FAILED payment back to PENDING and emits
    // PaymentRetried — without this subscription a retried payment was never
    // executed and simply expired again.
    const retryFilter = this.mobileMoneyContract.filters.PaymentRetried();
    this.mobileMoneyContract.on(retryFilter, (...args) => this._handlePaymentRetried(...args));
    console.log('[relayer] subscribed to PaymentRetried events');

    if (this.wasdiConnectorContract) {
      const highRiskFilter = this.wasdiConnectorContract.filters.HighRiskDetected();
      this.wasdiConnectorContract.on(highRiskFilter, (...args) => this._handleHighRiskDetected(...args));
      console.log('[relayer] subscribed to WASDI HighRiskDetected events');
    }
  }

  async _handlePaymentInitiated(paymentId, beneficiaryHash, amount, region, provider, event) {
    await this._processPayment('PaymentInitiated', paymentId, beneficiaryHash, amount, region, provider);
  }

  // A42 fix: PaymentRetried only carries (paymentId, retryCount) — resolve the full
  // payment details from the contract, then run the same execution pipeline.
  async _handlePaymentRetried(paymentId, retryCount, event) {
    const id = paymentId.toString();
    try {
      const payment = await this.mobileMoneyContract.getPayment(paymentId);
      await this._processPayment(
        `PaymentRetried(#${retryCount})`,
        paymentId,
        payment.beneficiaryHash,
        payment.amount,
        payment.region,
        payment.provider
      );
    } catch (error) {
      console.error('[relayer] failed to resolve retried payment', id, error.message || error);
      await auditLogger.logIncident('RETRY_RESOLUTION_FAILED', 'Could not load payment for PaymentRetried event', {
        paymentId: id,
        error: error.message || String(error),
      });
    }
  }

  async _processPayment(source, paymentId, beneficiaryHash, amount, region, provider) {
    const id = paymentId.toString();
    if (this.pendingPayments.has(id)) {
      console.log('[relayer] duplicate payment event ignored', id);
      return;
    }
    this.pendingPayments.add(id);

    const providerName = providerNameFromIndex(provider);
    console.log(`[relayer] ${source}:`, {
      paymentId: id,
      beneficiaryHash: beneficiaryHash.toString(),
      amount: amount.toString(),
      region,
      provider: providerName,
    });

    const beneficiary = findBeneficiary(this.beneficiaryRegistry, beneficiaryHash.toString());
    if (!beneficiary) {
      const reason = 'BENEFICIARY_DATA_MISSING';
      console.error('[relayer] missing beneficiary metadata for hash', beneficiaryHash.toString());
      await this._sendFail(id, reason);
      this.pendingPayments.delete(id);
      return;
    }

    const request = {
      paymentId: id,
      beneficiaryHash: beneficiaryHash.toString(),
      phoneNumber: beneficiary.phoneNumber,
      amount: amount.toString(),
      region,
      provider: providerName,
      externalReference: beneficiary.externalReference,
    };

    const result = await executeProviderPayment(providerName, request);

    if (result.success) {
      console.log('[relayer] payment executed successfully, confirming on-chain', {
        paymentId: id,
        transactionRef: result.transactionRef,
      });
      await this._sendConfirm(id, result.transactionRef);
    } else {
      console.warn('[relayer] payment execution failed:', result.reason);
      await this._sendFail(id, result.reason || 'PROVIDER_EXECUTION_FAILED');
    }

    this.pendingPayments.delete(id);
  }

  async _handleHighRiskDetected(region, riskScore, timestamp, event) {
    console.log('[relayer] HighRiskDetected event from WASDI:', {
      region,
      riskScore: riskScore.toString(),
      timestamp: new Date(Number(timestamp.toString()) * 1000).toISOString(),
    });
  }

  async _handleBatchPaymentInitiated(count, region, totalAmount, event) {
    // Informational only: batchInitiatePayments now also emits one PaymentInitiated per
    // beneficiary (A18 fix), and each is settled individually by _handlePaymentInitiated.
    // This aggregate event is kept for monitoring/reconciliation.
    console.log('[relayer] batch payment initiated (aggregate):', {
      count: count.toString(),
      region,
      totalAmount: totalAmount.toString(),
    });
  }

  _normalizeProvider(provider) {
    if (typeof provider === 'number' || typeof provider === 'bigint') {
      return Number(provider);
    }

    if (typeof provider === 'string') {
      return providerIndexFromName(provider);
    }

    throw new Error(`Invalid provider value: ${provider}`);
  }

  async submitBatchPayments(batch) {
    if (!Array.isArray(batch) || batch.length === 0) {
      throw new Error('Batch payload must be a non-empty array');
    }

    const beneficiaryHashes = [];
    const amounts = [];
    const phoneHashes = [];
    const providers = [];
    let region = null;

    for (const item of batch) {
      if (region === null) region = item.region;
      if (!item.region || item.region !== region) {
        throw new Error('All batch items must use the same region');
      }
      beneficiaryHashes.push(item.beneficiaryHash);
      amounts.push(item.amount);
      phoneHashes.push(item.phoneHash);
      providers.push(this._normalizeProvider(item.provider));
    }

    console.log('[relayer] submitting batch payment request:', {
      count: batch.length,
      region,
    });

    const tx = await this.mobileMoneyContract.batchInitiatePayments(
      beneficiaryHashes,
      amounts,
      phoneHashes,
      region,
      providers
    );
    const receipt = await tx.wait();

    console.log('[relayer] batchInitiatePayments transaction completed', {
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
    });

    return tx;
  }

  async confirmBatchPayments(confirmations) {
    if (!Array.isArray(confirmations) || confirmations.length === 0) {
      throw new Error('Confirmations payload must be a non-empty array');
    }

    const paymentIds = [];
    const transactionRefs = [];

    for (const item of confirmations) {
      paymentIds.push(item.paymentId);
      transactionRefs.push(item.transactionRef);
    }

    console.log('[relayer] submitting batch payment confirmations:', { count: confirmations.length });
    const tx = await this.mobileMoneyContract.batchConfirmPayments(paymentIds, transactionRefs);
    const receipt = await tx.wait();

    console.log('[relayer] batchConfirmPayments transaction completed', {
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
    });

    return tx;
  }

  async submitSatelliteEntries(entries) {
    if (!Array.isArray(entries)) {
      throw new Error('Satellite payload must be an array');
    }

    for (const entry of entries) {
      await this.submitSatelliteData(entry);
    }
  }

  // A41 fix: a swallowed confirmPayment/failPayment error left the off-chain payout
  // and the on-chain record permanently diverged (payment executed but stuck PENDING
  // until expiry). Settlement txs are now retried, and a final failure raises a
  // durable INCIDENT entry in the audit log carrying everything an operator needs
  // to replay the settlement manually.
  async _sendSettlementTx(action, paymentId, sendTx, incidentMetadata) {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const tx = await sendTx();
        await tx.wait();
        console.log(`[relayer] ${action} sent:`, paymentId);
        return true;
      } catch (error) {
        console.error(`[relayer] ${action} failed (attempt ${attempt}/${maxAttempts}):`, error.message || error);
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, attempt * 2000));
        } else {
          await auditLogger.logIncident(
            'SETTLEMENT_TX_FAILED',
            `${action} could not be sent on-chain after ${maxAttempts} attempts — manual reconciliation required`,
            { action, paymentId, error: error.message || String(error), ...incidentMetadata }
          );
        }
      }
    }
    return false;
  }

  async _sendConfirm(paymentId, transactionRef) {
    return this._sendSettlementTx(
      'confirmPayment',
      paymentId,
      () => this.mobileMoneyContract.confirmPayment(paymentId, transactionRef),
      { transactionRef }
    );
  }

  async _sendFail(paymentId, reason) {
    return this._sendSettlementTx(
      'failPayment',
      paymentId,
      () => this.mobileMoneyContract.failPayment(paymentId, reason),
      { reason }
    );
  }

  async submitSatelliteData(entry) {
    if (!this.wasdiConnectorContract) {
      throw new Error('WASDI connector contract is not configured');
    }

    const tx = await this.wasdiConnectorContract.submitSatelliteData(
      entry.region,
      entry.riskScore,
      entry.rainfall,
      entry.soilMoisture,
      entry.waterLevel,
      entry.satelliteSource
    );
    await tx.wait();
    console.log('[relayer] submitted satellite data for region', entry.region);
  }
}
