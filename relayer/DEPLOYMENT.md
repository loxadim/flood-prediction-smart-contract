# Deployment Guide

This guide covers deploying the off-chain relayer service to production environments.

## Pre-Deployment Checklist

Before deploying, complete all items below:

- [ ] Review [SECURITY.md](./SECURITY.md)
- [ ] All secrets stored in vault (not in `.env`)
- [ ] HTTPS enabled for all provider APIs
- [ ] SSL/TLS certificates valid for > 30 days
- [ ] Audit log storage configured
- [ ] Monitoring and alerting enabled
- [ ] Incident response team briefed
- [ ] Backup and recovery procedures tested
- [ ] Network firewall rules configured
- [ ] Database and logging infrastructure ready

## Environment Setup

### 1. Secure Secret Storage

Use one of:

- **HashiCorp Vault**: `vault kv put secret/relayer/production ...`
- **AWS Secrets Manager**: `aws secretsmanager create-secret ...`
- **Azure Key Vault**: `az keyvault secret set ...`
- **Google Cloud Secret Manager**: `gcloud secrets create ...`

Example (HashiCorp Vault):

```bash
vault kv put secret/relayer/production \
  PRIVATE_KEY="0x..." \
  ORANGE_MONEY_API_KEY="sk_prod_..." \
  ORANGE_MONEY_MERCHANT_ID="MERCHANT123" \
  WAVE_API_KEY="wave_prod_..."
```

### 2. Load Secrets at Runtime

Option A: Environment variables from vault:

```bash
#!/bin/bash
export $(vault kv get -format=env secret/relayer/production)
npm run relayer:start
```

Option B: Node.js vault integration:

```javascript
import vault from 'node-vault';

const client = vault.default({
  endpoint: process.env.VAULT_ADDR,
  token: process.env.VAULT_TOKEN,
});

const secrets = await client.read('secret/data/relayer/production');
process.env.PRIVATE_KEY = secrets.data.data.PRIVATE_KEY;
// ... etc
```

### 3. Configure Logging

#### Option A: Local File Logging

```bash
mkdir -p /var/log/relayer
chmod 700 /var/log/relayer
ln -s /var/log/relayer ./logs  # in relayer directory
```

#### Option B: Centralized Logging (Recommended)

Use a log aggregation service:

- **ELK Stack** (Elasticsearch, Logstash, Kibana)
- **Datadog**: Automatic JSON parsing
- **Splunk**: Enterprise-grade log analysis
- **CloudWatch** (AWS): Native integration

Example (Datadog):

```bash
# Install Datadog agent
npm install --save dd-trace

# Initialize in index.js
const tracer = require('dd-trace').init();
```

### 4. Monitoring & Alerting

#### Certificate Expiration Alert

```bash
# Using Prometheus
prometheus.gauge('relayer_cert_expiry_days', daysUntilExpiry);

# Alert rule:
alert: CertificateExpiringSoon
if: relayer_cert_expiry_days < 30
```

#### Anomaly Detection Alert

```bash
# Alert if failure rate > 50%
alert: HighPaymentFailureRate
if: relayer_payment_failure_rate > 0.5
annotations:
  summary: "High payment failure rate on {{ $labels.provider }}"
```

#### Log-based Alerts

```bash
# Using grep and cron
0 * * * * grep "SECURITY_EVENT" /var/log/relayer/audit-*.log | mail -s "Relayer Security Events" ops@dpa-foundation.org
```

## Deployment Methods

### Option 1: Manual Deployment (Development/Small Scale)

```bash
# 1. SSH into production server
ssh ubuntu@relayer.production.com

# 2. Clone repository
git clone https://github.com/loxadim/flood-prediction-smart-contract.git
cd flood-prediction-smart-contract

# 3. Install dependencies
npm install

# 4. Load secrets and start
export $(vault kv get -format=env secret/relayer/production)
npm run relayer:start &

# 5. Monitor logs
tail -f relayer/logs/audit-*.log
```

### Option 2: Docker Deployment (Recommended)

#### Dockerfile

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY relayer/ ./relayer/
COPY contracts/interfaces/ ./contracts/interfaces/
COPY artifacts/contracts/ ./artifacts/contracts/

RUN mkdir -p /app/logs /app/data
RUN chmod 700 /app/logs /app/data

EXPOSE 8080

CMD ["npm", "run", "relayer:start"]
```

#### Build & Push

```bash
# Build
docker build -t dpa/relayer:latest -f relayer/Dockerfile .

# Tag for registry
docker tag dpa/relayer:latest gcr.io/dpa-foundation/relayer:latest

# Push to registry
docker push gcr.io/dpa-foundation/relayer:latest
```

#### Docker Compose

```yaml
version: '3.9'
services:
  relayer:
    image: gcr.io/dpa-foundation/relayer:latest
    environment:
      - RPC_URL=${RPC_URL}
      - PRIVATE_KEY=${PRIVATE_KEY}
      - MOBILE_MONEY_PROVIDER_ADDRESS=${MOBILE_MONEY_PROVIDER_ADDRESS}
    volumes:
      - ./logs:/app/logs
      - ./beneficiaries.json:/app/relayer/beneficiaries.json:ro
    restart: unless-stopped
    networks:
      - production
    
networks:
  production:
    driver: bridge
