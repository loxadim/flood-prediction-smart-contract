import fs from 'node:fs/promises';
import { ethers } from 'ethers';
import {
  assertPaymentModeConfigured,
  assertSimulationAllowed,
  getConfig,
  providerIndexFromName,
  providerNameFromIndex,
  resolvePath,
} from './config.js';
import { executeProviderPayment, initializeProviders } from './providers.js';
import { loadBeneficiaryRegistry, findBeneficiary } from './registry.js';
import { auditLogger, certificateMonitor, anomalyDetector } from './security.js';
// A58 fix: every object logged on the payment path goes through sanitizeForLogging,
// which now recurses into nested objects and arrays. This module is where beneficiary
// phone numbers are resolved from the registry, so it is where the guard belongs.
import { sanitizeForLogging } from './crypto.js';

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
    // A8-09 fix: orders this process has seen and believes are still PENDING, so the
    // expiry sweep has something to iterate. Entries are dropped as soon as the chain
    // reports any other status.
    this.trackedPayments = new Set();
    this.paymentTimeout = 1800n; // seconds; refreshed from the contract on connect
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

    // A8-09 fix: sweep timed-out orders every 5 minutes so their regional daily
    // allowance is returned instead of staying reserved indefinitely.
    setInterval(() => {
      this._sweepStalePayments().catch((error) =>
        console.error('[relayer] stale payment sweep failed:', error.message || error));
    }, 5 * 60 * 1000);
  }

  async _loadBeneficiaryRegistry() {
    this.beneficiaryRegistry = await loadBeneficiaryRegistry(this.config.beneficiaryRegistryPath);
    const count = Object.keys(this.beneficiaryRegistry).length;
    console.log(`[relayer] loaded beneficiary registry (${count} records)`);
  }

  async _connect() {
    // A70 fix: initialize the audit logger here rather than only inside
    // initializeProviders(). The CLI commands in index.js (submit-satellite,
    // submit-batch, confirm-batch) call _connect() directly without going through
    // start(), so auditLogger.logFile stayed null and every audit write on those paths
    // was dropped — including the INCIDENT entries an operator needs to reconcile a
    // failed settlement by hand. _connect() is the one gate every entry point crosses.
    await auditLogger.initialize();

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

    const network = await this.provider.getNetwork();
    // A8-05 fix: both guards run before a single event can be processed. The first
    // rejects the old silent default (no credentials, no explicit flag); the second
    // refuses simulation anywhere but a local chain, since simulated payments are
    // confirmed on-chain exactly as if they had been executed.
    assertPaymentModeConfigured(this.config);
    assertSimulationAllowed(network.chainId, this.config.simulatePayments);

    // A8-09 fix: read the contract's own timeout rather than assuming the default, so the
    // sweep stays aligned if an operator changes it with setTimeout().
    try {
      this.paymentTimeout = await this.mobileMoneyContract.paymentTimeout();
    } catch {
      console.warn('[relayer] could not read paymentTimeout, keeping default', this.paymentTimeout.toString());
    }

    console.log('[relayer] connected to network', network);
    console.log('[relayer] wallet address', this.wallet.address);
    console.log(`[relayer] payment mode: ${this.config.simulatePayments ? 'SIMULATION' : 'LIVE'}`);
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
    // A71 fix: retryCount 0 — a first attempt. It feeds the provider idempotency key.
    await this._processPayment('PaymentInitiated', paymentId, beneficiaryHash, amount, region, provider, 0);
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
        payment.provider,
        // A71 fix: carry retryCount through so the provider idempotency key changes
        // between attempts. Prefer the on-chain value over the event argument — the
        // contract is authoritative if an event was replayed.
        Number(payment.retryCount ?? retryCount)
      );
    } catch (error) {
      console.error('[relayer] failed to resolve retried payment', id, error.message || error);
      await auditLogger.logIncident('RETRY_RESOLUTION_FAILED', 'Could not load payment for PaymentRetried event', {
        paymentId: id,
        error: error.message || String(error),
      });
    }
  }

  async _processPayment(source, paymentId, beneficiaryHash, amount, region, provider, retryCount = 0) {
    const id = paymentId.toString();
    if (this.pendingPayments.has(id)) {
      console.log('[relayer] duplicate payment event ignored', id);
      return;
    }
    this.pendingPayments.add(id);

    // A8-06 fix: the in-memory set above only dedupes within one process lifetime, and it
    // is cleared as soon as a payment settles. A PaymentInitiated event redelivered after
    // a websocket reconnect, a chain reorg or a restart therefore reached the provider a
    // second time. The chain is the only durable record of what has already been settled,
    // so consult it before spending money. Provider-side idempotency keys are a second
    // line of defence, not a first: they depend on the provider honouring them and do
    // nothing at all in simulation mode.
    if (!(await this._isStillPending(id))) {
      this.pendingPayments.delete(id);
      this.trackedPayments.delete(id);
      return;
    }
    this.trackedPayments.add(id);   // A8-09 fix: eligible for the expiry sweep

    const providerName = providerNameFromIndex(provider);
    console.log(`[relayer] ${source}:`, sanitizeForLogging({
      paymentId: id,
      beneficiaryHash: beneficiaryHash.toString(),
      amount: amount.toString(),
      region,
      provider: providerName,
    }));

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
      // A71 fix: the adapters build their idempotency key from paymentId + retryCount.
      // retryPayment() reuses the same paymentId by design, so a key made of paymentId
      // alone made a deliberate retry byte-identical to the attempt that just failed —
      // an idempotent endpoint would replay its cached response and the retry would
      // never actually execute.
      retryCount,
    };

    const result = await executeProviderPayment(providerName, request);

    if (result.success) {
      console.log('[relayer] payment executed successfully, confirming on-chain', sanitizeForLogging({
        paymentId: id,
        transactionRef: result.transactionRef,
      }));
      await this._sendConfirm(id, result.transactionRef);
    } else {
      console.warn('[relayer] payment execution failed:', result.reason);
      await this._sendFail(id, result.reason || 'PROVIDER_EXECUTION_FAILED');
    }

    this.pendingPayments.delete(id);
    // A8-09 fix: settled either way, so it leaves the expiry sweep. A settlement tx that
    // could not be sent has already raised a durable INCIDENT (A41); the sweep would not
    // help there, since the order needs manual reconciliation rather than expiry.
    this.trackedPayments.delete(id);
  }

  /**
   * A8-06 fix: is this payment still awaiting execution on-chain?
   *
   * PaymentStatus: 0 PENDING, 1 CONFIRMED, 2 FAILED, 3 EXPIRED, 4 CANCELLED. Only a
   * PENDING order may be executed; anything else means another process, another run, or
   * an expiry already settled it.
   *
   * A read failure returns false — declining to pay on incomplete information is the
   * conservative side of this decision, and the payment stays PENDING for the next event.
   *
   * @param {string} paymentId On-chain payment identifier
   * @returns {Promise<boolean>} true when the order is still PENDING
   */
  async _isStillPending(paymentId) {
    try {
      const status = await this.mobileMoneyContract.getPaymentStatus(paymentId);
      if (Number(status) === 0) return true;
      console.warn(`[relayer] payment ${paymentId} is no longer PENDING (status ${status}) — skipping execution`);
      await auditLogger.logSecurityEvent(
        'DUPLICATE_EXECUTION_PREVENTED', 'WARNING',
        'Payment event received for an order that is no longer PENDING',
        { paymentId, status: status.toString() }
      );
      return false;
    } catch (error) {
      console.error('[relayer] could not read payment status, refusing to execute', paymentId, error.message || error);
      await auditLogger.logIncident(
        'STATUS_READ_FAILED',
        'Could not read on-chain payment status before execution — payment skipped',
        { paymentId, error: error.message || String(error) }
      );
      return false;
    }
  }

  /**
   * A8-09 fix: move timed-out orders to EXPIRED so their regional daily allowance is
   * released.
   *
   * expireStalePayments() existed and refunded regionDailySpend correctly, but nothing
   * ever called it — even though BLOCKCHAIN_ARCHITECTURE_DESIGN.md documents the relayer
   * as the caller. Settlement went through confirmPayment(), which rejects an expired
   * payment rather than transitioning it, so a stale order kept its share of the daily
   * ceiling forever. With the ceiling now set to the region's own budget at deployment,
   * every incident permanently shrank that region's capacity to pay.
   *
   * @param {string[]} paymentIds Candidate orders, capped at the contract's MAX_BATCH_SIZE
   */
  async expireStalePayments(paymentIds) {
    if (!paymentIds.length) return;
    const batch = paymentIds.slice(0, 50); // MAX_BATCH_SIZE on MobileMoneyProvider
    try {
      const tx = await this.mobileMoneyContract.expireStalePayments(batch);
      await tx.wait();
      console.log(`[relayer] expireStalePayments sent for ${batch.length} order(s)`);
    } catch (error) {
      console.error('[relayer] expireStalePayments failed:', error.message || error);
      await auditLogger.logIncident(
        'EXPIRY_SWEEP_FAILED',
        'Could not expire stale payments — regional daily allowance stays reserved',
        { count: batch.length, error: error.message || String(error) }
      );
    }
  }

  /**
   * A8-09 fix: periodic sweep over the orders this process has seen, expiring those the
   * contract now considers timed out. Bounded by the tracked set, so it costs nothing
   * when the relayer is idle.
   */
  async _sweepStalePayments() {
    const candidates = [];
    for (const id of this.trackedPayments) {
      try {
        const payment = await this.mobileMoneyContract.getPayment(id);
        if (Number(payment.status) !== 0) {
          this.trackedPayments.delete(id);   // settled elsewhere, stop tracking
          continue;
        }
        const deadline = payment.initiatedAt + this.paymentTimeout;
        if (BigInt(Math.floor(Date.now() / 1000)) > deadline) candidates.push(id);
      } catch {
        this.trackedPayments.delete(id);
      }
    }
    if (candidates.length) await this.expireStalePayments(candidates);
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

  // ARCH-01: MobileMoneyProvider verifies each item against the FloodPrediction ledger
  // for `eventId`. On a bound deployment a batch without a matching eventId is rejected
  // on-chain (UnbackedPayment) — which is the point: the relayer can no longer create
  // payment orders that no trigger backs.
  async submitBatchPayments(batch, eventId = '') {
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
      providers,
      eventId
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
