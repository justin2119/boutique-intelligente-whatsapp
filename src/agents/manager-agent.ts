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
import { FormatterAgent, etaPhrase, unitLabel as unitLabelFor } from "./formatter-agent";
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

/** Demande d'une autre option (« un autre », « autre chose », « pas celui-là », « un moins cher »). */
const ALTERNATIVE_WORDS = /\b(un autre|une autre|autre chose|d autres?|autres? (?:modeles?|options?|propositions?|machines?|ordinateurs?)|pas celui|pas celle|moins cher|moins chere|plus abordable|autre modele|autre option)\b/;

/** Termes qui signalent une demande de produit à partir du mot entier (pour « hp », « pc », « core »…). */
const PRODUCT_WORD_BOUNDARY = /\b(pc|pcs|ordinateurs?|portables?|laptops?|macbooks?|mac|lenovo|thinkpad|dell|hp|asus|acer|machines?|core|intel|ryzen|gaming|bureau|tactile|ssd|ram|go|to|ghz|pouces?)\b/;

/**
 * Nombres en français (texte normalisé, sans accents) : quantités écrites en lettres.
 * « un » et « une » valent 1 ; « deux » à « vingt » et les dizaines usuelles sont couverts.
 */
const FRENCH_NUMBERS: Readonly<Record<string, number>> = {
  un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10,
  onze: 11, douze: 12, treize: 13, quatorze: 14, quinze: 15, seize: 16, vingt: 20, trente: 30,
  quarante: 40, cinquante: 50,
};

/** Mots de quantité reconnus après un nombre (texte normalisé). */
const QUANTITY_NOUN = "(pagnes?|pieces?|pcs|ordinateurs?|pc|machines?|unites?|paires?|boucles?|articles?|exemplaires?|fois)";

