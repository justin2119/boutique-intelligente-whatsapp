# Boutique intelligente : le vendeur WhatsApp

Agent IA vendeur WhatsApp pour une boutique de pagnes au marché Dantokpa (Cotonou, Bénin).

## Contexte

Le marché Dantokpa est l'un des plus grands marchés à ciel ouvert d'Afrique de l'Ouest. Les vendeurs de tissus (pagnes) reçoivent une grande partie de leurs demandes par WhatsApp : demandes de prix, disponibilité des motifs, photos, livraison. Ce projet vise à automatiser une partie de ces échanges avec un agent IA qui répond aux clients sur WhatsApp, consulte le catalogue de la boutique et aide à finaliser la vente.

## Architecture

- Messagerie : WhatsApp, via l'API Green API (webhooks entrants et envoi de messages sortants).
- Backend : Cloudflare Worker écrit en TypeScript, qui reçoit les webhooks Green API et orchestre l'agent.
- Agent : logique de conversation, outils (consultation du catalogue, prix, stock, panier), et mémoire de conversation par client.
- Données : catalogue de pagnes en fichiers JSON versionnés dans `data/catalog/`, commandes dans D1, sessions et déduplication dans KV.
- LLM : RodiumAI (API compatible OpenAI), utilisé uniquement en repli. Voir la section suivante.
- Tests : `tests/`.

Structure :

```
src/
  worker/   point d'entrée Cloudflare Worker (webhooks Green API, routage HTTP)
  agents/   logique de l'agent vendeur (Manager, Vendeur, Logisticien, Formateur, HITL)
  services/ services externes (LLM RodiumAI en repli)
  data/     catalogue, stockage KV/D1 et mock mémoire
  lib/      client Green API
  tools/    outils appelables par l'agent (catalogue, prix, stock)
  types/    types TypeScript partagés
data/
  catalog/  catalogue des pagnes (JSON)
migrations/ schéma D1 (commandes)
tests/
```

## Architecture hybride : règles d'abord, LLM en repli

Le bot fonctionne en deux étages :

