/**
 * Tests du Palier 2 : routage du Manager, alternatives du Vendeur, frais du Logisticien,
 * transitions de validation humaine (HITL). Exécution : pnpm run test:palier2
 */
import { loadCatalog } from "../src/data/catalog";
import { FormatterAgent } from "../src/agents/formatter-agent";
import { HitlValidator } from "../src/agents/hitl";
import { LogisticsAgent, EXPRESS_FEE_MULTIPLIER } from "../src/agents/logistics-agent";
import { ManagerAgent, classifyIntent, parseQuantity } from "../src/agents/manager-agent";
import { parseSlot, parseUseCase } from "../src/agents/intent-terms";
import { SellerAgent } from "../src/agents/seller-agent";

// Déclaration locale : tsconfig.json n'inclut que @cloudflare/workers-types (pas de @types/node).
declare const process: { exitCode: number | undefined };

/** Assertions locales (remplacent node:assert, non typé dans ce projet). Aucune signature `asserts`. */
const assert = {
  equal(actual: unknown, expected: unknown, message?: string): void {
    if (!Object.is(actual, expected)) {
      throw new Error(message ?? `attendu ${String(expected)}, obtenu ${String(actual)}`);
    }
  },
  deepEqual(actual: unknown, expected: unknown, message?: string): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) {
      throw new Error(message ?? `attendu ${e}, obtenu ${a}`);
    }
  },
  match(value: string, pattern: RegExp, message?: string): void {
    if (!pattern.test(value)) {
      throw new Error(message ?? `"${value}" ne correspond pas à ${String(pattern)}`);
    }
  },
  throws(fn: () => unknown, pattern: RegExp, message?: string): void {
    try {
      fn();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (!pattern.test(text)) {
        throw new Error(message ?? `erreur inattendue : ${text}`);
      }
      return;
    }
    throw new Error(message ?? "exception attendue");
  },
};

const FIXED_INSTANT = "2026-10-31T18:35:43.000Z";
const clock = (): Date => new Date(FIXED_INSTANT);

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`ok - ${name}`);
    })
    .catch((error: unknown) => {
      failed += 1;
      console.log(`not ok - ${name}`);
      console.log(`  ${error instanceof Error ? error.message : String(error)}`);
    });
}

function buildManager(): ManagerAgent {
  const catalog = loadCatalog();
  return new ManagerAgent({
    catalog,
    seller: new SellerAgent(catalog),
    logistics: new LogisticsAgent(catalog.zones),
    formatter: new FormatterAgent(),
    hitl: new HitlValidator(clock),
    clock,
  });
}