/** Motif d'un nombre écrit en lettres ou en chiffres, suivi d'un mot de quantité (texte normalisé). */
const NUMBER_WORD_PATTERN = new RegExp(`\\b(\\d{1,3}|${Object.keys(FRENCH_NUMBERS).join("|")})\\s*${QUANTITY_NOUN}\\b`);

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
 * Extrait la quantité demandée : chiffres (« 2 unités ») ou mots (« deux paires », « j'en veux deux »), 1 par défaut.
 * Les montants (budget) et les spécifications (16 Go, 1 To, 3 GHz, 14 pouces) ne sont pas des quantités.
 */
export function parseQuantity(message: string): number {
  const text = normalizeText(stripSpecs(stripBudget(message)));
  const withUnit = text.match(NUMBER_WORD_PATTERN);
  if (withUnit?.[1] !== undefined) {
    return Math.max(1, wordToNumber(withUnit[1]));
  }
  // « j'en veux deux » : pronom « en » suivi d'un nombre en lettres, sans nom de produit.
  const pronoun = text.match(/\ben (?:veux|prends|voudrais|souhaite|commande)\s+(\d{1,3}|[a-z]+)\b/);
  if (pronoun?.[1] !== undefined && pronoun[1] in FRENCH_NUMBERS) {
    return FRENCH_NUMBERS[pronoun[1]] ?? 1;
  }
  const bare = text.match(/(?<![\w-])(\d{1,3})(?![\w-])/);
  if (bare?.[1] !== undefined) {
    return Math.max(1, Number(bare[1]));
  }
  return 1;
}

/** Convertit un nombre en chiffres ou en lettres (texte normalisé) en entier. */
function wordToNumber(token: string): number {
  if (/^\d+$/.test(token)) {
    return Number(token);
  }
  return FRENCH_NUMBERS[token] ?? 1;
}

/** Retire les spécifications techniques (quantité de RAM, de SSD, taille d'écran, fréquence). */
export function stripSpecs(text: string): string {
  return text.replace(/\d+ ?(?:go|gb|to|tb|ghz|mhz|pouces?|pouce|inch|w)\b/g, " ").replace(/\s+/g, " ").trim();
}

/** Vrai si le client demande une autre option que celle proposée précédemment. */
export function asksAlternative(message: string): boolean {
  return ALTERNATIVE_WORDS.test(normalizeText(message));
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
    // Livraison standard par défaut : l'express n'est retenu que si le client le demande dans ce message.
    const option: DeliveryOption = explicitOption ?? "standard";
    const wantsAlternative = asksAlternative(message);
    events.push(
      `Manager : intention « ${intent} », quantité ${quantity}, budget ${budget ?? "non précisé"}, option de livraison ${option}, créneau ${slot ?? "non précisé"}, autre option ${wantsAlternative ? "demandée" : "non"}.`,
    );

    const hasContextProduct = context.lastProductId !== undefined && context.lastProductId !== null;
    // Produit nouvellement cité dans le message (recherche par mots-clés, budget compris).
    const freshResult = seller.recommend(message, quantity);
    // Recherche d'un autre produit : budget donné, ou demande d'alternative. Le produit refusé est exclu.
    const searchesOther = intent !== "order_request" && (budget !== null || wantsAlternative);
    let sellerResult: SellerResult;
    let optionsForFacts: Product[] = [];
    if (searchesOther) {
      const excluded = wantsAlternative && context.lastProductId ? [context.lastProductId] : [];
      const pool = this.computerOptions(budget, excluded);
      optionsForFacts = pool;
      sellerResult = pool.length > 0 ? seller.byId(pool[0].id, quantity) : { kind: "not_found", query: message };
      delegations.push({
        from: "manager",
        to: "seller",
        task: `Rechercher une autre option (budget ${budget ?? "libre"}, exclusion ${excluded.join(", ") || "aucune"})`,
        output: pool.length > 0 ? `${pool.length} option(s), meilleure : ${pool[0].id}` : "aucune option sous ce budget",
      });
    } else {
      // Sans nouveau produit cité, on reprend celui de la conversation (question de suivi, livraison, prix, usage, créneau).
      const reuseContext =
        hasContextProduct && freshResult.kind === "not_found" && (intent !== "order_request" || slot !== null);
      sellerResult = reuseContext ? seller.byId(context.lastProductId as string, quantity) : freshResult;
      delegations.push({
        from: "manager",
        to: "seller",
        task: reuseContext
          ? `Reprendre le produit de la conversation (${quantity} unité(s))`
          : `Rechercher le produit et vérifier le stock (${quantity} unité(s))`,
        output: describeSeller(sellerResult),
      });
    }

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
          budget,
          optionsForFacts,
          wantsAlternative,
          slot: slotForDraft,
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
   * Ordinateurs en stock, triés par prix croissant. Si un budget est donné, on garde ceux qui le respectent.
   * Les produits exclus (refusés par le client) sont retirés. Triés aussi par prix pour que la meilleure
   * option proposée soit la moins chère qui respecte le budget.
   */
  private computerOptions(budget: number | null, excludedIds: readonly string[]): Product[] {
    return this.deps.seller
      .listComputers(budget)
      .filter((p) => !excludedIds.includes(p.id));
  }

  /**
   * Construit les faits vérifiés et demande au LLM une réponse conversationnelle. Renvoie null sans LLM
   * ou si la réponse est rejetée : l'appelant garde alors le gabarit déterministe.
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
    readonly budget: number | null;
    readonly optionsForFacts: readonly Product[];
    readonly wantsAlternative: boolean;
    readonly slot: string | null;
  }): Promise<string | null> {
    const { llm, catalog } = this.deps;
    if (llm === undefined) {
      return null;
    }
    const facts = buildFacts(input, catalog.products);
    const allowedAmounts = [
      ...(input.budget !== null ? [input.budget] : []),
      ...catalog.products.map((p) => p.priceXof),
      ...orderTotalsFor(input.sellerResult, input.logisticsResult),
    ];
    try {
      return await llm.converse({ message: input.message, history: input.history, facts, allowedAmounts });
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

/** Montants calculés pour la commande (sous-total, total général) : autorisés dans la réponse du LLM. */
function orderTotalsFor(
  sellerResult: SellerResult,
  logisticsResult: LogisticsResult | null,
): number[] {
  if (sellerResult.kind !== "available" || logisticsResult?.kind !== "quoted") {
    return [];
  }
  return [sellerResult.subtotalXof, logisticsResult.feeXof, sellerResult.subtotalXof + logisticsResult.feeXof];
}

/**
 * Lignes de faits vérifiés transmises au LLM. Chaque montant, délai et référence vient des règles.
 * Un produit non trouvé ou une zone inconnue est signalé comme tel, pour que le LLM ne l'invente pas.
 * Quand produit, quantité et livraison sont connus, le détail de commande (sous-total, frais, total général)
 * est donné en entier, et les informations manquantes pour finaliser (créneau, repère) sont demandées.
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
    readonly budget?: number | null;
    readonly optionsForFacts?: readonly Product[];
    readonly wantsAlternative?: boolean;
    readonly slot?: string | null;
  },
  products: readonly Product[],
): string[] {
  const lines: string[] = [];
  const seller = input.sellerResult;
  if (input.budget !== undefined && input.budget !== null) {
    lines.push(`Budget indiqué par le client : ${formatFcfa(input.budget)}.`);
  }
  if (input.wantsAlternative) {
    lines.push("Le client demande une autre option que celle proposée précédemment.");
  }
  if (seller.kind === "available") {
    lines.push(`Produit : ${seller.product.name} (réf. ${seller.product.id}), catégorie ${seller.product.category}.`);
    lines.push(`Disponibilité : en stock (${seller.product.stock} unité(s) disponible(s)).`);
    lines.push(`Prix unitaire : ${formatFcfa(seller.product.priceXof)}.`);
    lines.push(`Quantité demandée : ${seller.quantity} ${unitLabelFor(seller.product, seller.quantity)}.`);
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
    lines.push("Aucun produit ne correspond exactement à la demande dans ce message.");
  }
  const options = input.optionsForFacts ?? [];
  if (options.length > 0) {
    lines.push("Ordinateurs en stock proposables (du moins cher au plus cher) :");
    for (const p of options.slice(0, 6)) {
      lines.push(`- ${p.name} (réf. ${p.id}), ${formatFcfa(p.priceXof)}, ${p.tags.join(", ")}.`);
    }
  } else if (input.budget !== undefined && input.budget !== null) {
    lines.push(`Aucun ordinateur en stock ne correspond à ce budget de ${formatFcfa(input.budget)}.`);
    const cheapest = (products as readonly Product[])
      .filter((p) => p.category === "ordinateur" && p.stock > 0)
      .sort((a, b) => a.priceXof - b.priceXof)[0];
    if (cheapest !== undefined) {
      lines.push(`Le modèle le moins cher en stock est ${cheapest.name} (réf. ${cheapest.id}) à ${formatFcfa(cheapest.priceXof)}.`);
    }
  }
  const logistics = input.logisticsResult;
  if (logistics?.kind === "quoted") {
    lines.push(`Livraison ${input.option === "express" ? "express" : "standard"} vers ${logistics.zone.zone} : frais ${formatFcfa(logistics.feeXof)}, ${etaPhrase(logistics.etaDays)}.`);
  } else if (logistics?.kind === "ambiguous") {
    lines.push(`Zone ambiguë : préciser parmi ${logistics.candidates.join(", ")}.`);
  } else if (logistics?.kind === "unknown_zone") {
    lines.push(`Zone « ${logistics.query} » non couverte par un tarif : demander la ville ou le quartier.`);
  } else if (input.askZone) {
    lines.push("Aucune zone de livraison indiquée : demander le quartier ou la ville.");
  }

  // Détail de commande : produit disponible, quantité connue et livraison chiffrée.
  if (seller.kind === "available" && logistics?.kind === "quoted") {
    const subtotal = seller.subtotalXof;
    const total = subtotal + logistics.feeXof;
    // Une seule ligne par montant : pas de doublon (prix unitaire, sous-total, frais, total général).
    lines.push(
      `Détail de la commande : ${seller.quantity} × ${formatFcfa(seller.product.priceXof)} = ${formatFcfa(subtotal)} pour les articles ; frais de livraison ${formatFcfa(logistics.feeXof)} ; total général ${formatFcfa(total)}.`,
    );
    lines.push("Le total est déjà calculé : le donner directement au client, sans dire qu'on le vérifie.");
    // Informations manquantes pour finaliser la commande.
    const missing: string[] = [];
    if (input.slot === undefined || input.slot === null) {
      missing.push("le créneau de livraison souhaité");
    }
    missing.push("le repère ou l'adresse précise de livraison");
    lines.push(`Pour finaliser la commande, demander au client : ${missing.join(" et ")}.`);
  }
  return lines;
}

/** Une quantité n'est lue que si le client la mentionne (sinon on garde celle de la conversation). */
function mentionsQuantity(message: string): boolean {
  const text = normalizeText(stripSpecs(stripBudget(message)));
  return NUMBER_WORD_PATTERN.test(text) || /\ben (?:veux|prends|voudrais|souhaite|commande)\s+(?:\d|[a-z]+)/.test(text);
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
