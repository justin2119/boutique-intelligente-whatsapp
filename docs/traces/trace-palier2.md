# Trace Palier 2 : orchestration multi-agents et validation humaine

Scénario : demande de Super Wax vert pour 2 pagnes, livraison express à Dantokpa, puis commande et validation humaine.

Source du scénario : src/demo-palier2.ts (MESSAGE_INQUIRY et MESSAGE_ORDER, horloge fixée à 2026-10-31T18:35:43.000Z).

Remarque de méthode : cette trace a été produite en exécutant une transcription fidèle de la logique du dépôt (src/agents/manager-agent.ts, seller-agent.ts, logistics-agent.ts, hitl.ts, formatter-agent.ts, normalize.ts, data/catalog/products.json et delivery-zones.json) avec js-exec. La commande pnpm run demo:palier2 n'a pas été exécutée dans cet environnement. Les chiffres et messages ci-dessous sont ceux produits par cette exécution.

## Catalogue utilisé (data/catalog/products.json)

- SW-003 : Super Wax Émeraude Géométrique, vert et noir, 9 500 FCFA, stock 0 (rupture). Alternatives : SW-002, SW-001.
- SW-002 : Super Wax Rose Pétale, rose et blanc, 9 000 FCFA, stock 25.
- SW-001 : Super Wax Mariage Or, or et blanc, 9 500 FCFA, stock 60.

## Zone de livraison (data/catalog/delivery-zones.json)

- Dantokpa (cotonou-dantokpa) : frais standard 500 FCFA, délai 0 jour. Alias : marche dantokpa.
- Règle express (src/agents/logistics-agent.ts) : frais = frais standard x 1,5 (arrondi), délai = max(1, délai standard - 1).
- Résultat express Dantokpa : 750 FCFA, 1 jour.

## Étape 1 : demande produit et livraison

### 1.1 Message entrant (client WhatsApp)

« Bonjour, je cherche du super wax vert, 2 pagnes. Je livre à Dantokpa en express. Combien ça coûte ? »

### 1.2 Manager : classification et plan de délégation

- Intention : delivery_inquiry. La règle de livraison (« livr ») est testée avant la règle produit (« cherche »).
- Quantité détectée : 2 (motif « 2 pagnes »).
- Option de livraison détectée : express (mot « express »).
- Plan : déléguer au Vendeur (recherche et stock), puis au Logisticien (zone Dantokpa, option express), puis au Formateur.

Événement journalisé : Manager : intention « delivery_inquiry », quantité 2, option de livraison express.

### 1.3 Vendeur : recherche catalogue et vérification du stock

- Termes retenus : super, wax, vert.
- Meilleur score : SW-003 (« vert » dans les couleurs, « super » et « wax » dans le nom).
- Stock SW-003 : 0 pour 2 demandés. Rupture.
- Alternatives validées en stock (SW-002 : 25, SW-001 : 60) : SW-002 puis SW-001.
- Résultat délégué : rupture : SW-003, alternatives SW-002, SW-001.

### 1.4 Logisticien : calcul de livraison

- Lieu détecté : Dantokpa.
- Option : express.
- Frais : 500 x 1,5 = 750 FCFA. Délai : max(1, 0 - 1) = 1 jour.
- Résultat délégué : Dantokpa : 750 FCFA, 1 jour(s).

### 1.5 Formateur : réponse WhatsApp

La demande ne crée pas de commande : aucune validation humaine n'est déclenchée pour une simple question.

```text
Bonjour 🙏🏾

😔 *Super Wax Émeraude Géométrique* (SW-003) n'a pas assez de stock pour 2 unité(s).
✨ Je vous propose plutôt :
• *Super Wax Rose Pétale* (SW-002) : 9 000 FCFA l'unité, 25 disponible(s)
• *Super Wax Mariage Or* (SW-001) : 9 500 FCFA l'unité, 60 disponible(s)

🚚 Livraison express à Dantokpa : 750 FCFA, délai estimé 1 jour(s).

Merci de votre confiance, à bientôt sur Dantokpa 🧵🇧🇯
```

