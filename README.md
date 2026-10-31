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

## Spécifications des paliers

Palier 1, Palier 2 et Palier 3 : les spécifications détaillées seront ajoutées ici à partir de l'énoncé officiel de l'exercice (RodiumAi Bootcamp, "Exercice · Boutique intelligente, le vendeur WhatsApp"). Cette section est à compléter.

- Palier 1 : (à compléter)
- Palier 2 : (à compléter)
- Palier 3 : (à compléter)

## Outils

- TypeScript
- Cloudflare Workers et Wrangler
- Green API (WhatsApp)

## Installation

Prérequis : Node.js 20 ou plus récent, pnpm (ou npm).

```
pnpm install
cp .dev.vars.example .dev.vars   # renseigner les clés Green API (ne jamais committer ce fichier)
pnpm dev                         # lancement local avec Wrangler
pnpm typecheck
pnpm deploy                      # déploiement sur Cloudflare
```

Les secrets (identifiant et jeton d'instance Green API, clé d'API LLM) doivent être stockés dans `.dev.vars` en local et via `wrangler secret put` en production.
