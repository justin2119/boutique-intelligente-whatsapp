import type { Catalog } from "../types";
import type {
  AggregatedResponse,
  Delegation,
  DeliveryOption,
  Intent,
  LogisticsResult,
  OrderDraft,
  Palier2Trace,
  SellerResult,
  ValidationDecision,
  ValidationRecord,
} from "../types/palier2";
import { FormatterAgent } from "./formatter-agent";
import { HitlValidator } from "./hitl";
import { LogisticsAgent, detectZoneTerm } from "./logistics-agent";
import { normalizeText } from "./normalize";
import { SellerAgent } from "./seller-agent";
import { hasFabricTerm, hasTechTerm, parseBudget, stripBudget } from "./intent-terms";

export interface ManagerDeps {
  readonly catalog: Catalog;
  readonly seller: SellerAgent;
  readonly logistics: LogisticsAgent;
  readonly formatter: FormatterAgent;
  readonly hitl: HitlValidator;
  readonly clock: () => Date;
}

const ORDER_WORDS: readonly string[] = ["commande", "je prends", "je veux acheter", "confirme", "reserve", "je valide"];
const DELIVERY_WORDS: readonly string[] = ["livr", "frais", "delai", "express", "zone"];
const PRODUCT_WORDS: readonly string[] = [
  "cherche", "wax", "pagne", "motif", "disponible", "couleur", "prix", "stock", "recommande", "conseil",
  "propose", "montrez", "avez", "voir", "quel", "quelle", "quels", "budget", "moins de",
];

/** Termes qui signalent une demande de produit à partir du mot entier (pour « hp », « pc », « core »…). */
const PRODUCT_WORD_BOUNDARY = /\b(pc|pcs|ordinateurs?|portables?|laptops?|macbooks?|mac|lenovo|thinkpad|dell|hp|asus|acer|machines?|core|intel|ryzen|gaming|bureau|tactile|ssd|ram|go|to|ghz|pouces?)\b/;

/** Classe l'intention du message (règles déterministes, reproductibles hors ligne). */
export function classifyIntent(message: string): Intent {
  const text = normalizeText(message);
  if (ORDER_WORDS.some((word) => text.includes(word))) {
    return "order_request";
  }
  if (DELIVERY_WORDS.some((word) => text.includes(word))) {
    return "delivery_inquiry";
  }
  if (PRODUCT_WORDS.some((word) => text.includes(word))) {
    return "product_inquiry";
  }
  if (hasTechTerm(message) || hasFabricTerm(message) || parseBudget(message) !== null) {
    return "product_inquiry";
  }
  if (PRODUCT_WORD_BOUNDARY.test(text)) {
    return "product_inquiry";
  }
  return "unknown";
}

/**
 * Extrait la quantité demandée ("2 pagnes", "2 pièces"), 1 par défaut.
 * Les montants (budget) et les spécifications (16 Go, 1 To, 3 GHz, 14 pouces) ne sont pas des quantités.
 */
export function parseQuantity(message: string): number {
  const text = stripSpecs(stripBudget(message));
  const withUnit = text.match(/(\d{1,3})\s*(pagnes?|pieces?|pcs|ordinateurs?|pc|machines?|unites?)\b/);
  if (withUnit?.[1] !== undefined) {
    return Math.max(1, Number(withUnit[1]));
  }
  const bare = text.match(/(?<![\w-])(\d{1,3})(?![\w-])/);
  if (bare?.[1] !== undefined) {
    return Math.max(1, Number(bare[1]));
  }
  return 1;
}

