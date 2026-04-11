# Guide de Déploiement — Polygon Amoy Testnet

**Projet :** OPAL Platform — DPA Foundation
**Réseau cible :** Polygon Amoy (Chain ID: 80002)
**Statut actuel :** ✅ Déployé sur Amoy le 3 avril 2026

---

## Statut du déploiement (mis à jour le 2026-04-11)

| Composant | Statut | Détails |
|-----------|--------|--------|
| Code des contrats | ✅ Complet | v1.0.0 — 7 contrats + 1 bibliothèque |
| Script de déploiement | ✅ Prêt | `scripts/deploy-amoy.js` résumable |
| Suite de tests | ✅ 465/465 | 15 fichiers de test, 100% passants |
| Wallet testnet | ✅ Identifié | `0x135D3c5310046763b6bdA8A8ac0f507E1eEB1fF6` |
| Fonds MATIC (testnet) | ✅ Suffisant | ~0.3 MATIC requis |
| RPC Amoy | ✅ Vérifié | `https://polygon-amoy.drpc.org` (opérationnel) |
| Clé privée dans `.env` | ✅ Configurée | Wallet `0x135D3c...` |
| Déploiement effectif | ✅ **Effectué** | 3 avril 2026 — `deployment-amoy-1775228383698.json` |
| CI/CD | ✅ Actif | GitHub Actions (build, test, lint, size-check) |

---

## Pré-requis

### 1. Wallet de déploiement ✅ (déjà configuré)

| Paramètre | Valeur |
|-----------|--------|
| Adresse | `0x135D3c5310046763b6bdA8A8ac0f507E1eEB1fF6` |
| Solde Amoy | **0.4000 MATIC** (vérifié le 2026-04-01) |
| RPC configuré | `https://polygon-amoy.drpc.org` ✅ |

### 2. Configurer la clé privée dans `.env` ← **Seule action manquante**

Le fichier `.env` est prêt, seule la clé privée est à renseigner :

```env
# Remplacer cette ligne dans .env :
PRIVATE_KEY=VOTRE_CLE_PRIVEE_ICI

# Par la clé privée de 0x135D3c5310046763b6bdA8A8ac0f507E1eEB1fF6
# Format : 64 caractères hexadécimaux, avec ou sans préfixe 0x
```

Pour exporter la clé depuis MetaMask :
> Paramètres → Sécurité et confidentialité → Afficher la phrase secrète / Exporter la clé privée

> ⚠️ **Sécurité :** Ne jamais partager la clé privée. Le fichier `.env` est dans `.gitignore`.

### 3. Fonds MATIC ✅ (déjà suffisants)

Le wallet dispose de **0.4 MATIC** — le déploiement de 7 contrats coûte environ 0.25–0.35 MATIC.
Aucun faucet nécessaire.

---

## Procédure de déploiement

### Étape 1 — Vérifier l'environnement

```bash
# Installer les dépendances
npm install

# Compiler les contrats
npx hardhat compile

# Lancer la suite de tests (doit être 465/465)
npx hardhat test
```

### Étape 2 — Vérifier le solde du wallet

```bash
node -e "
const {ethers} = require('ethers');
require('dotenv').config();
const provider = new ethers.JsonRpcProvider(process.env.AMOY_RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
wallet.getBalance().then(b => {
  console.log('Adresse :', wallet.address);
  console.log('Solde    :', ethers.formatEther(b), 'MATIC');
  if (b < ethers.parseEther('0.1'))
    console.log('⚠️  Solde insuffisant — obtenir du MATIC via faucet');
  else
    console.log('✅ Solde suffisant pour le déploiement');
});
"
```

### Étape 3 — Lancer le déploiement

```bash
# Déploiement sur Amoy (résumable — peut être interrompu et repris)
npm run deploy:amoy

# Ou directement :
npx hardhat run scripts/deploy-amoy.js --network amoy
```

Le script est **résumable** : en cas d'interruption, relancer la même commande.
Le fichier `deployment-amoy-progress.json` sauvegarde chaque étape.

### Étape 4 — Vérifier le déploiement

À la fin du déploiement, le script génère un manifest :
```
deployment-amoy-TIMESTAMP.json
```

Ce fichier contient toutes les adresses de contrats. Il sera automatiquement sauvegardé et
constitue la preuve du déploiement.

Le script vérifie aussi les contrats sur Polygonscan automatiquement si `POLYGONSCAN_API_KEY`
est configurée. Les contrats seront accessibles sur :
```
https://amoy.polygonscan.com/address/<ADRESSE_CONTRAT>
```

---

## Contrats déployés (ordre et configuration)

