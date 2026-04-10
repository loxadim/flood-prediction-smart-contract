# Deliverable Verification Report

**Project**: DPA Foundation OPAL — Flood Prediction Smart Contracts   
**Scope**: Cross-verification of 8 documentation deliverables against actual smart contract source code  
**Status**: ✅ ALL DISCREPANCIES RESOLVED (3 verification rounds)

---

## 1. Verification Methodology

1. **Source of truth**: Direct reads of all 7 contracts, 1 library, 7 interfaces (Solidity source files)
2. **Automated counts**: `grep -c` used for function/event/enum/struct counts across all interface files
3. **Cross-reference**: Each deliverable section compared field-by-field against source code
4. **Test confirmation**: 339/339 tests passing (30s) — code integrity confirmed

---

## 2. Files Verified

| # | Deliverable | Lines | Status |
|---|-------------|-------|--------|
| 1 | BLOCKCHAIN_USE_CASE_ASSESSMENT.md | 388 | ✅ 5 fixes applied (rounds 1–3) + date mis à jour (round 3) |
| 2 | BLOCKCHAIN_ARCHITECTURE_DESIGN.md | 882 | ✅ 7 fixes (rounds 1–2) + 4 fixes Audit Round 2 (round 3) + 1 fix (round 4) |
| 3 | SMART_CONTRACT_SPECIFICATIONS.md | 670+ | ✅ 47 fixes (rounds 1–2) + 12 fixes Audit Round 2 (round 3) |
| 4 | SMART_CONTRACT_TEST_RESULTS.md | 492 | ✅ 13 fixes (round 2) + date mis à jour (round 3) |
| 5 | SECURITY_COMPLIANCE_ASSESSMENT.md | 580+ | ✅ 3 fixes + section Audit Round 2 + score 93→96/100 (round 3) + 1 fix H-11 (round 4) |
| 6 | OPAL_INTEGRATION_PLAN.md | 734 | ✅ 7 fixes (round 3) + date mis à jour |
| 7 | PILOT_DEPLOYMENT_REPORT.md | 444 | ✅ 5 fixes (round 3) + wallet réel + statut déploiement + 1 fix Step 7 (round 4) |
| 8 | TECHNICAL_DOCUMENTATION.md | 1,316 | ✅ 9 fixes + date mis à jour (round 3) |

**Total fixes applied**: 25 (round 1) + 54 (round 2) + 28+ (round 3) + 3 (round 4) = **110+ corrections** across all documents

---

## 3. Discrepancies Found & Fixed

### 3.1 SMART_CONTRACT_SPECIFICATIONS.md (12 fixes)

| # | Section | Issue | Fix Applied |
|---|---------|-------|-------------|
| 1 | 2.2 | TriggerStatus enum: had `NONE, ACTIVE, VALIDATED, PAID, CANCELLED, EXPIRED, PARTIALLY_PAID` | Changed to `INACTIVE, PENDING, ACTIVE, VALIDATED, PAID, EXPIRED, CANCELLED` |
| 2 | 2.2 | RiskLevel enum: `NORMAL` | Changed to `MODERATE` |
| 3 | 2.3 | FloodTrigger struct: wrong field names (eventId bytes32, paidAmount, paidBeneficiaries, createdBy, metadata) | Rewritten to match code (eventId string, validatedAt, paidAt, triggeredBy, chainId) — 14 fields |
| 4 | 2.3 | BudgetAllocation struct: field names (totalBudget, spentBudget) and order wrong | Changed to `allocatedAmount`, `spentAmount`, correct field order |
| 5 | 2.4 | State variable types: `mapping(bytes32 =>)`, nested payment mapping, interface types | Changed to `mapping(string =>)`, single mapping, `address` types |
| 6 | 6.2 | PaymentStatus enum: started with `NONE(0)`, missing `CANCELLED` | Changed to `PENDING, CONFIRMED, FAILED, EXPIRED, CANCELLED` |
| 7 | 7.1 | VerificationStatus: `NONE, APPROVED`; RiskLevel: `CRITICAL` | Changed to `NOT_VERIFIED, VERIFIED`; `SANCTIONED` |
| 8 | 7.4 | Text said "APPROVED status" | Changed to "VERIFIED status" |
| 9 | 9.1–9.2 | hashBeneficiary signature: `(string memory externalId)` | Changed to `(bytes32 phoneHash, string memory region, uint256 amount)` |
| 10 | 10.1 | Interface function counts all wrong (e.g., IFloodPrediction: 4 → 21) | Updated all 7 interfaces to verified counts |
| 11 | 6.4 | `expireStalePayments` access: "anyone" | Changed to `onlyRelayer` |
| 12 | 2.4 | Contract address storage: interface types | Changed to `address` types |