Délégations : vendeur (rupture, alternatives), logisticien (750 FCFA, 1 jour), formateur (398 caractères).

## Étape 2 : commande et validation humaine (HITL)

### 2.1 Message entrant

« Je prends la commande : 2 pagnes SW-002, livraison à Dantokpa en express. »

### 2.2 Manager : classification et délégation

- Intention : order_request (le mot « commande » est testé en premier).
- Quantité : 2. Option : express.
- Plan : Vendeur (SW-002), Logisticien (Dantokpa, express), puis mise en validation humaine si les deux résultats sont valides.

### 2.3 Vendeur

- SW-002 : 25 en stock, 2 demandés. Disponible.
- Sous-total : 2 x 9 000 = 18 000 FCFA.

### 2.4 Logisticien

- Dantokpa, express : 750 FCFA, 1 jour.

### 2.5 Assemblage et pause HITL

- Brouillon de commande CMD-MVWQRPJS : 2 x SW-002, sous-total 18 000 FCFA, livraison 750 FCFA, total 18 750 FCFA, zone Dantokpa, délai 1 jour.
- Enregistrement dans le validateur HITL : VAL-0001, statut PENDING_HUMAN_VALIDATION, créé le 2026-10-31T18:35:43.000Z.
- La commande n'est pas finalisée à ce stade. Le système attend une décision humaine.

Événements journalisés :
- Manager : intention « order_request », quantité 2, option de livraison express.
- Commande CMD-MVWQRPJS assemblée : statut PENDING_HUMAN_VALIDATION (VAL-0001). Validation humaine requise avant finalisation.

### 2.6 Formateur : message d'attente au client

```text
Bonjour 🙏🏾

✅ *Super Wax Rose Pétale* (SW-002) est disponible pour 2 pagne(s).
💰 Prix : 9 000 FCFA l'unité, soit 18 000 FCFA.

🚚 Livraison express à Dantokpa : 750 FCFA, délai estimé 1 jour(s).

🧾 *Récapitulatif CMD-MVWQRPJS*
• Super Wax Rose Pétale x2 : 18 000 FCFA
Articles : 18 000 FCFA
Livraison : 750 FCFA
*Total : 18 750 FCFA*
📦 Livraison à Dantokpa, délai estimé 1 jour(s).
⏳ Votre commande est en attente de validation par notre équipe. Nous vous confirmons dès qu'elle est validée.

Merci de votre confiance, à bientôt sur Dantokpa 🧵🇧🇯
```

Délégations : vendeur (disponible), logisticien (750 FCFA), hitl (VAL-0001 : PENDING_HUMAN_VALIDATION), formateur (553 caractères).

## Étape 3 : décision humaine et réponse finale

### 3.1 Décision

Le gérant valide la commande (décision by manager, approved true, note « Stock vérifié au magasin. »).

Transition : VAL-0001 PENDING_HUMAN_VALIDATION vers CONFIRMED, décidée par manager le 2026-10-31T18:35:43.000Z.

### 3.2 Réponse finale au client

```text
Bonjour 🙏🏾

🧾 *Récapitulatif CMD-MVWQRPJS*
• Super Wax Rose Pétale x2 : 18 000 FCFA
Articles : 18 000 FCFA
Livraison : 750 FCFA
*Total : 18 750 FCFA*
📦 Livraison à Dantokpa, délai estimé 1 jour(s).
🎉 Votre commande est confirmée. Merci pour votre achat !

Merci de votre confiance, à bientôt sur Dantokpa 🧵🇧🇯
```

## Bilan

- Routage : demande de livraison, puis commande, classés avec les règles de src/agents/manager-agent.ts.
- Vendeur : rupture de SW-003 détectée, alternatives SW-002 et SW-001 proposées avec leur stock.
- Logisticien : tarif express Dantokpa de 750 FCFA (500 x 1,5), délai 1 jour.
- HITL : une seule transition, PENDING_HUMAN_VALIDATION vers CONFIRMED.
- Montant final : 18 750 FCFA (18 000 articles + 750 livraison).

Tests associés : tests/palier2.test.ts (commande : pnpm run test:palier2).