```
Étape 1/8 : MultiOracle
Étape 2/8 : WASDIOracleConnector
Étape 3/8 : JokalanteTargeting
Étape 4/8 : MobileMoneyProvider
Étape 6/8 : KYCAMLCompliance
Étape 7/8 : OpalGovernanceUpgradeable (UUPS Proxy)
Étape 8/8 : FloodPredictionContract (UUPS Proxy)
Post-deployment : Wiring + configuration
            ├── Liaison des adresses de contrats
            ├── Attribution des rôles (OPERATOR_ROLE, PAUSER_ROLE)
            ├── Configuration des budgets régionaux (6 régions)
            ├── Configuration de la gouvernance
            └── Enregistrement de l'oracle
```

### Régions pré-configurées

| Code | Région | Budget (FCFA) |
|------|--------|---------------|
| SN-TH | Thiès | 1 000 000 |
| SN-DK | Dakar | 2 000 000 |
| SN-SL | Saint-Louis | 1 500 000 |
| SN-ZG | Ziguinchor | 1 200 000 |
| SN-KL | Kaolack | 800 000 |
| SN-TC | Tambacounda | 600 000 |

---

## Scénario de test post-déploiement

Une fois les contrats déployés, exécuter ce scénario de validation :

```bash
# Test de bout en bout sur le testnet
npx hardhat run scripts/interactive-test.js --network amoy
```

Ce script teste :
1. Soumission de données oracle WASDI
2. Calcul du consensus MultiOracle
3. Création d'un trigger de flood
4. Vérification Merkle d'un bénéficiaire
5. Traitement d'un paiement batch (simulation)

---

## Résolution des problèmes courants

| Erreur | Cause | Solution |
|--------|-------|----------|
| `insufficient funds` | Solde MATIC insuffisant | Obtenir du MATIC via faucet |
| `nonce too low` | Transaction en attente | Attendre ou reset MetaMask |
| `PRIVATE_KEY undefined` | `.env` non configuré | Vérifier `.env` |
| `network timeout` | RPC public surchargé | Utiliser un RPC dédié (Alchemy/Infura) |
| `already deployed` | Reprise d'un déploiement partiel | Normal — le script reprend là où il s'est arrêté |
| `OracleRiskScoreMismatch` | Score soumis ≠ consensus oracle | Ajuster `oracleTolerance` (défaut 0) |

---

## Résultats du déploiement (3 avril 2026)

Le déploiement a été effectué avec succès sur le réseau Amoy. Manifest : `deployment-amoy-1775228383698.json`

| Contrat | Adresse | Type |
|---------|---------|------|
| MultiOracle | `0x16ffB4CdDfc05E5064AF0f547B149CEd40efEABA` | Direct |
| WASDIOracleConnector | `0x76531a00CAd031aB1f1576cb7B6332C5ce6101De` | Direct |
| JokalanteTargeting | `0x4CB2ad83eE9c187b8393E853c0fdb9d9027e9E32` | Direct |
| MobileMoneyProvider | `0x25c34c8C4a62Bf1ab4566cA64208CAf537DC5150` | Direct |
| KYCAMLCompliance | `0x9e319566185b01556081C1b6C66B47ed7986daD7` | Direct |
| OpalGovernance (Proxy) | `0xC07bC08B3e35B4bd8D238aEf644BD9697b8b4B7a` | UUPS Proxy |
| OpalGovernance (Impl) | `0x4379Deb01104fB3F4442e69a0F6CcE44C0BC7E53` | Implementation |
| FloodPrediction (Proxy) | `0x5c9733cBdACa3B88E7F7EE35d31a5C34F972201f` | UUPS Proxy |
| FloodPrediction (Impl) | `0xEcDD523F826fbbF6DfAAe4A0D485f91ed28D9509` | Implementation |

**Deployer** : `0x135D3c5310046763b6bdA8A8ac0f507E1eEB1fF6`  
**Durée** : 58.1s  
**Explorer** : [FloodPrediction sur Polygonscan](https://amoy.polygonscan.com/address/0x5c9733cBdACa3B88E7F7EE35d31a5C34F972201f)

---

## Livraison à DPA

Une fois le déploiement effectué, fournir à DPA :

1. **Le manifest JSON** : `deployment-amoy-TIMESTAMP.json`
2. **Les liens Polygonscan** :
   - `https://amoy.polygonscan.com/address/<FloodPredictionProxy>`
   - `https://amoy.polygonscan.com/address/<OpalGovernanceProxy>`
3. **Les logs de test** : sortie de `npx hardhat test` (465 tests)
4. **Le rapport de déploiement** : `PILOT_DEPLOYMENT_REPORT.md` mis à jour

---

*Document mis à jour le 2026-04-11 — OPAL Platform v1.0.0*