### 3.2 TECHNICAL_DOCUMENTATION.md (9 fixes)

| # | Section | Issue | Fix Applied |
|---|---------|-------|-------------|
| 1 | 3.2 | OpalGovernanceUpgradeable listed as "AccessControlUpgradeable" | Changed to `Ownable2StepUpgradeable` |
| 2 | 3.3 | `hashBeneficiary(address)` | Changed to `hashBeneficiary(bytes32 phoneHash, string region, uint256 amount)` |
| 3 | 4.1 | ADMIN_ROLE hash: `DEFAULT_ADMIN_ROLE` | Changed to `keccak256("ADMIN_ROLE")` |
| 4 | 4.2 | Constants: `MIN_PAYMENT`, `MAX_PAYMENT` | Changed to `MIN_PAYMENT_AMOUNT`, `MAX_PAYMENT_AMOUNT` |
| 5 | 4.4 | PaymentRecord struct fields: `timestamp`, `phoneNumber`, `paid` | Changed to `paidAt`, `eventId` (string), `verified` |
| 6 | 6 | Section header: "AccessControlUpgradeable" | Changed to `Ownable2StepUpgradeable` |
| 7 | 8.2 | Constants: `MAX_PAYMENT`, `MIN_PAYMENT` | Changed to `MAX_PAYMENT_AMOUNT`, `MIN_PAYMENT_AMOUNT` |
| 8 | 10.2 | `MAX_RISK` constant | Changed to `MAX_RISK_SCORE` |
| 9 | 10.2 | `DATA_FRESHNESS` constant | Changed to `_freshnessThreshold` (state variable, configurable) |

### 3.3 SECURITY_COMPLIANCE_ASSESSMENT.md (3 fixes)

| # | Section | Issue | Fix Applied |
|---|---------|-------|-------------|
| 1 | 6.6 | `MIN_PAYMENT = 500`, `MAX_PAYMENT = 5,000,000` | Changed to `MIN_PAYMENT_AMOUNT`, `MAX_PAYMENT_AMOUNT` |
| 2 | 8.1 | Payment limits row: `MAX_PAYMENT` | Changed to `MAX_PAYMENT_AMOUNT` |
| 3 | 8.2 | KYC flow diagram: `submitAttestation(beneficiaryHash, riskLevel)` — wrong params, conflated with approveAttestation | Split into 2-step flow: `submitAttestation(beneficiaryHash, identityHash, documentHash, region)` → `approveAttestation(beneficiaryHash, riskLevel, validityPeriod)` |

### 3.4 BLOCKCHAIN_ARCHITECTURE_DESIGN.md (1 fix — round 1)

| # | Section | Issue | Fix Applied |
|---|---------|-------|-------------|
| 1 | 2.3 | Interface function counts all wrong (same as SPECS §10.1) | Updated all 7 interfaces to verified counts |

---

## 3b. Round 2 — Additional Discrepancies Found & Fixed (July 2025)

A second verification pass identified **54 additional discrepancies** missed in round 1.

### 3b.1 SMART_CONTRACT_SPECIFICATIONS.md (35 additional fixes)