/** Retire les spécifications techniques (quantité de RAM, de SSD, taille d'écran, fréquence). */
export function stripSpecs(text: string): string {
  return text.replace(/\d+ ?(?:go|gb|to|tb|ghz|mhz|pouces?|pouce|inch|w)\b/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Agent Manager / Orchestrateur : analyse l'intention, délègue aux spécialistes,
 * agrège les résultats et met toute commande en validation humaine.
 */
export class ManagerAgent {
  private readonly deps: ManagerDeps;

  constructor(deps: ManagerDeps) {
    this.deps = deps;
  }

  async handle(message: string): Promise<Palier2Trace> {
    const { seller, logistics, formatter, hitl, catalog } = this.deps;
    const delegations: Delegation[] = [];
    const events: string[] = [];

    const intent = classifyIntent(message);
    const quantity = parseQuantity(message);
    const budget = parseBudget(message);
    const option: DeliveryOption = /express|urgent/.test(normalizeText(message)) ? "express" : "standard";
    events.push(
      `Manager : intention « ${intent} », quantité ${quantity}, budget ${budget ?? "non précisé"}, option de livraison ${option}.`,
    );

    const sellerResult = seller.recommend(message, quantity);
    delegations.push({
      from: "manager",
      to: "seller",
      task: `Rechercher le produit et vérifier le stock (${quantity} unité(s))`,
      output: describeSeller(sellerResult),
    });

    const zoneTerm = detectZoneTerm(message, catalog.zones);
    let logisticsResult: LogisticsResult | null = null;
    if (zoneTerm !== null) {
      logisticsResult = logistics.quote(zoneTerm, option);
      delegations.push({
        from: "manager",
        to: "logistics",
        task: `Calculer la livraison (${option}) vers « ${zoneTerm} »`,
        output: describeLogistics(logisticsResult),
      });
    }

    let draft: OrderDraft | null = null;
    let validation: ValidationRecord | null = null;
    if (intent === "order_request") {
      if (sellerResult.kind === "available" && logisticsResult?.kind === "quoted") {
        draft = this.buildDraft(sellerResult, logisticsResult);
        validation = hitl.submit(draft);
        events.push(
          `Commande ${draft.reference} assemblée : statut ${validation.status} (${validation.id}). Validation humaine requise avant finalisation.`,
        );
        delegations.push({
          from: "manager",
          to: "hitl",
          task: "Mettre la commande en validation humaine",
          output: `${validation.id} : ${validation.status}`,
        });
      } else {
        events.push("Commande non assemblée : produit indisponible ou livraison non confirmée.");
      }
    }

    const aggregated: AggregatedResponse = { intent, seller: sellerResult, logistics: logisticsResult, validation, draft };
    const customerMessage = formatter.compose(aggregated);
    delegations.push({
      from: "manager",
      to: "formatter",
      task: "Rédiger la réponse WhatsApp",
      output: `${customerMessage.length} caractères`,
    });
    return { message, delegations, aggregated, customerMessage, events };
  }

  /** Enregistre la décision humaine (gérant ou client) puis produit le message final. */
  resolveValidation(validationId: string, decision: ValidationDecision): { validation: ValidationRecord; customerMessage: string } {
    const validation = this.deps.hitl.decide(validationId, decision);
    const customerMessage = this.deps.formatter.compose({
      intent: "order_request",
      seller: null,
      logistics: null,
      validation,
      draft: validation.draft,
    });
    return { validation, customerMessage };
  }

  private buildDraft(
    seller: Extract<SellerResult, { kind: "available" }>,
    logistics: Extract<LogisticsResult, { kind: "quoted" }>,
  ): OrderDraft {
    const reference = `CMD-${this.deps.clock().getTime().toString(36).toUpperCase()}`;
    return {
      reference,
      lines: [
        {
          productId: seller.product.id,
          name: seller.product.name,
          quantity: seller.quantity,
          unitPriceXof: seller.product.priceXof,
          lineTotalXof: seller.subtotalXof,
        },
      ],
      zoneId: logistics.zone.id,
      zoneLabel: logistics.zone.zone,
      option: logistics.option,
      subtotalXof: seller.subtotalXof,
      deliveryFeeXof: logistics.feeXof,
      totalXof: seller.subtotalXof + logistics.feeXof,
      etaDays: logistics.etaDays,
    };
  }
}

function describeSeller(result: SellerResult): string {
  switch (result.kind) {
    case "available":
      return `disponible : ${result.product.id}, ${result.subtotalXof} FCFA`;
    case "out_of_stock":
      return `rupture : ${result.product.id}, alternatives ${result.alternatives.map((alt) => alt.id).join(", ") || "aucune"}`;
    case "not_found":
      return `aucun produit trouvé pour « ${result.query} »`;
  }
}

function describeLogistics(result: LogisticsResult): string {
  switch (result.kind) {
    case "quoted":
      return `${result.zone.zone} : ${result.feeXof} FCFA, ${result.etaDays} jour(s)`;
    case "ambiguous":
      return `ambigu : ${result.candidates.join(", ")}`;
    case "unknown_zone":
      return `zone inconnue : « ${result.query} »`;
  }
}

export type { Intent };
