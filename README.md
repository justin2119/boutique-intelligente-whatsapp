# Boutique intelligente : le vendeur WhatsApp

Agent IA vendeur WhatsApp pour une boutique de pagnes au marché Dantokpa (Cotonou, Bénin).

## Contexte

Le marché Dantokpa est l'un des plus grands marchés à ciel ouvert d'Afrique de l'Ouest. Les vendeurs de tissus (pagnes) reçoivent une grande partie de leurs demandes par WhatsApp : demandes de prix, disponibilité des motifs, photos, livraison. Ce projet vise à automatiser une partie de ces échanges avec un agent IA qui répond aux clients sur WhatsApp, consulte le catalogue de la boutique et aide à finaliser la vente.

## Architecture

- Messagerie : WhatsApp, via l'API Green API (webhooks entrants et envoi de messages sortants).
- Backend : Cloudflare Worker écrit en TypeScript, qui reçoit les webhooks Green API et orchestre l'agent.
- Agent : logique de conversation, outils (consultation du catalogue, prix, stock, panier), et mémoire de conversation par client.
- Données : catalogue de pagnes en fichiers JSON versionnés dans `data/catalog/`.
- Tests : `tests/`.

Structure initiale :

```
src/
  worker/   point d'entrée Cloudflare Worker (webhooks Green API)
  agents/   logique de l'agent vendeur
  tools/    outils appelables par l'agent (catalogue, prix, stock)
  types/    types TypeScript partagés
data/
  catalog/  catalogue des pagnes (JSON)
tests/
```

## Palier 1 : architecture

Le Palier 1 implémente un agent unique (`SingleAgent`) qui enchaîne plusieurs outils dans une boucle de raisonnement et d'action, avec une limite de 6 étapes. Un modèle à règles (`rule-based-llm`) remplace le LLM pour rendre le scénario reproductible hors ligne. Le client client OpenAI (`openai-client.ts`) est prévu pour le fonctionnement réel.

Modules :