| # | Section | Issue | Fix Applied |
|---|---------|-------|-------------|
| 1 | §2.3 | PaymentRecord.eventId type: `bytes32` | Changed to `string` |
| 2 | §2.4 | triggerPaidCount mapping key: `bytes32` | Changed to `string` |
| 3 | §2.4 | triggerSpentAmount mapping key: `bytes32` | Changed to `string` |
| 4 | §2.5 | `cancelTrigger(eventId)` missing param | Changed to `cancelTrigger(eventId, reason)` |
| 5 | §2.5 | `setRegionEmergency(region, active, reason)` wrong params | Changed to `setRegionEmergency(region, status)` |
| 6 | §2.5 | `getCooldownRemaining(region)` missing param | Changed to `getCooldownRemaining(region, riskScore)` |
| 7 | §2.5 | `validateAndProcessPayments` missing 5th param | Added `phoneHashes` parameter (bytes32[]) |
| 8 | §2.5 | `processBatchPayment` missing 5th param | Added `phoneHashes` parameter (bytes32[]) |
| 9 | §2.6 | FloodTriggerCreated params: `riskLevel, totalAmount, beneficiaryCount` | Changed to `timestamp, triggeredBy` |
| 10 | §2.6 | BudgetAllocated params: `amount, totalBudget` | Changed to `amount, allocatedBy` |
| 11 | §2.6 | BudgetSpent params: `amount, remainingBudget` | Changed to `amount, eventId` |
| 12 | §2.6 | RegionEmergencySet params: `active, reason` | Changed to `status, setBy` |
| 13 | §2.6 | ContractAddressUpdated params: `contractName, newAddress` | Changed to `contractName, oldAddress, newAddress` |
| 14 | §2.6 | GovernanceOverride params: `eventId, region, riskScore` | Changed to `eventId, governor, reason` |
| 15 | §2.6 | MobileMoneyPaymentsInitiated params: `eventId, count` | Changed to `eventId, count, totalAmount` |
| 16 | §2.6 | MobileMoneyPaymentsFailed params: `eventId, reason` | Changed to `eventId, count, totalAmount` |
| 17 | §2.6 | BudgetDeactivated params: `region` | Changed to `region, operator` |
| 18 | §2.6 | BudgetCommitted params: `region, amount` | Changed to `region, amount, eventId` |
| 19 | §2.6 | BudgetCommitmentReleased params: `region, amount` | Changed to `region, amount, eventId` |
| 20 | §3.2 | ConsensusResult fields: `medianRiskScore, submissionCount, isReached, round` | Changed to `consensusRiskScore, participantCount, reached, region` |
| 21 | §3.6 | Event name: `OracleReputationUpdated` | Changed to `ReputationUpdated` |
| 22 | §4.2 | ProposalStatus: `NONE, PENDING, EXECUTED, REJECTED, EXPIRED` | Changed to `PENDING, APPROVED, EXECUTED, REJECTED, EXPIRED` |
| 23 | §4.2 | ProposalType: `PARAMETER_CHANGE, EMERGENCY_TRIGGER, FUND_RELEASE, CONTRACT_UPGRADE, CUSTOM` | Changed to `EMERGENCY_TRIGGER, PARAMETER_CHANGE, BUDGET_ALLOCATION, UPGRADE, ORACLE_OVERRIDE` |
| 24 | §4.3 | Proposal struct: `callData, targetContract, metadata` | Changed to `data, requiredSignatures, region` |
| 25 | §4.4 | createProposal params: `type, description, callData, target, metadata` | Changed to `type, description, data, region` |
| 26 | §4.6 | Selector whitelist text: `callData` | Changed to `data` |
| 27 | §7.3 | submitAttestation params: `hash, docHash` | Changed to `beneficiaryHash, identityHash, documentHash, region` |
| 28 | §7.3 | approveAttestation params: `hash, riskLevel, notes` | Changed to `beneficiaryHash, riskLevel, validityPeriod` |
| 29 | §7.3 | rejectAttestation params: `hash, notes` | Changed to `beneficiaryHash, reason` |
| 30 | §7.3 | recordScreening params: `hash, passed, notes` | Changed to `beneficiaryHash, result` |
| 31 | §7.3 | suspendBeneficiary params: `hash` | Changed to `beneficiaryHash` |
| 32 | §7.3 | reinstateBeneficiary params: `hash, notes` | Changed to `beneficiaryHash` (no notes) |
| 33 | §7.3 | raiseFraudAlert params: `hash, notes` | Changed to `beneficiaryHash, alertType` |
| 34 | §10.1 | IOpalGovernance functions: 12 | Changed to 13 |
| 35 | §10.1 | IMobileMoneyProvider events: 6 | Changed to 7 |

Line count corrections also applied: OpalGovernance ~530→~490, JokalanteTargeting ~280→~320, MobileMoneyProvider ~650→~620, KYCAMLCompliance ~500→~490, WASDIOracleConnector ~500→~480, FloodPredictionLib ~120→~108.

### 3b.2 SMART_CONTRACT_TEST_RESULTS.md (13 fixes)

