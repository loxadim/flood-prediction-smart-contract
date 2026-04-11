# OPAL Platform — Flood Prediction Smart Contract

## DPA Foundation — Blockchain Layer for Parametric Flood Insurance

[![Solidity](https://img.shields.io/badge/Solidity-%5E0.8.22%20(compiled%200.8.28)-blue)](https://soliditylang.org/)
[![Hardhat](https://img.shields.io/badge/Hardhat-3.0.0-yellow)](https://hardhat.org/)
[![OpenZeppelin](https://img.shields.io/badge/OpenZeppelin-%5E5.4.0-purple)](https://openzeppelin.com/)
[![Network](https://img.shields.io/badge/Network-Polygon-8247E5)](https://polygon.technology/)

---

## Overview

This is the blockchain layer of the **OPAL (Open Parametric Aid Layer)** platform, developed by the **DPA Foundation** for parametric flood insurance in Senegal.

The system uses **satellite data from WASDI** (Web Advanced Space Developer Interface) to automatically trigger flood insurance payouts to vulnerable populations via **Mobile Money** (Orange Money, Wave).

### Key Features

- **Parametric triggers**: Automatic flood detection based on satellite risk scores (≥70% threshold)
- **Multi-oracle consensus**: IQR-based outlier detection across multiple data sources
- **Privacy-preserving**: Merkle tree verification — only hashes stored on-chain
- **Mobile Money bridge**: Off-chain relay pattern for Orange Money & Wave payments
- **UUPS upgradeable**: Safe upgrade path with proxy pattern
- **Multi-sig governance**: Emergency override with quorum-based proposals
- **KYC/AML compliance**: On-chain attestation lifecycle (GDPR-compliant, hash-only)

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                     OPAL Platform Architecture                       │
│                     (Hub-and-Spoke — FPC orchestrator)               │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────┐    ┌──────────────────┐                                │
│  │  WASDI   │───▶│  WASDIOracle     │  (off-chain satellite → chain) │
│  │ Satellite│    │  Connector       │                                │
│  └──────────┘    └──────────────────┘                                │
│                                                                      │
│  ┌──────────────────┐    reads     ┌───────────────────┐             │
│  │  FloodPrediction │ ───────────▶ │   MultiOracle     │             │
│  │     (UUPS Proxy) │    consensus │   (IQR Consensus) │             │
│  │ ═══ ORCHESTRATOR │              └───────────────────┘             │
│  │                  │     checks   ┌───────────────────┐             │
│  │  • triggerFlood  │  ───────────▶│   KYCAMLCompliance│             │
│  │  • batchPayments │              └───────────────────┘             │
│  │  • Merkle proofs │     payments ┌───────────────────┐             │
│  │                  │  ───────────▶│   MobileMoney     │             │
│  └──────────────────┘              │   (Orange/Wave)   │             │
│                                    └───────────────────┘             │
│  ┌──────────────────┐    ┌───────────────────┐                       │
│  │  Opal Governance │    │  Jokalante        │  (standalone,         │
│  │  (UUPS Proxy)    │    │  Targeting        │   address stored      │
│  │  upgrade control │    │  Merkle registry  │   in FPC)             │
│  └──────────────────┘    └───────────────────┘                       │
│                                                                      │
│  Note: FPC stores contract addresses and calls MO, KYC, MMP, JKT    │
│  via their interfaces. GOV calls FPC (executeProposal) and can       │
│  configure MO (onlyOwnerOrGovernance). WASDI is standalone.          │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Contracts

| Contract | Type | Description |
|----------|------|-------------|
| `FloodPredictionContract` | UUPS Proxy | Main orchestrator — triggers, payments, budgets |
| `MultiOracle` | Ownable2Step | Multi-source oracle with IQR consensus |
| `WASDIOracleConnector` | Ownable2Step | WASDI satellite data bridge (6 sources) |
| `OpalGovernanceUpgradeable` | UUPS Proxy | Multi-sig governance for emergencies |
| `JokalanteTargeting` | Ownable2Step | Merkle-based beneficiary targeting |
| `MobileMoneyProvider` | Ownable2Step | Mobile Money — 4 opérateurs (Orange, Wave, Free, E-Money) |
| `KYCAMLCompliance` | Ownable2Step | On-chain KYC attestations |
| `FloodPredictionLib` | Library | Cooldown calculation & utility functions |
| `MockWASDIOracle` | Mock | Test mock for satellite data |
| `MockMobileMoneyProvider` | Mock | Test mock for payment flow |
| `MockBeneficiaryRegistry` | Mock | Test mock for beneficiary registry |

---

## Quick Start

### Prerequisites

- Node.js >= 18
- npm >= 9

### Install

```bash
npm install
```

### Compile

```bash
npx hardhat build
```

### Test

```bash
# Full test suite (339 tests)
npx hardhat test

# With gas report
REPORT_GAS=true npx hardhat test

# Specific test file
npx hardhat test test/FloodPrediction.test.js
```

### Deploy

```bash
# Local (Hardhat) — UUPS proxy deployment
npx hardhat run scripts/deploy-upgradeable.js

# Polygon Amoy Testnet (resumable)
npx hardhat run scripts/deploy-amoy.js --network amoy

# Quick deploy (non-proxy)
npx hardhat run scripts/deploy-v3.js

# Upgrade existing proxy
PROXY_ADDRESS=0x... npx hardhat run scripts/upgrade-contract.js --network <network>
```

---

## Networks

| Network | Chain ID | RPC | Explorer |
|---------|----------|-----|----------|
| Polygon Mainnet | 137 | `POLYGON_RPC_URL` (env) | [PolygonScan](https://polygonscan.com) |
| Polygon Amoy | 80002 | `AMOY_RPC_URL` (env) | [Amoy Explorer](https://amoy.polygonscan.com) |
| Ethereum Sepolia | 11155111 | `SEPOLIA_RPC_URL` (env) | [Etherscan Sepolia](https://sepolia.etherscan.io) |
| Arbitrum One | 42161 | `ARBITRUM_RPC_URL` (env) | [Arbiscan](https://arbiscan.io) |
| Arbitrum Sepolia | 421614 | `ARBITRUM_SEPOLIA_RPC_URL` (env) | [Arbiscan Sepolia](https://sepolia.arbiscan.io) |
| Hardhat (in-process) | 1337 | — (in-memory EVM) | — |
| Localhost (HH node) | 31337 | `http://127.0.0.1:8545` | — |

---

## Environment Variables

Create a `.env` file:

```env
# Required for deployment
PRIVATE_KEY=your_wallet_private_key

# RPC URLs (required per-network)
POLYGON_RPC_URL=https://polygon-rpc.com
AMOY_RPC_URL=https://rpc-amoy.polygon.technology
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/...
ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc
ARBITRUM_SEPOLIA_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc

# Block explorer API keys (for contract verification)
POLYGONSCAN_API_KEY=your_polygonscan_key
ETHERSCAN_API_KEY=your_etherscan_key
ARBISCAN_API_KEY=your_arbiscan_key
```

---

## Project Structure

```
contracts/
├── FloodPredictionContract.sol          # Main orchestrator (UUPS Proxy)
├── MultiOracle.sol                      # Oracle consensus engine (IQR)
├── WASDIOracleConnector.sol             # WASDI satellite bridge (6 sources)
├── OpalGovernanceUpgradeable.sol        # Multi-sig governance (UUPS Proxy)
├── JokalanteTargeting.sol               # Merkle beneficiary targeting
├── MobileMoneyProvider.sol              # Mobile Money — 4 opérateurs
├── KYCAMLCompliance.sol                 # KYC attestations
├── libs/
│   └── FloodPredictionLib.sol           # Cooldown calculation library
└── mocks/
    ├── MockWASDIOracle.sol              # Test mock oracle
    ├── MockMobileMoneyProvider.sol      # Test mock paiements
    └── MockBeneficiaryRegistry.sol      # Test mock registre

interfaces/                                      # All contract interfaces
scripts/                                         # Deployment & test scripts
test/                                            # Comprehensive test suite
```

---

## Security

- **RBAC**: Separate ADMIN, OPERATOR, PAUSER, UPGRADER roles
- **Adaptive cooldown**: 10min (critical), 30min (high), 1h (moderate)
- **Nonce-based replay protection**: Per-region + global nonces
- **Merkle privacy**: Only beneficiary hashes on-chain
- **Emergency mode**: Global + region-level halt capability
- **H-11 fix**: `abi.encode` (not `abi.encodePacked`) for hash collision prevention
- **EIP-170 compliant**: Optimizer + viaIR for contract size limits

---

## Scope of Work Coverage

This project implements the 8-part scope from the DPA Foundation specification:

1. ✅ **Part 1**: Blockchain comparison & selection (Polygon L2)
2. ✅ **Part 2**: Smart contract platform with oracle integration
3. ✅ **Part 3**: Parametric trigger mechanism (satellite data → payout)
4. ✅ **Part 4**: Mobile Money bridge (Orange Money, Wave)
5. ✅ **Part 5**: KYC/AML compliance layer
6. ✅ **Part 6**: Governance & emergency controls
7. ✅ **Part 7**: Security audit compliance
8. ✅ **Part 8**: Deployment & documentation

---

## License

MIT — DPA Foundation, 2025
