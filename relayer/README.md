# Off-chain Relayer Service

This relayer service listens for `PaymentInitiated` events emitted by the on-chain `MobileMoneyProvider` contract.
It executes mobile money payment requests through sandbox APIs (Orange Money, Wave, Free Money, E-Money) or simulation mode, then writes back confirmation or failure to the blockchain.

## Architecture

```
┌──────────────────┐
│  FloodPrediction │
│    Contract      │
└────────┬─────────┘
         │ batchInitiatePayments()
         ▼
┌──────────────────────────┐
│  MobileMoneyProvider     │
│  Contract                │
└────────┬─────────────────┘
         │ PaymentInitiated event
         ▼
┌──────────────────────────────────────────┐
│  Relayer Service                         │
├──────────────────────────────────────────┤
│  • providers.js (Orange, Wave, Free, E)  │
│  • security.js (audit, monitoring)       │
│  • crypto.js (signatures, validation)    │
│  • registry.js (beneficiary lookup)      │
└────────┬─────────────────────────────────┘
         │ confirmPayment() / failPayment()
         ▼
┌──────────────────────────────────────────┐
│  Blockchain                              │
└──────────────────────────────────────────┘
```

## What it does

- Subscribes to `PaymentInitiated` on-chain events
- Maps `beneficiaryHash` to off-chain beneficiary data
- Validates TLS certificates and API credentials
- Calls mobile money provider sandbox APIs (Orange Money, Wave, Free Money, E-Money)
- Logs all operations to audit trails with security event tracking
- Monitors certificate expiration, API failures, and rate limits
- Sends `confirmPayment` or `failPayment` transactions back to the contract
- Provides CLI commands for batch and satellite data submission

## Setup

### 1. Install dependencies

Ensure you have Node 18+ and the project dependencies installed:

```bash
npm install
```

### 2. Copy the env file

```bash
cp relayer/.env.example .env
```

### 3. Fill in required values

Edit `.env` with your configuration:

```bash
# Blockchain
RPC_URL=https://rpc-amoy.maticvigil.com  # or your RPC endpoint
PRIVATE_KEY=0x...  # Relayer account private key
MOBILE_MONEY_PROVIDER_ADDRESS=0x...
WASDI_ORACLE_CONNECTOR_ADDRESS=0x...

# Simulation or Real APIs
SIMULATE_PAYMENTS=true  # Set to false to use real sandbox APIs

# Provider Credentials (if using real APIs)
ORANGE_MONEY_API_URL=https://sandbox-api.orange.com/payment
ORANGE_MONEY_API_KEY=your-api-key
ORANGE_MONEY_MERCHANT_ID=your-merchant-id

WAVE_API_URL=https://sandbox-api.wave.com/payment
WAVE_API_KEY=your-api-key

# ... etc for FREE_MONEY and EMONEY
```

### 4. Provide beneficiary metadata

Edit `relayer/beneficiaries.json`:

```json
{
  "0x0000000000000000000000000000000000000000000000000000000000000000": {
    "phoneNumber": "+221770000000",
    "externalReference": "beneficiary-001"
  }
}
```

## Run

### Event Listener Mode

```bash
npm run relayer:start
```

The relayer will listen for events from the blockchain and process payments.

### CLI Commands

#### Submit satellite data to WASDI

```bash
node relayer/index.js submit-satellite relayer/sample-satellite.json
```

#### Submit batch payment requests

```bash
node relayer/index.js submit-batch relayer/sample-batch-payments.json
```

#### Confirm batch payments

```bash
node relayer/index.js confirm-batch relayer/sample-batch-confirmations.json
```

## Features

### Security

- ✅ Audit logging with JSON records
- ✅ Certificate expiration monitoring
- ✅ Rate limit enforcement
- ✅ Anomaly detection (high failure rates)
- ✅ TLS validation for all API calls
- ✅ Sensitive data redaction from logs
- ✅ Webhook signature validation (HMAC-SHA256)
- ✅ Incident logging and alerting

### Providers Supported

| Provider | Status | API | Header |
|----------|--------|-----|--------|
| Orange Money | ✅ Ready | Bearer token | `Authorization: Bearer <key>` |
| Wave | ✅ Ready | Bearer token | `Authorization: Bearer <key>` |
| Free Money | ✅ Ready | Bearer token | `Authorization: Bearer <key>` |
| E-Money | ✅ Ready | API Key | `X-API-Key: <key>` |

