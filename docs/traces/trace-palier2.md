# Trace Palier 2 : multi-agents et validation humaine

Statut : trace non encore générée. Cette version n'a pas été exécutée.

Pour produire la trace réelle, lancer :

```
pnpm run demo:palier2 > docs/traces/trace-palier2.md
```

Le scénario couvre trois étapes :

1. Demande produit et livraison : le manager délègue au vendeur (super wax vert, SW-003 en rupture, alternative SW-002) puis au logisticien (Dantokpa, express).
2. Commande : le manager assemble la commande, la passe en PENDING_HUMAN_VALIDATION et attend la décision humaine.
3. Décision humaine : le gérant approuve, la commande passe à CONFIRMED, et la réponse finale est envoyée au client.
