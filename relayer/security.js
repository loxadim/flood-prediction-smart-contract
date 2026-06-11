import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolvePath } from './config.js';

const AUDIT_LOG_DIR = './relayer/logs';
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB

async function ensureAuditDir() {
  try {
    await fs.mkdir(resolvePath(AUDIT_LOG_DIR), { recursive: true });
  } catch (error) {
    console.error('[audit] failed to create log directory:', error.message);
  }
}

export class AuditLogger {
  constructor() {
    this.logFile = null;
  }

  async initialize() {
    await ensureAuditDir();
    const timestamp = new Date().toISOString().split('T')[0];
    this.logFile = path.join(resolvePath(AUDIT_LOG_DIR), `audit-${timestamp}.log`);
  }

  async _rotateLogs() {
    if (!this.logFile) return;

    try {
      const stats = await fs.stat(this.logFile);
      if (stats.size > MAX_LOG_SIZE) {
        const backup = `${this.logFile}.${Date.now()}`;
        await fs.rename(this.logFile, backup);
      }
    } catch (error) {
      // File doesn't exist, no rotation needed
    }
  }

  async log(event, details = {}) {
    await this._rotateLogs();
    if (!this.logFile) return;

    const entry = {
      timestamp: new Date().toISOString(),
      event,
      details,
      pid: process.pid,
    };

    try {
      await fs.appendFile(this.logFile, JSON.stringify(entry) + '\n');
      console.log(`[audit] ${event}:`, details);
    } catch (error) {
      console.error('[audit] failed to write log:', error.message);
    }
  }

  async logAuthAttempt(provider, success, reason = null) {
    await this.log('AUTH_ATTEMPT', {
      provider,
      success,
      reason,
    });
  }

  async logPaymentRequest(paymentId, provider, amount, status) {
    await this.log('PAYMENT_REQUEST', {
      paymentId,
      provider,
      amount,
      status,
    });
  }

  async logSecurityEvent(type, severity, message, metadata = {}) {
    await this.log('SECURITY_EVENT', {
      type,
      severity,
      message,
      metadata,
    });
  }

  async logIncident(title, description, metadata = {}) {
    await this.log('INCIDENT', {
      title,
      description,
      metadata,
    });

    // Alert to monitoring system (TODO: integrate with your monitoring)
    console.error(`[ALERT] 🚨 INCIDENT: ${title}`);
  }
}

export class CertificateMonitor {
  constructor() {
    this.certs = {};
  }

  async checkCertificates() {
    // Monitor TLS certificate expiration across providers
    const warnings = [];
    const now = Date.now();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

    for (const [provider, cert] of Object.entries(this.certs)) {
      if (!cert.expiresAt) continue;

      const expiresAt = new Date(cert.expiresAt).getTime();
      const daysLeft = Math.floor((expiresAt - now) / (24 * 60 * 60 * 1000));

      if (expiresAt < now) {
        warnings.push({
          severity: 'CRITICAL',
          provider,
          message: `Certificate expired ${Math.abs(daysLeft)} days ago`,
        });
      } else if (expiresAt - now < thirtyDaysMs) {
        warnings.push({
          severity: 'WARNING',
          provider,
          message: `Certificate expires in ${daysLeft} days`,
        });
      }
    }

    return warnings;
  }

  registerCertificate(provider, expiresAt) {
    this.certs[provider] = { expiresAt };
  }
}

export class AnomalyDetector {
  constructor() {
    this.requestStats = {};
    this.failureStats = {};
  }

  recordRequest(provider, status) {
    if (!this.requestStats[provider]) {
      this.requestStats[provider] = { total: 0, failed: 0 };
    }
    this.requestStats[provider].total++;
    if (status === 'failed') {
      this.requestStats[provider].failed++;
    }
  }

  detectAnomalies() {
    const anomalies = [];

    for (const [provider, stats] of Object.entries(this.requestStats)) {
      if (stats.total < 10) continue; // Need minimum sample size

      const failureRate = stats.failed / stats.total;

      // Alert if failure rate exceeds 50%
      if (failureRate > 0.5) {
        anomalies.push({
          type: 'HIGH_FAILURE_RATE',
          provider,
          failureRate: Math.round(failureRate * 100),
          message: `Provider ${provider} has ${Math.round(failureRate * 100)}% failure rate`,
        });
      }
    }

    return anomalies;
  }

  reset() {
    this.requestStats = {};
  }
}

export class RateLimitTracker {
  constructor() {
    this.requests = {};
  }

  isRateLimited(provider, limit = 100, windowMs = 60000) {
    const now = Date.now();
    if (!this.requests[provider]) {
      this.requests[provider] = [];
    }

    // Remove old requests outside the window
    this.requests[provider] = this.requests[provider].filter((t) => now - t < windowMs);

    if (this.requests[provider].length >= limit) {
      return true;
    }

    this.requests[provider].push(now);
    return false;
  }

  getRequestCount(provider) {
    if (!this.requests[provider]) return 0;
    return this.requests[provider].length;
  }
}

export const auditLogger = new AuditLogger();
export const certificateMonitor = new CertificateMonitor();
export const anomalyDetector = new AnomalyDetector();
export const rateLimitTracker = new RateLimitTracker();