```

Run:

```bash
docker-compose up -d
docker-compose logs -f
```

### Option 3: Kubernetes Deployment (High Availability)

#### Helm Chart

Create `relayer-chart/Chart.yaml`:

```yaml
apiVersion: v2
name: relayer
version: 1.0.0
appVersion: "1.0"
```

Create `relayer-chart/values.yaml`:

```yaml
image:
  repository: gcr.io/dpa-foundation/relayer
  tag: latest
  pullPolicy: IfNotPresent

replicaCount: 3

resources:
  limits:
    cpu: 500m
    memory: 512Mi
  requests:
    cpu: 250m
    memory: 256Mi

env:
  RPC_URL: https://rpc-amoy.maticvigil.com
  SIMULATE_PAYMENTS: "false"

secrets:
  - name: PRIVATE_KEY
    vault: secret/relayer/production
  - name: ORANGE_MONEY_API_KEY
    vault: secret/relayer/production
```

Deploy:

```bash
# Install
helm install relayer ./relayer-chart -n production

# Upgrade
helm upgrade relayer ./relayer-chart -n production

# Check status
kubectl get pods -n production
kubectl logs -n production deployment/relayer -f
```

## Post-Deployment

### 1. Health Checks

Create a health check endpoint (optional):

```javascript
// relayer/health.js
import express from 'express';

const app = express();

app.get('/health', (req, res) => {
  const uptime = process.uptime();
  const memory = process.memoryUsage();
  
  res.json({
    status: 'ok',
    uptime,
    memory,
    pendingPayments: relayerService.pendingPayments.size,
  });
});

app.listen(8080);
```

Health check URL:

```bash
curl https://relayer.production.com/health
```

### 2. Verify Operation

```bash
# Check audit logs
tail -f /var/log/relayer/audit-*.log

# Verify payment flow
grep "PAYMENT_REQUEST" /var/log/relayer/audit-*.log | tail -5

# Check certificate status
grep "CERT_EXPIRY" /var/log/relayer/audit-*.log

# Monitor failure rates
grep "ANOMALY" /var/log/relayer/audit-*.log
```

### 3. Backup Strategy

Daily backups:

```bash
#!/bin/bash
# /opt/backup-relayer.sh

BACKUP_DIR="/backups/relayer-$(date +%Y-%m-%d)"
mkdir -p $BACKUP_DIR

# Backup audit logs
cp -r /var/log/relayer/* $BACKUP_DIR/logs/

# Backup beneficiary registry (if using local storage)
cp /app/relayer/beneficiaries.json $BACKUP_DIR/

# Compress
tar -czf "$BACKUP_DIR.tar.gz" $BACKUP_DIR/

# Upload to cloud storage
gsutil cp "$BACKUP_DIR.tar.gz" gs://dpa-backups/relayer/

# Clean old backups (keep 90 days)
find /backups -name "relayer-*.tar.gz" -mtime +90 -delete
```

Cron schedule:

```bash
# Daily backup at 2 AM
0 2 * * * /opt/backup-relayer.sh >> /var/log/backup-relayer.log 2>&1
```

### 4. Incident Response

If relayer service fails:

```bash
# 1. Check logs
journalctl -u relayer -n 50

# 2. Restart service
systemctl restart relayer

# 3. Verify operation
curl https://relayer.production.com/health

# 4. If problem persists, escalate to ops team
# Contact: ops@dpa-foundation.org
```

## Rollback Procedure

If deployment fails:

```bash
# 1. Check deployment history
helm history relayer -n production

# 2. Rollback to previous version
helm rollback relayer -n production

# 3. Verify service
kubectl logs -n production deployment/relayer -f

# 4. Investigate issue
# Review changes between versions
# Check compatibility with on-chain contracts
```

## Performance Monitoring

### Key Metrics to Track

- **Payment latency**: Time from event to confirmation
- **Success rate**: Confirmed payments / initiated payments
- **API response time**: Per provider
- **Certificate expiry**: Days until expiration
- **Failure rate trend**: Rolling 24h average

### Dashboard Example (Grafana)

```
┌─────────────────────────────────┐
│ Relayer Dashboard               │
├─────────────────────────────────┤
│ Payments Today: 1,234           │
│ Success Rate: 99.2%             │
│ Avg Latency: 3.2s               │
│ Active Providers: 4             │
├─────────────────────────────────┤
│ Cert Expiry (Orange): 25 days   │
│ API Response Time                │
│ ├─ Orange Money: 245ms          │
│ ├─ Wave: 312ms                  │
│ ├─ Free Money: 198ms            │
│ └─ E-Money: 267ms               │
└─────────────────────────────────┘
```

## Support Contacts

| Role | Contact | Availability |
|------|---------|--------------|
| On-Call Ops | ops@dpa-foundation.org | 24/7 |
| Security Team | security@dpa-foundation.org | 9-5 (escalate 24/7) |
| Developer | dev@dpa-foundation.org | 9-5 |

## Maintenance Window

Scheduled maintenance:

- **Frequency**: Monthly (second Tuesday)
- **Duration**: 1-2 hours
- **Time**: 02:00-04:00 UTC (low activity period)
- **Notification**: Sent 1 week in advance

Maintenance tasks:

- [ ] Rotate API keys
- [ ] Update certificates
- [ ] Review and archive audit logs
- [ ] Performance optimization
- [ ] Security patching

---

For questions or issues, contact ops@dpa-foundation.org or open an issue on GitHub.