Per-file test counts were inflated (sum 450 vs actual 339). Corrected:

| Test File | Was | Actual |
|-----------|-----|--------|
| FloodPrediction.test.js | 78 | 55 |
| MultiOracle.test.js | 69 | 55 |
| OpalGovernance.test.js | 56 | 41 |
| MobileMoneyProvider.test.js | 63 | 39 |
| WASDIOracleConnector.test.js | 58 | 42 |
| JokalanteTargeting.test.js | 48 | 36 |
| SecurityFixes.test.js | 24 | 17 |

Also corrected: pie chart data, section headers (§4.1–§4.6).

### 3b.3 BLOCKCHAIN_ARCHITECTURE_DESIGN.md (6 line count fixes)

| Contract | Was | Actual |
|----------|-----|--------|
| OpalGovernanceUpgradeable | ~530 | ~490 |
| JokalanteTargeting | ~280 | ~320 |
| MobileMoneyProvider | ~650 | ~620 |
| KYCAMLCompliance | ~500 | ~490 |
| WASDIOracleConnector | ~500 | ~480 |
| FloodPredictionLib | ~120 | ~108 |

---

---

## 3c. Round 3 — Audit Round 2 Fixes (Avril 2026)

Suite à l'audit de sécurité Round 2 (Avril 2026), **6 findings critiques/hauts** ont été corrigés dans le code source. Les documents ont été mis à jour pour refléter ces changements.

### 3c.1 SMART_CONTRACT_SPECIFICATIONS.md (12 mises à jour)

| # | Section | Changement |
|---|---------|------------|
| 1 | En-tête | Date : July 2025 → Mars 2026 |
| 2 | §2.4 State Variables | Ajout `oracleTolerance uint256` (fix H-3) |
| 3 | §2.4 State Variables | `__gap uint256[49]` → `uint256[48]` (fix H-3 : slot consommé par oracleTolerance) |
| 4 | §2.5 Functions | Ajout `setOracleTolerance(newTolerance)` — ADMIN_ROLE, plage 0–10 (fix H-3) |
| 5 | §2.6 Events | Ajout `KYCBeneficiarySkipped(eventId indexed, beneficiaryHash)` (fix C-1) |
| 6 | §2.6 Events | Ajout `OracleToleranceUpdated(oldTolerance, newTolerance)` (fix H-3) |
| 7 | §4.3 Structs | Proposal : 12 → **13 champs** — ajout `target address` (fix H-2) |
| 8 | §4.4 Functions | `createProposal()` : ajout paramètre `target address` (fix H-2) |
| 9 | §5 JokalanteTargeting | Nouveau §5.4 : intégration on-chain FPC↔JKT via `verifyBeneficiary()` + `markVerified()` (fix H-1) |
| 10 | §7.1b KYCAMLCompliance | Nouveau struct `ComplianceAttestation` documenté avec champ `submittedBy address` (fix H-4) |
| 11 | §7.4 Key Behaviors | Ajout règle 4-yeux : `SelfApprovalNotAllowed` si approver == submitter (fix H-4) |
| 12 | Appendice A | Tableau récapitulatif des 6 fixes Audit Round 2 (C-1, C-2, H-1, H-2, H-3, H-4) |

### 3c.2 BLOCKCHAIN_ARCHITECTURE_DESIGN.md (4 mises à jour)

| # | Section | Changement |
|---|---------|------------|
| 1 | En-tête | Date : July 2025 → Mars 2026 |
| 2 | §1.1 Notes architecturales | Correction : JokalanteTargeting **est** appelé on-chain par FPC (était : "n'est PAS appelé") — fix H-1 |
| 3 | §1.2 Hub-and-Spoke diagram | JKT ajouté comme spoke actif ; note de rectification ⚠️ |
| 4 | §2.1 Contract Registry | `__gap[49]` → `__gap[48]` pour FloodPredictionContract |
| 5 | §7.6 (nouveau) | Section "Explicit Execution Target (H-2 Fix)" documentée |
| 6 | §11.1 Integration Points | FPC↔JKT ajouté ; GOV→target mis à jour avec note H-2 |

### 3c.3 BLOCKCHAIN_USE_CASE_ASSESSMENT.md (1 mise à jour)

| # | Section | Changement |
|---|---------|------------|
| 1 | En-tête | Date : July 2025 → Mars 2026 |

