# Architecture Applicative, Architecture Technique & Call Flows

## OPAL – Plateforme de Prédiction d'Inondations sur Blockchain

**Version** : 1.0.0  
**Réseau** : Polygon PoS (Amoy Testnet 80002 / Mainnet 137)  
**Solidity** : 0.8.28  
**Date** : Avril 2026

---

## Table des matières

- [Architecture Applicative, Architecture Technique \& Call Flows](#architecture-applicative-architecture-technique--call-flows)
  - [OPAL – Plateforme de Prédiction d'Inondations sur Blockchain](#opal--plateforme-de-prédiction-dinondations-sur-blockchain)
  - [Table des matières](#table-des-matières)
  - [1. Vue d'ensemble](#1-vue-densemble)
    - [Principes architecturaux](#principes-architecturaux)
  - [2. Architecture Applicative](#2-architecture-applicative)
    - [2.1 Couche Smart Contracts (On-Chain)](#21-couche-smart-contracts-on-chain)
      - [Résumé des 7 contrats](#résumé-des-7-contrats)
    - [2.2 Couche Off-Chain (Relayers \& Backend)](#22-couche-off-chain-relayers--backend)
      - [Composants off-chain](#composants-off-chain)
    - [2.3 Intégrations Externes](#23-intégrations-externes)
    - [2.4 Diagramme de composants](#24-diagramme-de-composants)
      - [Légende des flèches (vérifiée vs code)](#légende-des-flèches-vérifiée-vs-code)
  - [3. Architecture Technique](#3-architecture-technique)
    - [3.1 Stack Technique](#31-stack-technique)
    - [3.2 Topologie des Contrats](#32-topologie-des-contrats)
    - [3.3 Hiérarchie d'héritage](#33-hiérarchie-dhéritage)
    - [3.4 Modèle de Contrôle d'Accès (RBAC)](#34-modèle-de-contrôle-daccès-rbac)
      - [FloodPredictionContract](#floodpredictioncontract)
      - [OpalGovernance](#opalgovernance)
      - [Contrats Standard](#contrats-standard)
    - [3.5 Architecture de Déploiement](#35-architecture-de-déploiement)
      - [Ordre de déploiement](#ordre-de-déploiement)
      - [Réseaux configurés](#réseaux-configurés)
    - [3.6 Sécurité \& Conformité](#36-sécurité--conformité)
      - [Protection anti-attaques](#protection-anti-attaques)
      - [Conformité RGPD / NDPD](#conformité-rgpd--ndpd)
  - [4. Call Flows](#4-call-flows)
    - [4.1 CF-1 : Ingestion de données satellite](#41-cf-1--ingestion-de-données-satellite)
    - [4.2 CF-2 : Consensus multi-oracle](#42-cf-2--consensus-multi-oracle)
      - [Mode direct](#mode-direct)
      - [Mode commit-reveal (anti-front-running)](#mode-commit-reveal-anti-front-running)
    - [4.3 CF-3 : Création et validation d'un flood trigger](#43-cf-3--création-et-validation-dun-flood-trigger)
    - [4.4 CF-4 : Paiement batch aux bénéficiaires](#44-cf-4--paiement-batch-aux-bénéficiaires)
    - [4.5 CF-5 : Confirmation de paiement Mobile Money](#45-cf-5--confirmation-de-paiement-mobile-money)
    - [4.6 CF-6 : Vérification KYC/AML (4-eyes)](#46-cf-6--vérification-kycaml-4-eyes)
    - [4.7 CF-7 : Gouvernance – Override d'urgence](#47-cf-7--gouvernance--override-durgence)
    - [4.8 CF-8 : Upgrade UUPS](#48-cf-8--upgrade-uups)
      - [a) Upgrade FPC (UPGRADER\_ROLE uniquement)](#a-upgrade-fpc-upgrader_role-uniquement)
      - [b) Upgrade OpalGovernance (dual-control : Owner + Governance)](#b-upgrade-opalgovernance-dual-control--owner--governance)
    - [4.9 CF-9 : Flux complet end-to-end](#49-cf-9--flux-complet-end-to-end)
  - [5. Matrice des appels inter-contrats](#5-matrice-des-appels-inter-contrats)
  - [6. Constantes système](#6-constantes-système)

---

## 1. Vue d'ensemble

La plateforme **OPAL** est une solution blockchain de la DPA Foundation pour l'assurance paramétrique contre les inondations. Elle automatise la chaîne complète : **détection satellite → consensus oracle → déclenchement paramétrique → vérification des bénéficiaires → paiement Mobile Money**.

### Principes architecturaux

| Principe | Implémentation |
|----------|---------------|
| **Hub-and-Spoke** | `FloodPredictionContract` orchestre tous les contrats périphériques |
| **Privacy by Design** | Aucune PII on-chain — uniquement des hash keccak256 (RGPD/NDPD) |
| **Upgradeabilité** | UUPS Proxy (EIP-1822) pour `FloodPredictionContract` et `OpalGovernance` |
| **Multi-Oracle** | Consensus IQR avec détection d'outliers statistique |
| **Commit-Reveal** | Protection anti-front-running pour les soumissions oracle |
| **Dual-Control** | Approbation gouvernance + owner pour les upgrades |
| **4-Eyes** | Le soumetteur KYC ≠ l'approbateur |

---

## 2. Architecture Applicative

### 2.1 Couche Smart Contracts (On-Chain)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        POLYGON PoS (Amoy / Mainnet)                     │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │    Opal Governance (UUPS Proxy)                                  │   │
│  │    ───────────────────────────                                   │   │
│  │    Multi-sig | Proposals | Timelock | Selector Whitelist         │   │
│  └──────┬─────────────────────────────────────────────┬─────────── ─┘   │
│         │ executeProposal()                           │ config          │
│         │ .call(proposal.data)                        │ (onlyOwnerOr-   │
│         ▼                                             ▼  Governance)    │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │              FloodPredictionContract (UUPS Proxy)                │   │
│  │              ─────────────────────────────────                   │   │
│  │  • Orchestrateur central (hub)                                   │   │
│  │  • Création / validation des flood triggers                      │   │
│  │  • Traitement batch des paiements                                │   │
│  │  • Gestion budgétaire (committed / spent)                        │   │
│  │  • Cooldown adaptatif par région                                 │   │
│  │  Rôles: ADMIN | OPERATOR | UPGRADER | PAUSER                     │   │
│  └──────┬──────────┬──────────┬──────────┬──────────────────────────┘   │
│         │          │          │          │                              │
│    ┌────▼────┐ ┌───▼────┐ ┌──▼───┐ ┌───▼────┐                         │
│    │  Multi  │ │Jokal-  │ │ KYC  │ │Mobile  │                          │
│    │ Oracle  │ │anté    │ │ AML  │ │Money   │                          │
│    │         │ │Target. │ │Compl.│ │Provid. │                          │
│    ├─────────┤ ├────────┤ ├──────┤ ├────────┤                          │
│    │Consensus│ │Merkle  │ │Attest│ │Payment │                          │
│    │IQR      │ │Tree    │ │4-eyes│ │Bridge  │                          │
│    │Commit-  │ │Privacy │ │Fraud │ │Batch   │                          │
│    │Reveal   │ │RGPD    │ │Detect│ │Retry   │                          │
│    │Reputation│ │Expiry │ │Screen│ │Timeout │                          │
│    └─────────┘ └────────┘ └──────┘ └───▲────┘                          │
│                                        │                               │
│    ┌──────────────────┐                │                               │
│    │ WASDI Oracle     │   Aucun lien   │                               │
│    │ Connector        │   on-chain     │                               │
│    ├──────────────────┤   avec Multi-  │                               │
│    │ Sentinel-1/2     │   Oracle       │                               │
│    │ MODIS, Landsat   │                │                               │
│    │ VIIRS            │                │                               │
│    │ Anomaly Detect.  │                │                               │
│    │ Circular Buffer  │                │                               │
│    └──────────────────┘                │                               │
│                                        │                               │
│    ┌────────────────────┐              │                               │
│    │ FloodPredictionLib │              │                               │
│    │ (bibliothèque)     │              │                               │
│    ├────────────────────┤              │                               │
│    │ generateEventId()  │              │                               │
│    │ hashBeneficiary()  │              │                               │
│    │ calculateCooldown()│              │                               │
│    └────────────────────┘              │                               │
│                                        │                               │
└────────────────────────────────────────┼───────────────────────────────┘
                                         │
                                   Off-Chain Relayers
                              ┌──────────┼──────────┐
                              │          │          │
                     ┌────────▼──┐  ┌────▼─────┐  ┌▼──────────┐
                     │ WASDI     │  │ Oracle   │  │ Mobile    │
                     │ Relayer   │  │ Relayers │  │ Money     │
                     │→submitSat-│  │→submitDa-│  │ Relayer   │
                     │ elliteDa- │  │ ta()/    │  │→confirmPa-│
                     │ ta()      │  │ commitDa-│  │ yment()   │
                     │ sur WASDI │  │ ta()     │  │→failPaym- │
                     │ Connector │  │ sur Multi│  │ ent()     │
                     │           │  │ Oracle   │  │           │
                     └───────────┘  └──────────┘  └───────────┘
```

> **Note** : `OpalGovernance` appelle `FloodPredictionContract` (et potentiellement
> `MultiOracle`) via `executeProposal()` — et non l'inverse. `WASDIOracleConnector`
> et `MultiOracle` n'ont aucun lien on-chain : ils sont alimentés indépendamment
> par des relayers off-chain distincts.

#### Résumé des 7 contrats

| # | Contrat | Pattern | Rôle |
|---|---------|---------|------|
| 1 | **FloodPredictionContract** | UUPS Proxy | Orchestrateur central — triggers, paiements, budget |
| 2 | **MultiOracle** | Standard | Consensus IQR multi-oracle avec commit-reveal |
| 3 | **WASDIOracleConnector** | Standard | Ingestion données satellite WASDI (6 sources) |
| 4 | **JokalanteTargeting** | Standard | Registre bénéficiaires Merkle tree (privacy RGPD) |
| 5 | **KYCAMLCompliance** | Standard | Conformité KYC/AML avec 4-eyes et détection fraude |
| 6 | **MobileMoneyProvider** | Standard | Bridge paiements Mobile Money (4 opérateurs) |
| 7 | **OpalGovernanceUpgradeable** | UUPS Proxy | Gouvernance multi-sig avec timelock |

### 2.2 Couche Off-Chain (Relayers & Backend)

```
┌────────────────────────────────────────────────────────── ─────┐
│                      OPAL BACKEND                              │
│                                                                │
│  ┌──────────── ──┐  ┌───────────── ─┐  ┌──────────────────────┐│
│  │  WASDI        │  │  Relayer      │  │  OPAL Web App        ││
│  │  Relayer      │  │  Mobile Money │  │  (Dashboard)         ││
│  ├─────────── ───┤  ├───────────── ─┤  ├──────────────────────┤│
│  │ Polling WASDI │  │ Orange Money  │  │ Visualisation        ││
│  │ API satellite │  │ Wave API      │  │ régions/triggers     ││
│  │ → submitSatel-│  │ Free Money    │  │ Suivi paiements      ││
│  │   liteData()  │  │ E-Money       │  │ Administration       ││
│  │               │  │ confirmPay()  │  │ Event listening      ││
│  │               │  │ failPayment() │  │                      ││
│  └──────┬──── ───┘  └──────┬────── ─┘  └──────────┬───────────┘│
│         │                  │                      │            │
└─────────┼──────────────────┼──────────────────────┼────────────┘
          │                  │                      │
          │      Polygon RPC (JSON-RPC / WebSocket) │
          │                  │                      │
┌─────────▼──────────────────▼──────────────────────▼────────────┐
│                   SMART CONTRACTS (ON-CHAIN)                   │
└────────────────────────────────────────────────────────────────┘
```

#### Composants off-chain

| Composant | Responsabilité |
|-----------|---------------|
| **WASDI Relayer** | Polling API satellite WASDI → `WASDIOracleConnector.submitSatelliteData()` |
| **Oracle Relayers** (≥4) | Soumission données risque → `MultiOracle.submitData()` ou commit-reveal |
| **Mobile Money Relayer** | Appels API opérateurs → `confirmPayment()` / `failPayment()` |
| **OPAL Backend** | Écoute événements, génération arbres Merkle, orchestration workflow |
| **Jokalanté Platform** | Base bénéficiaires → génération `merkleRoot` → `JokalanteTargeting.updateMerkleRoot()` |
| **Dashboard OPAL** | Interface utilisateur pour monitoring et administration |

### 2.3 Intégrations Externes

| Système | Point d'intégration | Direction | Données |
|---------|---------------------|-----------|---------|
| **WASDI** | WASDIOracleConnector | Entrant | Risque, pluviométrie, humidité sol, niveau d'eau |
| **Sentinel-1/2** | Via WASDI | Entrant | Imagerie SAR & optique |
| **MODIS / Landsat / VIIRS** | Via WASDI | Entrant | Données EO multi-spectrales |
| **Orange Money** | MobileMoneyProvider | Sortant | Décaissements CFA (+221 77/78) |
| **Wave** | MobileMoneyProvider | Sortant | Décaissements CFA (+221 76) |
| **Free Money** | MobileMoneyProvider | Sortant | Décaissements CFA (+221 70) |
| **E-Money** | MobileMoneyProvider | Sortant | Décaissements CFA (+221 75) |
| **Jokalanté** | JokalanteTargeting | Entrant | Arbres Merkle bénéficiaires |
| **Listes de sanctions** | KYCAMLCompliance | Entrant | Données OFAC, ONU, etc. |
| **Polygon RPC** | Tous contrats | Bidirectionnel | Transactions & événements |

### 2.4 Diagramme de composants

```
                    ┌─────────────────────────┐
                    │      Utilisateurs        │
                    │  (Admin, Opérateur,       │
                    │   Gouverneur, Officier)   │
                    └────────────┬──────────────┘
                                 │
                    ┌────────────▼──────────────┐
                    │     OPAL Dashboard         │
                    │     (Web Application)      │
                    └────────────┬──────────────┘
                                 │
              ┌──────────────────▼──────────────────┐
              │           OPAL Backend               │
              │  ┌────────┐ ┌────────┐ ┌──────────┐ │
              │  │ Event  │ │ Merkle │ │ Workflow  │ │
              │  │Listener│ │  Gen.  │ │ Engine   │ │
              │  └───┬────┘ └───┬────┘ └────┬─────┘ │
              └──────┼──────────┼───────────┼───────┘
                     │          │           │
    ┌────────────────┼──────────┼───────────┼────────────────────┐
    │                │   Polygon RPC        │                    │
    │   ┌────────────▼──────────▼───────────▼────────────┐       │
    │   │        FloodPredictionContract (HUB)           │       │
    │   └──┬──────┬──────┬──────┬────────────────────────┘       │
    │      │      │      │      │          ▲                     │
    │  ┌───▼──┐┌──▼──┐┌──▼──┐┌──▼──┐  ┌────┴──────────┐         │
    │  │Multi ││Joka-││KYC  ││MMP  │  │Opal           │         │
    │  │Oracle││lanté││AML  ││     │  │Governance     │         │
    │  └──────┘└─────┘└─────┘└─────┘  │(appelle FPC   │         │
    │     ▲                            │ et MO via     │         │
    │     │                            │ executePropo- │         │
    │     │                            │ sal)          │         │
    │     │                            └───┬───────────┘         │
    │     │                                │ config               │
    │     │                                ▼                     │
    │     │                           ┌──────────────┐           │
    │     │                           │Multi Oracle  │           │
    │     │                           │(même contrat)│           │
    │     │                           └──────────────┘           │
    │     │                                                      │
    │  ┌──┴──────────┐                                           │
    │  │WASDI Oracle │   ◄── Aucun lien on-chain avec            │
    │  │Connector    │       MultiOracle. Alimentés               │
    │  └──▲──────────┘       indépendamment par les relayers.    │
    │     │                                                      │
    │     │  Off-chain Relayers ─ ─ ─ ─► MultiOracle             │
    │     │  (submitSatelliteData)       (submitData/commitData)  │
    │     │                                                      │
    │     │                     ┌─ ─ ─ ─ ─ ─ ─ ─ ─ ─┐           │
    │     │                     │ MMP émet des events │           │
    │     │                     │ écoutés off-chain   │           │
    │     │                     └─ ─ ─ ─ ─ ┬ ─ ─ ─ ─┘           │
    │     │                                │ BLOCKCHAIN           │
    └─────┼────────────────────────────────┼─────────────────────┘
          │                                │ (off-chain)
   ┌──────┴──────┐               ┌────────▼────────┐
   │ WASDI       │               │ Mobile Money    │
   │ Satellite   │               │ APIs            │
   │ Platform    │               │ (Orange, Wave,  │
   │             │               │  Free, E-Money) │
   └─────────────┘               └─────────────────┘
```

#### Légende des flèches (vérifiée vs code)

| Flèche | Type | Preuve dans le code |
|--------|------|---------------------|
| `FPC → MultiOracle` | Appel on-chain | `IMultiOracle(multiOracle).isConsensusReached()`, `.getConsensusRiskScore()` |
| `FPC → JokalanteTargeting` | Appel on-chain | `IJokalanteTargeting(...).verifyBeneficiary()`, `.markVerified()` |
| `FPC → KYCAMLCompliance` | Appel on-chain | `IKYCAMLCompliance(...).batchCheckCompliance()` |
| `FPC → MobileMoneyProvider` | Appel on-chain | `IMobileMoneyProvider(...).batchInitiatePayments()` |
| `GOV → FPC` | Appel on-chain | `executionTarget.call{gas}(proposal.data)` dans `executeProposal()` |
| `GOV → MultiOracle` | Appel on-chain (config) | `onlyOwnerOrGovernance` sur `setConsensusThreshold()`, etc. |
| `Relayer → WASDI` | Off-chain → on-chain | `submitSatelliteData()` (pas de lien WASDI→MO) |
| `Relayer → MultiOracle` | Off-chain → on-chain | `submitData()` / `commitData()` / `revealData()` |
| `MMP → Mobile Money APIs` | Off-chain (events) | `emit PaymentInitiated(...)` écouté par relayers |

---

## 3. Architecture Technique

### 3.1 Stack Technique

| Couche | Technologie | Version |
|--------|-------------|---------|
| **Blockchain** | Polygon PoS | Amoy (80002) / Mainnet (137) |
| **Langage** | Solidity | ^0.8.22 (compilé 0.8.28) |
| **Framework** | Hardhat | ^3.0.0 |
| **Librairies** | OpenZeppelin | ^5.4.0 (contracts + upgradeable) |
| **Client Ethereum** | ethers.js | ^6.14.0 |
| **Merkle Tree** | merkletreejs | ^0.6.0 |
| **Hash** | keccak256 | ^1.0.6 |
| **Optimiseur** | Solc Optimizer | 200 runs, viaIR=true |
| **Tests** | Mocha/Chai (Hardhat) | 339 tests, timeout 120s |

### 3.2 Topologie des Contrats

```
┌──────────────────────────────────────────────────────────────────┐
│                        UUPS PROXY LAYER                          │
│                                                                  │
│  ┌───────── ───────────────┐ ┌────────────────────────────────┐  │
│  │  ERC1967 Prox y         │ │  ERC1967 Proxy                 │  │
│  │  ↓                      │ │  ↓                             │  │
│  │  FloodPredictionContract│ │  OpalGovernanceUpgradeable     │  │
│  │  (Implementation V3)    │ │  (Implementation)              │  │
│  │  Storage Gaps: 48       │ │  Storage Gaps: 47              │  │
│  └───────────────── ───────┘ └────────────────────────────────┘  │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│                      STANDARD CONTRACTS                          │
│                                                                  │
│  ┌──────────────┐ ┌────────────────┐ ┌───────────────────────┐   │
│  │ MultiOracle  │ │ JokalanteTarget│ │ KYCAMLCompliance      │   │
│  │ Ownable2Step │ │ Ownable2Step   │ │ Ownable2Step          │   │
│  │ Pausable     │ │                │ │                       │   │
│  │ ReentrancyG. │ │                │ │                       │   │
│  └──────────────┘ └────────────────┘ └───────────────────────┘   │
│                                                                  │
│  ┌──────────────────────┐ ┌──────────────────────────────────┐   │
│  │ MobileMoneyProvider  │ │ WASDIOracleConnector             │   │
│  │ Ownable2Step         │ │ Ownable2Step                     │   │
│  │ Pausable             │ │ Pausable                         │   │
│  │ ReentrancyGuard      │ │ ReentrancyGuard                  │   │
│  └──────────────────────┘ └──────────────────────────────────┘   │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│                        LIBRARIES                                 │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ FloodPredictionLib                                       │    │
│  │  generateEventId() | hashBeneficiary() |calculateCooldown│    │
│  │  uint2str() | isValidRiskScore()                         │    │
│  └──────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
```

### 3.3 Hiérarchie d'héritage

```
FloodPredictionContract (UUPS Proxy)
├── Initializable
├── AccessControlUpgradeable        ← RBAC (4 rôles)
├── UUPSUpgradeable                 ← Autorisation upgrade
├── PausableUpgradeable             ← Pause d'urgence
├── ReentrancyGuardTransient        ← EIP-1153 (transient storage)
└── IFloodPrediction                ← Interface publique

OpalGovernanceUpgradeable (UUPS Proxy)
├── Initializable
├── Ownable2StepUpgradeable         ← Transfert de propriété sécurisé
├── UUPSUpgradeable
└── IOpalGovernance

MultiOracle (Standard)
├── Ownable2Step
├── ReentrancyGuard
├── Pausable
└── IMultiOracle

JokalanteTargeting (Standard)
├── Ownable2Step
└── IJokalanteTargeting

KYCAMLCompliance (Standard)
├── Ownable2Step
└── IKYCAMLCompliance

MobileMoneyProvider (Standard)
├── Ownable2Step
├── Pausable
├── ReentrancyGuard
└── IMobileMoneyProvider

WASDIOracleConnector (Standard)
├── Ownable2Step
├── Pausable
├── ReentrancyGuard
└── IWASDIOracle
```

### 3.4 Modèle de Contrôle d'Accès (RBAC)

#### FloodPredictionContract

| Rôle | Permissions | Détenteur |
|------|-------------|-----------|
| `ADMIN_ROLE` | Override gouvernance, mode urgence, annuler triggers, budget, adresses contrats, seuils | Admin wallet |
| `OPERATOR_ROLE` | Créer triggers (risque ≥ seuil), valider triggers, traiter paiements | Opérateur wallet |
| `UPGRADER_ROLE` | Autoriser implémentation UUPS | Upgrader wallet |
| `PAUSER_ROLE` | Pause / unpause d'urgence | Pauser wallet |

#### OpalGovernance

| Rôle | Permissions |
|------|-------------|
| `ADMIN` | Gestion acteurs, whitelist selectors, toutes opérations gouvernance |
| `GOVERNOR` | Créer, signer, exécuter des propositions |
| `OBSERVER` | Signer des propositions (consultatif) |

#### Contrats Standard

| Contrat | Propriétaire (Ownable2Step) | Autorisés |
|---------|---------------------------|-----------|
| MultiOracle | Admin | Oracles actifs (submitData) |
| JokalanteTargeting | Admin | Owner + FloodPredictionContract (markVerified) |
| KYCAMLCompliance | Admin | Owner + contrats autorisés (isCompliant) |
| MobileMoneyProvider | Admin | Relayers whitelistés (confirm/fail) |
| WASDIOracleConnector | Admin | Relayers whitelistés (submitSatelliteData) |

### 3.5 Architecture de Déploiement

#### Ordre de déploiement

```
Phase 1 — Contrats indépendants (parallélisable)
  ① MultiOracle
  ② WASDIOracleConnector
  ③ JokalanteTargeting
  ④ MobileMoneyProvider
  ⑤ KYCAMLCompliance

Phase 2 — Contrats proxy
  ⑥ OpalGovernanceUpgradeable (UUPS Proxy)
  ⑦ FloodPredictionContract (UUPS Proxy)

Phase 3 — Wiring post-déploiement
  ⑧ FPC.setContractAddresses(multiOracle, governance, targeting, mobileMoney, kyc)
  ⑨ FPC.grantRole(OPERATOR_ROLE, operatorAddress)
  ⑩ FPC.grantRole(PAUSER_ROLE, pauserAddress)
  ⑪ FPC.allocateBudget() pour chaque région

Phase 4 — Configuration régions Sénégal
  • Thiès (SN-TH)
  • Dakar (SN-DK)
  • Saint-Louis (SN-SL)
  • Ziguinchor (SN-ZG)
  • Kaolack (SN-KL)
  • Tambacounda (SN-TC)
```

#### Réseaux configurés

| Réseau | Chain ID | Usage | Gas |
|--------|---------|-------|-----|
| Hardhat (EDR) | 1337 | Tests locaux | 60M gas limit |
| Localhost | 31337 | Dev local | Default |
| Polygon Mainnet | 137 | Production | 50 gwei |
| Polygon Amoy | 80002 | Testnet | Default |
| Sepolia | 11155111 | Tests Ethereum | Default |
| Arbitrum Sepolia | 421614 | Tests L2 | Default |
| Arbitrum One | 42161 | Production L2 | Default |

### 3.6 Sécurité & Conformité

#### Protection anti-attaques

| Vecteur | Protection | Contrat(s) |
|---------|-----------|------------|
| Reentrancy | `ReentrancyGuardTransient` (EIP-1153) | FPC |
| Reentrancy | `ReentrancyGuard` classique | MultiOracle, MMP, WASDI |
| Front-running | Commit-Reveal (2min commit, 10min reveal) | MultiOracle |
| TOCTOU | Tolérance oracle ±10 points | FPC ↔ MultiOracle |
| Replay attack | Nonce par région + nonce global | FPC, MMP |
| Hash collision | `abi.encode` (pas `abi.encodePacked`) | JokalanteTargeting, Lib |
| Second preimage | Double-hash `keccak256(keccak256(...))` | JokalanteTargeting |
| Duplicate batch | Rejet doublons dans les batch | MMP |
| Pause d'urgence | `Pausable` sur fonctions critiques | Tous |
| Upgrade non autorisé | Dual-control (governance + owner) | FPC, OpalGov |

#### Conformité RGPD / NDPD

| Exigence | Implémentation |
|----------|---------------|
| Pas de PII on-chain | Hash keccak256 uniquement |
| Téléphones protégés | `phoneHash` au lieu du numéro |
| Identités protégées | `identityHash` (pas de CNI on-chain) |
| Documents protégés | `documentHash` (pas de pièces stockées) |
| Audit trail | Événements immuables pour chaque changement d'état |
| Principe 4-yeux | KYC : soumetteur ≠ approbateur |
| Expiration données | Durée de validité KYC et Merkle trees |

---

## 4. Call Flows

### 4.1 CF-1 : Ingestion de données satellite

> **Acteur** : WASDI Relayer (off-chain)  
> **Contrats** : WASDIOracleConnector

```
WASDI Satellite API          WASDI Relayer              WASDIOracleConnector
      │                           │                              │
      │  Données Sentinel-1/2     │                              │
      │  MODIS, Landsat, VIIRS    │                              │
      ├──────────────────────────►│                              │
      │                           │                              │
      │                           │  submitSatelliteData(        │
      │                           │    region="SN-TH",           │
      │                           │    riskScore=75,             │
      │                           │    rainfall=150,             │
      │                           │    soilMoisture=85,          │
      │                           │    waterLevel=250,           │
      │                           │    source=Sentinel1)         │
      │                           ├─────────────────────────────►│
      │                           │                              │
      │                           │                              │ Validation:
      │                           │                              │ ✓ relayer autorisé
      │                           │                              │ ✓ risk ∈ [0,100]
      │                           │                              │ ✓ rainfall ∈ [0,2000]
      │                           │                              │ ✓ soilMoisture ∈ [0,100]
      │                           │                              │ ✓ waterLevel ∈ [0,10000]
      │                           │                              │ ✓ source valide
      │                           │                              │
      │                           │                              │ Stockage circular buffer
      │                           │                              │ (max 100 entrées/région)
      │                           │                              │
      │                           │                              │ if |new - prev| > 40:
      │                           │                              │   emit AnomalyDetected
      │                           │                              │
      │                           │                              │ if risk ≥ alertThreshold(70):
      │                           │                              │   emit HighRiskDetected
      │                           │                              │
      │                           │  emit SatelliteDataSubmitted │
      │                           │◄─────────────────────────────┤
      │                           │                              │
```

### 4.2 CF-2 : Consensus multi-oracle

> **Acteurs** : Oracle Relayers (≥4)  
> **Contrat** : MultiOracle

#### Mode direct

```
Oracle 1..N                           MultiOracle
    │                                      │
    │  submitData(region, riskScore,       │
    │             dataSource)              │
    ├────────────────────────────────────► │
    │                                      │ Validation:
    │                                      │ ✓ oracle actif
    │                                      │ ✓ pas de doublon dans fenêtre
    │                                      │ ✓ données fraîches (< 1h)
    │                                      │
    │                                      │ Réputation: +2 (normal) / -10 (outlier)
    │                                      │ if 3 outliers consécutifs → probation
    │                                      │ if 4 outliers consécutifs → désactivation
    │                                      │
    │                                      │ Si ≥60% oracles ont soumis:
    │                                      │   1. Calcul IQR [Q1, Q3]
    │                                      │   2. Filtrer outliers hors [Q1-1.5·IQR, Q3+1.5·IQR]
    │                                      │   3. Médiane des scores restants
    │                                      │
    │  emit ConsensusReached(              │
    │    region, riskScore, timestamp)     │
    │◄──────────────────────────────────── ┤
    │                                      │
```

#### Mode commit-reveal (anti-front-running)

```
Oracle                               MultiOracle
  │                                       │
  │  Phase 1 — COMMIT (2 min)             │
  │  commitData(region,                   │
  │    keccak256(risk,source,salt))       │
  ├──────────────────────────────────────►│
  │                                       │ Stockage commitHash + timestamp
  │                                       │
  │  Phase 2 — REVEAL (10 min window)     │
  │  revealData(region, riskScore,        │
  │             dataSource, salt)         │
  ├──────────────────────────────────────►│
  │                                       │ Vérification:
  │                                       │ ✓ keccak256(risk,source,salt) == commitHash
  │                                       │ ✓ dans fenêtre reveal
  │                                       │
  │                                       │ → Traitement identique au mode direct
  │                                       │
```

### 4.3 CF-3 : Création et validation d'un flood trigger

> **Acteur** : Opérateur  
> **Contrats** : FloodPredictionContract → MultiOracle

```
Opérateur                FloodPredictionContract            MultiOracle
    │                              │                             │
    │  createFloodTrigger(         │                             │
    │    region="SN-TH",           │                             │
    │    riskScore=75,             │                             │
    │    merkleRoot=0x...,         │                             │
    │    totalAmount=50000,        │                             │
    │    beneficiaryCount=100)     │                             │
    ├─────────────────────────────►│                             │
    │                              │ Validation:                 │
    │                              │ ✓ OPERATOR_ROLE             │
    │                              │ ✓ not paused                │
    │                              │ ✓ cooldown respecté         │
    │                              │ ✓ budget disponible         │
    │                              │ ✓ amount ∈ [MIN, MAX]       │
    │                              │                             │
    │                              │  isConsensusReached(region) │
    │                              ├────────────────────────────►│
    │                              │◄────────────────────────────┤
    │                              │  true                       │
    │                              │                             │
    │                              │  getConsensusRiskScore()    │
    │                              ├────────────────────────────►│
    │                              │◄────────────────────────────┤
    │                              │  consensusScore             │
    │                              │                             │
    │                              │ Vérification TOCTOU:        │
    │                              │ |riskScore - consensus| ≤   │
    │                              │  oracleTolerance (défaut 0, │
    │                              │  max 10)                    │
    │                              │                             │
    │                              │ committedBudget += total    │
    │                              │ Stockage trigger            │
    │                              │ eventId = generateEventId() │
    │                              │                             │
    │  emit FloodTriggerCreated    │                             │
    │◄─────────────────────────────┤                             │
    │                              │                             │
    │  validateTrigger(eventId)    │                             │
    ├─────────────────────────────►│                             │
    │                              │ ✓ trigger exists            │
    │                              │ ✓ status == ACTIVE          │
    │  emit TriggerValidated       │                             │
    │◄─────────────────────────────┤                             │
    │                              │                             │
```

### 4.4 CF-4 : Paiement batch aux bénéficiaires

> **Acteur** : Opérateur  
> **Contrats** : FPC → JokalanteTargeting → KYCAMLCompliance → MobileMoneyProvider

```
Opérateur         FPC                Jokalanté       KYC/AML       MobileMoneyProvider
    │               │                    │              │                  │
    │ processBatch- │                    │              │                  │
    │ Payment(      │                    │              │                  │
    │  eventId,     │                    │              │                  │
    │  hashes[50],  │                    │              │                  │
    │  amounts[50], │                    │              │                  │
    │  proofs[50],  │                    │              │                  │
    │  phoneHash[], │                    │              │                  │
    │  providers[]) │                    │              │                  │
    ├──────────────►│                    │              │                  │
    │               │                    │              │                  │
    │               │ batchCheckCompliance(hashes[])    │                  │
    │               ├──────────────────────────────────►│                  │
    │               │◄──────────────────────────────────┤                  │
    │               │ compliant[] (bool array)          │                  │
    │               │                    │              │                  │
    │               │ Pour chaque bénéficiaire (i = 0..49):                │
    │               │                    │              │                  │
    │               │ Si non-compliant → skip           │                  │
    │               │   emit KYCBeneficiarySkipped      │                  │
    │               │                    │              │                  │
    │               │ verifyBeneficiary( │              │                  │
    │               │  region,hash,      │              │                  │
    │               │  amount,proof)     │              │                  │
    │               ├───────────────────►│              │                  │
    │               │◄───────────────────┤              │                  │
    │               │ true/false         │              │                  │
    │               │                    │              │                  │
    │               │ markVerified()     │              │                  │
    │               ├───────────────────►│              │                  │
    │               │                    │              │                  │
    │               │ [Fin boucle per-bénéficiaire]     │                  │
    │               │                    │              │                  │
    │               │ spentAmount +=     │              │                  │
    │               │ committedBudget -= │              │                  │
    │               │                    │              │                  │
    │               │ batchInitiatePayments(            │                  │
    │               │   hashes[], amounts[],            │                  │
    │               │   phoneHashes[], regions[],       │                  │
    │               │   providers[])                    │                  │
    │               ├─────────────────────────────────────────────────────►│
    │               │                    │              │                  │
    │               │                    │              │  Validation:     │
    │               │                    │              │  ✓ pas doublons  │
    │               │                    │              │  ✓ amount valide │
    │               │                    │              │  ✓ daily limit   │
    │               │                    │              │                  │
    │               │◄─────────────────────────────────────────────────────┤
    │               │ paymentIds[]       │              │                  │
    │               │                    │              │                  │
    │ emit Batch-   │                    │              │                  │
    │ PaymentProc.  │                    │              │                  │
    │◄──────────────┤                    │              │                  │
    │               │                    │              │                  │
```

### 4.5 CF-5 : Confirmation de paiement Mobile Money

> **Acteur** : Mobile Money Relayer (off-chain)  
> **Contrat** : MobileMoneyProvider

```
Orange Money /       Mobile Money            MobileMoneyProvider
Wave / Free /        Relayer
E-Money API
    │                     │                          │
    │  Réponse paiement   │                          │
    │  (succès/échec)     │                          │
    ├────────────────────►│                          │
    │                     │                          │
    │                     │  [Si succès]             │
    │                     │  confirmPayment(         │
    │                     │    paymentId,            │
    │                     │    transactionRef)       │
    │                     ├─────────────────────────►│
    │                     │                          │ Status: PENDING → CONFIRMED
    │                     │  emit PaymentConfirmed   │
    │                     │◄─────────────────────────┤
    │                     │                          │
    │                     │  [Si échec]              │
    │                     │  failPayment(            │
    │                     │    paymentId, reason)    │
    │                     ├─────────────────────────►│
    │                     │                          │ Status: PENDING → FAILED
    │                     │                          │ dailySpent -= amount (refund)
    │                     │  emit PaymentFailed      │
    │                     │◄─────────────────────────┤
    │                     │                          │
    │                     │  [Si retry possible]     │
    │                     │  retryPayment(paymentId) │
    │                     ├─────────────────────────►│
    │                     │                          │ ✓ retryCount < MAX_RETRIES (3)
    │                     │                          │ Status: FAILED → PENDING
    │                     │                          │ Timeout reset
    │                     │  emit PaymentRetried     │
    │                     │◄─────────────────────────┤
    │                     │                          │
    │                     │  [Si timeout expiré]     │
    │                     │                          │ Status: PENDING → EXPIRED
    │                     │                          │ (after DEFAULT_TIMEOUT = 30min)
    │                     │                          │
```

### 4.6 CF-6 : Vérification KYC/AML (4-eyes)

> **Acteurs** : Officier A (soumetteur), Officier B (approbateur)  
> **Contrat** : KYCAMLCompliance

```
Officier A             KYCAMLCompliance              Officier B
    │                         │                           │
    │  submitAttestation(     │                           │
    │    beneficiaryHash,     │                           │
    │    identityHash,        │                           │
    │    documentHash,        │                           │
    │    region="SN-DK")      │                           │
    ├────────────────────────►│                           │
    │                         │ Status: NOT_VERIFIED →    │
    │                         │         PENDING           │
    │                         │ submitter = Officier A    │
    │  emit AttestSubmitted   │                           │
    │◄────────────────────────┤                           │
    │                         │                           │
    │                         │  approveAttestation(      │
    │                         │    beneficiaryHash,       │
    │                         │    riskLevel=LOW,         │
    │                         │    validityPeriod=365d)   │
    │                         │◄──────────────────────────┤
    │                         │                           │
    │                         │ ✓ msg.sender ≠ submitter  │
    │                         │   (4-eyes enforced)       │
    │                         │ ✓ status == PENDING       │
    │                         │                           │
    │                         │ Status: PENDING →         │
    │                         │         VERIFIED          │
    │                         │ expiresAt = now + 365d    │
    │                         │ approvedCount++           │
    │                         │                           │
    │                         │  emit AttestApproved      │
    │                         ├──────────────────────────►│
    │                         │                           │
    │                         │                           │
    │    --- Détection fraude (ultérieur) ---             │
    │                         │                           │
    │                         │  raiseFraudAlert(         │
    │                         │    beneficiaryHash,       │
    │                         │    "Multiple device IDs") │
    │                         │◄──────────────────────────┤
    │                         │ fraudAlertCount++         │
    │                         │                           │
    │                         │ Si count ≥ 3 (threshold): │
    │                         │   statusBefore = VERIFIED │
    │                         │   Status: → SUSPENDED     │
    │                         │   approvedCount--         │
    │                         │   emit BenefSuspended     │
    │                         │                           │
```

### 4.7 CF-7 : Gouvernance – Override d'urgence

> **Acteurs** : Gouverneurs (multi-sig)  
> **Contrats** : OpalGovernance → FloodPredictionContract

```
Gouverneur 1      OpalGovernance           Gouverneur 2/3    FloodPredictionContract
    │                   │                        │                    │
    │ createProposal(   │                        │                    │
    │  EMERGENCY_TRIGGER│                        │                    │
    │  description,     │                        │                    │
    │  data=encode(FPC. │                        │                    │
    │   createGovOverride│                       │                    │
    │   Trigger(...)),  │                        │                    │
    │  target=FPC)      │                        │                    │
    ├──────────────────►│                        │                    │
    │                   │ ✓ acteur ADMIN/GOVERNOR│                    │
    │                   │ ✓ selector whitelisté  │                    │
    │                   │ Auto-signe (1ère sign.)│                    │
    │                   │ deadline = 4h (urgence)│                    │
    │ emit ProposalCreated                       │                    │
    │◄──────────────────┤                        │                    │
    │                   │                        │                    │
    │                   │  signProposal(id)      │                    │
    │                   │◄───────────────────────┤                    │
    │                   │ signatures++           │                    │
    │                   │                        │                    │
    │                   │  signProposal(id)      │                    │
    │                   │◄───────────────────────┤ (Gov 3)            │
    │                   │ signatures++           │                    │
    │                   │ ✓ quorum atteint       │                    │
    │                   │                        │                    │
    │                   │  executeProposal(id)   │                    │
    │                   │◄───────────────────────┤                    │
    │                   │                        │                    │
    │                   │ EMERGENCY → pas de     │                    │
    │                   │ timelock (1h skip)     │                    │
    │                   │                        │                    │
    │                   │ ✓ selector whitelisté  │                    │
    │                   │ ✓ gas limit respecté   │                    │
    │                   │                        │                    │
    │                   │ Low-level call:         │                    │
    │                   │ target.call{gas:limit}  │                    │
    │                   │ (data)                  │                    │
    │                   ├────────────────────────────────────────────►│
    │                   │                        │                    │
    │                   │                        │    createGovernance│
    │                   │                        │    OverrideTrigger │
    │                   │                        │    (bypasses risk │
    │                   │                        │     threshold)    │
    │                   │                        │                    │
    │                   │◄────────────────────────────────────────────┤
    │                   │ success                │                    │
    │                   │                        │                    │
    │ emit ProposalExecuted                      │                    │
    │◄──────────────────┤                        │                    │
    │                   │                        │                    │
```

### 4.8 CF-8 : Upgrade UUPS

> **Contrats** : FloodPredictionContract et OpalGovernanceUpgradeable

#### a) Upgrade FPC (UPGRADER_ROLE uniquement)

```
Upgrader                               FloodPredictionContract (Proxy)
(UPGRADER_ROLE)                               │
    │                                          │
    │  upgradeToAndCall(newImpl, data)          │
    ├─────────────────────────────────────────►│
    │                                          │ _authorizeUpgrade(newImpl):
    │                                          │   ✓ UPGRADER_ROLE
    │                                          │   ✓ newImpl != address(0)
    │                                          │   ✓ newImpl a du code
    │                                          │
    │                                          │ ERC1967 slot update
    │                                          │ Implementation → newImpl
    │                                          │
    │  Upgrade effectué                        │
    │◄─────────────────────────────────────────┤
    │                                          │
```

#### b) Upgrade OpalGovernance (dual-control : Owner + Governance)

```
Gouvernance                    OpalGovernanceUpgradeable (Proxy)
(executeProposal)                     │
    │                                  │
    │  Proposition UPGRADE acceptée    │
    │  → approveUpgrade(newImpl)       │
    │  (appelable uniquement par       │
    │   address(this) via proposal)    │
    ├─────────────────────────────────►│
    │                                  │ approvedUpgrades[newImpl] = true
    │                                  │
    │                                  │
Owner                                 │
    │                                  │
    │  upgradeToAndCall(newImpl, data) │
    ├─────────────────────────────────►│
    │                                  │ _authorizeUpgrade(newImpl):
    │                                  │   ✓ onlyOwner
    │                                  │   ✓ approvedUpgrades[newImpl] == true
    │                                  │
    │                                  │ ERC1967 slot update
    │                                  │ Implementation → newImpl
    │                                  │
    │  Upgrade effectué                │
    │◄─────────────────────────────────┤
    │                                  │
```

> **Note** : Le dual-control (approvedUpgrades) s'applique uniquement à OpalGovernance.
> FPC n'exige que le UPGRADER_ROLE pour l'upgrade.

### 4.9 CF-9 : Flux complet end-to-end

> Scénario : Détection d'inondation dans la région de Thiès → paiement aux bénéficiaires

```
┌─────┐  ┌─────────┐  ┌────────┐  ┌─────┐  ┌───────┐  ┌─────┐  ┌─────┐  ┌────────┐
│WASDI│  │WASDI    │  │Multi   │  │FPC  │  │Joka-  │  │KYC  │  │MMP  │  │Mobile  │
│Sat. │  │Relayer  │  │Oracle  │  │(Hub)│  │lanté  │  │AML  │  │     │  │Money   │
│     │  │         │  │        │  │     │  │       │  │     │  │     │  │Relayer │
└──┬──┘  └────┬────┘  └───┬────┘  └──┬──┘  └───┬───┘  └──┬──┘  └──┬──┘  └───┬────┘
   │          │            │          │         │         │        │          │
   │ data     │            │          │         │         │        │          │
   ├─────────►│            │          │         │         │        │          │
   │          │            │          │         │         │        │          │
   │   ① submitSatelliteData(SN-TH, 75, ...)   │         │        │          │
   │          ├──►(WASDIOracleConnector)         │         │        │          │
   │          │            │          │         │         │        │          │
   │   Oracles 1..N soumettent via submitData / commit-reveal     │          │
   │          │    ②       │          │         │         │        │          │
   │          ├───────────►│          │         │         │        │          │
   │          │            │          │         │         │        │          │
   │          │   ③ ConsensusReached  │         │         │        │          │
   │          │   (SN-TH, score=75)   │         │         │        │          │
   │          │            │          │         │         │        │          │
   │          │            │  ④ createFloodTrigger(SN-TH, 75, merkleRoot, 50K, 100)
   │          │            │◄─────────┤         │         │        │          │
   │          │            │          │         │         │        │          │
   │          │            │ isConsensusReached? │         │        │          │
   │          │            ├─────────►│◄────────│         │        │          │
   │          │            │  ✓ true  │         │         │        │          │
   │          │            │          │         │         │        │          │
   │          │            │  ⑤ validateTrigger(eventId)  │        │          │
   │          │            │◄─────────┤         │         │        │          │
   │          │            │          │         │         │        │          │
   │          │            │  ⑥ processBatchPayment(...)  │        │          │
   │          │            │          ├─────────┤         │        │          │
   │          │            │          │         │         │        │          │
   │          │            │  ⑥a batchCheckCompliance()   │        │          │
   │          │            │          ├──────────────────►│        │          │
   │          │            │          │◄──────────────────┤        │          │
   │          │            │          │         │         │        │          │
   │          │            │  ⑥b verifyBeneficiary()      │        │          │
   │          │            │          ├────────►│  (×N)   │        │          │
   │          │            │          │◄────────┤         │        │          │
   │          │            │          │         │         │        │          │
   │          │            │  ⑥c markVerified() │  (×N)   │        │          │
   │          │            │          ├────────►│         │        │          │
   │          │            │          │         │         │        │          │
   │          │            │  ⑥d batchInitiatePayments()  │        │          │
   │          │            │          ├───────────────────────────►│          │
   │          │            │          │         │         │        │          │
   │          │ emit BatchPaymentProcessed      │         │        │          │
   │          │            │          │         │         │        │          │
   │   ⑦ Relayer poll paymentIds + appel API Mobile Money │        │          │
   │          │            │          │         │         │        ├─────────►│
   │          │            │          │         │         │        │          │
   │   ⑧ confirmPayment(paymentId, txRef) / failPayment()│        │          │
   │          │            │          │         │         │        │◄─────────┤
   │          │            │          │         │         │        │          │
   │   emit PaymentConfirmed / PaymentFailed    │         │        │          │
   │          │            │          │         │         │        │          │
```

**Étapes résumées :**

| # | Action | Contrat | Appelant |
|---|--------|---------|----------|
| ① | Ingestion satellite | WASDIOracleConnector | WASDI Relayer |
| ② | Soumission score risque | MultiOracle | Oracle Relayers (≥4) |
| ③ | Consensus atteint (IQR median) | MultiOracle | Automatique |
| ④ | Création flood trigger | FPC | Opérateur |
| ⑤ | Validation du trigger | FPC | Opérateur |
| ⑥ | Paiement batch (50 max) | FPC → Jokalanté → KYC → MMP | Opérateur |
| ⑦ | Appel API Mobile Money | Off-chain | MM Relayer |
| ⑧ | Confirmation/échec paiement | MobileMoneyProvider | MM Relayer |

---

## 5. Matrice des appels inter-contrats

```
                    Multi   WASDI   Joka-   KYC     MMP     Opal    FPC
                    Oracle  Oracle  lanté   AML     Money   Gov     (Hub)
                    ──────  ──────  ──────  ─────   ──────  ──────  ─────
FloodPrediction  │  READ    -       R/W     READ    WRITE   -       self
  Contract (FPC) │
                 │
MultiOracle      │  self    -       -       -       -       -       -
                 │
WASDI Oracle     │  -       self    -       -       -       -       -
  Connector      │
                 │
JokalanteTarget  │  -       -       self    -       -       -       -
                 │
KYCAMLCompliance │  -       -       -       self    -       -       -
                 │
MobileMoneyProv. │  -       -       -       -       self    -       -
                 │
OpalGovernance   │  WRITE   -       -       -       -       self    WRITE
                 │ (config)                                       (call)
```

**Légende :**
- **READ** : Appels en lecture (`view`/`pure`)
- **WRITE** : Appels en écriture (transactions d'état)
- **R/W** : Lecture + écriture

**Détail des appels cross-contract :**

| Appelant | Appelé | Fonction(s) | Type |
|----------|--------|-------------|------|
| FPC | MultiOracle | `isConsensusReached()`, `getConsensusRiskScore()` | READ |
| FPC | JokalanteTargeting | `verifyBeneficiary()` | READ |
| FPC | JokalanteTargeting | `markVerified()` | WRITE |
| FPC | KYCAMLCompliance | `batchCheckCompliance()` | READ |
| FPC | MobileMoneyProvider | `batchInitiatePayments()` | WRITE |
| OpalGovernance | FPC | `createGovernanceOverrideTrigger()` (via low-level call) | WRITE |
| OpalGovernance | FPC | `allocateBudget()`, autres (via selector whitelist) | WRITE |
| OpalGovernance | MultiOracle | `setConsensusThreshold()`, `setDataFreshnessThreshold()`, `setMaxConsecutiveOutliers()` (via `onlyOwnerOrGovernance`) | WRITE |

---

## 6. Constantes système

| Constante | Valeur | Contrat |
|-----------|--------|---------|
| `MAX_BATCH_SIZE` | 50 bénéficiaires | FPC, JokalanteTargeting, MMP |
| `DEFAULT_RISK_THRESHOLD` | 70% | FPC |
| `GOVERNANCE_RISK_THRESHOLD` | 85% (déclaré, non utilisé dans la logique) | FPC |
| `MIN_PAYMENT` | 500 CFA | FPC, MMP |
| `MAX_PAYMENT` | 5 000 000 CFA | FPC, MMP |
| `ORACLE_TOLERANCE` | 0 par défaut (max 10 pts) | FPC |
| `MAX_ORACLES` | 10 | MultiOracle |
| `MIN_ORACLE_COUNT` | 4 | MultiOracle |
| `CONSENSUS_THRESHOLD` | 60% | MultiOracle |
| `DATA_FRESHNESS` | 1 heure | MultiOracle |
| `COMMIT_PHASE` | 2 min | MultiOracle |
| `REVEAL_WINDOW` | 10 min | MultiOracle |
| `INITIAL_REPUTATION` | 50 | MultiOracle |
| `REPUTATION_BONUS` | +2 | MultiOracle |
| `REPUTATION_PENALTY` | −10 | MultiOracle |
| `DEFAULT_EXPIRY` | 90 jours | JokalanteTargeting |
| `MAX_BENEFICIARIES_PER_REGION` | 50 000 | JokalanteTargeting |
| `DEFAULT_VALIDITY_PERIOD` | 365 jours | KYCAMLCompliance |
| `FRAUD_THRESHOLD` | 3 alertes | KYCAMLCompliance |
| `MAX_RETRIES` | 3 | MobileMoneyProvider |
| `DEFAULT_TIMEOUT` | 30 min | MobileMoneyProvider |
| `MAX_TIMEOUT` | 24h | MobileMoneyProvider |
| `MAX_HISTORY_ENTRIES` | 100 par région | WASDIOracleConnector |
| `FRESHNESS_THRESHOLD` | 6 heures | WASDIOracleConnector |
| `ANOMALY_THRESHOLD` | 40 points | WASDIOracleConnector |
| `ALERT_THRESHOLD` | 70 | WASDIOracleConnector |
| `MAX_ACTORS` | 20 | OpalGovernance |
| `DEFAULT_DEADLINE` | 24h | OpalGovernance |
| `EMERGENCY_DEADLINE` | 4h | OpalGovernance |
| `EXECUTION_DELAY` | 1h (sauf urgence) | OpalGovernance |
| `MIN_QUORUM` | 2 | OpalGovernance |
| `EXECUTION_GAS_LIMIT` | 100K – 5M | OpalGovernance |
| `STORAGE_GAPS (FPC)` | 48 slots | FloodPredictionContract |
| `STORAGE_GAPS (Gov)` | 47 slots | OpalGovernance |

---

*Document généré dans le cadre du projet OPAL — DPA Foundation*  
*Dernière mise à jour : Avril 2026*