### Monitoring

The relayer automatically monitors:

- **Certificate expiration** (checks every 6 hours, alerts < 30 days)
- **API failure rates** (alerts if > 50% failures)
- **Authentication attempts** (logs success/failure)
- **Rate limit violations**
- **API timeouts** (20s timeout per request)

Alerts are logged to `relayer/logs/audit-YYYY-MM-DD.log`.

## Batch Event Limitation

The current `MobileMoneyProvider` contract emits `BatchPaymentInitiated` for batch flows but does not emit `PaymentInitiated` for each item.
In that case, the relayer can log the batch event, but individual payment IDs are not visible through events alone.

**Recommended contract fix**: Emit `PaymentInitiated` inside the batch loop or add a batch metadata event with payment identifiers.

## Security Documentation

For detailed security best practices, incident response procedures, and compliance information, see [SECURITY.md](./SECURITY.md).

## Logs

Audit logs are stored in `relayer/logs/audit-YYYY-MM-DD.log`:

```bash
# View today's logs
tail -f relayer/logs/audit-*.log

# Search for security events
grep SECURITY_EVENT relayer/logs/audit-*.log

# Search for payment requests
grep PAYMENT_REQUEST relayer/logs/audit-*.log
```

## Extending for real sandbox APIs

1. Update provider URLs in `.env`
2. Implement the provider API contract in `relayer/providers.js` (adapters are pre-built)
3. Add real beneficiary metadata to `relayer/beneficiaries.json`
4. Set `SIMULATE_PAYMENTS=false` to enable real API calls
5. Test with a small batch before going to production
6. Monitor `relayer/logs/audit-*.log` for failures

## Example: Orange Money Setup

```bash
# Get credentials from Orange Money developer portal
# https://developers.orange.com/products/orange-money-api

export ORANGE_MONEY_API_URL="https://sandbox.orangemoneyweb.com/api/payment"
export ORANGE_MONEY_API_KEY="sk_sandbox_..."
export ORANGE_MONEY_MERCHANT_ID="MERCHANT123"
export ORANGE_MONEY_CALLBACK_URL="https://your-relayer.com/webhooks/orange-money"

# Add to .env
echo "ORANGE_MONEY_API_URL=$ORANGE_MONEY_API_URL" >> .env
echo "ORANGE_MONEY_API_KEY=$ORANGE_MONEY_API_KEY" >> .env
echo "ORANGE_MONEY_MERCHANT_ID=$ORANGE_MONEY_MERCHANT_ID" >> .env

# Set simulation mode to false
sed -i 's/SIMULATE_PAYMENTS=true/SIMULATE_PAYMENTS=false/g' .env

# Test with one payment
npm run relayer:start
```

## Troubleshooting

### Certificate validation error
```
Error: Provider API URL must use HTTPS
```
**Solution**: Ensure all provider URLs use HTTPS (e.g., `https://...`, not `http://...`)

### Authentication failures
```
[audit] AUTH_ATTEMPT: {"provider": "ORANGE_MONEY", "success": false, "reason": 401}
```
**Solution**: Check your API key in `.env` and verify it hasn't expired.

### Rate limit exceeded
```
[audit] RATE_LIMIT: WARNING 'Orange Money rate limit reached'
```
**Solution**: The relayer implements rate limits (100 req/min). Wait 1 minute or adjust in `relayer/security.js`.

### High failure rate alert
```
[audit] ANOMALY: WARNING 'Provider ... has 75% failure rate'
```
**Solution**: Check provider API status, credentials, and network connectivity. Review logs for error details.

## Performance Tuning

- **Timeout**: 20 seconds per API request (edit `providers.js`)
- **Rate limit**: 100 requests per 60 seconds per provider (edit `security.js`)
- **Certificate check**: Every 6 hours (edit `service.js`)
- **Anomaly check**: Every 1 hour (edit `service.js`)

## Support

For issues or questions:

- Check [SECURITY.md](./SECURITY.md) for security-related questions
- Review audit logs in `relayer/logs/`
- Open an issue on GitHub or contact ops@dpa-foundation.org
