import { describe, it, before } from 'mocha';
import { expect } from 'chai';
import { RelayerService } from '../relayer/service.js';
import { auditLogger, anomalyDetector, rateLimitTracker } from '../relayer/security.js';
import { hashSensitiveData, sanitizeForLogging } from '../relayer/crypto.js';

describe('Relayer Service', () => {
  let service;

  before(async () => {
    process.env.SIMULATE_PAYMENTS = 'true';
    process.env.RPC_URL = 'http://127.0.0.1:8545';
    process.env.PRIVATE_KEY = '0x0000000000000000000000000000000000000000000000000000000000000001';
    process.env.MOBILE_MONEY_PROVIDER_ADDRESS = '0x1234567890123456789012345678901234567890';

    await auditLogger.initialize();
  });

  describe('Security', () => {
    it('should hash sensitive data', () => {
      const phoneNumber = '+221770000000';
      const hash = hashSensitiveData(phoneNumber);
      
      expect(hash).to.be.a('string');
      expect(hash).to.have.length(64); // SHA-256 hex
      expect(hash).to.not.include(phoneNumber);
    });

    it('should sanitize logs', () => {
      const obj = {
        paymentId: '0xabc',
        phoneNumber: '+221770000000',
        Authorization: 'Bearer secret-key',
      };

      const sanitized = sanitizeForLogging(obj);

      expect(sanitized.paymentId).to.equal('0xabc');
      expect(sanitized.phoneNumber).to.be.undefined; // removed
      expect(sanitized.Authorization).to.equal('***REDACTED***');
    });
  });

  describe('Rate Limiting', () => {
    it('should allow requests within limit', () => {
      rateLimitTracker.requests = {}; // Reset
      
      const isLimited = rateLimitTracker.isRateLimited('TEST_PROVIDER', 5, 60000);
      expect(isLimited).to.be.false;
    });

    it('should block requests exceeding limit', () => {
      rateLimitTracker.requests = {}; // Reset
      
      for (let i = 0; i < 5; i++) {
        rateLimitTracker.isRateLimited('TEST_PROVIDER', 5, 60000);
      }

      const isLimited = rateLimitTracker.isRateLimited('TEST_PROVIDER', 5, 60000);
      expect(isLimited).to.be.true;
    });
  });

  describe('Anomaly Detection', () => {
    it('should detect high failure rates', () => {
      anomalyDetector.reset();

      // Record 7 failures out of 10 requests
      for (let i = 0; i < 7; i++) {
        anomalyDetector.recordRequest('TEST_PROVIDER', 'failed');
      }
      for (let i = 0; i < 3; i++) {
        anomalyDetector.recordRequest('TEST_PROVIDER', 'success');
      }

      const anomalies = anomalyDetector.detectAnomalies();
      
      expect(anomalies).to.have.length(1);
      expect(anomalies[0].type).to.equal('HIGH_FAILURE_RATE');
      expect(anomalies[0].failureRate).to.equal(70);
    });

    it('should not flag low failure rates', () => {
      anomalyDetector.reset();

      // Record 1 failure out of 20 requests
      for (let i = 0; i < 1; i++) {
        anomalyDetector.recordRequest('TEST_PROVIDER', 'failed');
      }
      for (let i = 0; i < 19; i++) {
        anomalyDetector.recordRequest('TEST_PROVIDER', 'success');
      }

      const anomalies = anomalyDetector.detectAnomalies();
      expect(anomalies).to.have.length(0);
    });
  });

  describe('Audit Logging', () => {
    it('should log payment requests', async () => {
      await auditLogger.logPaymentRequest(
        '0xtest123',
        'ORANGE_MONEY',
        1500,
        'SUCCESS'
      );

      // Log should exist (check in file system in integration test)
      expect(auditLogger.logFile).to.exist;
    });

    it('should log security events', async () => {
      await auditLogger.logSecurityEvent(
        'TEST_EVENT',
        'WARNING',
        'Test event message',
        { testData: 'value' }
      );

      // Should not throw
      expect(true).to.be.true;
    });
  });

  describe('Provider Integration', () => {
    it('should support simulation mode', async () => {
      process.env.SIMULATE_PAYMENTS = 'true';

      const { executeProviderPayment } = await import('../relayer/providers.js');

      const result = await executeProviderPayment('ORANGE_MONEY', {
        paymentId: '0xtest',
        beneficiaryHash: '0xbene',
        phoneNumber: '+221770000000',
        amount: 1500,
        region: 'Dakar',
        externalReference: 'ref-123',
      });

      expect(result.success).to.be.true;
      expect(result.transactionRef).to.include('SIMULATED');
    });
  });
});