async function main(): Promise<void> {
  const catalog = loadCatalog();

  // Routage du Manager
  await check("routage : demande de produit", () => {
    assert.equal(classifyIntent("Je cherche du wax bleu"), "product_inquiry");
  });
  await check("routage : demande de livraison", () => {
    assert.equal(classifyIntent("Combien pour livrer à Calavi ?"), "delivery_inquiry");
  });
  await check("routage : demande de commande", () => {
    assert.equal(classifyIntent("Je prends la commande : 2 pagnes SW-002"), "order_request");
  });
  await check("routage : message hors sujet", () => {
    assert.equal(classifyIntent("Bonjour, comment allez-vous ?"), "unknown");
  });
  await check("routage : quantité lue depuis « 2 pagnes »", () => {
    assert.equal(parseQuantity("je cherche du super wax vert, 2 pagnes"), 2);
  });
  await check("routage : quantité par défaut à 1", () => {
    assert.equal(parseQuantity("je cherche du super wax vert"), 1);
  });

  // Créneau de livraison
  await check("créneau : « Créneau vers 15h » est reconnu", () => {
    assert.equal(parseSlot("Créneau vers 15h") !== null, true);
  });
  await check("créneau : « 7h00-12h00 » est reconnu", () => {
    assert.equal(parseSlot("7h00-12h00") !== null, true);
  });
  await check("créneau : « demain matin » est reconnu", () => {
    assert.equal(parseSlot("demain matin") !== null, true);
  });
  await check("créneau : un message sans créneau n'en contient pas", () => {
    assert.equal(parseSlot("Combien ça coûte pour livrer à Dantokpa ?"), null);
  });

  // Vendeur : recommandations et alternatives
  await check("vendeur : SW-003 en rupture pour la recherche « super wax vert »", () => {
    const result = new SellerAgent(catalog).recommend("super wax vert", 2);
    assert.equal(result.kind, "out_of_stock");
    if (result.kind !== "out_of_stock") return;
    assert.equal(result.product.id, "SW-003");
  });
  await check("vendeur : alternatives en stock pour SW-003 sont SW-002 puis SW-001", () => {
    const result = new SellerAgent(catalog).recommend("super wax vert", 2);
    if (result.kind !== "out_of_stock") throw new Error("attendu : rupture");
    assert.deepEqual(result.alternatives.map((alt) => alt.id), ["SW-002", "SW-001"]);
  });
  await check("vendeur : SW-002 disponible pour 2 pagnes à 18 000 FCFA", () => {
    const result = new SellerAgent(catalog).recommend("SW-002", 2);
    assert.equal(result.kind, "available");
    if (result.kind !== "available") return;
    assert.equal(result.product.id, "SW-002");
    assert.equal(result.subtotalXof, 18000);
  });
  await check("vendeur : requête inconnue renvoie not_found", () => {
    const result = new SellerAgent(catalog).recommend("zzzz qqqq", 1);
    assert.equal(result.kind, "not_found");
  });

  // Logisticien : standard et express
  await check("logistique : Dantokpa standard = 500 FCFA, 0 jour", () => {
    const result = new LogisticsAgent(catalog.zones).quote("Dantokpa", "standard");
    assert.equal(result.kind, "quoted");
    if (result.kind !== "quoted") return;
    assert.equal(result.feeXof, 500);
    assert.equal(result.etaDays, 0);
  });
  await check("logistique : Dantokpa express = 750 FCFA, 0 jour (jour même)", () => {
    const result = new LogisticsAgent(catalog.zones).quote("Dantokpa", "express");
    assert.equal(result.kind, "quoted");
    if (result.kind !== "quoted") return;
    assert.equal(result.feeXof, Math.round(500 * EXPRESS_FEE_MULTIPLIER));
    assert.equal(result.feeXof, 750);
    assert.equal(result.etaDays, 0);
  });
  await check("logistique : Akpakpa express = 1 500 FCFA, 0 jour (standard 1 jour, express jour même)", () => {
    const result = new LogisticsAgent(catalog.zones).quote("Akpakpa", "express");
    if (result.kind !== "quoted") throw new Error("attendu : tarif");
    assert.equal(result.feeXof, 1500);
    assert.equal(result.etaDays, 0);
  });
  await check("logistique : Cotonou seul est ambigu", () => {
    const result = new LogisticsAgent(catalog.zones).quote("Cotonou", "standard");
    assert.equal(result.kind, "ambiguous");
  });
  await check("logistique : zone inconnue", () => {
    const result = new LogisticsAgent(catalog.zones).quote("Paris", "standard");
    assert.equal(result.kind, "unknown_zone");
  });

  // Scénario de bout en bout et transitions HITL
  await check("scénario : demande de livraison ne crée pas de commande", async () => {
    const manager = buildManager();
    const trace = await manager.handle("Bonjour, je cherche du super wax vert, 2 pagnes. Je livre à Dantokpa en express. Combien ça coûte ?");
    assert.equal(trace.aggregated.intent, "delivery_inquiry");
    assert.equal(trace.aggregated.validation, null);
    assert.equal(trace.aggregated.draft, null);
    assert.match(trace.customerMessage, /SW-002/);
    assert.match(trace.customerMessage, /750 FCFA/);
  });
  await check("scénario : commande SW-002 en PENDING_HUMAN_VALIDATION puis CONFIRMED", async () => {
    const manager = buildManager();
    const trace = await manager.handle("Je prends la commande : 2 pagnes SW-002, livraison à Dantokpa en express.");
    const pending = trace.aggregated.validation;
    if (pending === null) {
      throw new Error("validation attendue");
    }
    assert.equal(pending.status, "PENDING_HUMAN_VALIDATION");
    assert.equal(pending.draft.totalXof, 18750);
    assert.equal(pending.draft.subtotalXof, 18000);
    assert.equal(pending.draft.deliveryFeeXof, 750);
    const resolved = manager.resolveValidation(pending.id, { by: "manager", approved: true, note: "Stock vérifié" });
    assert.equal(resolved.validation.status, "CONFIRMED");
    assert.equal(resolved.validation.decidedBy, "manager");
    assert.match(resolved.customerMessage, /confirmée/);
  });
  await check("scénario : créneau donné après le devis crée la commande en validation (pas de répétition)", async () => {
    const manager = buildManager();
    const quote = await manager.handle("Bonjour, je cherche un ThinkPad T14 pour Sokodé en express. Combien ça coûte ?");
    assert.equal(quote.aggregated.validation, null, "le devis ne crée pas de commande");
    const reply = await manager.handle("Créneau vers 15h", quote.context);
    assert.equal(reply.aggregated.intent, "order_request");
    const validation = reply.aggregated.validation;
    if (validation === null) {
      throw new Error("validation attendue après le créneau");
    }
    assert.equal(validation.status, "PENDING_HUMAN_VALIDATION");
    assert.equal(validation.draft.slot, "Créneau vers 15h");
    assert.match(reply.customerMessage, /Créneau souhaité : Créneau vers 15h/);
    assert.match(reply.customerMessage, /en cours de validation/);
    assert.equal(reply.context?.orderPlaced, true);
  });
  await check("scénario : un second créneau ne recrée pas la commande", async () => {
    const manager = buildManager();
    const quote = await manager.handle("Je cherche un ThinkPad T14 pour Sokodé en express");
    const first = await manager.handle("Créneau vers 15h", quote.context);
    const second = await manager.handle("7h00-12h00", first.context);
    assert.equal(second.aggregated.validation, null, "pas de nouvelle commande");
  });

  // Vue d'ensemble du catalogue
  await check("catalogue : « quels articles sont présents ? » est une vue d'ensemble", () => {
    assert.equal(classifyIntent("quels articles sont présents ?"), "browse_catalog");
  });
  await check("catalogue : la vue d'ensemble liste les catégories sans référence produit", async () => {
    const manager = buildManager();
    const trace = await manager.handle("quels articles sont présents ?");
    assert.equal(trace.aggregated.intent, "browse_catalog");
    assert.equal(trace.aggregated.validation, null);
    assert.match(trace.customerMessage, /catégories disponibles/);
    assert.match(trace.customerMessage, /Ordinateurs : \d+ article\(s\)/);
    assert.equal(/[A-Z]{2}-\d{3}/.test(trace.customerMessage), false, "aucune référence produit dans la vue d'ensemble");
  });
  await check("catalogue : le formateur compose une ligne par catégorie avec la fourchette de prix", () => {
    const text = new FormatterAgent().composeCatalog([
      { category: "ordinateur", count: 8, minPriceXof: 380000, maxPriceXof: 1150000 },
    ] as never);
    assert.match(text, /Ordinateurs : 8 article\(s\), de 380 000 FCFA à 1 150 000 FCFA/);
  });

  // Ordinateurs par usage d'études
  await check("usage : « pour mes études » est reconnu comme usage études", () => {
    assert.equal(parseUseCase("Je cherche un ordinateur pour mes études"), "etudes");
  });
  await check("usage : une demande d'ordinateur pour les études n'est pas une commande", () => {
    assert.equal(classifyIntent("Je cherche un ordinateur pour mes études") === "order_request", false);
  });

  // Changement de sujet en cours de commande
  await check("sujet : une demande d'ordinateur après une commande ne reprend pas le pagne commandé", async () => {
    const manager = buildManager();
    const order = await manager.handle("Je prends la commande : 2 pagnes SW-002, livraison à Dantokpa en express.");
    assert.equal(order.aggregated.validation?.status, "PENDING_HUMAN_VALIDATION");
    const switched = await manager.handle("Je cherche un ordinateur pour mes études", order.context);
    assert.equal(switched.aggregated.validation, null, "pas de nouvelle commande");
    assert.equal(/SW-002/.test(switched.customerMessage), false, "le pagne précédent n'est pas repris");
    assert.equal(switched.context?.lastProductId === "SW-002", false, "le produit du contexte est remplacé");
  });
  await check("sujet : une vue d'ensemble pendant une commande garde la commande en cours", async () => {
    const manager = buildManager();
    const order = await manager.handle("Je prends la commande : 2 pagnes SW-002, livraison à Dantokpa en express.");
    const browse = await manager.handle("quels articles sont présents ?", order.context);
    assert.equal(browse.aggregated.intent, "browse_catalog");
    assert.equal(browse.context?.orderPlaced, true);
  });

  // Pas d'ordinateur sous 1 unité : le mot « ordinateur » ne doit pas être lu comme une quantité
  await check("quantité : « 2 ordinateurs » donne une quantité de 2", () => {
    assert.equal(parseQuantity("je veux 2 ordinateurs pour mes études"), 2);
  });

  console.log(`\n${passed} réussi(s), ${failed} échec(s)`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main();