### 3c.4 SECURITY_COMPLIANCE_ASSESSMENT.md (mise à jour pré-existante Round 3)

| # | Section | Changement |
|---|---------|------------|
| 1 | Score global | 93/100 → **96/100** |
| 2 | §5.2b (nouveau) | Section complète "Findings Round 2 — Audit Avril 2026" avec les 6 findings et statuts résolus |
| 3 | §8 Tableau de conformité | Colonne statuts mise à jour (C-1, C-2, H-1 à H-4 tous résolus) |

### 3c.5 Autres documents (dates mises à jour)

| Document | Ancienne date | Nouvelle date | Volet contrat |
|----------|--------------|---------------|---------------|
| SMART_CONTRACT_TEST_RESULTS.md | June 2025 | **Avril 2026** | Volet 4 |
| OPAL_INTEGRATION_PLAN.md | June 2025 | **Avril 2026** | Volet 6 |
| TECHNICAL_DOCUMENTATION.md | June 2025 | **Juin 2026** | Volet 8 |
| DELIVERABLE_VERIFICATION_REPORT.md | June 2025 | **Avril 2026** | Transversal |
| PILOT_DEPLOYMENT_REPORT.md | — | mis à jour | Volet 7 |

---

## 3d. Round 4 — Vérification diagrammes Mermaid (Avril 2026)

Un quatrième passage de vérification a porté exclusivement sur les **34 diagrammes Mermaid** répartis dans les 8 livrables. 3 anomalies ont été détectées et corrigées.

### 3d.1 BLOCKCHAIN_ARCHITECTURE_DESIGN.md (1 correction)

| # | Section | Problème | Correction |
|---|---------|----------|------------|
| 1 | §10.2 Deployment Architecture | Diagramme réseau : réseau `Arbitrum Sepolia (chainId: 421614)` présent dans `hardhat.config.js` mais absent du subgraph "Testnet" | Ajout du nœud `ARB_SEP[Arbitrum Sepolia - chainId 421614]` dans le subgraph Testnet |

### 3d.2 PILOT_DEPLOYMENT_REPORT.md (1 correction)

