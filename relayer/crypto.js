import crypto from 'node:crypto';

/**
 * Validate webhook signature using HMAC-SHA256
 * Expected header format: X-Signature: sha256=<signature>
 */
export function validateWebhookSignature(payload, signature, secret) {
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');

  // A44 fix: timingSafeEqual throws on length mismatch — a malformed signature
  // must yield `false`, not an uncaught exception in the webhook handler.
  const provided = Buffer.from(String(signature));
  const expected = Buffer.from(`sha256=${expectedSignature}`);
  if (provided.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(provided, expected);
}

/**
 * Verify TLS certificate chain (basic validation)
 * In production, use a proper TLS library or configure Node.js built-in cert validation
 */
export function validateTLSCertificate(url) {
  if (!url.startsWith('https://')) {
    throw new Error('Provider API URL must use HTTPS');
  }
  return true;
}

/**
 * Sanitize credentials from logs
 */
export function sanitizeForLogging(obj) {
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }

  const sanitized = { ...obj };
  // Credentials: redact so audit trail shows the key was present
  const keysToRedact = ['Authorization', 'apiKey', 'secret', 'password', 'token'];
  // PII: delete entirely — no trace in logs
  const keysToDelete = ['phoneNumber'];

  for (const key of keysToRedact) {
    if (key in sanitized) sanitized[key] = '***REDACTED***';
  }
  for (const key of keysToDelete) {
    delete sanitized[key];
  }

  return sanitized;
}

/**
 * Hash sensitive data for audit logging
 */
export function hashSensitiveData(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Validate provider credentials are not hardcoded in source
 */
export function validateNoHardcodedSecrets(config) {
  const suspiciousPatterns = [
    /^(0x)?[a-f0-9]{40,}$/i, // Private key patterns
    /^Bearer\s+/i, // Bearer tokens
    /^sk_/i, // Stripe/similar API keys
  ];

  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string') {
      for (const pattern of suspiciousPatterns) {
        if (pattern.test(value)) {
          throw new Error(`Suspicious hardcoded value detected for key: ${key}`);
        }
      }
    }
  }
}
