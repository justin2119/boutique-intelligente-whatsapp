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

Palier 2 et Palier 3 : (à compléter)

## Démo et trace

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
pnpm deploy                      # déploiement sur Cloudflare
```

Les secrets (identifiant et jeton d'instance Green API, clé d'API LLM) doivent être stockés dans `.dev.vars` en local et via `wrangler secret put` en production.