| # | Section | Problème | Correction |
|---|---------|----------|------------|
| 1 | §4.1 Deployment Order | Numérotation en doublon : nœuds D7 **et** D8 tous deux étiquetés "Step 7" (D7=`Step 7: Wire Addresses`, D8=`Step 7: FloodPrediction — UUPS`) | D7 renommé en `Spokes ready` (nœud de convergence sans numéro d'étape) ; D8 reste `Step 7: FloodPrediction — UUPS` |

### 3d.3 SECURITY_COMPLIANCE_ASSESSMENT.md (1 correction)

| # | Section | Problème | Correction |
|---|---------|----------|------------|
| 1 | §4 + §5.3 H-11 | Description H-11 trop générale : "All hashing uses abi.encode" — inexact car `generateEventId()` dans `FloodPredictionLib.sol` (lignes 56-67) utilise `abi.encodePacked` pour la concaténation de chaînes (non cryptographique), tandis que seules les fonctions de hachage cryptographique (`hashBeneficiary()`) utilisent `abi.encode` | Reformulé : "All cryptographic hashing uses abi.encode — generateEventId() uses abi.encodePacked for string formatting only (non-cryptographic)" |

---

## 4. Verified Ground Truth Reference

### 4.1 Interface Function/Event Counts (grep-verified)

| Interface | Enums | Structs | Functions | Events |
|-----------|-------|---------|-----------|--------|
| IFloodPrediction | 2 | 2 | 21 | 4 |
| IMultiOracle | 0 | 3 | 10 | 7 |
| IOpalGovernance | 2 | 2 | 13 | 8 |
| IJokalanteTargeting | 0 | 1 | 9 | 5 |
| IMobileMoneyProvider | 1 | 1 | 10 | 7 |
| IKYCAMLCompliance | 2 | 2 | 9 | 8 |
| IWASDIOracle | 0 | 1 | 7 | 3 |

### 4.2 Key Constants (source-verified)

| Constant | Contract | Value |
|----------|----------|-------|
| ADMIN_ROLE | FloodPredictionContract | `keccak256("ADMIN_ROLE")` |
| MIN_PAYMENT_AMOUNT | FloodPredictionContract | 500 |
| MAX_PAYMENT_AMOUNT | FloodPredictionContract | 5,000,000 |
| MAX_RISK_SCORE | WASDIOracleConnector | 100 |
| _freshnessThreshold | WASDIOracleConnector | 6 hours (state variable) |

### 4.3 Access Control Patterns

| Contract | Pattern |
|----------|---------|
| FloodPredictionContract | AccessControlUpgradeable (4 roles) |
| OpalGovernanceUpgradeable | Ownable2StepUpgradeable |
| MultiOracle | Ownable2Step |
| WASDIOracleConnector | Ownable2Step |
| JokalanteTargeting | Ownable2Step |
| MobileMoneyProvider | Ownable2Step + Pausable |
| KYCAMLCompliance | Ownable2Step |

### 4.4 Key Struct Fields

**PaymentRecord** (FloodPredictionContract-local):
`beneficiaryHash` (bytes32), `amount` (uint256), `paidAt` (uint256), `eventId` (string), `verified` (bool)

**hashBeneficiary** (FloodPredictionLib):
`hashBeneficiary(bytes32 phoneHash, string memory region, uint256 amount)` → `keccak256(abi.encode(phoneHash, region, amount))`

---

## 5. Test Confirmation

```
339 passing (30s)
```

All tests pass — code integrity confirmed. No documentation changes affected contract code.

---

## 6. Conclusion

All 8 deliverables have been cross-verified against the actual Solidity source code across **4 verification rounds**. A total of **110+ discrepancies** were identified and corrected:

**Round 1 (25 fixes):**
- **12** in SMART_CONTRACT_SPECIFICATIONS.md (enum values, struct fields, function counts, access modifiers)
- **9** in TECHNICAL_DOCUMENTATION.md (constant names, access control types, struct fields)
- **3** in SECURITY_COMPLIANCE_ASSESSMENT.md (constant names, KYC flow diagram)
- **1** in BLOCKCHAIN_ARCHITECTURE_DESIGN.md (interface function counts)

**Round 2 (54 fixes):**
- **35** in SMART_CONTRACT_SPECIFICATIONS.md (event parameters, function signatures, struct fields, enum values, mapping types, line counts, interface counts)
- **13** in SMART_CONTRACT_TEST_RESULTS.md (inflated per-file test counts, pie chart, section headers)
- **6** in BLOCKCHAIN_ARCHITECTURE_DESIGN.md (line count approximations)

All deliverables now accurately reflect the deployed smart contract code.

**Round 3 (28+ corrections — Avril 2026) :**
- **12** dans SMART_CONTRACT_SPECIFICATIONS.md (oracleTolerance, __gap, Proposal 13 champs, JKT §5.4, KYC §7.1b, SelfApprovalNotAllowed, Appendice A)
- **6** dans BLOCKCHAIN_ARCHITECTURE_DESIGN.md (note JKT corrigée, diagramme, __gap, §7.6, integration points)
- **6** dans SECURITY_COMPLIANCE_ASSESSMENT.md (score 93→96, section §5.2b Audit Round 2)
- **4** mises à jour de dates (SMART_CONTRACT_TEST_RESULTS, OPAL_INTEGRATION_PLAN, TECHNICAL_DOCUMENTATION, ce rapport)

**Round 4 (3 corrections — Avril 2026) :**
- **1** dans BLOCKCHAIN_ARCHITECTURE_DESIGN.md : diagramme réseau §10.2 — ajout `Arbitrum Sepolia (chainId: 421614)` dans le subgraph Testnet (présent dans hardhat.config.js ligne 708 mais absent du diagramme)
- **1** dans PILOT_DEPLOYMENT_REPORT.md : diagramme déploiement §4.1 — nœud D7 doublement étiqueté "Step 7" (même label que D8) — corrigé en `Spokes ready` (nœud de convergence sans numéro d'étape)
- **1** dans SECURITY_COMPLIANCE_ASSESSMENT.md : H-11 §4 et §5.3 — reformulation de "All hashing uses abi.encode" en "All cryptographic hashing uses abi.encode — generateEventId() uses abi.encodePacked for string formatting only (non-cryptographic)" pour refléter fidèlement FloodPredictionLib.sol lignes 56-67 vs 86

> **Score de fiabilité documentaire : 110+ corrections totales — tous livrables synchronisés avec le code source v4.0.0 post-audit.**
