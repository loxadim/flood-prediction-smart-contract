# Relayer Security Handbook

This document outlines security best practices for deploying and operating the off-chain relayer service for the OPAL platform.

## 1. Secret Management

### ✅ Best Practices

- **Store secrets in a vault**: Never hardcode API keys, private keys, or certificates in source code. Use:
  - HashiCorp Vault
  - AWS Secrets Manager
  - Azure Key Vault
  - Google Cloud Secret Manager
  
- **Use environment variables**: Load secrets from `.env` files (development only) or secure vaults (production).

- **Rotate credentials regularly**: Implement a credential rotation policy:
  - API keys: monthly
  - Private keys: yearly (or on compromise)
  - Certificates: before expiration (< 30 days warning)

- **Validate configuration on startup**: The relayer validates that no hardcoded secrets exist in configuration.

### ❌ Avoid

- ❌ Commit `.env` files to git
- ❌ Hardcode private keys or API keys in code
- ❌ Share credentials across environments
- ❌ Reuse credentials for multiple clients

## 2. Transport Security

### HTTPS / TLS Configuration

All sandbox API calls use HTTPS with strict TLS validation:

```bash
# The relayer validates:
- Certificate chain validity
- Hostname verification
- No self-signed certificates in production
```

### Certificate Monitoring

The relayer automatically monitors certificate expiration:

- Checks every 6 hours
- Logs warnings 30 days before expiration
- Emits critical alerts on expiration

Logs are stored in `relayer/logs/audit-YYYY-MM-DD.log`.

## 3. API Rate Limiting

The relayer implements per-provider rate limiting:

- Default: 100 requests per 60 seconds
- Configurable via code in `security.js`
- Rate limit violations are logged as security events

## 4. Audit Logging

All operations are logged to JSON audit files:

**Log format:**
```json
{
  "timestamp": "2025-06-05T12:34:56.789Z",
  "event": "PAYMENT_REQUEST",
  "details": {
    "paymentId": "0xabc...",
    "provider": "ORANGE_MONEY",
    "amount": "1500",
    "status": "SUCCESS"
  },
  "pid": 12345
}
```

**Log rotation:**
- Max file size: 10MB
- Old logs are archived with timestamp suffix

**Key events:**
- `AUTH_ATTEMPT`: API authentication success/failure
- `PAYMENT_REQUEST`: Payment initiation and confirmation
- `SECURITY_EVENT`: Security-related incidents
- `INCIDENT`: Critical incidents requiring immediate attention

## 5. Authentication Failures

If authentication fails:

1. The relayer logs the failure with the provider name and status code
2. Anomaly detection tracks failure rates
3. If failure rate exceeds 50%, a security event is emitted
4. All sensitive data (phone numbers, hashes) is redacted from logs

## 6. Webhook Signature Validation

When receiving webhooks from payment providers, validate signatures:

```javascript
import { validateWebhookSignature } from './crypto.js';

const isValid = validateWebhookSignature(
  payload,
  req.headers['x-signature'],
  process.env.PROVIDER_WEBHOOK_SECRET
);
```

## 7. Incident Response

### Incident Escalation

In case of a security incident:

1. **Log the incident immediately**: Use `auditLogger.logIncident()`
2. **Revoke compromised credentials**: Remove the API key from the vault
3. **Generate new credentials**: Create fresh API keys with the provider
4. **Audit logs**: Review audit logs to detect unauthorized activity
5. **Notify stakeholders**: Contact the provider and internal teams
6. **Document**: Write a post-incident summary

### Example Incident Response

```bash
# 1. Detect compromise
# (via monitoring alerts or manual review)

# 2. Revoke credentials
export ORANGE_MONEY_API_KEY=""  # Clear from vault

# 3. Stop the relayer
npm run relayer:stop

# 4. Review audit logs
tail -f relayer/logs/audit-2025-06-05.log

# 5. Restart with new credentials
export ORANGE_MONEY_API_KEY="new-key-from-vault"
npm run relayer:start
```

## 8. Monitoring Alerts

Configure alerts for:

- **Certificate expiration** (< 30 days)
- **Authentication failures** (> 5 consecutive failures)
- **High failure rate** (> 50% of requests)
- **Rate limit violations**
- **Unexpected API errors**

## 9. Deployment Checklist

Before deploying to production:

- [ ] Store all secrets in a vault (not in `.env`)
- [ ] Enable HTTPS for all provider APIs
- [ ] Configure TLS certificate monitoring
- [ ] Set up audit log storage and rotation
- [ ] Configure monitoring and alerting
- [ ] Test incident response procedures
- [ ] Review audit logs for the past 7 days
- [ ] Verify certificate validity and expiration dates
- [ ] Document escalation contacts

## 10. Provider-Specific Security Notes

### Orange Money
- Uses `Authorization: Bearer <API_KEY>` headers
- Requires HTTPS for all requests
- Supports webhook callbacks with HMAC-SHA256 signatures
- Certificate renewal: contact support 30 days before expiration

### Wave
- Uses `Authorization: Bearer <API_KEY>` headers
- Requires X-Idempotency-Key header for retry safety
- Supports webhook callbacks
- Certificate renewal: via Wave dashboard

### Free Money
- Uses `Authorization: Bearer <API_KEY>` headers
- No webhook support (polling required)
- Certificate renewal: contact support

### E-Money
- Uses `X-API-Key: <API_KEY>` header (not Bearer)
- Requires HTTPS for all requests
- Supports webhook callbacks
- Certificate renewal: automated (typically annual)

## 11. Data Privacy (GDPR Compliance)

- Phone numbers are hashed before logging: `hashSensitiveData(phoneNumber)`
- Beneficiary hashes never appear in clear text in logs
- Audit logs are encrypted at rest in production
- Log retention: 90 days (configurable)

## 12. Disaster Recovery

### Backup Strategy

- **Private keys**: Backed up to encrypted vault storage
- **Audit logs**: Daily backup to separate secure storage
- **Beneficiary registry**: Version controlled and backed up

### Recovery Procedures

1. **Lost private key**: Regenerate and re-authorize relayer account on-chain
2. **Corrupted audit logs**: Restore from backup and reconcile
3. **Provider API outage**: Switch to fallback provider or simulation mode

## 13. Contact Information

### Security Issues
- Report security vulnerabilities to: security@dpa-foundation.org
- **Do not** publicly disclose vulnerabilities
- Allow 48 hours for initial response

### Operational Support
- Relayer support: relayer-ops@dpa-foundation.org
- On-call: [your-on-call-contact]

## 14. Compliance

This relayer complies with:

- **PCI DSS**: Payment security standards
- **GDPR**: Data privacy regulations (EU)
- **SENEGAL LAWS**: Local financial regulations
- **OPAL POLICY**: DPA Foundation security policies

## References

- [OWASP API Security](https://owasp.org/www-project-api-security/)
- [Secure Coding Guidelines](https://cheatsheetseries.owasp.org/)
- [Certificate Best Practices](https://www.certificate-transparency.org/)
