# Documentation OPAL Platform — DPA Foundation

**Projet :** OPAL for Floods — DPA Foundation / Mercy Corps
**Période :** 15 février 2026 – 31 octobre 2026
**Version :** 1.0.0

---

## Index des livrables

Ce dossier contient l'ensemble des livrables documentaires correspondant aux 8 volets du contrat.

---

### Livrables Babacar Lo (Schedule A)

| # | Document | Volet | Échéance | Statut |
|---|----------|-------|----------|--------|
| 1 | [Évaluation des use cases blockchain](../BLOCKCHAIN_USE_CASE_ASSESSMENT.md) | Volet 1 | Mars 2026 | ✅ Livré |
| 2 | [Architecture technique et intégration système](../BLOCKCHAIN_ARCHITECTURE_DESIGN.md) | Volet 2 | Mars 2026 | ✅ Livré |
| 3 | [Spécifications des smart contracts](../SMART_CONTRACT_SPECIFICATIONS.md) | Volet 3 | Mars 2026 | ✅ Livré |
| 4 | [Résultats de tests des smart contracts](../SMART_CONTRACT_TEST_RESULTS.md) | Volet 4 | Avril 2026 | ✅ Livré |
| 5 | [Évaluation sécurité et conformité](../SECURITY_COMPLIANCE_ASSESSMENT.md) | Volet 5 | Avril 2026 | ✅ Livré |
| 6 | [Plan d'intégration avec la plateforme OPAL](../OPAL_INTEGRATION_PLAN.md) | Volet 6 | Avril–Mai 2026 | ✅ Livré |
| 7 | [Rapport de déploiement pilote](../PILOT_DEPLOYMENT_REPORT.md) | Volet 7 | Juin 2026 | 🔄 En cours |
| 8 | [Documentation technique](../TECHNICAL_DOCUMENTATION.md) | Volet 8 | Juin 2026 | ✅ Livré |
| 8b | [Guide de déploiement Amoy](./DEPLOYMENT_GUIDE_AMOY.md) | Volet 7–8 | Juin 2026 | ✅ Livré |

---

### Documents supplémentaires

| Document | Description |
|----------|-------------|
| [Rapport d'audit technique v2025](../TECHNICAL_AUDIT_2025.md) | Audit de sécurité initial (v3) |
| [Rapport de vérification des livrables](../DELIVERABLE_VERIFICATION_REPORT.md) | Matrice de conformité contractuelle |

---

## Structure du projet

```
flood-prediction-smart-contract/
│
├── contracts/                    # Smart contracts Solidity
│   ├── FloodPredictionContract.sol      # Orchestrateur principal (UUPS)
│   ├── OpalGovernanceUpgradeable.sol    # Gouvernance multi-sig (UUPS)
│   ├── MultiOracle.sol                  # Consensus IQR multi-oracle
│   ├── WASDIOracleConnector.sol         # Connecteur satellite WASDI
│   ├── JokalanteTargeting.sol           # Ciblage bénéficiaires (Merkle)
│   ├── KYCAMLCompliance.sol             # Conformité KYC/AML
│   ├── MobileMoneyProvider.sol          # Paiements Mobile Money
│   └── libs/FloodPredictionLib.sol      # Bibliothèque utilitaire
│
├── interfaces/                   # Interfaces Solidity
├── test/                         # 12 fichiers de tests (339 tests)
├── scripts/                      # Scripts de déploiement
│   ├── deploy-amoy.js            # Déploiement Polygon Amoy (résumable)
│   └── stress-test-1000.js       # Tests de charge
│
├── docs/                         # ← Ce dossier (documentation formelle)
│   ├── README.md                 # Index (ce fichier)
│   └── DEPLOYMENT_GUIDE_AMOY.md  # Guide déploiement testnet
│
└── hardhat.config.js             # Configuration Hardhat 3
```

---

## Rappel des livrables contractuels Babacar

### Livrable 1 — Architecture technique + spécifications oracle (Mars 2026) ✅

- Architecture des 7 smart contracts avec pattern hub-and-spoke
- Spécifications du système MultiOracle (IQR, réputation, freshness)
- Spécifications du WASDIOracleConnector (WASDI/satellite)
- **Documents :** `BLOCKCHAIN_ARCHITECTURE_DESIGN.md`, `SMART_CONTRACT_SPECIFICATIONS.md`

### Livrable 2 — Smart contracts déployés sur testnet + documentation de sécurité (Avril–Mai 2026) 🔄

- Code des contrats : ✅ v4.0.0 complet (7 contrats, 339 tests passants)
- Déploiement Polygon Amoy : 🔄 Script prêt — exécution en attente (voir `docs/DEPLOYMENT_GUIDE_AMOY.md`)
- Documentation de sécurité : ✅ `SECURITY_COMPLIANCE_ASSESSMENT.md` (score 93/100, 28 findings résolus)

### Livrable 3 — Intégration API Mobile Money (sandbox) + journaux de test (Juin 2026) 🔄

- `MobileMoneyProvider.sol` : ✅ Orange Money, Wave, Free Money, E-Money
- `SMART_CONTRACT_TEST_RESULTS.md` : ✅ Résultats détaillés des 339 tests
- Sandbox relayer off-chain : 🔄 Intégration en cours