- `src/data/catalog.ts` : chargement du catalogue (`data/catalog/products.json`) et des zones de livraison (`data/catalog/delivery-zones.json`).
- `src/tools/` : registre d'outils (`index.ts`), avec validation des arguments (`validation.ts`) et utilitaires de texte (`text.ts`).
- `src/agents/single-agent.ts` : boucle agent (pensée, action, observation, réponse finale), limite de 6 étapes.
- `src/agents/rule-based-llm.ts` : LLM déterministe pour la démo et les tests.
- `src/agents/trace.ts` : rendu Markdown de la trace d'exécution.
- `src/types/index.ts` : types partagés (résultats d'outils, traces).
- `src/runtime.ts` : accès aux arguments de ligne de commande.

## Palier 1 : outils

- `search_product` : recherche d'un produit dans le catalogue par termes (nom, couleur, motif).
- `check_stock` : vérifie le stock d'un produit pour une quantité donnée. En cas de rupture, propose des alternatives disponibles. Refuse les identifiants inconnus.
- `calculate_delivery` : calcule les frais et le délai de livraison pour une zone. Gère les alias (par exemple Calavi vers le centre) et demande une précision pour les lieux ambigus (par exemple Cotonou seul).
- `convert_currency` : convertit un montant en FCFA vers une devise cible. Utilise un taux en direct si disponible, sinon un taux de repli.
- `create_order` : crée une commande en statut PENDING_CONFIRMATION (total = articles + livraison). Refuse une commande si un article est en rupture.

## Palier 1 : spécifications

- Le client demande un produit et une quantité, indique son lieu de livraison et une devise.
- L'agent vérifie le stock, propose une alternative en cas de rupture, calcule la livraison et convertit le total.
- L'agent ne finalise pas la commande sans accord explicite du client.

## Palier 2 : architecture multi-agents

Le Palier 2 remplace l'agent unique par un orchestrateur qui délègue à quatre agents spécialisés. Le code est dans `src/agents/` et les types dans `src/types/palier2.ts`.

- Manager (`manager-agent.ts`) : classe l'intention du message (`product_inquiry`, `delivery_inquiry`, `order_request`, `unknown`), lit la quantité et l'option de livraison (standard ou express), décide des délégations, agrège les résultats et déclenche la validation humaine pour toute commande.
- Vendeur (`seller-agent.ts`) : recherche le produit dans le catalogue par termes, vérifie le stock pour la quantité demandée et, en cas de rupture, propose les alternatives déclarées dans le catalogue qui sont en stock.
- Logisticien (`logistics-agent.ts`) : calcule les frais et le délai pour une zone. Standard : tarif de base de `delivery-zones.json`. Express : frais multipliés par 1,5 (arrondi), délai réduit d'un jour avec un minimum de 1 jour. Les lieux ambigus (par exemple Cotonou seul) et les zones inconnues sont signalés.
- Formateur WhatsApp (`formatter-agent.ts`) : rédige la réponse en français, avec le ton d'un commerçant du marché Dantokpa, des puces, le détail des montants (articles, livraison, total) et un appel à l'action.

Les montants sont au format FCFA (`formatFcfa` dans `normalize.ts`).

## Palier 2 : supervision humaine (HITL)

Toute commande assemblée par le Manager est enregistrée dans le validateur (`hitl.ts`) avec le statut `PENDING_HUMAN_VALIDATION`. La commande n'est pas finalisée sans décision explicite :

1. Le Manager assemble le brouillon (référence `CMD-...`, lignes, sous-total, frais de livraison, total, délai) et l'enregistre (`VAL-0001`, `VAL-0002`, ...).
2. Le client reçoit un récapitulatif avec la mention qu'une validation est en cours.
3. Une décision humaine (gérant ou client) passe la commande à `CONFIRMED` (approuvée) ou `REJECTED` (refusée).
4. Une validation déjà traitée ne peut pas être décidée une seconde fois : le système renvoie une erreur.

Le Manager ne met en validation que si le produit est disponible et la livraison chiffrée. Sinon la commande n'est pas assemblée.

## Palier 2 : démo, trace et tests

Le scénario de démo (`src/demo-palier2.ts`) enchaîne une demande de « super wax vert » pour 2 pagnes livrés à Dantokpa en express (SW-003 en rupture, alternative SW-002), puis une commande de 2 x SW-002 en express, puis la validation humaine.

Lancer la démo :

```
pnpm run demo:palier2
```

Lancer les tests du Palier 2 (routage du Manager, alternatives du Vendeur, frais standard et express, transitions HITL) :

```
pnpm run test:palier2
```

La trace de ce scénario est documentée dans [docs/traces/trace-palier2.md](docs/traces/trace-palier2.md). Les tests sont dans [tests/palier2.test.ts](tests/palier2.test.ts).

## Palier 1 : démo et trace

Scénario de démo : recherche de "super wax vert" (SW-003 en rupture), proposition de l'alternative SW-002, livraison à Dantokpa, conversion en euros.

Lancer la démo :

```
pnpm run demo:palier1
```

La trace complète de l'exécution (5 appels d'outils, résultats et réponse finale) est documentée dans [docs/traces/trace-palier1.md](docs/traces/trace-palier1.md). Les tests du Palier 1 sont dans [tests/palier1.test.ts](tests/palier1.test.ts) (15 vérifications).

## Outils

- TypeScript
- Cloudflare Workers et Wrangler
- Green API (WhatsApp)
- tsx (exécution locale de la démo)

## Installation

Prérequis : Node.js 20 ou plus récent, pnpm (ou npm).

```
pnpm install
cp .dev.vars.example .dev.vars   # renseigner les clés Green API (ne jamais committer ce fichier)
pnpm dev                         # lancement local avec Wrangler
pnpm typecheck
pnpm run demo:palier1            # démo du Palier 1
pnpm run demo:palier2            # démo du Palier 2
pnpm run test:palier2            # tests du Palier 2
pnpm deploy                      # déploiement sur Cloudflare
```

Les secrets (identifiant et jeton d'instance Green API, clé d'API LLM) doivent être stockés dans `.dev.vars` en local et via `wrangler secret put` en production.