1. Règles déterministes (par défaut). Le Manager classe l'intention du message (`product_inquiry`, `delivery_inquiry`, `order_request`, `unknown`) par mots-clés et expressions, lit la quantité, le budget, l'option de livraison et le créneau, puis délègue au Vendeur, au Logisticien et au Formateur. Cette voie ne consomme aucun token et couvre la grande majorité des échanges (demandes de produit, de livraison, de commande, de créneau).
2. Repli RodiumAI (optionnel, seulement si l'intention est `unknown`). Le service `src/services/llm-service.ts` peut extraire des champs structurés (température 0) ou répondre en conseil consultatif (température 0.2) à partir d'un catalogue compacté. Les réponses du LLM ne fixent jamais un prix ou un stock : les montants restent calculés par les outils déterministes.

Si `RODIUM_API_KEY` n'est pas défini, aucun appel LLM n'est fait et le comportement reste entièrement déterministe.

Le client ne peut pas valider sa propre commande : toute commande reste en validation humaine (voir Palier 2).

## Optimisation des tokens

Objectif : consommer le moins de tokens possible sans dégrader la qualité du service.

- Priorité au déterministe : le LLM n'est appelé que lorsque `classifyIntent` renvoie `unknown` (fonction `shouldUseLlmFallback`). Les messages reconnus par les règles ne coûtent aucun token.
- Limites de sortie : `max_tokens` 150 pour l'extraction structurée, 300 pour le conseil.
- Prompts compacts : instructions denses, sans prose superflue. Le conseil reçoit un catalogue sous forme de lignes `id|nom|prix|stock|catégorie`, limité à 8 produits en stock.
- Historique réduit : seuls les 4 derniers messages sont injectés dans le prompt de conseil.
- Température : 0 pour l'extraction (sortie stable et courte), 0.2 pour le dialogue.
- Délai maximal : 8 secondes par appel. En cas d'erreur ou de délai dépassé, le bot répond par son message déterministe.

## Variables d'environnement LLM (RodiumAI)

- `RODIUM_API_KEY` : clé d'API RodiumAI. Secret : `wrangler secret put RODIUM_API_KEY`, ou dans `.dev.vars` en local. Si absente, le repli LLM est désactivé.
- `RODIUM_BASE_URL` : URL de base de l'API. Valeur par défaut : `https://api.rodiumai.io/v1`.
- `RODIUM_MODEL` : modèle utilisé. Valeur par défaut : `openai/gpt-6-luna` (alternative : `rodiumai/basic`).

Ces trois variables sont décrites dans `.dev.vars.example`.

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

## Palier 3 : déploiement Cloudflare Workers, Green API et persistance

### Architecture

- `src/worker/index.ts` : point d'entrée Worker. Routes `GET /` (healthcheck) et `POST /webhook/whatsapp`.
- `src/lib/green-api.ts` : parsing des notifications entrantes (`incomingMessageReceived`, messages texte) et client REST sortant (`sendMessage`, `sendButtons`) avec reprises sur 429 et 5xx.
- `src/data/storage.ts` : KV (`CONVERSATIONS_KV`) pour la déduplication (`dedup:<messageId>`, TTL 24 h) et l'historique (`conversation:<téléphone>`, 20 derniers échanges) ; D1 (`DB`) pour la table `orders` ; mock mémoire pour les tests et le développement local.
- `migrations/0001_init_orders.sql` : schéma D1 de la table `orders`.

Flux d'un message entrant :

1. Green API envoie une notification `incomingMessageReceived` à `POST /webhook/whatsapp`.
2. Le Worker vérifie le secret (en-tête `x-webhook-secret` ou `Authorization: Bearer`) si `WEBHOOK_SECRET` est défini, puis lit la notification. Les notifications non textuelles, les groupes et les instances inconnues sont ignorées.
3. Idempotence : si le `idMessage` a déjà été traité (clé KV), la requête est ignorée (`status: duplicate`).
4. Si l'expéditeur est le gérant (`MANAGER_PHONE`) et que le message est `VALIDER CMD-...` ou `REFUSER CMD-...`, la commande est décidée, enregistrée en D1 et le client est notifié.
5. Sinon, le message client est confié au Manager (Palier 2) : Vendeur, Logisticien, puis Formateur WhatsApp. Le repli LLM s'applique uniquement si l'intention est `unknown`.
6. Si une commande est assemblée, elle est enregistrée en D1 avec le statut `PENDING_HUMAN_VALIDATION` et le gérant reçoit un récapitulatif avec les commandes `VALIDER` ou `REFUSER`.
7. La réponse formatée est envoyée au client via `sendMessage` de Green API.

Le client ne peut pas valider sa propre commande : seule la décision du gérant passe la commande à `CONFIRMED` ou `REJECTED`.

### Variables d'environnement et secrets

Variables non secrètes (dans `wrangler.toml`, section `[vars]`) :

- `GREEN_API_BASE_URL` : `https://api.green-api.com`.
- `RODIUM_BASE_URL` et `RODIUM_MODEL` peuvent aussi être placées dans `[vars]` (valeurs par défaut : voir la section LLM).

Secrets (à définir avec `wrangler secret put` en production, ou dans `.dev.vars` en local) :

- `GREEN_API_ID_INSTANCE` : identifiant de l'instance Green API. Les notifications d'une autre instance sont ignorées.
- `GREEN_API_TOKEN_INSTANCE` : jeton de l'instance Green API.
- `WEBHOOK_SECRET` : secret partagé vérifié sur chaque webhook. Recommandé en production.
- `MANAGER_PHONE` : numéro du gérant au format international sans le signe plus (par exemple 22900000000). Requis pour la validation humaine.
- `RODIUM_API_KEY` : clé RodiumAI, optionnelle. Sans elle, le repli LLM est désactivé.

Modèle de configuration locale : `.dev.vars.example` (copier vers `.dev.vars`, ne jamais committer `.dev.vars`).

### Déploiement Cloudflare pas à pas

1. Installer les dépendances : `pnpm install`.
2. Créer le namespace KV : `pnpm exec wrangler kv namespace create CONVERSATIONS_KV`. Reporter l'identifiant renvoyé dans `wrangler.toml` (champ `id` de `[[kv_namespaces]]`).
3. Créer la base D1 : `pnpm exec wrangler d1 create boutique-orders`. Reporter `database_id` dans `wrangler.toml`.
4. Appliquer le schéma : `pnpm run db:migrate:remote` (ou `pnpm run db:migrate:local` pour le développement).
5. Définir les secrets :

```
pnpm exec wrangler secret put GREEN_API_ID_INSTANCE
pnpm exec wrangler secret put GREEN_API_TOKEN_INSTANCE
pnpm exec wrangler secret put WEBHOOK_SECRET
pnpm exec wrangler secret put MANAGER_PHONE
pnpm exec wrangler secret put RODIUM_API_KEY   # optionnel
```

6. Déployer : `pnpm run deploy`. L'URL affichée (par exemple `https://boutique-intelligente-whatsapp.<compte>.workers.dev`) sert de base aux webhooks.
7. Configurer Green API : dans le tableau de bord de l'instance, activer les notifications entrantes (`incomingMessageReceived`) et renseigner l'URL du webhook `https://<votre-worker>/webhook/whatsapp`. Si `WEBHOOK_SECRET` est défini, ajouter l'en-tête `x-webhook-secret` avec la même valeur (si le tableau de bord ne permet pas d'en-têtes personnalisés, utiliser une URL de la forme `https://<votre-worker>/webhook/whatsapp` protégée par un mécanisme équivalent).

