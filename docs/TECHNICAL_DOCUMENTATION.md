# Documentation Technique Exhaustive — OPAL Platform

**Projet** : OPAL Platform — DPA Foundation
**Version** : 4.0.0
**Date** : Juin 2026
**Auteur** : Babacar LO — DPA Foundation
**Licence** : MIT
**Compilateur Solidity** : 0.8.28 (`pragma ^0.8.22`)
**Framework** : Hardhat 3.0.0
**Blockchain cible** : Polygon PoS (Mainnet / Amoy Testnet)
**Classification** : Documentation technique interne — Confidentiel

---

## Table des matires

1. [Resume executif](#1-resume-executif)
2. [Glossaire technique](#2-glossaire-technique)
3. [Architecture systeme](#3-architecture-systeme)
4. [Pile technologique](#4-pile-technologique)
5. [Contrat FloodPredictionContract](#5-contrat-floodpredictioncontract)
6. [Contrat MultiOracle](#6-contrat-multioracle)
7. [Contrat WASDIOracleConnector](#7-contrat-wasdioracleconnector)
8. [Contrat OpalGovernanceUpgradeable](#8-contrat-opalgovernanceupgradeable)
9. [Contrat JokalanteTargeting](#9-contrat-jokalantetargeting)
10. [Contrat MobileMoneyProvider](#10-contrat-mobilemoneyprovider)
11. [Contrat KYCAMLCompliance](#11-contrat-kycamlcompliance)
12. [Bibliotheque FloodPredictionLib](#12-bibliotheque-floodpredictionlib)
13. [Contrats Mock (tests)](#13-contrats-mock-tests)
14. [Interfaces](#14-interfaces)
15. [Machine a etats — Cycles de vie](#15-machine-a-etats--cycles-de-vie)
16. [Construction et verification Merkle](#16-construction-et-verification-merkle)
17. [Algorithme de consensus IQR](#17-algorithme-de-consensus-iqr)
18. [Schema commit-reveal](#18-schema-commit-reveal)
19. [Layout de stockage (Storage Layout)](#19-layout-de-stockage-storage-layout)
20. [Matrice de controle d'acces](#20-matrice-de-controle-dacces)
21. [Analyse de gas](#21-analyse-de-gas)
22. [Registre des correctifs de securite](#22-registre-des-correctifs-de-securite)
23. [Invariants de securite](#23-invariants-de-securite)
24. [Evenements et observabilite](#24-evenements-et-observabilite)
25. [Guide de deploiement](#25-guide-de-deploiement)
26. [Procedure de mise a jour (UUPS)](#26-procedure-de-mise-a-jour-uups)
27. [Configuration et environnement](#27-configuration-et-environnement)
28. [Suite de tests](#28-suite-de-tests)
29. [Workflow bout-en-bout](#29-workflow-bout-en-bout)
30. [Conformite reglementaire](#30-conformite-reglementaire)
31. [Procedures d'urgence](#31-procedures-durgence)
32. [Depannage](#32-depannage)
33. [Modules de formation](#33-modules-de-formation)
34. [Annexes](#34-annexes)

---

## 1. Resume executif

OPAL (Open Platform for African Livelihoods) est une plateforme blockchain de la DPA Foundation qui automatise l'assurance parametrique contre les inondations au Senegal et en Afrique de l'Ouest. Le systeme utilise des donnees satellitaires (WASDI) pour detecter les risques d'inondation, atteindre un consensus multi-oracle, declencher des paiements parametriques, et distribuer les fonds aux beneficiaires via Mobile Money (Orange Money, Wave, Free Money, E-Money).

### Objectifs du systeme

| Objectif | Mecanisme |
|----------|-----------|
| Detection automatique des inondations | Donnees satellitaires WASDI (Sentinel-1/2, MODIS, Landsat, VIIRS) |
| Consensus fiable | Multi-oracle avec detection IQR des valeurs aberrantes |
| Paiements parametriques | Declenchement automatique au seuil de risque >= 70% |
| Protection des donnees | Aucune PII on-chain (RGPD/NDPD) — hashes uniquement |
| Gouvernance decentralisee | Multi-signature avec quorum configurable |
| Distribution rapide | Integration Mobile Money en < 24h |
| Scalabilite | Paiements par lots de 50, testes jusqu'a 5 000 beneficiaires |
| Auditabilite | Trail d'audit immutable via evenements indexes |

### Chiffres cles

| Metrique | Valeur |
|----------|--------|
| Contrats principaux | 7 |
| Contrats mock | 3 |
| Interfaces | 7 |
| Bibliotheque utilitaire | 1 |
| Tests automatises | 512 |
| Fichiers de test | 17 |
| Scripts de deploiement | 7 |
| Correctifs de securite integres | 35+ |
| Storage gaps disponibles | 48 (FPC) + 47 (Gov) = 95 slots |

---

## 2. Glossaire technique

| Terme | Definition |
|-------|-----------|
| **FPC** | FloodPredictionContract — contrat orchestrateur principal |
| **UUPS** | Universal Upgradeable Proxy Standard (EIP-1822) — pattern de mise a jour |
| **IQR** | Interquartile Range — methode statistique de detection des valeurs aberrantes |
| **WASDI** | Web Advanced Space Developer Interface — plateforme de donnees satellitaires |
| **Merkle Tree** | Arbre de hachage pour verification d'appartenance a un ensemble |
| **RBAC** | Role-Based Access Control — controle d'acces base sur les roles |
| **CFA/FCFA** | Franc CFA — devise d'Afrique de l'Ouest (XOF) |
| **RGPD** | Reglement General sur la Protection des Donnees |
| **NDPD** | Loi senegalaise sur la protection des donnees personnelles |
| **BCEAO** | Banque Centrale des Etats de l'Afrique de l'Ouest |
| **PII** | Personally Identifiable Information |
| **EIP-1153** | Transient Storage — stockage ephemere par transaction (Cancun) |
| **EIP-170** | Limite de taille de contrat (24 576 octets) |
| **Commit-Reveal** | Schema en deux phases pour empecher le front-running |
| **Cooldown** | Delai minimum entre deux declenchements pour une meme region |
| **Parametric Insurance** | Assurance declenchee par un parametre mesurable (pas de reclamation) |
| **Relayer** | Service off-chain qui transmet les donnees entre systemes |
| **Jokalante** | Nom Wolof — systeme de ciblage des beneficiaires |
| **Storage Gap** | Slots reserves pour compatibilite de mise a jour |

---

## 3. Architecture systeme

### 3.1 Vue d'ensemble — Architecture Hub-and-Spoke

```
                     ┌──────────────────────────────┐
                     │    WASDI Satellite Platform   │
                     │  (Sentinel-1/2, MODIS, etc.) │
                     └──────────────┬───────────────┘
                                    │ API REST
                     ┌──────────────▼───────────────┐
                     │    WASDIOracleConnector       │
                     │    Ownable2Step | Pausable    │
                     │    ReentrancyGuard            │
                     │    6 sources satellite        │
                     │    Buffer circulaire (100)    │
                     │    Detection anomalies bidir. │
                     └──────────────┬───────────────┘
                                    │ submitData()
                     ┌──────────────▼───────────────┐
                     │        MultiOracle            │
                     │    Ownable2Step | Pausable     │
                     │    ReentrancyGuard            │
                     │    Max 10 oracles             │
                     │    Consensus IQR + Reputation │
                     │    Commit-Reveal              │
                     └──────────────┬───────────────┘
                                    │ getConsensusRiskScore()
┌──────────────────┐ ┌─────────────▼────────────────┐ ┌───────────────────┐
│  OpalGovernance  │ │  FloodPredictionContract (FPC)│ │ JokalanteTargeting│
│  Upgradeable     │ │  UUPS | AccessControl        │ │ Ownable2Step      │
│  UUPS Proxy      │─│  PausableUpgradeable         │─│ Merkle Trees      │
│  Multi-sig       │ │  ReentrancyGuardTransient    │ │ Privacy-preserving│
│  Quorum          │ │  RBAC 4 roles                │ │ 50K benef./region │
│  Timelock 1h     │ │  Budget mgmt (CFA)           │ │ Expiry 90 jours   │
└──────────────────┘ └──┬────────────────────────┬──┘ └───────────────────┘
                        │                        │
           ┌────────────▼────────┐    ┌──────────▼──────────┐
           │  MobileMoneyProvider│    │  KYCAMLCompliance    │
           │  Ownable2Step       │    │  Ownable2Step        │
           │  Pausable           │    │  4-eyes principle    │
           │  ReentrancyGuard    │    │  Sanctions screening │
           │  4 operateurs SN    │    │  RGPD-compliant      │
           │  Retry (max 3)      │    │  Hash-only on-chain  │
           └─────────────────────┘    └─────────────────────┘
```

### 3.2 Flux de donnees

```
Phase 1 — Collecte          Phase 2 — Consensus        Phase 3 — Declenchement
┌─────────┐                 ┌────────────┐              ┌──────────┐
│ Satellite│──relayer──────>│ WASDI      │──submit─────>│ Multi    │
│ Sentinel │                │ Connector  │              │ Oracle   │
│ MODIS    │                │ (validate  │              │ (IQR     │
│ Landsat  │                │  freshness │              │  median  │
│ VIIRS    │                │  anomaly)  │              │  repute) │
└─────────┘                 └────────────┘              └────┬─────┘
                                                             │ consensus >= 70%
Phase 4 — Paiement          Phase 5 — Distribution      ────▼─────────
┌──────────┐                ┌────────────┐              │    FPC       │
│ Jokalante│──verify───────>│ FPC        │──initiate───>│ (orchestrate)│
│ Targeting│  Merkle proof  │ (validate  │              └──────┬───────┘
└──────────┘                │  + pay)    │                     │
                            └────┬───────┘              ┌──────▼───────┐
                                 │                      │ MobileMoney  │
                            ┌────▼───────┐              │ Provider     │
                            │ KYC/AML    │              │ (OrangeMoney │
                            │ Compliance │──relay──────>│  Wave, Free  │
                            │ (graceful  │              │  E-Money)    │
                            │  skip)     │              └──────────────┘
                            └────────────┘
```

### 3.3 Matrice d'interaction inter-contrats

| Appelant (ligne) → Appele (colonne) | FPC | MultiOracle | WASDI | Governance | Jokalante | MobileMoney | KYC |
|--------------------------------------|-----|-------------|-------|------------|-----------|-------------|-----|
| **FloodPredictionContract** | — | `getConsensusRiskScore()` | — | — | `verifyBeneficiary()`, `markVerified()` | `batchInitiatePayments()` | `batchCheckCompliance()` |
| **MultiOracle** | — | — | — | — | — | — | — |
| **WASDIOracleConnector** | — | — | — | — | — | — | — |
| **OpalGovernance** | `createGovernanceOverrideTrigger()`, parametres | — | — | — | — | — | — |
| **JokalanteTargeting** | — | — | — | — | — | — | — |
| **MobileMoneyProvider** | — | — | — | — | — | — | — |
| **KYCAMLCompliance** | — | — | — | — | — | — | — |

### 3.4 Pattern de conception utilises

| Pattern | Contrat(s) | Raison |
|---------|-----------|--------|
| UUPS Proxy (EIP-1822) | FPC, OpalGovernance | Mises a jour sans redeploy |
| Hub-and-Spoke | FPC (hub) | Orchestration centralisee, modules decouples |
| Commit-Reveal | MultiOracle | Prevention du front-running entre oracles |
| Merkle Tree | JokalanteTargeting, FPC | Verification d'eligibilite O(log n) |
| Off-chain Relayer | MobileMoney, WASDI, KYC | Bridge blockchain ←→ systemes externes |
| Access Control (RBAC) | FPC | Separation des responsabilites (4 roles) |
| Ownable2Step | 5 contrats | Transfert de propriete securise (2 etapes) |
| Circuit Breaker | FPC (emergency), Pausable | Arret d'urgence |
| Nonce-based Replay Protection | FPC, MobileMoney | Prevention des rejeux cross-chain |
| Circular Buffer | WASDIOracleConnector | Historique borne a 100 entrees/region |
| Double Hash (V-01) | JokalanteTargeting | Prevention attaque second-preimage |
| Storage Gap | FPC (__gap[48]), Gov (__gap[47]) | Compatibilite de mise a jour future |

---

## 4. Pile technologique

### 4.1 Dependances de production

| Package | Version | Usage |
|---------|---------|-------|
| `@openzeppelin/contracts` | ^5.4.0 | Contrats de base (Ownable2Step, MerkleProof, etc.) |
| `@openzeppelin/contracts-upgradeable` | ^5.4.0 | Contrats upgradeables (AccessControlUpgradeable, UUPSUpgradeable) |

### 4.2 Dependances de developpement

| Package | Version | Usage |
|---------|---------|-------|
| `hardhat` | ^3.0.0 | Framework de developpement Solidity |
| `@nomicfoundation/hardhat-ethers` | ^4.0.0 | Integration ethers.js |
| `@nomicfoundation/hardhat-ethers-chai-matchers` | ^3.0.0 | Assertions Chai pour ethers |
| `@nomicfoundation/hardhat-verify` | ^3.0.0 | Verification sur explorateurs de blocs |
| `@openzeppelin/hardhat-upgrades` | 4.0.0-alpha.0 | Deploiement et mise a jour UUPS |
| `ethers` | ^6.14.0 | Interaction blockchain |
| `chai` | ^5.1.2 | Framework d'assertions pour tests |
| `mocha` | ^11.0.0 | Framework de tests |
| `merkletreejs` | ^0.6.0 | Construction d'arbres Merkle (tests) |
| `keccak256` | ^1.0.6 | Hachage Keccak-256 (tests) |
| `solhint` | ^6.1.0 | Linter Solidity |
| `dotenv` | ^17.3.1 | Variables d'environnement |

### 4.3 Configuration du compilateur

```javascript
// hardhat.config.js
solidity: {
  version: "0.8.28",
  settings: {
    optimizer: {
      enabled: true,
      runs: 200,         // Equilibre deploy/runtime gas
    },
    viaIR: true,         // Obligatoire pour conformite EIP-170 (taille < 24 576 octets)
  },
},
```

| Parametre | Valeur | Justification |
|-----------|--------|---------------|
| `version` | 0.8.28 | Derniere version stable, support Cancun (EIP-1153) |
| `optimizer.enabled` | true | Reduction du gas en production |
| `optimizer.runs` | 200 | Compromis : deploiement econome + execution optimisee |
| `viaIR` | true | Pipeline IR pour respecter la limite EIP-170 (24 576 octets) |
| `hardfork` | cancun | EIP-1153 transient storage pour `ReentrancyGuardTransient` |

### 4.4 Configuration reseau

| Reseau | Chain ID | Type | Gas Price | Usage |
|--------|----------|------|-----------|-------|
| hardhat | 1337 | edr-simulated | Auto | Tests locaux, CI/CD |
| localhost | 31337 | http | Auto | Developpement interactif |
| polygon | 137 | http | 50 gwei | **Production** |
| amoy | 80002 | http | Auto | Testnet principal |
| sepolia | 11155111 | http | Auto | Testnet Ethereum |
| arbitrumSepolia | 421614 | http | Auto | Testnet Arbitrum |
| arbitrum | 42161 | http | Auto | Mainnet Arbitrum |

---

## 5. Contrat FloodPredictionContract

**Fichier** : `contracts/FloodPredictionContract.sol`
**Interface** : `interfaces/IFloodPrediction.sol`
**Auteur** : Babacar LO
**Heritage** : `Initializable`, `AccessControlUpgradeable`, `UUPSUpgradeable`, `PausableUpgradeable`, `ReentrancyGuardTransient`, `IFloodPrediction`
**Pattern** : UUPS Proxy
**Conformite** : Volets 3-6

### 5.1 Responsabilite

Orchestrateur central du systeme OPAL. Recoit les scores de risque valides par le consensus multi-oracle, declenche les paiements parametriques lorsque les seuils sont atteints, verifie l'eligibilite des beneficiaires via arbres Merkle, et distribue les fonds via Mobile Money.

### 5.2 Roles RBAC

| Role | Identifiant | Permissions |
|------|------------|-------------|
| `ADMIN_ROLE` | `keccak256("ADMIN_ROLE")` | Administration complete : budget, configuration, urgence, adresses contrats, seuil de risque, tolerance oracle |
| `OPERATOR_ROLE` | `keccak256("OPERATOR_ROLE")` | Operations : creation de triggers, validation, traitement des paiements |
| `UPGRADER_ROLE` | `keccak256("UPGRADER_ROLE")` | Autorisation des mises a jour UUPS (`_authorizeUpgrade`) |
| `PAUSER_ROLE` | `keccak256("PAUSER_ROLE")` | Pause/reprise du contrat (`pause()`, `unpause()`) |

**Note** : Le deployer recoit `DEFAULT_ADMIN_ROLE` + `ADMIN_ROLE` a l'initialisation.

### 5.3 Constantes

| Constante | Valeur | Description |
|-----------|--------|-------------|
| `VERSION` | 3 | Version du contrat |
| `MAX_BATCH_SIZE` | 50 | Nombre maximum de beneficiaires par lot |
| `DEFAULT_RISK_THRESHOLD` | 70 | Seuil de risque standard (%) |
| `GOVERNANCE_RISK_THRESHOLD` | 85 | Constante historique exposee; le chemin override est admin-only et ne l'applique pas directement |
| `MAX_RISK_SCORE` | 100 | Score de risque maximum |
| `MIN_PAYMENT_AMOUNT` | 500 | Montant minimum par paiement (FCFA) |
| `MAX_PAYMENT_AMOUNT` | 5 000 000 | Montant maximum par paiement (FCFA) |
| `COOLDOWN_CRITICAL` | 10 minutes | Cooldown risque critique (>= seuil+15) |
| `COOLDOWN_HIGH` | 30 minutes | Cooldown risque eleve (>= seuil) |
| `COOLDOWN_NORMAL` | 1 heure | Cooldown risque normal |
| `MAX_REGION_LENGTH` | 20 | Longueur max code region (caracteres) |
| `MAX_STRING_LENGTH` | 500 | Longueur max chaines generales |

### 5.4 Enumerations

```solidity
enum TriggerStatus { INACTIVE, PENDING, ACTIVE, VALIDATED, PAID, EXPIRED, CANCELLED }
// INACTIVE(0) → PENDING(1) → ACTIVE(2) → VALIDATED(3) → PAID(4)
//                                                      → EXPIRED(5)
//                                                      → CANCELLED(6)

enum RiskLevel { LOW, MODERATE, HIGH, CRITICAL }
// LOW(0): riskScore < seuil
// MODERATE(1): usage interne
// HIGH(2): riskScore >= seuil
// CRITICAL(3): riskScore >= seuil + 15
```

### 5.5 Structures de donnees

```solidity
struct FloodTrigger {
    string eventId;              // Identifiant unique genere (FLOOD-{region}-{timestamp}-{chainId}-{nonce})
    string region;               // Code region (ex: "SN-TH" pour Thies)
    uint256 riskScore;           // Score de risque 0-100
    uint256 timestamp;           // Horodatage de creation
    uint256 validatedAt;         // Horodatage de validation
    uint256 paidAt;              // Horodatage du premier paiement
    TriggerStatus status;        // Statut actuel
    RiskLevel riskLevel;         // Niveau de risque categorise
    address triggeredBy;         // Adresse de l'operateur
    uint256 totalAmount;         // Montant total a distribuer (FCFA)
    uint256 beneficiaryCount;    // Nombre de beneficiaires
    bytes32 merkleRoot;          // Racine Merkle des beneficiaires
    bool isGovernanceOverride;   // true si cree par gouvernance
    uint256 chainId;             // Chain ID pour unicite cross-chain (M-01)
}

struct BudgetAllocation {
    string region;               // Code region
    uint256 allocatedAmount;     // Budget alloue (FCFA)
    uint256 spentAmount;         // Budget consomme (FCFA)
    uint256 lastUpdated;         // Derniere mise a jour
    bool isActive;               // Statut actif
}

struct PaymentRecord {
    bytes32 beneficiaryHash;     // Hash du beneficiaire
    uint256 amount;              // Montant paye (FCFA)
    uint256 paidAt;              // Horodatage du paiement
    string eventId;              // ID de l'evenement associe
    bool verified;               // Verifie via Merkle
}
```

### 5.6 Variables d'etat

| Variable | Type | Description |
|----------|------|-------------|
| `triggers` | `mapping(string => FloodTrigger)` | Triggers indexes par eventId |
| `triggerIds` | `string[]` | Liste ordonnee des IDs de triggers |
| `triggerCount` | `uint256` | Compteur de triggers crees |
| `budgets` | `mapping(string => BudgetAllocation)` | Budgets par region |
| `budgetRegions` | `string[]` | Liste des regions avec budget |
| `totalBudgetAllocated` | `uint256` | Total budgets alloues (FCFA) |
| `totalBudgetSpent` | `uint256` | Total depense (FCFA) |
| `paymentRecords` | `mapping(bytes32 => PaymentRecord)` | Enregistrements de paiement |
| `totalPaymentsProcessed` | `uint256` | Nombre total de paiements |
| `totalAmountDisbursed` | `uint256` | Montant total distribue |
| `triggerPaidCount` | `mapping(string => uint256)` | Beneficiaires payes par trigger (multi-batch) |
| `committedBudget` | `mapping(string => uint256)` | Budget engage (reserve, non depense) |
| `triggerSpentAmount` | `mapping(string => uint256)` | Montant reel depense par trigger |
| `regionNonces` | `mapping(string => uint256)` | Nonces par region (replay protection) |
| `globalNonce` | `uint256` | Nonce global |
| `lastTriggerTimestamp` | `mapping(string => uint256)` | Dernier declenchement par region (cooldown) |
| `riskThreshold` | `uint256` | Seuil de risque configurable (defaut 70) |
| `multiOracle` | `address` | Adresse du contrat MultiOracle |
| `governance` | `address` | Adresse du contrat de gouvernance |
| `jokalanteTargeting` | `address` | Adresse du contrat de ciblage |
| `mobileMoneyProvider` | `address` | Adresse du contrat Mobile Money |
| `kycCompliance` | `address` | Adresse du contrat KYC/AML |
| `emergencyMode` | `bool` | Mode urgence global |
| `regionEmergency` | `mapping(string => bool)` | Mode urgence par region |
| `oracleTolerance` | `uint256` | Tolerance oracle (H-03, defaut 0, max 10) |

### 5.7 Fonctions principales

#### 5.7.1 Initialisation

```solidity
function initialize(address admin) external initializer
```
- Initialise le proxy UUPS
- Attribue `DEFAULT_ADMIN_ROLE` et `ADMIN_ROLE` a `admin`
- Definit `riskThreshold = DEFAULT_RISK_THRESHOLD` (70)

#### 5.7.2 Gestion des triggers

```solidity
function createFloodTrigger(
    string calldata region,        // Code region <= 20 caracteres
    uint256 riskScore,             // Score 0-100, doit etre >= riskThreshold
    bytes32 merkleRoot,            // Racine Merkle des beneficiaires
    uint256 totalAmount,           // Montant total (FCFA)
    uint256 beneficiaryCount       // Nombre de beneficiaires
) external onlyRole(OPERATOR_ROLE) whenNotPaused returns (string memory eventId)
```

**Pre-conditions** :
1. `riskScore` dans [0, 100]
2. `riskScore >= riskThreshold` (defaut 70)
3. Cooldown ecoule pour la region (adaptatif selon le risque)
4. Pas en mode urgence (global ni regional)
5. Budget alloue et actif pour la region
6. Budget disponible (allocatedAmount - spentAmount - committedBudget) >= totalAmount
7. Score oracle concordant (si multiOracle configure) avec tolerance (H-03)

**Post-conditions** :
- Trigger cree avec statut `ACTIVE`
- Budget engage (committed) augmente de `totalAmount`
- Nonce region incremente
- Cooldown mis a jour
- Evenement `FloodTriggerCreated` emis

```solidity
function createGovernanceOverrideTrigger(
    string calldata region,
    uint256 riskScore,
    bytes32 merkleRoot,
    uint256 totalAmount,
    uint256 beneficiaryCount,
    string calldata reason
) external returns (string memory eventId)
```

- Appelable uniquement par l'adresse `governance`
- Contourne le seuil de risque standard (pas de verification >= 70%)
- Met a jour le `lastTriggerTimestamp` (M-08)
- Marque `isGovernanceOverride = true`
- Evenement `GovernanceOverride` emis

```solidity
function validateTrigger(string calldata eventId) external onlyRole(OPERATOR_ROLE)
```
- Valide un trigger `ACTIVE` → `VALIDATED`
- Pre-condition : trigger existe et statut == ACTIVE

```solidity
function cancelTrigger(string calldata eventId, string calldata reason) external onlyRole(ADMIN_ROLE)
```
- Annule un trigger `ACTIVE` ou `VALIDATED` → `CANCELLED`
- **L-03** : libere le budget engage (`committedBudget[region] -= totalAmount`)
- Evenement `TriggerCancelled` emis

#### 5.7.3 Traitement des paiements

```solidity
function validateAndProcessPayments(
    string calldata eventId,
    bytes32[] calldata beneficiaryHashes,
    uint256[] calldata amounts,
    bytes32[][] calldata merkleProofs,
    bytes32[] calldata phoneHashes,
    IMobileMoneyProvider.MobileProvider[] calldata providers
) external onlyRole(OPERATOR_ROLE) whenNotPaused nonReentrant
```

**Flux atomique (une seule transaction)** :
1. Valide le trigger (ACTIVE → VALIDATED)
2. Verifie chaque beneficiaire contre l'arbre Merkle
3. Controle de conformite KYC (graceful skip — C-01)
4. Initie les paiements Mobile Money en lot
5. Met a jour le statut du trigger selon completion

```solidity
function processBatchPayment(
    string calldata eventId,
    bytes32[] calldata beneficiaryHashes,
    uint256[] calldata amounts,
    bytes32[][] calldata merkleProofs,
    bytes32[] calldata phoneHashes
) external onlyRole(OPERATOR_ROLE) whenNotPaused nonReentrant
```

- Pour les lots subsequents (quand > 50 beneficiaires)
- Trigger doit etre VALIDATED ou PAID
- Incremente `triggerPaidCount[eventId]`
- Si tous les beneficiaires payes → statut PAID

**Verification de chaque beneficiaire** :
1. `beneficiaryHash` non deja paye pour ce trigger
2. `amount` dans [MIN_PAYMENT_AMOUNT, MAX_PAYMENT_AMOUNT]
3. Preuve Merkle valide (double hash, V-01)
4. KYC compliant (skip si echec, C-01 — emet `KYCBeneficiarySkipped`)
5. Si passe → initie paiement Mobile Money

#### 5.7.4 Gestion budgetaire

```solidity
function allocateBudget(string calldata region, uint256 amount) external onlyRole(ADMIN_ROLE)
```
- Alloue un budget pour une region
- Additionnel (s'ajoute a l'existant)
- Met a jour `totalBudgetAllocated`

```solidity
function deactivateBudget(string calldata region) external onlyRole(ADMIN_ROLE)
```
- Desactive le budget d'une region

#### 5.7.5 Mode urgence

```solidity
function activateEmergencyMode(string calldata reason) external onlyRole(ADMIN_ROLE)
function deactivateEmergencyMode() external onlyRole(ADMIN_ROLE)
function setRegionEmergency(string calldata region, bool status) external onlyRole(ADMIN_ROLE)
```

- Urgence globale : bloque TOUS les triggers et paiements
- Urgence regionale : bloque une region specifique
- Independants : urgence regionale peut exister sans urgence globale

#### 5.7.6 Configuration

```solidity
function setContractAddresses(
    address _multiOracle,
    address _governance,
    address _targeting,
    address _mobileMoney,
    address _kyc
) external onlyRole(ADMIN_ROLE)
```
- Connecte les contrats peripheriques
- `address(0)` autorise pour KYC (desactive la verification)

```solidity
function updateRiskThreshold(uint256 newThreshold) external onlyRole(ADMIN_ROLE)
```
- Modifie le seuil de risque (V-06)
- Contraint a [1, 100]

```solidity
function setOracleTolerance(uint256 newTolerance) external onlyRole(ADMIN_ROLE)
```
- Tolerance entre score soumis et consensus oracle (H-03)
- Contraint a [0, 10]

#### 5.7.7 Fonctions de lecture (paginees — M-02)

```solidity
function getFloodTrigger(string calldata eventId) external view returns (FloodTrigger memory)
function getRegionBudget(string calldata region) external view returns (BudgetAllocation memory)
function getRegionBudgetRemaining(string calldata region) external view returns (uint256)
function isBeneficiaryPaid(string calldata eventId, bytes32 beneficiaryHash) external view returns (bool)
function getCooldownRemaining(string calldata region, uint256 riskScore) external view returns (uint256)
function getTriggerIdsPaginated(uint256 offset, uint256 limit) external view returns (string[] memory, uint256)
function getBudgetRegionsPaginated(uint256 offset, uint256 limit) external view returns (string[] memory, uint256)
function getVersion() external pure returns (uint256)  // Retourne VERSION (3)
```

### 5.8 Evenements

| Evenement | Parametres | Declencheur |
|-----------|-----------|-------------|
| `FloodTriggerCreated` | `eventId` (indexed), `region`, `riskScore`, `timestamp`, `triggeredBy` | `createFloodTrigger()`, `createGovernanceOverrideTrigger()` |
| `TriggerValidated` | `eventId` (indexed), `validator`, `timestamp` | `validateTrigger()`, `validateAndProcessPayments()` |
| `BatchPaymentProcessed` | `eventId` (indexed), `beneficiaryCount`, `totalAmount`, `timestamp` | `processBatchPayment()`, `validateAndProcessPayments()` |
| `BudgetAllocated` | `region` (indexed), `amount`, `allocatedBy` | `allocateBudget()` |
| `TriggerCancelled` | `eventId` (indexed), `cancelledBy`, `reason` | `cancelTrigger()` |
| `SinglePaymentProcessed` | `eventId` (indexed), `beneficiaryHash`, `amount`, `timestamp` | Chaque paiement individuel |
| `BudgetSpent` | `region` (indexed), `amount`, `eventId` | Debit budgetaire |
| `EmergencyModeActivated` | `activatedBy`, `reason` | `activateEmergencyMode()` |
| `EmergencyModeDeactivated` | `deactivatedBy` | `deactivateEmergencyMode()` |
| `RegionEmergencySet` | `region` (indexed), `status`, `setBy` | `setRegionEmergency()` |
| `RiskThresholdUpdated` | `oldThreshold`, `newThreshold` | `updateRiskThreshold()` |
| `OracleToleranceUpdated` | `oldTolerance`, `newTolerance` | `setOracleTolerance()` |
| `ContractAddressUpdated` | `contractName`, `oldAddress`, `newAddress` | `setContractAddresses()` |
| `GovernanceOverride` | `eventId` (indexed), `governor`, `reason` | `createGovernanceOverrideTrigger()` |
| `MobileMoneyPaymentsInitiated` | `eventId` (indexed), `count`, `totalAmount` | Initiation lot MM |
| `MobileMoneyPaymentsFailed` | `eventId` (indexed), `count`, `totalAmount` | Echec lot MM |
| `BudgetDeactivated` | `region` (indexed), `operator` | `deactivateBudget()` |
| `BudgetCommitted` | `region` (indexed), `amount`, `eventId` | Budget engage |
| `BudgetCommitmentReleased` | `region` (indexed), `amount`, `eventId` | Budget libere (annulation) |
| `KYCBeneficiarySkipped` | `eventId` (indexed), `beneficiaryHash` | KYC echoue (C-01, skip) |

### 5.9 Erreurs personnalisees

| Erreur | Cause |
|--------|-------|
| `InvalidRiskScore()` | Score hors [0, 100] |
| `BelowRiskThreshold()` | Score < seuil configurable |
| `CooldownNotElapsed()` | Cooldown region pas encore ecoule |
| `TriggerNotFound()` | eventId inexistant |
| `TriggerNotActive()` | Trigger pas au statut requis |
| `TriggerAlreadyPaid()` | Tous beneficiaires deja payes |
| `InsufficientBudget()` | Budget region insuffisant |
| `InvalidBatchSize()` | Lot vide ou > MAX_BATCH_SIZE |
| `InvalidPaymentAmount()` | Montant hors [500, 5 000 000] |
| `BeneficiaryAlreadyPaid()` | Beneficiaire deja paye pour ce trigger |
| `InvalidMerkleProof()` | Preuve Merkle invalide |
| `EmergencyModeActive()` | Mode urgence actif |
| `NotInEmergencyMode()` | Tentative de desactivation sans mode urgence |
| `ArrayLengthMismatch()` | Tableaux de tailles differentes |
| `InvalidAddress()` | Adresse zero non autorisee |
| `RegionNotActive()` | Region sans budget actif |
| `TriggerNotCancellable()` | Statut ne permet pas l'annulation |
| `InvalidThreshold()` | Seuil hors [1, 100] |
| `StringTooLong()` | Chaine > MAX_STRING_LENGTH |
| `RegionStringTooLong()` | Region > MAX_REGION_LENGTH |
| `KYCCheckFailed()` | (reserve) |
| `InvalidBeneficiaryCount()` | Nombre beneficiaires invalide |
| `OracleRiskScoreMismatch()` | Ecart oracle > tolerance (H-03) |

---

## 6. Contrat MultiOracle

**Fichier** : `contracts/MultiOracle.sol`
**Interface** : `interfaces/IMultiOracle.sol`
**Heritage** : `IMultiOracle`, `Ownable2Step`, `ReentrancyGuard`, `Pausable`
**Pattern** : Standard (non-upgradeable)

### 6.1 Responsabilite

Moteur de consensus multi-oracle qui agrege les scores de risque de plusieurs sources independantes en utilisant la detection statistique IQR (Interquartile Range) pour filtrer les valeurs aberrantes. Integre un systeme de reputation et le schema commit-reveal contre le front-running.

### 6.2 Constantes

| Constante | Valeur | Description |
|-----------|--------|-------------|
| `MAX_ORACLES` | 10 | Nombre maximum d'oracles enregistrables |
| `MIN_ORACLE_COUNT` | 4 | Minimum d'oracles actifs pour consensus (I-03) |
| `MIN_RISK_SCORE` | 0 | Score minimum |
| `MAX_RISK_SCORE` | 100 | Score maximum |
| `MAX_REPUTATION` | 100 | Reputation maximale |
| `INITIAL_REPUTATION` | 50 | Reputation initiale |
| `REPUTATION_BONUS` | 2 | Bonus par soumission non-aberrante |
| `REPUTATION_PENALTY` | 10 | Penalite par soumission aberrante |
| `DEFAULT_CONSENSUS_THRESHOLD` | 60 | Seuil de consensus par defaut (%) |
| `MIN_CONSENSUS_THRESHOLD` | 50 | Seuil minimum (L-05) |
| `DEFAULT_FRESHNESS` | 1 heure | Fraicheur des donnees par defaut |
| `MIN_FRESHNESS_THRESHOLD` | 5 minutes | Fraicheur minimale configurable |
| `MAX_FRESHNESS_THRESHOLD` | 7 jours | Fraicheur maximale configurable |
| `COMMIT_TIMEOUT` | 2 minutes | Duree de la phase commit |
| `REVEAL_WINDOW` | 10 minutes | Fenetre de revelation |

### 6.3 Structures

```solidity
struct OracleData {
    address oracle;
    uint256 riskScore;          // 0-100
    uint256 timestamp;
    string dataSource;          // "WASDI", "CHIRPS", "GFS", etc.
    bool isOutlier;
}

struct ConsensusResult {
    uint256 consensusRiskScore;  // Mediane des non-aberrants
    uint256 participantCount;    // Oracles participants
    uint256 outlierCount;        // Oracles aberrants
    uint256 timestamp;
    bool reached;                // Consensus atteint ?
    string region;
}

struct OracleInfo {
    address oracleAddress;
    string name;
    uint256 reputation;          // 0-100
    uint256 totalSubmissions;
    uint256 outlierCount;
    uint256 consecutiveOutliers; // Auto-desactivation si >= 3
    bool isActive;
    uint256 registeredAt;
}
```

### 6.4 Algorithme IQR (detaille en section 17)

1. Trier les scores soumis
2. Calculer Q1 (25e percentile) et Q3 (75e percentile)
3. IQR = Q3 - Q1
4. Bornes : [Q1 - 1.5 * IQR, Q3 + 1.5 * IQR]
5. Tout score hors bornes = aberrant
6. Consensus = mediane des non-aberrants
7. Consensus atteint si non-aberrants >= `consensusThreshold`% des oracles actifs

### 6.5 Systeme de reputation

| Action | Ajustement | Plage |
|--------|-----------|-------|
| Soumission normale | +2 | [0, 100] |
| Soumission aberrante | -10 | [0, 100] |
| 3 aberrations consecutives | Auto-desactivation | M-08 : avertissement (probation) avant desactivation |

### 6.6 Fonctions principales

```solidity
// Gestion des oracles (owner uniquement)
function registerOracle(address oracle, string calldata name) external onlyOwner
function deactivateOracle(address oracle) external onlyOwner
function reactivateOracle(address oracle) external onlyOwner

// Soumission directe (backward compatible)
function submitData(string calldata region, uint256 riskScore, string calldata dataSource) external

// Schema commit-reveal
function commitData(string calldata region, bytes32 commitHash) external
function revealData(string calldata region, uint256 riskScore, string calldata dataSource, bytes32 salt) external

// Lecture
function getConsensus(string calldata region) external view returns (ConsensusResult memory)
function isConsensusReached(string calldata region) external view returns (bool)
function getConsensusRiskScore(string calldata region) external view returns (uint256)
function getOracleInfo(address oracle) external view returns (OracleInfo memory)
function getActiveOracleCount() external view returns (uint256)
function getOracleReputation(address oracle) external view returns (uint256)
```

### 6.7 Evenements

| Evenement | Description |
|-----------|-------------|
| `OracleRegistered` | Nouvel oracle enregistre |
| `OracleDeactivated` | Oracle desactive (manuellement ou auto) |
| `OracleReactivated` | Oracle reactive |
| `DataSubmitted` | Score soumis (direct) |
| `DataCommitted` | Commit recu (phase 1) |
| `DataRevealed` | Reveal recu (phase 2) |
| `ConsensusReached` | Consensus atteint pour une region |
| `OutlierDetected` | Valeur aberrante detectee |
| `ReputationUpdated` | Reputation mise a jour |
| `LowOracleCountWarning` | Avertissement si < MIN_ORACLE_COUNT (H5-MO) |
| `OracleProbationWarning` | Avertissement avant auto-desactivation (M-08) |
| `GovernanceUpdated` | Adresse de gouvernance mise a jour |

---

## 7. Contrat WASDIOracleConnector

**Fichier** : `contracts/WASDIOracleConnector.sol`
**Interface** : `interfaces/IWASDIOracle.sol`
**Heritage** : `IWASDIOracle`, `Ownable2Step`, `Pausable`, `ReentrancyGuard`
**Pattern** : Standard (non-upgradeable)

### 7.1 Responsabilite

Pont entre la plateforme satellitaire WASDI et la blockchain. Recoit les donnees satellitaires via des relayers autorises, stocke l'historique dans un buffer circulaire, detecte les anomalies bidirectionnelles, et alimente le MultiOracle.

### 7.2 Sources satellitaires supportees

| Source | Type | Donnees |
|--------|------|---------|
| Sentinel-1 | SAR (Radar) | Humidite du sol, inondations |
| Sentinel-2 | Optique multispectrale | Vegetation, eau de surface |
| MODIS | Radiometre | Temperature, precipitation |
| Landsat-8 | Optique | Cartographie terrain |
| Landsat-9 | Optique | Cartographie terrain (HD) |
| VIIRS | Radiometre | Feux, inondations nocturnes |

### 7.3 Constantes

| Constante | Valeur | Description |
|-----------|--------|-------------|
| `MAX_RISK_SCORE` | 100 | Score de risque max |
| `MAX_RAINFALL` | 2 000 | Precipitations max (mm) |
| `MAX_SOIL_MOISTURE` | 100 | Humidite du sol max (%) |
| `MAX_WATER_LEVEL` | 10 000 | Niveau d'eau max (cm) |
| `MIN_FRESHNESS` | 30 minutes | Fraicheur minimale configurable |
| `MAX_FRESHNESS` | 7 jours | Fraicheur maximale configurable |
| `MAX_HISTORY_ENTRIES` | 100 | Taille du buffer circulaire par region |
| `ANOMALY_THRESHOLD` | 40 | Seuil de detection d'anomalie (points) |

### 7.4 Securite specifique

| Controle | Correctif | Description |
|----------|----------|-------------|
| Test mode desactive par defaut | C-02 | Pas de simulation en production |
| Production mode lock (irreversible) | H-06 | `lockProductionMode()` desactive definitivement testMode |
| Detection anomalies bidirectionnelle | M-09 | Detecte pics ET chutes soudaines |
| Protection dernier relayer | H-05 | Impossible de supprimer le dernier relayer autorise |
| Buffer circulaire V-05 | V-05 | Ecrit avant d'incrementer le compteur |
| Seuil d'alerte configurable | V-06 | `riskAlertThreshold` ajustable |
| Fraicheur moyenne | M-WASDI-2 | Exclut les entrees perimees du calcul de moyenne |

### 7.5 Structure de donnees

```solidity
struct SatelliteData {
    string region;               // Code region
    uint256 riskScore;           // Score de risque 0-100
    uint256 rainfall;            // Precipitations (mm)
    uint256 soilMoisture;        // Humidite du sol (%)
    uint256 waterLevel;          // Niveau d'eau (cm)
    uint256 timestamp;           // Horodatage
    string satelliteSource;      // Source satellite
    bool isProcessed;            // Drapeau de traitement
}
```

### 7.6 Fonctions principales

```solidity
// Soumission (relayers autorises uniquement)
function submitSatelliteData(
    string calldata region,
    uint256 riskScore,
    uint256 rainfall,
    uint256 soilMoisture,
    uint256 waterLevel,
    string calldata satelliteSource
) external onlyRelayer whenNotPaused

// Lecture
function getLatestData(string calldata region) external view returns (SatelliteData memory)
function getRiskScore(string calldata region) external view returns (uint256)
function isDataFresh(string calldata region) external view returns (bool)
function getHistoricalData(string calldata region, uint256 count) external view returns (SatelliteData[] memory)
function getAverageRisk(string calldata region, uint256 count) external view returns (uint256)

// Gestion relayers
function addRelayer(address relayer) external onlyOwner
function removeRelayer(address relayer) external onlyOwner  // H-05: ne peut supprimer le dernier

// Simulation (test mode uniquement)
function simulateHighRisk(string calldata region) external  // Desactivee apres lockProductionMode()
function simulateLowRisk(string calldata region) external   // Desactivee apres lockProductionMode()

// Mode production
function setTestMode(bool enabled) external onlyOwner       // Impossible si productionLocked
function lockProductionMode() external onlyOwner             // Irreversible (H-06)
```

---

## 8. Contrat OpalGovernanceUpgradeable

**Fichier** : `contracts/OpalGovernanceUpgradeable.sol`
**Interface** : `interfaces/IOpalGovernance.sol`
**Heritage** : `Initializable`, `Ownable2StepUpgradeable`, `UUPSUpgradeable`, `IOpalGovernance`
**Pattern** : UUPS Proxy

### 8.1 Responsabilite

Gouvernance multi-signature pour les declenchements d'urgence et les modifications de parametres. Implemente un workflow proposition-signature-execution avec quorum configurable, timelock, et whitelist de selecteurs de fonctions.

### 8.2 Constantes

| Constante | Valeur | Description |
|-----------|--------|-------------|
| `MAX_ACTORS` | 20 | Nombre maximum d'acteurs de gouvernance |
| `DEFAULT_DEADLINE` | 24 heures | Delai standard pour les propositions |
| `EMERGENCY_DEADLINE` | 4 heures | Delai pour propositions d'urgence |
| `MIN_QUORUM` | 2 | Quorum minimum |
| `EXECUTION_DELAY` | 1 heure | Timelock apres quorum atteint (M-10) |

### 8.3 Types de propositions

| Type | Deadline | Timelock | Usage |
|------|----------|----------|-------|
| `EMERGENCY_TRIGGER` | 4h | **Aucun** (H11-GOV) | Declenchement d'urgence inondation |
| `PARAMETER_CHANGE` | 24h | 1h | Modification de parametres contrat |
| `BUDGET_ALLOCATION` | 24h | 1h | Allocation budgetaire |
| `UPGRADE` | 24h | 1h | Mise a jour de contrat |
| `ORACLE_OVERRIDE` | 24h | 1h | Override oracle |

### 8.4 Cycle de vie d'une proposition

```
                    createProposal()
                         │
                         ▼
                    ┌──────────┐
                    │  PENDING  │
                    └─────┬────┘
                          │ signProposal() × quorum
                          ▼
                    ┌──────────┐
                    │ APPROVED  │ ── quorumReachedAt enregistre
                    └─────┬────┘
                          │ +1h timelock (sauf EMERGENCY_TRIGGER)
                          ▼
                   executeProposal()
                          │
                    ┌──────────┐
                    │ EXECUTED  │
                    └──────────┘

  Alternatives :
  ─ rejectProposal() → REJECTED (owner OU quorum de rejections)
  ─ deadline depasse → EXPIRED
```

### 8.5 Controles de securite

| Controle | Correctif | Description |
|----------|----------|-------------|
| Target explicite par proposition | H-02 | Chaque proposition specifie son contrat cible (fallback: FPC) |
| Gas limit configurable | M-03 | `executionGasLimit` ajustable [100K, 5M] |
| Timelock 1h | M-10 | Delai obligatoire apres quorum (sauf urgence) |
| Comptage rejections separe | M-01v2 | `rejectionCount` independant de `signatureCount` |
| Approbation upgrade gouvernance | V-03 | `approveUpgrade()` controlable uniquement par proposition |
| Whitelist selecteurs | C-01 | Seuls les selecteurs autorises sont executables |
| Swap-and-pop acteurs | L-06 | Compaction de la liste d'acteurs a la suppression |
| Rejet par owner OU quorum | L-02 | Double mecanisme de rejet |
| Pas de timelock urgence | H11-GOV | `EMERGENCY_TRIGGER` execute immediatement apres quorum |

### 8.6 Fonctions principales

```solidity
// Initialisation
function initialize(address initialOwner, uint256 initialQuorum) external initializer

// Cycle de vie propositions
function createProposal(ProposalType, string description, bytes data, string region, address target) external returns (uint256)
function signProposal(uint256 proposalId) external
function executeProposal(uint256 proposalId) external
function rejectProposal(uint256 proposalId) external

// Gestion acteurs
function addGovernanceActor(address actor, string name, string role) external onlyOwner
function removeGovernanceActor(address actor) external onlyOwner
function updateQuorum(uint256 newQuorum) external onlyOwner

// Configuration
function setFloodPredictionContract(address floodPrediction) external onlyOwner
function setAllowedSelector(bytes4 selector, bool allowed) external onlyOwner
function setAllowedSelectorBatch(bytes4[] selectors, bool[] allowed) external onlyOwner
function setExecutionGasLimit(uint256 newLimit) external onlyOwner

// Upgrade (V-03)
function approveUpgrade(address implementation) external  // Appelable uniquement par proposition executee
```

---

## 9. Contrat JokalanteTargeting

**Fichier** : `contracts/JokalanteTargeting.sol`
**Interface** : `interfaces/IJokalanteTargeting.sol`
**Heritage** : `IJokalanteTargeting`, `Ownable2Step`
**Pattern** : Standard (non-upgradeable)

### 9.1 Responsabilite

Ciblage des beneficiaires preservant la vie privee via arbres Merkle. Gere les racines Merkle par region, verifie l'eligibilite des beneficiaires par preuve cryptographique, et suit le statut de verification.

### 9.2 Configuration

| Parametre | Valeur par defaut | Max | Description |
|-----------|------------------|-----|-------------|
| `MAX_BATCH_SIZE` | 50 | 50 | Verifications par lot |
| `defaultExpiryDuration` | 90 jours | 365 jours | Duree de validite des criteres |
| `maxBeneficiariesPerRegion` | 50 000 | — | Capacite maximale par region |

### 9.3 Modele de confidentialite

```
Off-chain                          On-chain
┌─────────────────┐               ┌──────────────────┐
│Base beneficiaire│               │JokalanteTargeting│
│ - Nom           │               │ - merkleRoot     │
│ - Telephone     │   hash+tree   │ - beneficiaryCount│
│ - Montant       │──────────────>│ - isActive       │
│ - Region        │               │ - expiresAt      │
│                 │               │                  │
│ Genere:         │               │ Verifie:         │
│ - phoneHash     │               │ - Merkle proof   │
│ - leafHash      │               │ - Double hash    │
│ - Merkle tree   │               │ - Statut verified│
└─────────────────┘               └──────────────────┘
```

**Aucune PII stockee on-chain** : seuls les hashes (keccak256) sont enregistres.

### 9.4 Construction des feuilles Merkle (V-01 + H-11)

```
leaf = keccak256(bytes.concat(keccak256(abi.encode(beneficiaryHash, amount))))
```

- **abi.encode** (pas abi.encodePacked) : empeche les collisions de hash (H-11)
- **Double hash** : prevention des attaques second-preimage (V-01)
- **beneficiaryHash** = `keccak256(abi.encode(phoneHash, region, amount))` (via FloodPredictionLib)

### 9.5 Fonctions principales

```solidity
// Gestion racines Merkle
function updateMerkleRoot(string calldata region, bytes32 merkleRoot, uint256 beneficiaryCount) external onlyOwner

// Verification
function verifyBeneficiary(string calldata region, bytes32 beneficiaryHash, uint256 amount, bytes32[] calldata merkleProof) external view returns (bool)
function verifyBeneficiaryBatch(string calldata region, bytes32[] calldata hashes, uint256[] calldata amounts, bytes32[][] calldata proofs) external view returns (bool[] memory)

// Marquage (appelants autorises — L-06)
function markVerified(string calldata region, bytes32 beneficiaryHash) external  // FPC uniquement

// Gestion regions
function deactivateRegion(string calldata region) external onlyOwner
function getActiveRegions(uint256 offset, uint256 limit) external view returns (string[] memory)  // M-07 pagination
function isRegionActive(string calldata region) external view returns (bool)
function getTargetingCriteria(string calldata region) external view returns (TargetingCriteria memory)
```

---

## 10. Contrat MobileMoneyProvider

**Fichier** : `contracts/MobileMoneyProvider.sol`
**Interface** : `interfaces/IMobileMoneyProvider.sol`
**Heritage** : `IMobileMoneyProvider`, `Ownable2Step`, `Pausable`, `ReentrancyGuard`
**Pattern** : Standard (non-upgradeable)

### 10.1 Responsabilite

Pont de paiement Mobile Money pour les operateurs senegalais. Gere le cycle de vie complet des paiements : initiation, confirmation, echec, expiration, et retry. Fonctionne via un pattern de relayer off-chain.

### 10.2 Operateurs supportes

| Operateur | Prefixe | Variable enum |
|-----------|---------|--------------|
| Orange Money (Sonatel) | +221 77, +221 78 | `ORANGE_MONEY` |
| Wave | +221 76 | `WAVE` |
| Free Money (Tigo) | +221 70 | `FREE_MONEY` |
| E-Money (SGBS) | +221 75 | `EMONEY` |

### 10.3 Constantes

| Constante | Valeur | Description |
|-----------|--------|-------------|
| `MAX_PAYMENT_AMOUNT` | 5 000 000 | Plafond par paiement (FCFA) |
| `MIN_PAYMENT_AMOUNT` | 500 | Minimum par paiement (FCFA) |
| `MAX_BATCH_SIZE` | 50 | Taille max de lot (M-06) |
| `MAX_RETRIES` | 3 | Tentatives maximales |
| `DEFAULT_TIMEOUT` | 30 minutes | Timeout par defaut |
| `MAX_TIMEOUT` | 24 heures | Timeout maximum |
| `MIN_TIMEOUT` | 5 minutes | Timeout minimum |

### 10.4 Cycle de vie du paiement

```
initiatePayment()
       │
       ▼
  ┌──────────┐
  │  PENDING  │──── timeout depasse ────> EXPIRED
  └────┬─────┘
       │
  ┌────┴─────────┐
  │              │
  ▼              ▼
confirmPayment() failPayment()
  │              │
  ▼              ▼
CONFIRMED     FAILED ──── retryPayment() (si retryCount < 3) ──> PENDING
                │
                └── retryCount >= 3 ──> reste FAILED (terminal)
```

### 10.5 Generation du paymentId

```solidity
paymentId = keccak256(abi.encode(
    beneficiaryHash,
    amount,
    block.timestamp,
    block.chainid,    // M-05: protection cross-chain
    _paymentNonce++
))
```

### 10.6 Controles de securite

| Controle | Correctif | Description |
|----------|----------|-------------|
| Hash telephone uniquement | V-04 | Pas de PII on-chain |
| Duplicats dans lot | H8-MMP | Revert si beneficiaire en double dans un batch |
| ChainId dans paymentId | M-05 | Protection replay cross-chain |
| Revert prefixe inconnu | L-03 | Pas de fallback silencieux sur numero invalide |
| Limite expiration batch | L-09 | `expireStalePayments()` respecte MAX_BATCH_SIZE |
| Limites journalieres | — | Par region, configurables |

### 10.7 Fonctions principales

```solidity
// Operations de paiement
function initiatePayment(bytes32 beneficiaryHash, uint256 amount, bytes32 phoneHash, string calldata region, MobileProvider provider) external returns (bytes32)
function confirmPayment(bytes32 paymentId, string calldata transactionRef) external
function failPayment(bytes32 paymentId, string calldata reason) external
function retryPayment(bytes32 paymentId) external
function batchInitiatePayments(bytes32[] calldata hashes, uint256[] calldata amounts, bytes32[] calldata phones, string calldata region, MobileProvider[] calldata providers) external returns (bytes32[] memory)
function batchConfirmPayments(bytes32[] calldata paymentIds, string[] calldata txRefs) external
function expireStalePayments(bytes32[] calldata paymentIds) external  // L-09: max MAX_BATCH_SIZE

// Configuration
function setDailyLimit(string calldata region, uint256 limit) external onlyOwner
function setPaymentTimeout(uint256 timeout) external onlyOwner

// Lecture
function getPayment(bytes32 paymentId) external view returns (Payment memory)
function getPaymentStatus(bytes32 paymentId) external view returns (PaymentStatus)
function getPendingPaymentCount() external view returns (uint256)
function getTotalDisbursed() external view returns (uint256)
```

---

## 11. Contrat KYCAMLCompliance

**Fichier** : `contracts/KYCAMLCompliance.sol`
**Interface** : `interfaces/IKYCAMLCompliance.sol`
**Heritage** : `IKYCAMLCompliance`, `Ownable2Step`
**Pattern** : Standard (non-upgradeable)

### 11.1 Responsabilite

Registre de conformite KYC/AML on-chain. Stocke les attestations de verification d'identite sous forme de hashes (RGPD-compliant). Implemente le principe des 4 yeux, le screening des sanctions, la detection de fraude, et la suspension/reinstatement des beneficiaires.

### 11.2 Architecture RGPD-compliant

```
Beneficiaire ──── documents ───> Service KYC off-chain
                                      │
                                  verification
                                      │
                                      ▼
                                Compliance Relayer
                                      │
                            submitAttestation()
                                      │
                                      ▼
                              ┌────────────────┐
                              │ KYCAMLCompliance│
                              │ (on-chain)      │
                              │                 │
                              │ Stocke :        │
                              │ - identityHash  │
                              │ - documentHash  │
                              │ - status        │
                              │ - riskLevel     │
                              │ - timestamps    │
                              │                 │
                              │ NE stocke PAS : │
                              │ - Nom           │
                              │ - Telephone     │
                              │ - CNI           │
                              │ - Adresse       │
                              └────────────────┘
```

### 11.3 Enumerations

```solidity
enum VerificationStatus { NOT_VERIFIED, PENDING, VERIFIED, REJECTED, EXPIRED, SUSPENDED }
enum RiskLevel { LOW, MEDIUM, HIGH, SANCTIONED }
```

### 11.4 Cycle de vie de l'attestation

```
submitAttestation()           approveAttestation() (H-04: officier different)
       │                            │
       ▼                            ▼
  ┌──────────┐               ┌──────────┐
  │  PENDING │──────────────>│ VERIFIED │
  └────┬─────┘               └─────┬────┘
       │                           │
       ▼                           ▼
  rejectAttestation()       suspendBeneficiary()
       │                           │
       ▼                           ▼
  ┌──────────┐               ┌──────────┐
  │ REJECTED │               │ SUSPENDED│ ─── statusBeforeSuspension sauvegarde (C-03)
  └──────────┘               └─────┬────┘
                                   │
                             reinstateBeneficiary()
                                   │
                                   ▼
                             Restaure le statut precedent (C-03)
                             (VERIFIED ou PENDING)
```

### 11.5 Principe des 4 yeux (H-04)

```
Officier A ── submitAttestation() ──> PENDING
Officier B ── approveAttestation() ──> VERIFIED
                     │
              Revert si A == B (H-04)
```

L'officier qui soumet ne peut PAS approuver la meme attestation. Ceci previent la fraude interne.

### 11.6 Detection de fraude

| Mecanisme | Comportement |
|-----------|-------------|
| `raiseFraudAlert()` | Incremente `fraudAlertCount[beneficiaryHash]` |
| Seuil de fraude | Si `fraudAlertCount >= fraudThreshold` (defaut 3) → auto-suspension |
| Screening sanctions | `SANCTIONED` → suspension automatique |
| Reinstatement | Restaure le statut avant suspension (C-03) |

### 11.7 Fonctions principales

```solidity
// Cycle de vie attestation
function submitAttestation(bytes32 beneficiaryHash, bytes32 identityHash, bytes32 documentHash, string calldata region) external
function approveAttestation(bytes32 beneficiaryHash, RiskLevel riskLevel, uint256 validityPeriod) external  // H-04: != submitter
function rejectAttestation(bytes32 beneficiaryHash, string calldata reason) external
function recordScreening(bytes32 beneficiaryHash, ScreeningResult calldata result) external

// Suspension / reinstatement
function suspendBeneficiary(bytes32 beneficiaryHash, string calldata reason) external
function reinstateBeneficiary(bytes32 beneficiaryHash) external  // C-03: restaure statut precedent

// Fraude
function raiseFraudAlert(bytes32 beneficiaryHash, string calldata alertType) external

// Requetes de conformite (onlyAuthorized — H9-KYC)
function isCompliant(bytes32 beneficiaryHash) external view returns (bool)
function batchCheckCompliance(bytes32[] calldata hashes) external view returns (bool[] memory)  // Max 200
function getAttestation(bytes32 beneficiaryHash) external view returns (ComplianceAttestation memory)
```

### 11.8 Definitions de conformite

Un beneficiaire est **compliant** si et seulement si :
1. `status == VERIFIED`
2. `expiresAt > block.timestamp` (non expire)
3. `screening.isCleared == true` (screening reussi)
4. Non suspendu

---

## 12. Bibliotheque FloodPredictionLib

**Fichier** : `contracts/libs/FloodPredictionLib.sol`
**Type** : Library (deploye inline, pas d'adresse propre)

### 12.1 Fonctions

| Fonction | Signature | Description |
|----------|-----------|-------------|
| `uint2str` | `(uint256) → string` | Conversion nombre → chaine |
| `generateEventId` | `(string region, uint256 timestamp, uint256 chainId, uint256 nonce) → string` | Genere `FLOOD-{region}-{timestamp}-{chainId}-{nonce}` |
| `hashBeneficiary` | `(bytes32 phoneHash, string region, uint256 amount) → bytes32` | Hash beneficiaire via `abi.encode` (H-11) |
| `calculateCooldown` | `(uint256 riskScore, uint256 threshold) → uint256` | Cooldown adaptatif : >= threshold+15 → 10min, >= threshold → 30min, sinon → 1h |
| `isValidRiskScore` | `(uint256 riskScore) → bool` | Valide [0, 100] |

### 12.2 Erreurs

| Erreur | Declencheur |
|--------|------------|
| `EmptyRegion()` | `generateEventId` ou `hashBeneficiary` avec region vide |
| `InvalidAmount()` | `hashBeneficiary` avec phoneHash nul |

---

## 13. Contrats Mock (tests)

### 13.1 MockWASDIOracle

**Fichier** : `contracts/mocks/MockWASDIOracle.sol` (~177 lignes)

Simule le WASDIOracleConnector sans connexion API reelle. Supporte :
- Soumission de donnees simulees
- Mode risque eleve / faible
- Scenarios personnalises
- Helpers pour tests automatises

### 13.2 MockMobileMoneyProvider

**Fichier** : `contracts/mocks/MockMobileMoneyProvider.sol` (~299 lignes)

Simule le MobileMoneyProvider. Modes :
- **Auto-confirm** : confirme automatiquement chaque paiement
- **Auto-fail** : echoue automatiquement
- **Force revert** : provoque des reverts (test error handling)
- Historique des paiements pour assertions

### 13.3 MockBeneficiaryRegistry

**Fichier** : `contracts/mocks/MockBeneficiaryRegistry.sol` (~323 lignes)

Registre de beneficiaires pour tests :
- Enregistrement individuel et en lot
- Calcul de feuilles et racines Merkle
- Scenarios preset pour regions senegalaises (Thies, Saint-Louis, Kaffrine)
- Helpers de numeros de telephone

---

## 14. Interfaces

Toutes les interfaces sont dans le repertoire `interfaces/`.

| Interface | Fichier | Definit |
|-----------|---------|---------|
| `IFloodPrediction` | `IFloodPrediction.sol` | FloodTrigger, BudgetAllocation, TriggerStatus, RiskLevel, fonctions core |
| `IMultiOracle` | `IMultiOracle.sol` | OracleInfo, ConsensusResult, OracleData, commit-reveal, gestion oracles |
| `IOpalGovernance` | `IOpalGovernance.sol` | Proposal, GovernanceActor, ProposalType, ProposalStatus, cycle de vie |
| `IJokalanteTargeting` | `IJokalanteTargeting.sol` | TargetingCriteria, verification Merkle, gestion regions |
| `IMobileMoneyProvider` | `IMobileMoneyProvider.sol` | Payment, PaymentStatus, operations paiement |
| `IKYCAMLCompliance` | `IKYCAMLCompliance.sol` | ComplianceAttestation, ScreeningResult, VerificationStatus, RiskLevel |
| `IWASDIOracle` | `IWASDIOracle.sol` | SatelliteData, soumission et lecture donnees satellite |

---

## 15. Machine a etats — Cycles de vie

### 15.1 Cycle de vie du FloodTrigger

```
                  createFloodTrigger()
                         │
                         ▼
┌────────────┐     ┌──────────┐     validateTrigger()    ┌──────────────┐
│  (creation) │────>│  ACTIVE │─────────────────────────>│  VALIDATED    │
└────────────┘     └────┬─────┘                           └──────┬───────┘
                        │                                        │
                   cancelTrigger()                        processBatchPayment()
                        │                                        │
                        ▼                                        ▼
                  ┌──────────────┐                         ┌──────────┐
                  │  CANCELLED    │                         │   PAID    │
                  │ (budget       │                         │ (tous     │
                  │  libere L-03) │                         │  payes)   │
                  └──────────────┘                         └──────────┘

  Note: validateAndProcessPayments() combine ACTIVE → VALIDATED → PAID en une transaction
  Note: Les lots multiples maintiennent le statut VALIDATED jusqu'au dernier lot
```

### 15.2 Cycle de vie du Paiement Mobile Money

```
  initiatePayment()        confirmPayment()
        │                       │
        ▼                       ▼
   ┌──────────┐           ┌──────────────┐
   │  PENDING │──────────>│  CONFIRMED   │  (terminal)
   └────┬─────┘           └──────────────┘
        │
        ├── timeout ──────> EXPIRED (terminal)
        │
        └── failPayment()
              │
              ▼
         ┌──────────┐
         │  FAILED  │──── retryPayment() (si retryCount < 3) ──> PENDING
         └──────────┘
              │
              └── retryCount >= 3 ──> FAILED (terminal)
```

### 15.3 Cycle de vie de la Proposition de Gouvernance

```
  createProposal() (auto-signe par proposeur)
        │
        ▼
   ┌──────────┐
   │  PENDING │
   └────┬─────┘
        │
        ├── signProposal() × quorum ──> APPROVED
        │                                    │
        │                     +1h timelock   │ (sauf EMERGENCY_TRIGGER)
        │                                    │
        │                             executeProposal()
        │                                    │
        │                                    ▼
        │                              ┌──────────┐
        │                              │ EXECUTED │ (terminal)
        │                              └──────────┘
        │
        ├── rejectProposal() (owner OU quorum rejections)
        │         │
        │         ▼
        │    ┌──────────┐
        │    │ REJECTED │ (terminal)
        │    └──────────┘
        │
        └── deadline depasse ──> EXPIRED (terminal)
```

### 15.4 Cycle de vie du Statut KYC

```
  submitAttestation()
        │
        ▼
   ┌──────────┐
   │  PENDING │
   └────┬─────┘
        │
        ├── approveAttestation() (officier different — H-04)
        │         │
        │         ▼
        │    ┌──────────┐         suspendBeneficiary()
        │    │ VERIFIED │───────────────────────────────> SUSPENDED
        │    └──────────┘                                     │
        │                                              reinstateBeneficiary()
        │                                                     │
        │                                              Restaure statut (C-03)
        │
        ├── rejectAttestation()
        │         │
        │         ▼
        │    ┌──────────┐
        │    │ REJECTED │
        │    └──────────┘
        │
        └── validityPeriod depasse ──> EXPIRED
```

---

## 16. Construction et verification Merkle

### 16.1 Construction off-chain (JavaScript)

```javascript
const { MerkleTree } = require('merkletreejs');
const { keccak256, defaultAbiCoder } = require('ethers');

// 1. Preparer les donnees des beneficiaires
const beneficiaries = [
    { phoneHash: keccak256("0x...phone1"), region: "SN-TH", amount: 50000 },
    { phoneHash: keccak256("0x...phone2"), region: "SN-TH", amount: 75000 },
];

// 2. Calculer les beneficiaryHashes (identique a FloodPredictionLib.hashBeneficiary)
const beneficiaryHashes = beneficiaries.map(b =>
    keccak256(defaultAbiCoder.encode(
        ["bytes32", "string", "uint256"],
        [b.phoneHash, b.region, b.amount]
    ))
);

// 3. Construire les feuilles (double hash — V-01 + H-11)
const leaves = beneficiaryHashes.map((hash, i) =>
    keccak256(
        ethers.solidityPacked(
            ["bytes"],
            [keccak256(defaultAbiCoder.encode(
                ["bytes32", "uint256"],
                [hash, beneficiaries[i].amount]
            ))]
        )
    )
);

// 4. Construire l'arbre Merkle
const tree = new MerkleTree(leaves, keccak256, { sort: true });
const merkleRoot = tree.getHexRoot();

// 5. Generer les preuves pour chaque beneficiaire
const proofs = leaves.map(leaf => tree.getHexProof(leaf));
```

### 16.2 Verification on-chain

```solidity
// JokalanteTargeting.verifyBeneficiary()
function verifyBeneficiary(
    string calldata region,
    bytes32 beneficiaryHash,
    uint256 amount,
    bytes32[] calldata merkleProof
) external view returns (bool) {
    TargetingCriteria storage criteria = _criteria[region];
    require(criteria.isActive && block.timestamp < criteria.expiresAt);

    // Reconstruction de la feuille (double hash — V-01)
    bytes32 leaf = keccak256(bytes.concat(
        keccak256(abi.encode(beneficiaryHash, amount))
    ));

    // Verification via OpenZeppelin MerkleProof
    return MerkleProof.verify(merkleProof, criteria.merkleRoot, leaf);
}
```

### 16.3 Proprietes cryptographiques

| Propriete | Mecanisme | Correctif |
|-----------|-----------|----------|
| Anti-collision | `abi.encode` (padding fixe) au lieu de `abi.encodePacked` | H-11 |
| Anti-second-preimage | Double hash `keccak256(bytes.concat(keccak256(...)))` | V-01 |
| Complexite verification | O(log n) pour n beneficiaires | — |
| Taille preuve | log2(n) * 32 octets | — |
| Integrite | Toute modification d'une feuille change la racine | — |

---

## 17. Algorithme de consensus IQR

### 17.1 Processus detaille

```
Entree : scores[] = [s1, s2, ..., sn] soumis par n oracles

Etape 1 — Filtrage fraicheur
  Exclure les scores ou timestamp > dataFreshnessThreshold

Etape 2 — Tri
  Trier scores[] par ordre croissant

Etape 3 — Calcul des quartiles
  n_valid = nombre de scores valides
  Q1 = scores[n_valid / 4]           (25e percentile)
  Q3 = scores[3 * n_valid / 4]       (75e percentile)

Etape 4 — IQR et bornes
  IQR = Q3 - Q1
  borne_basse = Q1 - 1.5 * IQR       (floor a 0)
  borne_haute = Q3 + 1.5 * IQR       (cap a 100)

Etape 5 — Detection aberrantes
  Pour chaque score s:
    si s < borne_basse OU s > borne_haute:
      marquer comme aberrant (isOutlier = true)
      reputation_oracle -= 10
      consecutiveOutliers++
      si consecutiveOutliers >= 3 → probation warning (M-08)
      si consecutiveOutliers > 3 → auto-deactivation
    sinon:
      reputation_oracle += 2  (cap a 100)
      consecutiveOutliers = 0

Etape 6 — Consensus
  non_aberrants = scores filtres (isOutlier == false)
  si |non_aberrants| >= consensusThreshold% * activeOracleCount:
    consensus_atteint = true
    consensusRiskScore = mediane(non_aberrants)
  sinon:
    consensus_atteint = false

Sortie : ConsensusResult { consensusRiskScore, participantCount, outlierCount, reached }
```

### 17.2 Exemple numerique

```
Oracles actifs : 5, consensusThreshold = 60%
Soumissions : [65, 70, 72, 68, 95]

Tri : [65, 68, 70, 72, 95]
Q1 = 68, Q3 = 72
IQR = 72 - 68 = 4
borne_basse = 68 - 6 = 62
borne_haute = 72 + 6 = 78

Filtrage :
  65 → ok (62 ≤ 65 ≤ 78)
  68 → ok
  70 → ok
  72 → ok
  95 → ABERRANT (95 > 78)

Non-aberrants : [65, 68, 70, 72] (4 sur 5)
4/5 = 80% >= 60% → consensus atteint
Mediane([65, 68, 70, 72]) = (68 + 70) / 2 = 69

Resultat : consensusRiskScore = 69
```

---

## 18. Schema commit-reveal

### 18.1 Objectif

Empecher le front-running entre oracles : un oracle ne peut pas voir les soumissions des autres avant de soumettre la sienne.

### 18.2 Processus

```
Phase 1 — Commit (2 minutes)
┌─────────────────────────────────────────────────────────┐
│ Oracle calcule off-chain :                               │
│   commitHash = keccak256(abi.encode(                     │
│       region, riskScore, dataSource, salt                │
│   ))                                                     │
│                                                          │
│ Oracle appelle : commitData(region, commitHash)          │
│                                                          │
│ On-chain : stocke commitHash + timestamp                 │
│ Emis : DataCommitted(oracle, region, round)              │
└─────────────────────────────────────────────────────────┘

Phase 2 — Reveal (10 minutes apres fin des commits)
┌─────────────────────────────────────────────────────────┐
│ Oracle appelle : revealData(region, riskScore,           │
│                              dataSource, salt)           │
│                                                          │
│ On-chain verifie :                                       │
│   keccak256(abi.encode(region, riskScore,                │
│                        dataSource, salt))                │
│   == commitHash stocke                                   │
│                                                          │
│ Si valide → donnee enregistree pour consensus            │
│ Emis : DataRevealed(oracle, region, riskScore)           │
└─────────────────────────────────────────────────────────┘

Phase 3 — Consensus (automatique)
  Si suffisamment de reveals → calcul IQR + median
```

---

## 19. Layout de stockage (Storage Layout)

### 19.1 FloodPredictionContract (UUPS Proxy)

**Important** : Les slots herites d'OpenZeppelin Upgradeable ne sont PAS listes ici. Seuls les slots propres au contrat sont documentes.

| Slot | Variable | Type | Notes |
|------|----------|------|-------|
| S+0 | `triggers` | mapping(string => FloodTrigger) | — |
| S+1 | `triggerIds` | string[] | — |
| S+2 | `triggerCount` | uint256 | — |
| S+3 | `budgets` | mapping(string => BudgetAllocation) | — |
| S+4 | `budgetRegions` | string[] | — |
| S+5 | `totalBudgetAllocated` | uint256 | — |
| S+6 | `totalBudgetSpent` | uint256 | — |
| S+7 | `paymentRecords` | mapping(bytes32 => PaymentRecord) | — |
| S+8 | `totalPaymentsProcessed` | uint256 | — |
| S+9 | `totalAmountDisbursed` | uint256 | — |
| S+10 | `triggerPaidCount` | mapping(string => uint256) | Multi-batch |
| S+11 | `committedBudget` | mapping(string => uint256) | Budget engage |
| S+12 | `triggerSpentAmount` | mapping(string => uint256) | — |
| S+13 | `regionNonces` | mapping(string => uint256) | Replay protection |
| S+14 | `globalNonce` | uint256 | — |
| S+15 | `lastTriggerTimestamp` | mapping(string => uint256) | Cooldown |
| S+16 | `riskThreshold` | uint256 | Defaut 70 |
| S+17 | `multiOracle` | address | — |
| S+18 | `governance` | address | — |
| S+19 | `jokalanteTargeting` | address | — |
| S+20 | `mobileMoneyProvider` | address | — |
| S+21 | `kycCompliance` | address | — |
| S+22 | `emergencyMode` | bool | — |
| S+23 | `regionEmergency` | mapping(string => bool) | — |
| S+24 | `oracleTolerance` | uint256 | H-03 (consomme 1 slot du gap) |
| S+25..S+72 | `__gap[48]` | uint256[48] | 48 slots disponibles pour futures mises a jour |

### 19.2 OpalGovernanceUpgradeable (UUPS Proxy)

| Slot | Variable | Type |
|------|----------|------|
| S+0 | `actors` | mapping(address => GovernanceActor) |
| S+1 | `actorList` | address[] |
| S+2 | `activeActorCount` | uint256 |
| S+3 | `proposals` | mapping(uint256 => Proposal) |
| S+4 | `proposalCount` | uint256 |
| S+5 | `executedProposalCount` | uint256 |
| S+6 | `proposalSignatures` | mapping(uint256 => mapping(address => bool)) |
| S+7 | `quorum` | uint256 |
| S+8 | `floodPredictionContract` | address |
| S+9..S+12 | Variables additionnelles (selectors, timelock, etc.) | — |
| S+N..S+N+46 | `__gap[47]` | uint256[47] — 47 slots disponibles |

### 19.3 Regles de compatibilite pour mise a jour

1. **JAMAIS** reordonner les variables d'etat existantes
2. **JAMAIS** changer le type d'une variable existante
3. **TOUJOURS** ajouter les nouvelles variables **avant** le `__gap`
4. **TOUJOURS** reduire la taille du `__gap` d'autant de slots consommes
5. **TOUJOURS** verifier la compatibilite avec `hardhat-upgrades` avant deploiement

---

## 20. Matrice de controle d'acces

### 20.1 FloodPredictionContract

| Fonction | ADMIN | OPERATOR | PAUSER | UPGRADER | Governance | Externe |
|----------|-------|----------|--------|----------|------------|---------|
| `initialize()` | Init | — | — | — | — | — |
| `createFloodTrigger()` | — | ✓ | — | — | — | — |
| `validateTrigger()` | — | ✓ | — | — | — | — |
| `processBatchPayment()` | — | ✓ | — | — | — | — |
| `validateAndProcessPayments()` | — | ✓ | — | — | — | — |
| `allocateBudget()` | ✓ | — | — | — | — | — |
| `deactivateBudget()` | ✓ | — | — | — | — | — |
| `cancelTrigger()` | ✓ | — | — | — | — | — |
| `createGovernanceOverrideTrigger()` | — | — | — | — | ✓ | — |
| `activateEmergencyMode()` | ✓ | — | — | — | — | — |
| `deactivateEmergencyMode()` | ✓ | — | — | — | — | — |
| `setRegionEmergency()` | ✓ | — | — | — | — | — |
| `setContractAddresses()` | ✓ | — | — | — | — | — |
| `updateRiskThreshold()` | ✓ | — | — | — | — | — |
| `setOracleTolerance()` | ✓ | — | — | — | — | — |
| `pause()` | — | — | ✓ | — | — | — |
| `unpause()` | — | — | ✓ | — | — | — |
| `_authorizeUpgrade()` | — | — | — | ✓ | — | — |
| `getFloodTrigger()` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

### 20.2 Autres contrats

| Contrat | Proprietaire (owner) | Autorises supplementaires |
|---------|---------------------|--------------------------|
| MultiOracle | Deployer | Oracles enregistres (submitData) |
| WASDIOracleConnector | Deployer | Relayers autorises (submitSatelliteData) |
| JokalanteTargeting | Deployer | `authorizedCallers` pour markVerified (FPC) |
| MobileMoneyProvider | Deployer | — |
| KYCAMLCompliance | Deployer | `complianceOfficers` + `authorizedContracts` |

---

## 21. Analyse de gas

### 21.1 Estimations par operation

| Operation | Gas estime | Notes |
|-----------|-----------|-------|
| Deploiement FPC (proxy) | ~4 500 000 | UUPS + AccessControl |
| Deploiement MultiOracle | ~3 800 000 | Ownable2Step + IQR |
| `createFloodTrigger()` | ~150 000 - 250 000 | Inclut verification oracle |
| `validateTrigger()` | ~50 000 - 80 000 | Mise a jour statut |
| `processBatchPayment()` (50 benef.) | ~800 000 - 1 200 000 | Merkle + MM + KYC |
| `validateAndProcessPayments()` (50) | ~900 000 - 1 300 000 | Validation + paiement |
| `allocateBudget()` | ~60 000 - 100 000 | Ecriture mapping |
| `submitData()` (oracle) | ~100 000 - 200 000 | + consensus si seuil atteint |
| `submitSatelliteData()` | ~80 000 - 150 000 | Buffer circulaire + anomalie |
| `createProposal()` | ~100 000 - 180 000 | + auto-signature |
| `updateMerkleRoot()` | ~60 000 - 100 000 | — |
| `verifyBeneficiary()` (view) | ~30 000 | O(log n) |

### 21.2 Techniques d'optimisation utilisees

| Technique | Impact | Localisation |
|-----------|--------|-------------|
| Custom errors (pas de string revert) | ~50% economie sur revert | Tous les contrats |
| Optimizer (200 runs) | Equilibre deploy/runtime | `hardhat.config.js` |
| viaIR compilation | Optimisations avancees | `hardhat.config.js` |
| Operations par lot (max 50) | Amortissement overhead par-tx | FPC, MobileMoney |
| EIP-1153 TransientStorage | Reentrancy guard moins cher | FPC (`ReentrancyGuardTransient`) |
| `abi.encode` (pas `abi.encodePacked`) | Correct + economise le recalcul | FloodPredictionLib |
| Pagination des vues | Evite OOG sur grands ensembles | M-02 |
| `calldata` (pas `memory`) | Economie sur les parametres | Tous les contrats |

### 21.3 Tests de charge

| Test | Beneficiaires | Lots | Gas total | Gas/beneficiaire |
|------|--------------|------|-----------|-----------------|
| BatchBeneficiaries1000 | 1 000 | 20 × 50 | ~20M | ~20 000 |
| BatchBeneficiaries2000 | 2 000 | 40 × 50 | ~40M | ~20 000 |
| BatchBeneficiaries3000 | 3 000 | 60 × 50 | ~60M | ~20 000 |
| BatchBeneficiaries5000 | 5 000 | 100 × 50 | ~100M | ~20 000 |

---

## 22. Registre des correctifs de securite

### 22.1 Severite Haute (H)

| ID | Description | Contrat | Correctif |
|----|------------|---------|----------|
| H-01 | Oracle tolerance TOCTOU | FPC | `oracleTolerance` configurable [0, 10] |
| H-02 | Target explicite par proposition | Governance | Champ `target` dans Proposal struct |
| H-03 | Seuil de risque dynamique dans cooldown | FPC | `calculateCooldown(riskScore, threshold)` |
| H-04 | Principe des 4 yeux KYC | KYC | Approver != submitter enforced |
| H-05 | Protection dernier relayer | WASDI | `relayerCount` + erreur `CannotRemoveLastRelayer` |
| H-06 | Production mode lock irreversible | WASDI | `lockProductionMode()` one-way |
| H-07 | Leaf unifie (hash, amount) | Jokalante/FPC | Merkle leaf inclut beneficiaryHash + amount |
| H-08 | Duplicats dans batch MM | MobileMoney | Detection inner-loop + revert |
| H-09 | Acces restreint requetes KYC | KYC | `onlyAuthorized` sur `isCompliant()` |
| H-11 | abi.encode anti-collision | Lib/Jokalante/FPC | `abi.encode` partout au lieu de `abi.encodePacked` |
| H11-GOV | Pas de timelock urgence | Governance | `EMERGENCY_TRIGGER` bypass EXECUTION_DELAY |
| H5-MO | Avertissement oracles insuffisants | MultiOracle | Emit warning (pas revert) si < MIN_ORACLE_COUNT |

### 22.2 Severite Moyenne (M)

| ID | Description | Contrat | Correctif |
|----|------------|---------|----------|
| M-01 | ChainId dans event ID | FPC | `chainId` dans FloodTrigger |
| M-01v2 | Comptage rejections separe | Governance | `rejectionCount` independant |
| M-02 | Pagination vues | FPC | `getTriggerIdsPaginated()`, `getBudgetRegionsPaginated()` |
| M-03 | Gas limit execution configurable | Governance | `executionGasLimit` [100K, 5M] |
| M-04 | Emit event au lieu de skip silencieux | MobileMoney | Evenement sur paiement non-pending |
| M-05 | ChainId dans payment ID | MobileMoney | `block.chainid` dans hash |
| M-06 | Taille de lot unifiee | MobileMoney | `MAX_BATCH_SIZE = 50` partout |
| M-07 | Pagination regions | Jokalante | `getActiveRegions(offset, limit)` |
| M-08 | Probation avant auto-desactivation | MultiOracle | Avertissement a 3 outliers consecutifs |
| M-09 | Detection anomalies bidirectionnelle | WASDI | Detecte pics ET chutes |
| M-10 | Timelock 1h apres quorum | Governance | `EXECUTION_DELAY` + `quorumReachedAt` |
| M-11 | Plafond paiement aligne | MobileMoney | `MAX_PAYMENT_AMOUNT = 5M` |
| M-JOKA | Lecture isActive avant ecrasement | Jokalante | Preserve statut precedent |
| M-WASDI-1 | Wraparound buffer circulaire | WASDI | Gestion correcte du modulo |
| M-WASDI-2 | Fraicheur dans calcul moyenne | WASDI | Exclut entrees perimees |

### 22.3 Severite Basse (L) et Informationnel (I/V/C)

| ID | Description | Contrat | Correctif |
|----|------------|---------|----------|
| L-01 | Validation inputs library | Lib | `EmptyRegion()`, `InvalidAmount()` |
| L-02 | Rejet par owner OU quorum | Governance | Double mecanisme |
| L-03 | Liberation budget a l'annulation | FPC | `committedBudget` decremente |
| L-05 | Seuil consensus min 50% | MultiOracle | Validation dans setter |
| L-06 | Swap-and-pop acteurs / autorizedCallers | Gov/Jokalante | Compaction liste |
| L-09 | Limite batch expiration | MobileMoney | `expireStalePayments` <= MAX_BATCH_SIZE |
| L-10 | ReentrancyGuardTransient avec UUPS | FPC | EIP-1153 safe avec proxy |
| V-01 | Double hash Merkle | Jokalante | Prevention second-preimage |
| V-02 | Separation des roles RBAC | FPC | 4 roles distincts |
| V-03 | Approbation upgrade via gouvernance | Governance | `approveUpgrade()` |
| V-04 | Hash telephone (pas plaintext) | MobileMoney | `phoneHash` uniquement |
| V-05 | Ecriture avant increment buffer | WASDI | Ordre d'ecriture corrige |
| V-06 | Seuil de risque configurable | FPC/Lib/WASDI | `riskThreshold` dynamique |
| C-01 | KYC graceful skip | FPC | Skip au lieu de revert |
| C-02 | Test mode desactive par defaut | WASDI | `testMode = false` initial |
| C-03 | Restauration statut apres suspension | KYC | `statusBeforeSuspension` |
| I-03 | Minimum 4 oracles actifs | MultiOracle | `MIN_ORACLE_COUNT = 4` |

---

## 23. Invariants de securite

### 23.1 Invariants budgetaires

```
∀ region r :
  budgets[r].spentAmount + committedBudget[r] <= budgets[r].allocatedAmount
  totalBudgetSpent <= totalBudgetAllocated
```

### 23.2 Invariants de paiement

```
∀ trigger t, beneficiaire b :
  isBeneficiaryPaid(t.eventId, b) == true ⟹ b ne sera plus paye pour ce trigger
  triggerPaidCount[t.eventId] <= t.beneficiaryCount
  triggerSpentAmount[t.eventId] <= t.totalAmount
```

### 23.3 Invariants oracle

```
∀ oracle o :
  0 <= o.reputation <= 100
  o.consecutiveOutliers >= 3 ⟹ (o.isActive == false OU probation warning emis)
  activeOracleCount <= MAX_ORACLES (10)
```

### 23.4 Invariants de gouvernance

```
∀ proposal p :
  p.signatureCount <= activeActorCount
  p.status == EXECUTED ⟹ p.signatureCount >= quorum
  p.status == EXECUTED ⟹ p.executedAt > 0
  (p.proposalType != EMERGENCY_TRIGGER ∧ p.status == EXECUTED)
    ⟹ p.executedAt >= quorumReachedAt + EXECUTION_DELAY
```

### 23.5 Invariants de protection

```
// Replay protection
∀ trigger cree : eventId est unique (region + timestamp + chainId + nonce)
∀ paiement : paymentId est unique (beneficiary + amount + timestamp + chainId + nonce)

// Cooldown
∀ region r, nouveau trigger a timestamp t :
  t >= lastTriggerTimestamp[r] + calculateCooldown(riskScore, riskThreshold)

// KYC 4-eyes
∀ attestation a :
  a.status == VERIFIED ⟹ a.submittedBy != a.approvedBy
```

---

## 24. Evenements et observabilite

### 24.1 Evenements critiques a surveiller en production

| Priorite | Evenement | Contrat | Action recommandee |
|----------|----------|---------|-------------------|
| **P0** | `EmergencyModeActivated` | FPC | Alerte immediate equipe |
| **P0** | `HighRiskDetected` | WASDI | Verifier donnees satellite, preparer trigger |
| **P0** | `MobileMoneyPaymentsFailed` | FPC | Investiguer echec, retry si necessaire |
| **P1** | `FloodTriggerCreated` | FPC | Verifier region, montant, beneficiaires |
| **P1** | `ConsensusReached` | MultiOracle | Verifier score, participants |
| **P1** | `ProposalCreated` (EMERGENCY) | Governance | Signer rapidement |
| **P2** | `OutlierDetected` | MultiOracle | Verifier oracle, investiguer deviation |
| **P2** | `OracleProbationWarning` | MultiOracle | Oracle a risque de desactivation |
| **P2** | `PaymentFailed` | MobileMoney | Verifier API operateur |
| **P2** | `FraudAlertRaised` | KYC | Investiguer beneficiaire |
| **P3** | `BatchPaymentProcessed` | FPC | Confirmer distribution |
| **P3** | `PaymentConfirmed` | MobileMoney | Audit trail |
| **P3** | `ReputationUpdated` | MultiOracle | Suivi qualite oracles |

### 24.2 Pattern d'indexation

Tous les evenements critiques utilisent le mot-cle `indexed` sur les champs de recherche principaux :
- `eventId` pour les triggers et paiements
- `region` pour le budget et les donnees satellite
- `oracle` pour la gestion des oracles
- `proposalId` pour la gouvernance
- `beneficiaryHash` pour la conformite KYC
- `paymentId` pour les paiements Mobile Money

---

## 25. Guide de deploiement

### 25.1 Pre-requis

| Outil | Version | Verification |
|-------|---------|-------------|
| Node.js | >= 22.x | `node --version` |
| npm | >= 9.x | `npm --version` |
| Git | Toute version | `git --version` |

### 25.2 Installation

```bash
git clone <repository-url>
cd flood-prediction-smart-contract
npm install
# Le script postinstall execute automatiquement : node scripts/patch-edr-gas-cap.js
```

### 25.3 Compilation

```bash
npx hardhat build
# Ou : npm run build
```

### 25.4 Tests

```bash
# Suite complete (512 tests)
npx hardhat test

# Fichier specifique
npx hardhat test test/FloodPrediction.test.js

# Stress test
npx hardhat run scripts/stress-test-1000.js --network localhost
```

### 25.5 Deploiement local

```bash
# Terminal 1 : Demarrer le noeud local
npx hardhat node

# Terminal 2 : Deployer
npx hardhat run scripts/deploy-upgradeable.js --network localhost
```

**Ordre de deploiement (`deploy-upgradeable.js`)** :

| Etape | Contrat | Type | Dependances |
|-------|---------|------|-------------|
| 1/5 | MultiOracle | Standard (direct) | Aucune |
| 2/5 | OpalGovernanceUpgradeable | UUPS Proxy (quorum=2) | Aucune |
| 3/5 | JokalanteTargeting | Standard (direct) | Aucune |
| 4/5 | MobileMoneyProvider | Standard (direct) | Aucune |
| 5/5 | FloodPredictionContract | UUPS Proxy | Aucune |
| 6/5 | Cablage | `setContractAddresses()` | Tous les contrats |

### 25.6 Deploiement Polygon Amoy (testnet)

**Pre-requis** :
1. Alimenter le wallet deployer en MATIC Amoy
2. Configurer `.env` (PRIVATE_KEY, AMOY_RPC_URL, POLYGONSCAN_API_KEY)

```bash
npx hardhat run scripts/deploy-amoy.js --network amoy
```

**Specificites `deploy-amoy.js`** :
- Deploiement **resumable** : sauvegarde progression dans `deployment-amoy-progress.json`
- Verification automatique sur PolygonScan (delai 30s pour indexation)
- Gas settings : `maxFeePerGas: 50 gwei`, `maxPriorityFeePerGas: 30 gwei`
- Post-deploiement automatise :
  1. Cablage `setContractAddresses()`
  2. Attribution OPERATOR_ROLE et PAUSER_ROLE
  3. Allocation budgets pour 6 regions du Senegal
  4. Configuration gouvernance (target + selectors)
  5. Enregistrement oracle initial

### 25.7 Deploiement production (Polygon Mainnet)

```bash
# 1. Verifier que tous les tests passent
npx hardhat test

# 2. Deployer sur testnet d'abord
npx hardhat run scripts/deploy-amoy.js --network amoy

# 3. Tester manuellement sur testnet

# 4. Deployer sur mainnet
npx hardhat run scripts/deploy-upgradeable.js --network polygon
```

**Checklist production** :
- [ ] Tous les 512 tests passent
- [ ] Deploiement testnet reussi
- [ ] Tests manuels E2E sur testnet
- [ ] Audit de securite passe
- [ ] `testMode = false` et `productionLocked = true` sur WASDI
- [ ] Quorum de gouvernance configure (>= 2)
- [ ] Selecteurs de fonctions whitelistes
- [ ] Budgets alloues
- [ ] Oracles enregistres (>= 4)
- [ ] Relayers WASDI autorises
- [ ] Officiers KYC enregistres
- [ ] Adresses contrats verifiees sur PolygonScan

### 25.8 Sortie de deploiement

```json
{
  "network": "amoy",
  "chainId": 80002,
  "deployer": "0x...",
  "timestamp": 1719...,
  "contracts": {
    "MultiOracle": "0x...",
    "WASDIOracleConnector": "0x...",
    "JokalanteTargeting": "0x...",
    "MobileMoneyProvider": "0x...",
    "KYCAMLCompliance": "0x...",
    "OpalGovernanceProxy": "0x...",
    "FloodPredictionProxy": "0x...",
    "OpalGovernanceImpl": "0x...",
    "FloodPredictionImpl": "0x..."
  }
}
```

---

## 26. Procedure de mise a jour (UUPS)

### 26.1 Contrats upgradeables

| Contrat | Storage Gap | Condition d'upgrade |
|---------|-------------|-------------------|
| FloodPredictionContract | `__gap[48]` | `UPGRADER_ROLE` requis |
| OpalGovernanceUpgradeable | `__gap[47]` | `onlyOwner` + `approvedUpgrades[impl]` (V-03) |

### 26.2 Procedure

```bash
# 1. Preparer la nouvelle implementation
# (modifier le contrat, incrementer VERSION, ajuster __gap)

# 2. Compiler
npx hardhat build

# 3. Executer la mise a jour
PROXY_ADDRESS=0x... npx hardhat run scripts/upgrade-contract.js --network <network>
```

**Etapes internes de `upgrade-contract.js`** :
1. Lecture de `PROXY_ADDRESS`
2. Obtention du signer (doit avoir UPGRADER_ROLE)
3. Creation de la nouvelle factory
4. `ozUpgrades.upgradeProxy(PROXY_ADDRESS, NewFactory, { kind: "uups" })`
5. Verification version via `getVersion()`

### 26.3 Checklist de mise a jour

- [ ] Nouvelle implementation compile sans erreur
- [ ] Layout de stockage compatible (pas de reordonnancement)
- [ ] `__gap` reduit du nombre de nouveaux slots
- [ ] Tous les tests existants passent avec la nouvelle implementation
- [ ] Nouveaux tests ecrits pour les nouvelles fonctionnalites
- [ ] `_disableInitializers()` dans le constructeur
- [ ] `getVersion()` retourne version incrementee
- [ ] Mise a jour testnet executee avant mainnet
- [ ] Pour Governance : proposition d'upgrade approuvee (V-03)

---

## 27. Configuration et environnement

### 27.1 Variables d'environnement (`.env`)

```bash
# Cle privee deployer (SANS prefixe 0x)
PRIVATE_KEY=your_private_key_here

# URLs RPC
AMOY_RPC_URL=https://rpc-amoy.polygon.technology
POLYGON_RPC_URL=https://polygon-rpc.com
SEPOLIA_RPC_URL=https://rpc.sepolia.org
ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc
ARBITRUM_SEPOLIA_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc

# Cles API explorateurs de blocs
POLYGONSCAN_API_KEY=your_polygonscan_api_key
ETHERSCAN_API_KEY=your_etherscan_api_key
ARBISCAN_API_KEY=your_arbiscan_api_key
```

### 27.2 Hardhat config — Resolution des variables

```javascript
const envOrVar = (name) => process.env[name] ? process.env[name] : configVariable(name);
```

1. Verifie `process.env[name]` (via dotenv)
2. Fallback sur `configVariable(name)` (Hardhat keystore)

### 27.3 Block Gas Settings (EDR)

| Parametre | Valeur |
|-----------|--------|
| `blockGasLimit` | 60 000 000 |
| `allowUnlimitedContractSize` | false |
| `hardfork` | cancun |
| `chainId` | 1337 (hardhat) / 31337 (localhost) |

### 27.4 Scripts npm

| Commande | Description |
|----------|-------------|
| `npm run build` | Compile tous les contrats |
| `npm test` | Execute la suite de tests complete (512 tests) |
| `npm run deploy:local` | Deploie sur localhost |
| `npm run deploy:amoy` | Deploie sur Polygon Amoy |
| `npm run deploy:sepolia` | Deploie sur Sepolia |
| `npm run upgrade` | Met a jour le contrat sur localhost |
| `npm run stress-test` | Test de charge 1000 beneficiaires |
| `npm run node` | Demarre un noeud Hardhat local |
| `npm run clean` | Nettoie le cache et les artefacts |

---

## 28. Suite de tests

### 28.1 Vue d'ensemble

| Fichier de test | Focus | Tests |
|----------------|-------|-------|
| `KYCAMLCompliance.test.js` | Attestations KYC/AML, RGPD, principe des 4 yeux, fraude, expiry/renouvellement | 84 |
| `MultiOracle.test.js` | Consensus IQR, reputation, commit-reveal, freshness | 77 |
| `FloodPrediction.test.js` | Contrat principal : deploiement, RBAC, budget, triggers, paiements, urgence, upgrade | 55 |
| `OpalGovernance.test.js` | Propositions, quorum, timelock, selecteurs, upgrade approval | 49 |
| `WASDIOracleConnector.test.js` | Donnees satellite, buffer circulaire, anomalies, test/prod mode | 42 |
| `MobileMoneyProvider.test.js` | Paiements, retry, batch, providers, limites | 38 |
| `JokalanteTargeting.test.js` | Merkle roots, verification, regions, expiry | 36 |
| `AuditV2Fixes.test.js` | Correctifs audit round 2 | 22 |
| `AuditFixValidation.test.js` | Validation des correctifs d'audit initiaux | 17 |
| `SecurityFixes.test.js` | Verification de tous les correctifs de securite | 17 |
| `AuditV3Fixes.test.js` | Correctifs audit round 3 (full-project) | 14 |
| `AuditV4Fixes.test.js` | Correctifs audit round 4 (full-project + relayer) | 11 |
| `BatchBeneficiaries10000.test.js` | Stress test 10000 beneficiaires | 9 |
| `BatchBeneficiaries5000.test.js` | Stress test 5000 beneficiaires | 9 |
| `Relayer.test.js` | Service relayer Mobile Money (off-chain) | 9 |
| `BatchBeneficiaries2000.test.js` | Stress test 2000 beneficiaires | 8 |
| `BatchBeneficiaries3000.test.js` | Stress test 3000 beneficiaires | 8 |
| `BatchBeneficiaries1000.test.js` | Stress test 1000 beneficiaires | 7 |

**Total : 512 tests (18 fichiers)**

### 28.2 Couverture par categorie

| Categorie | Couverture |
|-----------|-----------|
| Deploiement et initialisation | ✓ |
| Controle d'acces (RBAC/Ownable) | ✓ |
| Gestion budgetaire | ✓ |
| Creation et validation de triggers | ✓ |
| Paiements par lots (Merkle + KYC + MM) | ✓ |
| Mode urgence (global + regional) | ✓ |
| Mise a jour UUPS | ✓ |
| Consensus IQR et reputation | ✓ |
| Commit-reveal | ✓ |
| Donnees satellite et anomalies | ✓ |
| Gouvernance multi-sig | ✓ |
| KYC/AML (4-eyes, suspension, reinstatement) | ✓ |
| Mobile Money (retry, batch, providers) | ✓ |
| Correctifs securite (35+) | ✓ |
| Tests de charge (1K-10K beneficiaires) | ✓ |

### 28.3 Tests de charge 1K–10K

Les tests de charge ont ete verifies avec succes jusqu'a 10 000 beneficiaires dans le jeu de tests de la suite.

- `test/BatchBeneficiaries1000.test.js` : 1 000 beneficiaires
- `test/BatchBeneficiaries2000.test.js` : 2 000 beneficiaires
- `test/BatchBeneficiaries3000.test.js` : 3 000 beneficiaires
- `test/BatchBeneficiaries5000.test.js` : 5 000 beneficiaires
- `test/BatchBeneficiaries10000.test.js` : 10 000 beneficiaires

#### Resultats et mesures de gaz

| Nombre de beneficiaires | Batches | Gas total | Gas moyen / batch | Gas moyen / beneficiaire |
|-------------------------|---------|-----------|-------------------|--------------------------|
| 2 000 | 40 | 623 044 300 | 15 576 107 | 311 522 |
| 3 000 | 60 | 936 452 760 | 15 607 546 | 312 151 |
| 5 000 | 100 | 1 783 937 678 | 17 839 376 | 356 787 |
| 10 000 | 200 | 3 577 521 684 | 17 887 608 | 357 752 |

#### Observations clefs

- Le traitement batch de 50 beneficiaires est stable jusqu'a 10 000 beneficiaires.
- Le cout par beneficiaire reste relativement stable autour de 312k gas jusqu'a 3 000 beneficiaires, puis monte a ~357k gas pour 5 000 et 10 000.
- La prevention de double-paiement fonctionne correctement sur toute l'echelle testee.
- Le test initiale de role `RolesNotDistinct()` a ete corrige en attribuant 4 signataires distincts lors de l'initialisation de `FloodPredictionContract`.

### 28.4 Execution

```bash
# Suite complete
npx hardhat test

# Avec verbose
npx hardhat test --verbose

# Fichier specifique
npx hardhat test test/FloodPrediction.test.js

# Pattern
npx hardhat test test/Batch*.test.js
```

---

## 29. Workflow bout-en-bout

### 29.1 Scenario complet : Inondation a Thies (SN-TH)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     PHASE 1 : DETECTION SATELLITE                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. WASDI detecte des precipitations anormales via Sentinel-1               │
│  2. Relayer off-chain appelle :                                             │
│     WASDIOracleConnector.submitSatelliteData(                               │
│       "SN-TH", 82, 150, 75, 200, "Sentinel-1"                             │
│     )                                                                       │
│  3. Buffer circulaire mis a jour, anomalie evaluee                          │
│  4. Evenement SatelliteDataSubmitted emis                                   │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                     PHASE 2 : CONSENSUS ORACLE                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  5. Oracle 1 : submitData("SN-TH", 80, "WASDI")                           │
│  6. Oracle 2 : submitData("SN-TH", 78, "CHIRPS")                          │
│  7. Oracle 3 : submitData("SN-TH", 82, "GFS")                             │
│  8. Oracle 4 : submitData("SN-TH", 75, "MODIS")                           │
│  9. IQR : Q1=77, Q3=81, IQR=4, bornes=[71, 87]                           │
│     Tous dans les bornes → 0 aberrant                                       │
│ 10. Consensus : mediane([75, 78, 80, 82]) = 79                            │
│ 11. Evenement ConsensusReached("SN-TH", 79, 4)                            │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                     PHASE 3 : DECLENCHEMENT PARAMETRIQUE                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│ 12. Operateur prepare off-chain :                                           │
│     - Liste de 200 beneficiaires eligibles                                  │
│     - Calcul phoneHashes + beneficiaryHashes                               │
│     - Construction arbre Merkle (double hash)                              │
│     - merkleRoot = tree.getHexRoot()                                       │
│                                                                             │
│ 13. Operateur appelle :                                                     │
│     FPC.createFloodTrigger("SN-TH", 79, merkleRoot, 10000000, 200)       │
│                                                                             │
│ 14. Verifications automatiques :                                            │
│     ✓ 79 >= 70 (seuil)                                                     │
│     ✓ Cooldown ecoule                                                       │
│     ✓ Budget suffisant (10M FCFA)                                          │
│     ✓ Oracle consensus = 79 (tolerance OK)                                  │
│                                                                             │
│ 15. Trigger cree : eventId = "FLOOD-SN-TH-1719...-1337-0"                │
│     Statut : ACTIVE                                                         │
│     Budget engage : committedBudget["SN-TH"] += 10000000                   │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                     PHASE 4 : PAIEMENT PAR LOTS                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│ 16. Lot 1/4 (50 beneficiaires) :                                           │
│     FPC.validateAndProcessPayments(eventId, hashes[0:50], amounts[0:50],   │
│                                     proofs[0:50], phoneHashes[0:50])       │
│     → Trigger ACTIVE → VALIDATED                                            │
│     → 50 paiements inities via MobileMoneyProvider                         │
│     → KYC verifie pour chaque (skip si non-compliant)                      │
│                                                                             │
│ 17. Lots 2-4 (50 beneficiaires chacun) :                                   │
│     FPC.processBatchPayment(eventId, hashes[50:100], ...)                  │
│     FPC.processBatchPayment(eventId, hashes[100:150], ...)                 │
│     FPC.processBatchPayment(eventId, hashes[150:200], ...)                 │
│     → Dernier lot : Trigger VALIDATED → PAID                                │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                     PHASE 5 : DISTRIBUTION MOBILE MONEY                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│ 18. Relayer off-chain detecte les evenements PaymentInitiated               │
│ 19. Pour chaque paiement :                                                  │
│     - Appel API Orange Money / Wave / Free / E-Money                       │
│     - Si succes : confirmPayment(paymentId, txRef)                         │
│     - Si echec : failPayment(paymentId, reason)                            │
│     - Si echec + retry < 3 : retryPayment(paymentId)                      │
│ 20. Evenements PaymentConfirmed emis                                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 29.2 Test interactif

```bash
npx hardhat run scripts/interactive-test.js
```

Deploie tous les contrats, configure le systeme, construit un arbre Merkle pour 2 beneficiaires, et cree un trigger de test.

---

## 30. Conformite reglementaire

### 30.1 Matrice de conformite DPA

| Volet | Exigence | Implementation | Statut |
|-------|---------|---------------|--------|
| Volet 1 | Selection blockchain | Polygon PoS L2 (faible cout, EVM) | ✅ |
| Volet 2 | Integration oracle | WASDI + MultiOracle + IQR consensus | ✅ |
| Volet 3 | Conception smart contracts | 7 contrats, hub-and-spoke, UUPS | ✅ |
| Volet 4 | Mecanisme parametrique | Seuil >= 70%, cooldown adaptatif | ✅ |
| Volet 5 | Securite et conformite | KYC/AML, RBAC, 35+ correctifs | ✅ |
| Volet 6 | Gouvernance | Multi-sig, quorum, timelock | ✅ |
| Volet 7 | Audit securite | Audit complet + round 2 integre | ✅ |
| Volet 8 | Deploiement et documentation | Amoy deploy + cette documentation | ✅ |

### 30.2 RGPD / NDPD (Protection des donnees)

| Exigence | Implementation |
|----------|---------------|
| Minimisation des donnees | Hashes uniquement on-chain (keccak256) |
| Pas de PII | Pas de nom, telephone, CNI, adresse |
| Droit a l'oubli | Hashes non reversibles |
| Consentement | Gere off-chain par le processus KYC |
| Transfert de donnees | Pas de donnees personnelles transferees |

### 30.3 BCEAO (Reglementation Mobile Money)

| Exigence | Implementation |
|----------|---------------|
| Identification | KYC/AML obligatoire (attestation on-chain) |
| Plafonds | MAX_PAYMENT_AMOUNT = 5M FCFA par paiement |
| Limites journalieres | `setDailyLimit()` configurable par region |
| Audit trail | Evenements indexes et horodates |
| Operateurs agrees | Orange Money, Wave, Free Money, E-Money |

---

## 31. Procedures d'urgence

### 31.1 Arret d'urgence global

```solidity
// 1. Pause du contrat (PAUSER_ROLE)
FPC.pause()

// 2. Activation mode urgence (ADMIN_ROLE)
FPC.activateEmergencyMode("Raison de l'urgence")

// Effet : tous les triggers et paiements bloques
```

### 31.2 Arret d'urgence regional

```solidity
// Bloquer une region specifique
FPC.setRegionEmergency("SN-TH", true)

// Les autres regions continuent de fonctionner
```

### 31.3 Reprise apres urgence

```solidity
// 1. Desactiver l'urgence
FPC.deactivateEmergencyMode()
// OU
FPC.setRegionEmergency("SN-TH", false)

// 2. Reprendre le contrat
FPC.unpause()
```

### 31.4 Oracle compromis

```solidity
// 1. Desactiver l'oracle compromis
MultiOracle.deactivateOracle(oracleAddress)

// 2. Verifier que >= MIN_ORACLE_COUNT (4) oracles restent actifs
MultiOracle.getActiveOracleCount()

// 3. Si necessaire, enregistrer un remplacement
MultiOracle.registerOracle(newOracleAddress, "Oracle-Replacement")
```

### 31.5 Relayer WASDI compromis

```solidity
// 1. Revoquer le relayer
WASDIOracleConnector.removeRelayer(compromisedAddress)  // H-05: interdit si dernier

// 2. Ajouter un remplacement
WASDIOracleConnector.addRelayer(newRelayerAddress)
```

---

## 32. Depannage

### 32.1 Erreurs de compilation

| Erreur | Cause | Solution |
|--------|-------|---------|
| Contract size exceeds 24576 bytes | Contrat trop volumineux | Verifier `viaIR: true` dans config |
| Stack too deep | Trop de variables locales | Activer `viaIR: true` |
| Import not found | Dependance manquante | `npm install` |

### 32.2 Erreurs de deploiement

| Erreur | Cause | Solution |
|--------|-------|---------|
| Insufficient funds | Pas assez de MATIC/ETH | Alimenter le wallet deployer |
| Nonce too low | Transaction en attente | Attendre ou incrementer nonce |
| Gas estimation failed | Revert dans le constructeur | Verifier les parametres d'initialisation |

### 32.3 Erreurs de test

```bash
# Nettoyer le cache Hardhat
npx hardhat clean

# Reinstaller les dependances
rm -rf node_modules && npm install

# Verifier la version Node.js
node --version  # >= 22.x requis
```

### 32.4 Gas optimization tips

| Technique | Impact |
|-----------|--------|
| Custom errors (pas de string revert) | ~50% economie revert gas |
| Optimizer (200 runs) | Equilibre deploy/runtime |
| viaIR compilation | Optimisations pipeline avancees |
| Operations par lot (max 50) | Amortissement overhead par-tx |
| EIP-1153 TransientStorage | Reentrancy guard moins cher |
| `calldata` au lieu de `memory` | Economie parametres |
| Pagination vues | Evite out-of-gas |

---

## 33. Modules de formation

### 33.1 Module 1 : Vue d'ensemble du systeme

**Public cible** : Tous les membres de l'equipe
**Duree** : 1 heure

**Sujets** :
1. OPAL Platform — assurance parametrique contre les inondations
2. Architecture systeme — hub-and-spoke, 7 contrats
3. Concepts cles : arbres Merkle, consensus oracle, UUPS
4. Modele de confidentialite — pas de PII on-chain
5. Conformite reglementaire — KYC/AML, RGPD/NDPD, BCEAO

### 33.2 Module 2 : Guide operateur

**Public cible** : Operateurs systeme
**Duree** : 2 heures

**Sujets** :
1. Attribution du role OPERATOR_ROLE
2. Creation de triggers via `createFloodTrigger()`
3. Traitement des paiements par lot — preparation Merkle off-chain
4. Monitoring des evenements pour confirmation
5. Gestion budgetaire — allocation et suivi
6. Procedures d'urgence — pause, mode urgence

**Exercices pratiques** :
- Creer un trigger avec donnees simulees sur noeud local
- Traiter un lot de 50 beneficiaires
- Activer et desactiver le mode urgence
- Interroger les statistiques systeme

### 33.3 Module 3 : Guide developpeur

**Public cible** : Developpeurs smart contracts
**Duree** : 4 heures

**Sujets** :
1. Setup environnement (Node.js, Hardhat, VS Code)
2. Compilation et tests
3. Pattern UUPS proxy
4. Ecriture de nouveaux tests
5. Procedures de deploiement (local → testnet → mainnet)
6. Workflow de mise a jour avec gestion storage gap
7. Ajout de nouvelles fonctionnalites
8. Techniques d'optimisation gas

### 33.4 Module 4 : Guide gouvernance

**Public cible** : Membres du conseil de gouvernance
**Duree** : 1.5 heures

**Sujets** :
1. Modele de gouvernance — multi-signature
2. Types de propositions
3. Cycle de vie — creer → signer → executer
4. Exigences de quorum (MIN_QUORUM = 2)
5. Mecanisme de timelock — 1h EXECUTION_DELAY (M-10)
6. Bypass urgence — EMERGENCY_TRIGGER sans timelock
7. Whitelist de selecteurs — seules les fonctions approuvees

### 33.5 Module 5 : Guide conformite

**Public cible** : Officiers de conformite
**Duree** : 1.5 heures

**Sujets** :
1. Workflow KYC/AML — verification off-chain, attestation on-chain
2. Niveaux de risque — LOW, MEDIUM, HIGH, SANCTIONED
3. Regles d'auto-suspension — SANCTIONED uniquement
4. Processus de reinstatement — restaure le statut precedent (C-03)
5. Detection de fraude — seuil de 3 rapports
6. Periodes de validite — defaut 365 jours, max 730 jours
7. Controle d'acces — `onlyAuthorized` pour conformite RGPD (H9-KYC)
8. Trail d'audit — evenements indexes et horodates

---

## 34. Annexes

### 34.1 Arborescence du projet

```
flood-prediction-smart-contract/
├── contracts/
│   ├── FloodPredictionContract.sol    # Orchestrateur principal (UUPS)
│   ├── MultiOracle.sol                # Consensus multi-oracle (IQR)
│   ├── WASDIOracleConnector.sol       # Pont donnees satellite WASDI
│   ├── OpalGovernanceUpgradeable.sol  # Gouvernance multi-sig (UUPS)
│   ├── JokalanteTargeting.sol         # Ciblage Merkle beneficiaires
│   ├── MobileMoneyProvider.sol        # Pont Mobile Money Senegal
│   ├── KYCAMLCompliance.sol           # Conformite KYC/AML
│   ├── libs/
│   │   └── FloodPredictionLib.sol     # Bibliotheque utilitaire
│   └── mocks/
│       ├── MockWASDIOracle.sol        # Mock pour tests
│       ├── MockMobileMoneyProvider.sol # Mock pour tests
│       └── MockBeneficiaryRegistry.sol # Mock pour tests
├── interfaces/
│   ├── IFloodPrediction.sol
│   ├── IMultiOracle.sol
│   ├── IOpalGovernance.sol
│   ├── IJokalanteTargeting.sol
│   ├── IMobileMoneyProvider.sol
│   ├── IKYCAMLCompliance.sol
│   └── IWASDIOracle.sol
├── test/
│   ├── FloodPrediction.test.js
│   ├── MultiOracle.test.js
│   ├── WASDIOracleConnector.test.js
│   ├── OpalGovernance.test.js
│   ├── JokalanteTargeting.test.js
│   ├── MobileMoneyProvider.test.js
│   ├── KYCAMLCompliance (via SecurityFixes)
│   ├── SecurityFixes.test.js
│   ├── AuditV2Fixes.test.js
│   ├── BatchBeneficiaries1000.test.js
│   ├── BatchBeneficiaries2000.test.js
│   ├── BatchBeneficiaries3000.test.js
│   └── BatchBeneficiaries5000.test.js
├── scripts/
│   ├── deploy-upgradeable.js          # Deploiement UUPS (local/mainnet)
│   ├── deploy-amoy.js                 # Deploiement Amoy (resumable)
│   ├── deploy-v3.js                   # Deploiement direct (tests)
│   ├── upgrade-contract.js            # Mise a jour UUPS
│   ├── interactive-test.js            # Test interactif E2E
│   ├── stress-test-1000.js            # Test de charge
│   └── patch-edr-gas-cap.js           # Postinstall EDR fix
├── types/
│   └── ethers-contracts/              # Types TypeScript generes
├── docs/                              # Documentation
├── .openzeppelin/                     # Manifestes proxy OZ
├── hardhat.config.js                  # Configuration Hardhat
├── package.json                       # Dependances et scripts
├── .env.example                       # Template variables d'environnement
├── .solhint.json                      # Configuration linter Solidity
├── .solhintignore                     # Exclusions linter
└── .gitignore
```

### 34.2 Codes region Senegal

| Code | Region |
|------|--------|
| SN-TH | Thies |
| SN-SL | Saint-Louis |
| SN-KA | Kaffrine |
| SN-KD | Kolda |
| SN-ZG | Ziguinchor |
| SN-MT | Matam |

### 34.3 References techniques

| Ressource | Description |
|-----------|-------------|
| EIP-1822 | UUPS Proxy Standard |
| EIP-1153 | Transient Storage (Cancun) |
| EIP-170 | Limite taille contrat (24 576 octets) |
| OpenZeppelin Contracts 5.4 | Bibliotheque de contrats securises |
| Hardhat 3.0 | Framework de developpement Solidity |
| MerkleTree.js | Construction d'arbres Merkle JavaScript |
| WASDI Platform | Web Advanced Space Developer Interface |

### 34.4 Contacts et responsabilites

| Role | Responsabilite |
|------|---------------|
| Administrateur systeme | Gestion budgets, configuration, urgence |
| Operateur | Creation triggers, traitement paiements |
| Responsable gouvernance | Propositions, signatures, execution |
| Officier conformite | KYC/AML, screening, suspension |
| Developpeur | Maintenance code, tests, deploiement |
| Gestionnaire oracle | Enregistrement et monitoring oracles |
| Gestionnaire relayer | Maintenance relayers WASDI et Mobile Money |

---

*Documentation Technique v4.1.0 — OPAL Platform — DPA Foundation — Juillet 2026*

*512 tests automatises — 60+ correctifs de securite integres — 7 contrats principaux*
