import type { Catalog, Product } from "../types";
import type {
  AggregatedResponse,
  ConversationContext,
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
import { FormatterAgent, etaPhrase } from "./formatter-agent";
import { HitlValidator } from "./hitl";
import { LogisticsAgent, askForZoneMessage, detectZoneTerm } from "./logistics-agent";
import { formatFcfa, normalizeText } from "./normalize";
import { SellerAgent } from "./seller-agent";
import { hasFabricTerm, hasTechTerm, parseBudget, parseSlot, stripBudget } from "./intent-terms";
import type { LlmChatMessage, RodiumLlmService } from "../services/llm-service";

export interface ManagerDeps {
  readonly catalog: Catalog;
  readonly seller: SellerAgent;
  readonly logistics: LogisticsAgent;
  readonly formatter: FormatterAgent;
  readonly hitl: HitlValidator;
  readonly clock: () => Date;
  /** Conseiller conversationnel RodiumAI. Absent sans RODIUM_API_KEY : réponses déterministes. */
  readonly llm?: RodiumLlmService;
}

const ORDER_WORDS: readonly string[] = ["commande", "je prends", "je veux acheter", "confirme", "reserve", "je valide", "je le prends", "je la prends", "ok je prends"];
const DELIVERY_WORDS: readonly string[] = ["livr", "frais", "delai", "express", "zone", "quartier", "adresse", "domicile", "chez moi"];
const PRODUCT_WORDS: readonly string[] = [
  "cherche", "wax", "pagne", "motif", "disponible", "couleur", "prix", "stock", "recommande", "conseil",
  "propose", "montrez", "avez", "voir", "quel", "quelle", "quels", "budget", "moins de", "usage", "besoin",
  "pour", "comparer", "comparaison", "difference", "meilleur", "vaut",
];

/** Termes qui signalent une demande de produit à partir du mot entier (pour « hp », « pc », « core »…). */
const PRODUCT_WORD_BOUNDARY = /\b(pc|pcs|ordinateurs?|portables?|laptops?|macbooks?|mac|lenovo|thinkpad|dell|hp|asus|acer|machines?|core|intel|ryzen|gaming|bureau|tactile|ssd|ram|go|to|ghz|pouces?)\b/;

/**
 * Contenu d'ordre à ne jamais reformuler : références de commande, codes de validation et mots-clés de commande gérant.
 * Un message qui en contient un reste exactement tel que produit par les règles.
 */
const PROTECTED_CONTENT = /CMD-|VALIDER|REFUSER/i;

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
 * Extrait la quantité demandée ("2 unités", "2 ordinateurs"), 1 par défaut.
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
 * Les faits (stock, prix, frais, délai) sont calculés par les règles. Hors commande, le LLM rédige
 * la réponse conversationnelle à partir de ces faits ; les gabarits stricts sont réservés aux commandes.
 */
export class ManagerAgent {
  private readonly deps: ManagerDeps;

  constructor(deps: ManagerDeps) {
    this.deps = deps;
  }

  async handle(
    message: string,
    context: ConversationContext = {},
    history: readonly LlmChatMessage[] = [],
  ): Promise<Palier2Trace> {
    const { seller, logistics, formatter, hitl, catalog } = this.deps;
    const delegations: Delegation[] = [];
    const events: string[] = [];

    let intent: Intent = classifyIntent(message);
    // Créneau donné par le client (« Créneau vers 15h », « 7h00-12h00 », « demain matin »).
    const slot = parseSlot(message);
    const quantity = mentionsQuantity(message) ? parseQuantity(message) : (context.lastQuantity ?? 1);
    const budget = parseBudget(message);
    const explicitOption: DeliveryOption | null = /express|urgent|vite|rapide/.test(normalizeText(message)) ? "express" : null;
    const option: DeliveryOption = explicitOption ?? context.lastOption ?? "standard";
    events.push(
      `Manager : intention « ${intent} », quantité ${quantity}, budget ${budget ?? "non précisé"}, option de livraison ${option}, créneau ${slot ?? "non précisé"}.`,
    );

    const hasContextProduct = context.lastProductId !== undefined && context.lastProductId !== null;
    // Produit nouvellement cité dans le message.
    const freshResult = seller.recommend(message, quantity);
    // Sans nouveau produit cité, on reprend celui de la conversation (question de suivi, livraison, prix, usage, créneau).
    const reuseContext =
      hasContextProduct && freshResult.kind === "not_found" && (intent !== "order_request" || slot !== null);
    const sellerResult: SellerResult = reuseContext
      ? seller.byId(context.lastProductId as string, quantity)
      : freshResult;
    delegations.push({
      from: "manager",
      to: "seller",
      task: reuseContext
        ? `Reprendre le produit de la conversation (${quantity} unité(s))`
        : `Rechercher le produit et vérifier le stock (${quantity} unité(s))`,
      output: describeSeller(sellerResult),
    });

    const zoneTerm = detectZoneTerm(message, catalog.zones) ?? (hasContextProduct ? context.lastZoneTerm ?? null : null);
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

    // Le client répond au créneau demandé après le devis : la commande passe en validation humaine.
    // Un seul ordre par produit : une fois la commande envoyée, un nouveau créneau ne la recrée pas.
    if (
      slot !== null &&
      context.orderPlaced !== true &&
      sellerResult.kind === "available" &&
      logisticsResult?.kind === "quoted"
    ) {
      intent = "order_request";
    }

    const slotForDraft = slot ?? context.lastSlot ?? null;
    let draft: OrderDraft | null = null;
    let validation: ValidationRecord | null = null;
    if (intent === "order_request") {
      if (sellerResult.kind === "available" && logisticsResult?.kind === "quoted") {
        draft = this.buildDraft(sellerResult, logisticsResult, slotForDraft);
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

    // Livraison demandée sans lieu précis : une seule question naturelle, sans liste.
    const askZone = intent === "delivery_inquiry" && zoneTerm === null && sellerResult.kind === "not_found";
    const aggregated: AggregatedResponse = { intent, seller: sellerResult, logistics: logisticsResult, validation, draft };
    const deterministicMessage = askZone ? askForZoneMessage(catalog.zones) : formatter.compose(aggregated);

    // Le LLM rédige la conversation hors commande. Une commande ou une validation garde le gabarit strict.
    const isOrderTurn = validation !== null || intent === "order_request";
    const conversational = isOrderTurn
      ? null
      : await this.converseWithFacts({
          message,
          history,
          sellerResult,
          logisticsResult,
          zoneTerm,
          askZone,
          option,
          quantity,
          context,
        });
    const customerMessage = conversational ?? deterministicMessage;
    delegations.push({
      from: "manager",
      to: "formatter",
      task: conversational !== null ? "Rédiger la réponse conversationnelle (LLM, faits vérifiés)" : "Rédiger la réponse WhatsApp (gabarit)",
      output: `${customerMessage.length} caractères`,
    });
    const orderPlaced = validation !== null || (freshResult.kind === "not_found" && context.orderPlaced === true);
    return {
      message,
      delegations,
      aggregated,
      customerMessage,
      events,
      context: nextContext(sellerResult, quantity, zoneTerm, option, slotForDraft, orderPlaced),
    };
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

  /**
   * Construit les faits vérifiés (une ligne par fait) à partir des résultats des règles,
   * puis demande au LLM une réponse conversationnelle. Renvoie null sans LLM ou si la réponse est rejetée :
   * l'appelant garde alors le gabarit déterministe. Aucun fait n'est inventé ici.
   */
  private async converseWithFacts(input: {
    readonly message: string;
    readonly history: readonly LlmChatMessage[];
    readonly sellerResult: SellerResult;
    readonly logisticsResult: LogisticsResult | null;
    readonly zoneTerm: string | null;
    readonly askZone: boolean;
    readonly option: DeliveryOption;
    readonly quantity: number;
    readonly context: ConversationContext;
  }): Promise<string | null> {
    const { llm, catalog } = this.deps;
    if (llm === undefined) {
      return null;
    }
    const facts = buildFacts(input, catalog.products);
    try {
      return await llm.converse({ message: input.message, history: input.history, facts });
    } catch {
      return null;
    }
  }

  private buildDraft(
    seller: Extract<SellerResult, { kind: "available" }>,
    logistics: Extract<LogisticsResult, { kind: "quoted" }>,
    slot: string | null,
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
      slot,
    };
  }
}

/**
 * Lignes de faits vérifiés transmises au LLM. Chaque montant, délai et référence vient des règles.
 * Un produit non trouvé ou une zone inconnue est signalé comme tel, pour que le LLM ne l'invente pas.
 */
export function buildFacts(
  input: {
    readonly sellerResult: SellerResult;
    readonly logisticsResult: LogisticsResult | null;
    readonly zoneTerm: string | null;
    readonly askZone: boolean;
    readonly option: DeliveryOption;
    readonly quantity: number;
    readonly context: ConversationContext;
  },
  products: readonly Product[],
): string[] {
  const lines: string[] = [];
  const seller = input.sellerResult;
  if (seller.kind === "available") {
    lines.push(`Produit : ${seller.product.name} (réf. ${seller.product.id}), catégorie ${seller.product.category}.`);
    lines.push(`Disponibilité : en stock (${seller.product.stock} unité(s) disponible(s)).`);
    lines.push(`Prix unitaire : ${formatFcfa(seller.product.priceXof)}.`);
    lines.push(`Sous-total pour ${seller.quantity} unité(s) : ${formatFcfa(seller.subtotalXof)}.`);
    if (seller.product.tags.length > 0) {
      lines.push(`Caractéristiques : ${seller.product.tags.join(", ")}.`);
    }
  } else if (seller.kind === "out_of_stock") {
    lines.push(`Produit : ${seller.product.name} (réf. ${seller.product.id}) : rupture de stock pour ${seller.quantity} unité(s).`);
    if (seller.alternatives.length > 0) {
      for (const alt of seller.alternatives) {
        lines.push(`Alternative disponible : ${alt.name} (réf. ${alt.id}), ${formatFcfa(alt.priceXof)}, ${alt.stock} unité(s).`);
      }
    } else {
      lines.push("Aucune alternative disponible pour l'instant.");
    }
  } else {
    lines.push("Aucun produit précis n'a été identifié dans ce message.");
  }
  const logistics = input.logisticsResult;
  if (logistics?.kind === "quoted") {
    lines.push(`Livraison ${input.option === "express" ? "express" : "standard"} vers ${logistics.zone.zone} : frais ${formatFcfa(logistics.feeXof)}, ${etaPhrase(logistics.etaDays)}.`);
    if (seller.kind === "available") {
      lines.push(`Total avec livraison : ${formatFcfa(seller.subtotalXof + logistics.feeXof)}.`);
    }
  } else if (logistics?.kind === "ambiguous") {
    lines.push(`Zone ambiguë : préciser parmi ${logistics.candidates.join(", ")}.`);
  } else if (logistics?.kind === "unknown_zone") {
    lines.push(`Zone « ${logistics.query} » non couverte par un tarif : demander la ville ou le quartier.`);
  } else if (input.askZone) {
    lines.push("Aucune zone de livraison indiquée : demander le quartier ou la ville.");
  }
  if (products.length > 0 && seller.kind === "not_found") {
    const inStock = products.filter((p) => p.stock > 0).slice(0, 8);
    lines.push(`Produits disponibles au catalogue : ${inStock.map((p) => `${p.name} (réf. ${p.id}, ${formatFcfa(p.priceXof)})`).join(" ; ")}.`);
  }
  return lines;
}

/** Une quantité n'est lue que si le client la mentionne (sinon on garde celle de la conversation). */
function mentionsQuantity(message: string): boolean {
  return /\d{1,3}\s*(pagnes?|pieces?|pcs|ordinateurs?|pc|machines?|unites?)\b/.test(normalizeText(stripBudget(message)));
}

function nextContext(
  sellerResult: SellerResult,
  quantity: number,
  zoneTerm: string | null,
  option: DeliveryOption,
  slot: string | null,
  orderPlaced: boolean,
): ConversationContext {
  const product: Product | null = sellerResult.kind === "not_found" ? null : sellerResult.product;
  return {
    lastProductId: product?.id ?? null,
    lastQuantity: quantity,
    lastZoneTerm: zoneTerm,
    lastOption: option,
    lastSlot: slot,
    orderPlaced,
  };
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