### Tests curl

Healthcheck :

```
curl -s http://localhost:8787/
```

Simulation d'un message client en local (`pnpm dev`) :

```
curl -s -X POST http://localhost:8787/webhook/whatsapp \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: $WEBHOOK_SECRET" \
  -d '{"typeWebhook":"incomingMessageReceived","instanceData":{"idInstance":1101000001,"wid":"1101000001@c.us","typeInstance":"whatsapp"},"timestamp":1761935212,"idMessage":"TEST-0001","senderData":{"chatId":"22997000001@c.us","sender":"22997000001@c.us","chatName":"Client test"},"messageData":{"typeMessage":"textMessage","textMessageData":{"textMessage":"Bonjour, je cherche du super wax vert, 2 pagnes"}}}'
```

Rejouer le même `idMessage` : la réponse doit indiquer `"status":"duplicate"`.

Décision du gérant (remplacer la référence par celle reçue dans la notification) :

```
curl -s -X POST http://localhost:8787/webhook/whatsapp \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: $WEBHOOK_SECRET" \
  -d '{"typeWebhook":"incomingMessageReceived","instanceData":{"idInstance":1101000001,"wid":"1101000001@c.us","typeInstance":"whatsapp"},"timestamp":1761935300,"idMessage":"TEST-0002","senderData":{"chatId":"22900000000@c.us","sender":"22900000000@c.us","chatName":"Gérant"},"messageData":{"typeMessage":"textMessage","textMessageData":{"textMessage":"VALIDER CMD-REMPLACER"}}}'
```

Test de sécurité (doit répondre 401 si `WEBHOOK_SECRET` est défini) :

```
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<votre-worker>/webhook/whatsapp -H "Content-Type: application/json" -d '{}'
```

### Tests Palier 3

```
pnpm run test:palier3
```

Les tests couvrent le parsing des notifications, le client Green API (URL, reprises, erreurs non réessayables), la déduplication KV, le dispatch vers le Manager, la validation humaine par le gérant et le routage HTTP.

Limites connues : la cohérence KV est éventuelle (une même notification envoyée deux fois très rapidement peut être traitée deux fois). Le compteur de validations du HITL est en mémoire et redémarre à chaque requête ; les commandes sont identifiées par leur référence `CMD-...` en D1.

## Lancer et tester

Commandes principales :

```
pnpm install
pnpm run test:palier2     # routage, vendeur, logistique, HITL
pnpm run test:palier3     # webhook, déduplication, gérant, HTTP
pnpm run typecheck
pnpm run demo:palier1
pnpm run demo:palier2
pnpm dev                  # worker local avec Wrangler
pnpm run deploy
```

Les tests des paliers 2 et 3 ne font appel à aucune API externe : ils sont reproductibles hors ligne et n'utilisent pas de clé RodiumAI.

## Outils

- TypeScript
- Cloudflare Workers et Wrangler
- Green API (WhatsApp)
- RodiumAI (repli LLM, optionnel)
- tsx (exécution locale de la démo et des tests)

## Installation

Prérequis : Node.js 20 ou plus récent, pnpm (ou npm).

```
pnpm install
cp .dev.vars.example .dev.vars   # renseigner les clés Green API et, si besoin, RODIUM_API_KEY (ne jamais committer ce fichier)
pnpm dev                         # lancement local avec Wrangler
pnpm typecheck
pnpm run demo:palier1            # démo du Palier 1
pnpm run demo:palier2            # démo du Palier 2
pnpm run test:palier2            # tests du Palier 2
pnpm run test:palier3            # tests du Palier 3
pnpm run deploy                  # déploiement sur Cloudflare
```

Les secrets (identifiant et jeton d'instance Green API, secret du webhook, numéro du gérant, clé d'API RodiumAI) doivent être stockés dans `.dev.vars` en local et via `wrangler secret put` en production.
