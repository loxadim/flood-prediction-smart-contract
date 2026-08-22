import crypto from 'node:crypto';
import tls from 'node:tls';

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
 * Read the expiry date of the TLS certificate served by `url`.
 *
 * A8-10 fix: CertificateMonitor exposed registerCertificate() but nothing ever called it,
 * so the six-hourly expiry check iterated an empty map and reported nothing, forever. A
 * monitoring loop that cannot produce a finding is worse than none: it reads as coverage.
 * This performs the one lookup the monitor was always meant to have.
 *
 * @param {string} url HTTPS endpoint to inspect
 * @param {number} timeoutMs Handshake timeout
 * @returns {Promise<string|null>} `valid_to` date string, or null when unreachable
 */
export function fetchCertificateExpiry(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let host;
    let port;
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      port = parsed.port ? Number(parsed.port) : 443;
    } catch {
      resolve(null);
      return;
    }

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* already closed */ }
      resolve(value);
    };

    const socket = tls.connect({ host, port, servername: host }, () => {
      const cert = socket.getPeerCertificate();
      finish(cert && cert.valid_to ? cert.valid_to : null);
    });

    socket.setTimeout(timeoutMs, () => finish(null));
    socket.on('error', () => finish(null));
  });
}

// Credentials: redact so the audit trail still shows the key was present
const KEYS_TO_REDACT = ['authorization', 'apikey', 'secret', 'password', 'token'];
// PII: delete entirely — no trace in logs
const KEYS_TO_DELETE = ['phonenumber', 'msisdn', 'subscribermsisdn', 'phone'];

/**
 * Sanitize credentials and PII out of an object before logging.
 *
 * A58 fix: this used to walk only the top level, so a `phoneNumber` nested inside a
 * provider response, an error body, or a batch array went straight through untouched.
 * It now recurses through plain objects and arrays. Key matching is case-insensitive
 * because provider payloads are inconsistent (`msisdn`, `subscriberMsisdn`, `phone`).
 *
 * @param {*} value Any value; non-objects are returned as-is
 * @returns {*} A sanitized deep copy — the input is never mutated
 */
export function sanitizeForLogging(value, ancestors = new WeakSet()) {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  // Guard against cyclic structures (fetch responses, error chains).
  // A68 fix: `ancestors` tracks the CURRENT PATH, not every object already visited.
  // With a single shared visited-set, an object legitimately referenced twice in a
  // non-cyclic graph — routine in a provider response — had its second occurrence
  // replaced by '[Circular]', silently destroying valid log data. Only a true
  // ancestor is a cycle, so the object is removed from the set on the way out.
  if (ancestors.has(value)) return '[Circular]';
  ancestors.add(value);

  let result;
  if (Array.isArray(value)) {
    result = value.map((item) => sanitizeForLogging(item, ancestors));
  } else {
    result = {};
    for (const [key, item] of Object.entries(value)) {
      const normalized = key.toLowerCase();
      if (KEYS_TO_DELETE.includes(normalized)) continue;
      result[key] = KEYS_TO_REDACT.includes(normalized)
        ? '***REDACTED***'
        : sanitizeForLogging(item, ancestors);
    }
  }

  ancestors.delete(value);
  return result;
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
