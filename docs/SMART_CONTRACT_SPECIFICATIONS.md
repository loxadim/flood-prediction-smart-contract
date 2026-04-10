# Smart Contract Specifications

## OPAL Parametric Flood Insurance Platform

**Project:** DPA Foundation — OPAL Platform  
**Version:** 1.0.0  
**Solidity:** ^0.8.22 (compiled 0.8.28)  
**OpenZeppelin:** ^5.4.0

---

## Table of Contents

1. [Overview](#1-overview)
2. [FloodPredictionContract](#2-floodpredictioncontract)
3. [MultiOracle](#3-multioracle)
4. [OpalGovernanceUpgradeable](#4-opalgovernanceupgradeable)
5. [JokalanteTargeting](#5-jokalantetargeting)
6. [MobileMoneyProvider](#6-mobilemoneyprovider)
7. [KYCAMLCompliance](#7-kycamlcompliance)
8. [WASDIOracleConnector](#8-wasdioracleconnector)
9. [FloodPredictionLib](#9-floodpredictionlib)
10. [Interfaces](#10-interfaces)
11. [Mock Contracts](#11-mock-contracts)

---

## 1. Overview

The platform comprises **7 main contracts**, **1 library**, **7 interfaces**, and **3 mock contracts**:

| Contract | Type | Purpose |
|----------|------|---------|
| FloodPredictionContract | UUPS Proxy | Central orchestrator — triggers, payments, budgets |
| MultiOracle | Standard | Multi-oracle consensus with IQR outlier detection |
| OpalGovernanceUpgradeable | UUPS Proxy | Multi-sig governance with timelock |
| JokalanteTargeting | Standard | Privacy-preserving Merkle tree verification |
| MobileMoneyProvider | Standard | Mobile Money payment lifecycle |
| KYCAMLCompliance | Standard | KYC/AML attestation and screening |
| WASDIOracleConnector | Standard | WASDI satellite data bridge |
| FloodPredictionLib | Library | Shared utility functions |

---

## 2. FloodPredictionContract

**File:** `contracts/FloodPredictionContract.sol` (~994 lines)  
**Type:** UUPS Upgradeable Proxy  
**Inheritance:** `Initializable → AccessControlUpgradeable → UUPSUpgradeable → PausableUpgradeable → ReentrancyGuardTransient → IFloodPrediction`

### 2.1 Constants

| Constant | Type | Value | Purpose |
|----------|------|-------|---------|
| VERSION | uint256 | 3 | Contract version |
| MAX_BATCH_SIZE | uint256 | 50 | Max beneficiaries per batch |
| DEFAULT_RISK_THRESHOLD | uint256 | 70 | Minimum risk score for triggers |
| GOVERNANCE_RISK_THRESHOLD | uint256 | 85 | Minimum for governance overrides |
| MAX_RISK_SCORE | uint256 | 100 | Maximum risk score |
| MIN_PAYMENT_AMOUNT | uint256 | 500 | Minimum payment (FCFA) |
| MAX_PAYMENT_AMOUNT | uint256 | 5,000,000 | Maximum payment (FCFA) |
| COOLDOWN_CRITICAL | uint256 | 10 minutes | Cooldown for CRITICAL risk |
| COOLDOWN_HIGH | uint256 | 30 minutes | Cooldown for HIGH risk |
| COOLDOWN_NORMAL | uint256 | 1 hour | Cooldown for LOW/NORMAL risk |
| MAX_REGION_LENGTH | uint256 | 20 | Max region string length |
| MAX_STRING_LENGTH | uint256 | 500 | Max metadata string length |
| ADMIN_ROLE | bytes32 | keccak256("ADMIN_ROLE") | Administrator role |
| OPERATOR_ROLE | bytes32 | keccak256("OPERATOR_ROLE") | Operator role |
| UPGRADER_ROLE | bytes32 | keccak256("UPGRADER_ROLE") | Upgrade authorization role |
| PAUSER_ROLE | bytes32 | keccak256("PAUSER_ROLE") | Pause/unpause role |

### 2.2 Enums

**TriggerStatus** (from IFloodPrediction):

| Value | Name | Description |
|-------|------|-------------|
| 0 | INACTIVE | Default / non-existent |
| 1 | PENDING | Trigger created, awaiting validation |
| 2 | ACTIVE | Active trigger |
| 3 | VALIDATED | Validated, ready for payments |
| 4 | PAID | All payments complete |
| 5 | EXPIRED | Time-expired |
| 6 | CANCELLED | Cancelled by admin |

**RiskLevel** (from IFloodPrediction):

| Value | Name | Threshold |
|-------|------|-----------|
| 0 | LOW | riskScore < 50 |
| 1 | MODERATE | 50 ≤ riskScore < 70 |
| 2 | HIGH | 70 ≤ riskScore < 85 |
| 3 | CRITICAL | riskScore ≥ 85 |

### 2.3 Structs

**FloodTrigger** (14 fields):
| Field | Type | Description |
|-------|------|-------------|
| eventId | string | Unique trigger identifier |
| region | string | Geographic region |
| riskScore | uint256 | Risk score (0-100) |
| timestamp | uint256 | Creation timestamp |
| validatedAt | uint256 | Validation timestamp |
| paidAt | uint256 | Payment timestamp |
| status | TriggerStatus | Current trigger status |
| riskLevel | RiskLevel | Calculated risk level |
| triggeredBy | address | Trigger creator |
| totalAmount | uint256 | Total budget for trigger |
| beneficiaryCount | uint256 | Number of beneficiaries |
| merkleRoot | bytes32 | Beneficiary Merkle root |
| isGovernanceOverride | bool | Created via governance |
| chainId | uint256 | Chain ID for replay protection (M-01) |

**BudgetAllocation** (5 fields):
| Field | Type | Description |
|-------|------|-------------|
| region | string | Region name |
| allocatedAmount | uint256 | Allocated budget |
| spentAmount | uint256 | Amount spent |
| lastUpdated | uint256 | Last update timestamp |
| isActive | bool | Active status |

**PaymentRecord** (5 fields):
| Field | Type | Description |
|-------|------|-------------|
| beneficiaryHash | bytes32 | Hashed beneficiary ID |
| amount | uint256 | Payment amount (FCFA) |
| paidAt | uint256 | Payment timestamp |
| eventId | string | Associated trigger |
| verified | bool | Verification status |

### 2.4 State Variables

| Variable | Type | Description |
|----------|------|-------------|
| triggers | mapping(string → FloodTrigger) | Trigger storage |
| triggerIds | string[] | All trigger IDs |
| triggerCount | uint256 | Total triggers |
| budgets | mapping(string → BudgetAllocation) | Regional budgets |
| budgetRegions | string[] | All budget regions |
| totalBudgetAllocated | uint256 | Sum of allocated budgets |
| totalBudgetSpent | uint256 | Sum of spent budgets |
| paymentRecords | mapping(bytes32 → PaymentRecord) | Per-payment records |
| totalPaymentsProcessed | uint256 | Total payment count |
| totalAmountDisbursed | uint256 | Total FCFA disbursed |
| triggerPaidCount | mapping(string → uint256) | Paid count per trigger |
| committedBudget | mapping(string → uint256) | Committed (reserved) budget per region |
| triggerSpentAmount | mapping(string → uint256) | Spent per trigger |
| regionNonces | mapping(string → uint256) | Nonces for event ID generation |
| globalNonce | uint256 | Global nonce |
| lastTriggerTimestamp | mapping(string → uint256) | Last trigger time per region |
| riskThreshold | uint256 | Current risk threshold |
| multiOracle | address | Oracle contract address |
| governance | address | Governance contract address |
| jokalanteTargeting | address | Targeting contract address |
| mobileMoneyProvider | address | Payment contract address |
| kycCompliance | address | KYC contract address |
| emergencyMode | bool | Global emergency flag |
| regionEmergency | mapping(string → bool) | Per-region emergency |
| oracleTolerance | uint256 | Max allowed deviation between submitted riskScore and oracle consensus (default 0 = strict) |
| __gap | uint256[48] | Storage gap for upgrades (reduced from 49 to account for oracleTolerance) |

### 2.5 Functions

| Function | Visibility | Access | Description |
|----------|------------|--------|-------------|
| `initialize(address admin, address operator, address upgrader, address pauser)` | external | initializer | Initialize proxy with role-separated addresses (V-02 fix) |
| `createFloodTrigger(region, riskScore, merkleRoot, totalAmount, beneficiaryCount)` | external | OPERATOR_ROLE, whenNotPaused | Create a flood trigger |
| `createGovernanceOverrideTrigger(region, riskScore, merkleRoot, totalAmount, beneficiaryCount, reason)` | external | ADMIN_ROLE, whenNotPaused | Create governance override trigger (GOVERNANCE_RISK_THRESHOLD=85 defined but not enforced in code) |
| `validateTrigger(eventId)` | external | OPERATOR_ROLE | Set trigger to VALIDATED |
| `validateAndProcessPayments(eventId, hashes, amounts, proofs, phoneHashes)` | external | OPERATOR_ROLE, nonReentrant, whenNotPaused | One-step validate + batch pay |
| `cancelTrigger(eventId, reason)` | external | ADMIN_ROLE | Cancel an ACTIVE trigger |
| `processBatchPayment(eventId, hashes, amounts, proofs, phoneHashes)` | external | OPERATOR_ROLE, nonReentrant, whenNotPaused | Pay batch of validated trigger |
| `allocateBudget(region, amount)` | external | ADMIN_ROLE | Allocate budget to region |
| `deactivateBudget(region)` | external | ADMIN_ROLE | Deactivate region budget |
| `activateEmergencyMode(reason)` | external | ADMIN_ROLE | Activate global emergency |
| `deactivateEmergencyMode()` | external | ADMIN_ROLE | Deactivate global emergency |
| `setRegionEmergency(region, status)` | external | ADMIN_ROLE | Toggle per-region emergency |
| `updateRiskThreshold(newThreshold)` | external | ADMIN_ROLE | Update risk threshold |
| `setOracleTolerance(newTolerance)` | external | ADMIN_ROLE | Set oracle score tolerance (0–10; default 0 = exact match required) |
| `setContractAddresses(oracle, gov, targeting, mobileMoney, kyc)` | external | ADMIN_ROLE | Set external contract addresses |
| `pause()` | external | PAUSER_ROLE | Pause contract |
| `unpause()` | external | PAUSER_ROLE | Unpause contract |
| `getFloodTrigger(eventId)` | external view | — | Get trigger details |
| `getRegionBudget(region)` | external view | — | Get budget allocation |
| `getRegionBudgetRemaining(region)` | external view | — | Get remaining budget |
| `getPaymentRecord(eventId, hash)` | external view | — | Get payment record |
| `isBeneficiaryPaid(eventId, hash)` | external view | — | Check if paid |
| `getSystemStats()` | external view | — | Get global statistics |
| `getTriggerIds()` | external view | — | All trigger IDs |
| `getTriggerIdsPaginated(offset, limit)` | external view | — | Paginated trigger IDs |
| `getBudgetRegionsPaginated(offset, limit)` | external view | — | Paginated regions |
| `getVersion()` | external pure | — | Return VERSION |
| `getCooldownRemaining(region, riskScore)` | external view | — | Remaining cooldown time |
| `_getRiskLevel(riskScore)` | internal pure | — | Calculate risk level |
| `_authorizeUpgrade(newImpl)` | internal | UPGRADER_ROLE | UUPS upgrade authorization |

### 2.6 Events

| Event | Parameters |
|-------|-----------|
| FloodTriggerCreated | eventId, region, riskScore, timestamp, triggeredBy |
| TriggerValidated | eventId, validator, timestamp |
| TriggerCancelled | eventId, cancelledBy, reason |
| BatchPaymentProcessed | eventId, batchSize, totalAmount, timestamp |
| SinglePaymentProcessed | eventId, beneficiaryHash, amount, timestamp |
| BudgetAllocated | region, amount, allocatedBy |
| BudgetSpent | region, amount, eventId |
| BudgetDeactivated | region, operator |
| BudgetCommitted | region, amount, eventId |
| BudgetCommitmentReleased | region, amount, eventId |
| EmergencyModeActivated | reason, activatedBy |
| EmergencyModeDeactivated | deactivatedBy |
| RegionEmergencySet | region, status, setBy |
| RiskThresholdUpdated | oldThreshold, newThreshold |
| ContractAddressUpdated | contractName, oldAddress, newAddress |
| GovernanceOverride | eventId, governor, reason |
| MobileMoneyPaymentsInitiated | eventId, count, totalAmount |
| MobileMoneyPaymentsFailed | eventId, count, totalAmount |
| KYCBeneficiarySkipped | eventId (indexed), beneficiaryHash — emitted for each beneficiary skipped due to failed KYC (C-1 fix: individual skip instead of global revert) |
| OracleToleranceUpdated | oldTolerance, newTolerance |

### 2.7 Custom Errors

`InvalidRiskScore`, `BelowRiskThreshold`, `CooldownNotElapsed`, `TriggerNotFound`, `TriggerNotActive`, `TriggerAlreadyPaid`, `InsufficientBudget`, `InvalidBatchSize`, `InvalidPaymentAmount`, `BeneficiaryAlreadyPaid`, `InvalidMerkleProof`, `EmergencyModeActive`, `NotInEmergencyMode`, `ArrayLengthMismatch`, `InvalidAddress`, `RegionNotActive`, `TriggerNotCancellable`, `InvalidThreshold`, `StringTooLong`, `RegionStringTooLong`, `KYCCheckFailed`, `InvalidBeneficiaryCount`, `OracleRiskScoreMismatch`

> **Audit Round 2 (Avril 2026) — Nouvelles erreurs / événements :** `KYCBeneficiarySkipped` (event C-1), `OracleToleranceUpdated` (event H-3), `setOracleTolerance()` (function H-3).

---

## 3. MultiOracle

**File:** `contracts/MultiOracle.sol` (~950 lines)  
**Type:** Standard (Non-Upgradeable)  
**Inheritance:** `IMultiOracle → Ownable2Step → ReentrancyGuard`

### 3.1 Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| MAX_ORACLES | 10 | Maximum registered oracles |
| MIN_ORACLE_COUNT | 4 | Minimum oracles for consensus |
| MIN_RISK_SCORE | 0 | Minimum valid risk score |
| MAX_RISK_SCORE | 100 | Maximum valid risk score |
| MAX_REPUTATION | 100 | Reputation cap |
| INITIAL_REPUTATION | 50 | Starting reputation |
| REPUTATION_BONUS | 2 | Bonus for aligned submission |
| REPUTATION_PENALTY | 10 | Penalty for outlier submission |
| IQR_MULTIPLIER_NUM | 3 | IQR multiplier numerator |
| IQR_MULTIPLIER_DEN | 2 | IQR multiplier denominator |

### 3.2 Structs

**OracleData** (5 fields): `oracle` (address), `riskScore` (uint256), `timestamp` (uint256), `dataSource` (string), `isOutlier` (bool)

**ConsensusResult** (6 fields): `consensusRiskScore` (uint256), `participantCount` (uint256), `outlierCount` (uint256), `timestamp` (uint256), `reached` (bool), `region` (string)

**OracleInfo** (9 fields): `oracleAddress` (address), `name` (string), `reputation` (uint256), `totalSubmissions` (uint256), `outlierCount` (uint256), `consecutiveOutliers` (uint256), `isActive` (bool), `registeredAt` (uint256)

### 3.3 Configuration

| Parameter | Default | Setter |
|-----------|---------|--------|
| consensusThreshold | 60% | `setConsensusThreshold()` |
| dataFreshnessThreshold | 1 hour | `setDataFreshnessThreshold()` |
| maxConsecutiveOutliers | 3 | `setMaxConsecutiveOutliers()` |

### 3.4 Key Functions

| Function | Access | Description |
|----------|--------|-------------|
| `registerOracle(address, name)` | onlyOwner | Register new oracle |
| `deactivateOracle(address)` | onlyOwner | Deactivate oracle |
| `reactivateOracle(address)` | onlyOwner | Reactivate oracle |
| `submitData(region, riskScore, dataSource)` | onlyActiveOracle | Submit risk data |
| `getConsensus(region)` | view | Get consensus result |
| `isConsensusReached(region)` | view | Check consensus status |
| `getConsensusRiskScore(region)` | view | Get consensus risk score |
| `setConsensusThreshold(threshold)` | onlyOwner | Update threshold |

### 3.5 Consensus Algorithm

1. Minimum 4 active oracles required
2. Each oracle submits `riskScore` for a `region`
3. Submissions within `dataFreshnessThreshold` (1h) are considered
4. When ≥60% of active oracles have submitted:
   - Sort submissions, calculate Q1, Q3, IQR
   - Flag outliers: score < Q1 - 1.5×IQR or score > Q3 + 1.5×IQR
   - Calculate median of non-outlier submissions
   - Penalize outlier oracles (reputation -10), reward others (+2)
   - Auto-deactivate oracle after 3 consecutive outliers

### 3.6 Events

`OracleRegistered`, `OracleDeactivated`, `OracleReactivated`, `DataSubmitted`, `ConsensusReached`, `OutlierDetected`, `ReputationUpdated`, `ConsensusThresholdUpdated`, `DataFreshnessThresholdUpdated`, `MaxConsecutiveOutliersUpdated`, `OracleProbationWarning`, `InsufficientOracleCountWarning`

---

## 4. OpalGovernanceUpgradeable

**File:** `contracts/OpalGovernanceUpgradeable.sol` (~508 lines)  
**Type:** UUPS Upgradeable Proxy  
**Inheritance:** `Initializable → Ownable2StepUpgradeable → UUPSUpgradeable → IOpalGovernance`

### 4.1 Constants

| Constant | Value |
|----------|-------|
| MAX_ACTORS | 20 |
| DEFAULT_DEADLINE | 24 hours |
| EMERGENCY_DEADLINE | 4 hours |
| MIN_QUORUM | 2 |
| EXECUTION_DELAY | 1 hour |

### 4.2 Enums

**ProposalStatus**: PENDING(0), APPROVED(1), EXECUTED(2), REJECTED(3), EXPIRED(4)

**ProposalType**: EMERGENCY_TRIGGER(0), PARAMETER_CHANGE(1), BUDGET_ALLOCATION(2), UPGRADE(3), ORACLE_OVERRIDE(4)

### 4.3 Structs

**Proposal** (13 fields): `id`, `proposalType`, `status`, `proposer`, `target` *(address — explicit execution target; H-2 fix)*, `description`, `data`, `signatureCount`, `requiredSignatures`, `createdAt`, `deadline`, `executedAt`, `region`

**GovernanceActor** (7 fields): `actorAddress`, `name`, `role`, `isActive`, `proposalCount`, `signatureCount`, `registeredAt`

### 4.4 Key Functions

| Function | Access | Description |
|----------|--------|-------------|
| `initialize(owner, quorum)` | initializer | Initialize with owner and quorum |
| `addGovernanceActor(addr, name, role)` | onlyOwner | Add governance actor |
| `removeGovernanceActor(addr)` | onlyOwner | Remove actor (quorum check) |
| `createProposal(type, description, data, region, target)` | actor only | Create proposal — `target` is the contract to call on execution (H-2 fix; defaults to `floodPredictionContract` if zero address) |
| `signProposal(id)` | actor only | Sign proposal |
| `executeProposal(id)` | actor only | Execute after timelock |
| `rejectProposal(id)` | actor only | Reject proposal |
| `expireProposal(id)` | anyone | Expire past-deadline proposal |
| `setAllowedSelector(selector, allowed)` | onlyOwner | Whitelist function selector |
| `setAllowedSelectorBatch(selectors, allowed)` | onlyOwner | Batch whitelist |
| `setExecutionGasLimit(limit)` | onlyOwner | Set gas limit for execution |

### 4.5 Timelock Mechanism (M-10 Fix)

After quorum is reached (stored in `quorumReachedAt[proposalId]`), a mandatory 1-hour `EXECUTION_DELAY` must elapse before `executeProposal()` can be called. **Exception:** `EMERGENCY_TRIGGER` proposals bypass the timelock.

### 4.6 Selector Whitelist (H4-GOV Fix)

`executeProposal()` extracts the function selector from `data` and checks `allowedSelectors[selector]`. Only whitelisted selectors can be executed, preventing arbitrary function calls on the target contract.

### 4.7 Storage Gap

`uint256[47] private __gap` — reserves 47 storage slots for future upgrades.

---

## 5. JokalanteTargeting

**File:** `contracts/JokalanteTargeting.sol` (~320 lines)  
**Type:** Standard (Non-Upgradeable)  
**Inheritance:** `IJokalanteTargeting → Ownable2Step`

### 5.1 Configuration

| Parameter | Default | Setter |
|-----------|---------|--------|
| defaultExpiryDuration | 90 days | configurable |
| maxBeneficiariesPerRegion | 50,000 | configurable |

### 5.2 Key Functions

| Function | Access | Description |
|----------|--------|-------------|
| `updateMerkleRoot(region, merkleRoot, count)` | onlyOwner | Set Merkle root for region |
| `deactivateRegion(region)` | onlyOwner | Deactivate region targeting |
| `verifyBeneficiary(region, hash, amount, proof)` | public view | Verify Merkle proof |
| `verifyBeneficiaryBatch(region, hashes, amounts, proofs)` | public view | Batch verify |
| `markVerified(hash, region)` | onlyAuthorizedCaller | Mark beneficiary verified |
| `addAuthorizedCaller(addr)` | onlyOwner | Add authorized caller |
| `removeAuthorizedCaller(addr)` | onlyOwner | Remove authorized caller |

### 5.3 Privacy Design

- Uses `abi.encode` (NOT `abi.encodePacked`) for hash computation — prevents hash collision attacks (H-01 fix)
- Beneficiary PII never stored on-chain — only hashes and Merkle roots
- `authorizedCallers` mapping restricts who can mark beneficiaries as verified (L-06 fix)
- `markVerified()` is implementation-only (NOT in IJokalanteTargeting interface)

### 5.4 On-Chain Integration with FloodPredictionContract (H-1 fix — Audit Round 2)

After the H-1 audit fix, **JokalanteTargeting is called on-chain by FloodPredictionContract** during payment processing:

1. When `jokalanteTargeting != address(0)`, `processBatchPayment()` calls `IJokalanteTargeting.verifyBeneficiary(region, hash, amount, proof)` instead of performing an inline `MerkleProof.verify()`.
2. After a successful payment, `FloodPredictionContract` calls `JokalanteTargeting.markVerified(region, hash)` to record the on-chain payout.
3. If `jokalanteTargeting == address(0)` (unconfigured), FPC falls back to inline `MerkleProof.verify()` for backward compatibility.

> **FPC must be added as an `authorizedCaller`** in JokalanteTargeting via `addAuthorizedCaller(fpc_address)` to allow `markVerified()` calls.

---

## 6. MobileMoneyProvider

**File:** `contracts/MobileMoneyProvider.sol` (~620 lines)  
**Type:** Standard (Non-Upgradeable)  
**Inheritance:** `IMobileMoneyProvider → Ownable2Step → Pausable → ReentrancyGuard`

### 6.1 Constants

| Constant | Value |
|----------|-------|
| MAX_PAYMENT_AMOUNT | 5,000,000 FCFA |
| MIN_PAYMENT_AMOUNT | 500 FCFA |
| MAX_BATCH_SIZE | 50 |
| MAX_RETRIES | 3 |
| DEFAULT_TIMEOUT | 30 minutes |
| MAX_TIMEOUT | 24 hours |
| MIN_TIMEOUT | 5 minutes |

### 6.2 Enums

**MobileProvider** (defined in `IMobileMoneyProvider.sol`): ORANGE_MONEY(0), WAVE(1), FREE_MONEY(2), EMONEY(3)

**PaymentStatus** (from interface): PENDING(0), CONFIRMED(1), FAILED(2), EXPIRED(3), CANCELLED(4)

### 6.3 Provider Selection

Le fournisseur Mobile Money est fourni en paramètre (et non détecté par préfixe téléphonique) car tout fournisseur peut servir n'importe quel numéro.

| Provider | Enum Value | API |
|----------|-----------|-----|
| Orange Money | 0 | Orange Money API v3 |
| Wave | 1 | Wave Business API |
| Free Money | 2 | Free Money B2B |
| E-Money | 3 | SGBS E-Money |

### 6.4 Key Functions

| Function | Access | Description |
|----------|--------|-------------|
| `initiatePayment(hash, amount, phone, region, provider)` | onlyRelayer, whenNotPaused | Start payment |
| `confirmPayment(paymentId)` | onlyRelayer | Confirm payment |
| `failPayment(paymentId, reason)` | onlyRelayer | Mark payment failed |
| `retryPayment(paymentId)` | onlyRelayer | Retry (max 3) |
| `batchInitiatePayments(hashes, amounts, phones, region, providers)` | onlyRelayer, whenNotPaused | Batch initiate |
| `batchConfirmPayments(paymentIds, transactionRefs)` | onlyRelayer | Batch confirm |
| `expireStalePayments(paymentIds)` | onlyRelayer | Expire timed-out payments |

### 6.5 Duplicate Prevention (H8-MMP Fix)

`initiatePayment()` rejects duplicate payment initiation for the same `beneficiaryHash` + `eventId` combination.

---

## 7. KYCAMLCompliance

**File:** `contracts/KYCAMLCompliance.sol` (~490 lines)  
**Type:** Standard (Non-Upgradeable)  
**Inheritance:** `IKYCAMLCompliance → Ownable2Step`

### 7.1 Enums

**VerificationStatus**: NOT_VERIFIED(0), PENDING(1), VERIFIED(2), REJECTED(3), EXPIRED(4), SUSPENDED(5)

**RiskLevel**: LOW(0), MEDIUM(1), HIGH(2), SANCTIONED(3)

### 7.1b Struct — ComplianceAttestation (8 fields)

| Field | Type | Description |
|-------|------|-------------|
| identityHash | bytes32 | Hash of identity document |
| documentHash | bytes32 | Hash of supporting document |
| status | VerificationStatus | Current verification status |
| riskLevel | RiskLevel | AML risk classification |
| verifiedAt | uint256 | Timestamp of approval |
| expiresAt | uint256 | Expiry timestamp |
| verifiedBy | address | Officer who approved (H-4 fix) |
| submittedBy | address | Officer who submitted — enforces 4-eyes: `approveAttestation()` reverts with `SelfApprovalNotAllowed` if `msg.sender == submittedBy` (H-4 fix) |
| region | string | Geographic region |

### 7.2 Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| defaultValidityPeriod | 365 days | Attestation validity |
| maxValidityPeriod | 730 days | Maximum validity |
| fraudThreshold | 3 alerts | Auto-suspension threshold |

### 7.3 Key Functions

| Function | Access | Description |
|----------|--------|-------------|
| `submitAttestation(beneficiaryHash, identityHash, documentHash, region)` | onlyComplianceOfficer | Submit KYC attestation |
| `approveAttestation(beneficiaryHash, riskLevel, validityPeriod)` | onlyComplianceOfficer | Approve attestation |
| `rejectAttestation(beneficiaryHash, reason)` | onlyComplianceOfficer | Reject attestation |
| `recordScreening(beneficiaryHash, result)` | onlyComplianceOfficer | Record AML screening |
| `suspendBeneficiary(beneficiaryHash, reason)` | onlyComplianceOfficer | Suspend beneficiary |
| `reinstateBeneficiary(beneficiaryHash)` | onlyComplianceOfficer | Reinstate (C-03 fix) |
| `raiseFraudAlert(beneficiaryHash, alertType)` | onlyComplianceOfficer | Raise fraud alert |
| `isCompliant(hash)` | view | Single compliance check |
| `batchCheckCompliance(hashes)` | view | Batch compliance check |

### 7.4 Key Behaviors

- **Auto-suspension:** Only `SANCTIONED` status triggers automatic suspension (NOT `HIGH` risk level)
- **Reinstatement (C-03 fix):** `reinstateBeneficiary()` restores the **previous status** stored in `statusBeforeSuspension[hash]`, not a default APPROVED
- **Compliance check:** `isCompliant()` and `batchCheckCompliance()` require VERIFIED status AND non-expired attestation
- **Fraud threshold:** After 3 fraud alerts (`fraudThreshold`), beneficiary is automatically suspended
- **4-eyes principle (H-4 fix):** `approveAttestation()` reverts `SelfApprovalNotAllowed` if the approver is the same address that submitted the attestation. Enforces mandatory dual-officer sign-off.

### 7.5 Custom Errors

`NotComplianceOfficer`, `AttestationNotFound`, `AttestationAlreadyExists`, `InvalidAttestationStatus`, `BeneficiaryNotSuspended`, `SelfApprovalNotAllowed` *(H-4 fix — 4-eyes enforcement)*

---

## 8. WASDIOracleConnector

**File:** `contracts/WASDIOracleConnector.sol` (~510 lines)  
**Type:** Standard (Non-Upgradeable)  
**Inheritance:** `IWASDIOracle → Ownable2Step → Pausable → ReentrancyGuard`

### 8.1 Constants

| Constant | Value | Description |
|----------|-------|-------------|
| MAX_RISK_SCORE | 100 | Maximum risk score |
| MAX_RAINFALL | 2,000 mm | Maximum rainfall |
| MAX_SOIL_MOISTURE | 100% | Maximum soil moisture |
| MAX_WATER_LEVEL | 10,000 cm | Maximum water level |
| MIN_FRESHNESS | 30 minutes | Minimum freshness threshold |
| MAX_FRESHNESS | 7 days | Maximum freshness threshold |
| MAX_HISTORY_ENTRIES | 100 | Max history per region |
| ANOMALY_THRESHOLD | 40 | Risk score for anomaly detection |

### 8.2 Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| _freshnessThreshold | 6 hours | Data freshness window |
| testMode | false | Enable simulation functions |
| productionLocked | false | Irreversible production lock (H-06 fix) |

### 8.3 Key Functions

| Function | Access | Description |
|----------|--------|-------------|
| `submitSatelliteData(region, risk, rainfall, soil, water, source)` | onlyRelayer, whenNotPaused | Submit satellite data |
| `getLatestData(region)` | view | Get latest satellite data |
| `getRiskScore(region)` | view | Get latest risk score |
| `isDataFresh(region)` | view | Check data freshness |
| `getHistoricalData(region, startIndex, count)` | view | Get history |
| `getAverageRisk(region, count)` | view | Average risk score |
| `hasRecentAnomaly(region)` | view | Check for recent anomalies |
| `simulateHighRisk(region)` | onlyRelayer | Simulate high risk (test only) |
| `simulateLowRisk(region)` | onlyRelayer | Simulate low risk (test only) |
| `lockProductionMode()` | onlyOwner | Irreversible production lock |

### 8.4 Production Lock (H-06 Fix)

`lockProductionMode()` irreversibly disables test mode and simulation functions. Once called, `testMode` cannot be re-enabled, preventing accidental use of simulation functions in production.

### 8.5 Satellite Sources

Sentinel-1 (SAR), Sentinel-2 (optical), MODIS (thermal/vegetation), Landsat-8 (multispectral), Landsat-9 (multispectral), VIIRS (nighttime lights)

---

## 9. FloodPredictionLib

**File:** `contracts/libs/FloodPredictionLib.sol` (~111 lines)  
**Type:** Library

### 9.1 Functions

| Function | Visibility | Description |
|----------|------------|-------------|
| `uint2str(uint256)` | internal pure | Convert uint to string |
| `generateEventId(region, timestamp, chainId, nonce)` | internal pure | Generate unique event ID |
| `hashBeneficiary(phoneHash, region, amount)` | internal pure | Hash beneficiary ID with abi.encode |
| `calculateCooldown(riskScore, threshold)` | internal pure | Adaptive cooldown by risk level (V-06: dynamic threshold) |
| `isValidRiskScore(score)` | internal pure | Validate 0 ≤ score ≤ 100 |

### 9.2 Hash Function (H-11 Fix)

```solidity
function hashBeneficiary(bytes32 phoneHash, string memory region, uint256 amount) internal pure returns (bytes32) {
    return keccak256(abi.encode(phoneHash, region, amount));
}
```

Uses `abi.encode` instead of `abi.encodePacked` to prevent hash collision attacks with variable-length inputs.

### 9.3 Cooldown Calculation

| Risk Score | Cooldown Duration |
|------------|------------------|
| ≥ threshold+15 (CRITICAL) | 10 minutes |
| ≥ threshold (HIGH) | 30 minutes |
| < threshold (LOW/NORMAL) | 1 hour |

---

## 10. Interfaces

### 10.1 Interface Summary

| Interface | File | Enums | Structs | Functions | Events |
|-----------|------|-------|---------|-----------|--------|
| IFloodPrediction | interfaces/IFloodPrediction.sol | 2 | 2 | 21 | 4 |
| IMultiOracle | interfaces/IMultiOracle.sol | 0 | 3 | 10 | 7 |
| IOpalGovernance | interfaces/IOpalGovernance.sol | 2 | 2 | 13 | 8 |
| IJokalanteTargeting | interfaces/IJokalanteTargeting.sol | 0 | 1 | 9 | 5 |
| IMobileMoneyProvider | interfaces/IMobileMoneyProvider.sol | 1 | 1 | 10 | 7 |
| IKYCAMLCompliance | interfaces/IKYCAMLCompliance.sol | 2 | 2 | 9 | 8 |
| IWASDIOracle | interfaces/IWASDIOracle.sol | 0 | 1 | 7 | 3 |

### 10.2 Design Principles

- Enums and structs defined in interfaces (shared types)
- Implementation-specific functions (e.g., `markVerified`) NOT exposed in interfaces
- All public/external functions have corresponding interface declarations
- Events declared in interfaces for consistent ABI generation

---

## 11. Mock Contracts

### 11.1 MockBeneficiaryRegistry (~330 lines)

Test utility for beneficiary registration with preset scenarios:
- **Thiès scenario:** 5 beneficiaries, 25,000-50,000 FCFA
- **Saint-Louis scenario:** 5 beneficiaries, 25,000-45,000 FCFA
- **Kaffrine scenario:** 3 beneficiaries, 20,000 FCFA each

Functions: `registerBeneficiary`, `batchRegisterBeneficiaries`, `computeLeaf`, `computeRegionLeaves`, `loadScenarioThies`, `loadScenarioSaintLouis`, `loadScenarioKaffrine`

### 11.2 MockMobileMoneyProvider (~300 lines)

Test double implementing `IMobileMoneyProvider` with configurable behavior:
- `autoConfirm` — automatically confirm payments
- `autoFail` — automatically fail payments
- `forceRevert` — revert all operations
- Tracks `paymentHistory`, `batchCallCount`, `lastBatchSize`

### 11.3 MockWASDIOracle (~190 lines)

Test double implementing `IWASDIOracle`, inherits `Ownable2Step`:
- `simulateHighRisk(region)` — risk=85, rainfall=120mm, soilMoisture=95%
- `simulateLowRisk(region)` — risk=15, rainfall=10mm
- `simulateCustom(region, risk, rainfall, soil, water, source)`
- `DATA_FRESHNESS_THRESHOLD = 1 hour`

---

*Total: 8 contracts + 1 library + 7 interfaces + 3 mocks = 19 Solidity files*
*Verified against codebase — Solidity ^0.8.22, OpenZeppelin ^5.4.0, 339/339 tests passing*

---

## Appendix A — Audit Round 2 Changes (Avril 2026)

| Fix ID | Contract | Change |
|--------|----------|--------|
| C-1 | FloodPredictionContract | KYC check changed from global revert to per-beneficiary skip; `KYCBeneficiarySkipped` event added |
| C-2 | FloodPredictionContract | `budgetRegions.push()` guarded by `lastUpdated == 0` sentinel to prevent duplicate entries |
| H-1 | FloodPredictionContract + JokalanteTargeting | FPC now calls `IJokalanteTargeting.verifyBeneficiary()` and `markVerified()` on-chain when configured |
| H-2 | OpalGovernanceUpgradeable + IOpalGovernance | `Proposal` struct gains `target address` field (13 fields); `createProposal()` signature updated; execution routes to `proposal.target` when non-zero |
| H-3 | FloodPredictionContract | `oracleTolerance` state variable (default 0) allows ±delta between submitted `riskScore` and oracle consensus; `setOracleTolerance()` function added; `OracleToleranceUpdated` event added; `__gap` reduced from 49 to 48 |
| H-4 | KYCAMLCompliance + IKYCAMLCompliance | `ComplianceAttestation` gains `submittedBy address` field; `approveAttestation()` reverts `SelfApprovalNotAllowed` when approver == submitter |
