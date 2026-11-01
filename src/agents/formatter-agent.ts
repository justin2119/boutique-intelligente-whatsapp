import type { AggregatedResponse, LogisticsResult, SellerResult, ValidationRecord } from "../types/palier2";
import { formatFcfa } from "./normalize";
import { SALES_POLICY, policyLines, type SalesPolicy } from "./sales-policy";

/** Libellé du délai : « livraison le jour même » pour 0 jour, sinon « délai estimé de N jour(s) ». */
export function etaPhrase(etaDays: number): string {
  return etaDays === 0 ? "livraison le jour même" : `délai estimé de ${etaDays} jour(s)`;
}

/**
 * Agent Commercial : rédige UN message WhatsApp par tour, formel et direct (vouvoiement).
 * Chaque section ne reprend que ce que le client vient de demander ; la signature n'apparaît qu'une fois.
 */
export class FormatterAgent {
  private readonly policy: SalesPolicy;

  constructor(policy: SalesPolicy = SALES_POLICY) {
    this.policy = policy;
  }

  compose(aggregated: AggregatedResponse): string {
    const sections: string[] = [];
    if (aggregated.seller !== null) {
      sections.push(sellerSection(aggregated.seller));
    }
    if (aggregated.logistics !== null) {
      sections.push(logisticsSection(aggregated.logistics));
    }
    if (aggregated.validation !== null) {
      sections.push(orderSection(aggregated.validation, policyLines(this.policy)));
    }
    if (sections.length === 0) {
      sections.push(
        "Pour vous orienter vers le modèle adapté, merci de préciser votre usage principal (bureautique, développement, graphisme ou montage, études, gaming) et votre budget.",
      );
    }
    sections.push(`Cordialement,\nL'équipe ${this.policy.storeName}`);
    return sections.join("\n\n");
  }
}

function sellerSection(result: SellerResult): string {
  switch (result.kind) {
    case "available":
      return [
        "*Disponibilité confirmée*",
        `• Modèle : ${result.product.name} (réf. ${result.product.id})`,
        `• Quantité : ${result.quantity} unité(s)`,
        `• Prix unitaire : ${formatFcfa(result.product.priceXof)}`,
        `• Sous-total : ${formatFcfa(result.subtotalXof)}`,
        pitchFor(result.product.category, result.product.tags),
      ].join("\n");
    case "out_of_stock": {
      const lines = [
        "*Disponibilité*",
        `*${result.product.name}* (réf. ${result.product.id}) n'est pas disponible en ${result.quantity} unité(s) à ce jour.`,
      ];
      if (result.alternatives.length > 0) {
        lines.push("Alternatives disponibles :");
        for (const alt of result.alternatives) {
          lines.push(`• *${alt.name}* (réf. ${alt.id}) : ${formatFcfa(alt.priceXof)}, ${alt.stock} unité(s) disponible(s)`);
        }
      }
      return lines.join("\n");
    }
    case "not_found":
      return "Pour vous recommander le modèle adapté, merci de préciser votre usage principal (bureautique, développement, graphisme ou montage, études, gaming) et votre budget.";
  }
}

/** Argument commercial factuel selon la catégorie. */
function pitchFor(category: string, tags: readonly string[]): string {
  if (category === "ordinateur") {
    if (tags.includes("macbook") || tags.includes("apple")) {
      return "*Atouts :* puce Apple, autonomie prolongée, adapté au travail, aux études et à la création.";
    }
    if (tags.includes("thinkpad") || tags.includes("ultrabook")) {
      return "*Atouts :* robustesse, clavier de référence et mobilité, adapté à un usage professionnel intensif.";
    }
    if (tags.includes("gaming")) {
      return "*Atouts :* carte graphique dédiée, adapté au gaming, au montage vidéo et au rendu 3D.";
    }
    if (tags.includes("oled")) {
      return "*Atouts :* écran OLED à restitution des couleurs précise, adapté au graphisme et au visionnage.";
    }
    return "*Atouts :* bon rapport qualité-prix pour la bureautique, les études et la navigation.";
  }
  return "*Atouts :* produit sélectionné par notre équipe.";
}

function logisticsSection(result: LogisticsResult): string {
  switch (result.kind) {
    case "quoted": {
      const label = result.option === "express" ? "express" : "standard";
      return [
        "*Livraison*",
        `• Zone : ${result.zone.zone}`,
        `• Option : ${label}`,
        `• Frais : ${formatFcfa(result.feeXof)}`,
        `• Délai : ${etaPhrase(result.etaDays)}`,
        "Merci de nous indiquer le créneau souhaité et l'adresse précise (repère, rue ou point de rencontre).",
      ].join("\n");
    }
    case "ambiguous":
      return `*Livraison*\nMerci de préciser votre quartier parmi les zones suivantes : ${result.candidates.join(", ")}.`;
    case "unknown_zone":
      return `*Livraison*\nNous ne disposons pas encore de tarif pour « ${result.query} ». Merci de nous indiquer la ville ou le quartier de livraison.`;
  }
}

function orderSection(validation: ValidationRecord, conditions: string[]): string {
  const draft = validation.draft;
  const lines = draft.lines.map((line) => `• ${line.name} x${line.quantity} : ${formatFcfa(line.lineTotalXof)}`);
  const status =
    validation.status === "PENDING_HUMAN_VALIDATION"
      ? "Votre commande est en cours de validation. Nous vous confirmerons sa prise en charge sous peu."
      : validation.status === "CONFIRMED"
        ? "Votre commande est confirmée. Nous vous remercions de votre achat."
        : "Nous ne sommes pas en mesure de valider cette commande pour le moment. Notre équipe reviendra vers vous.";
  return [
    `*Récapitulatif de commande ${draft.reference}*`,
    ...lines,
    `• Sous-total articles : ${formatFcfa(draft.subtotalXof)}`,
    `• Frais de livraison : ${formatFcfa(draft.deliveryFeeXof)}`,
    `*Total : ${formatFcfa(draft.totalXof)}*`,
    `• Livraison : ${draft.zoneLabel}, ${etaPhrase(draft.etaDays)}`,
    ...conditions,
    status,
  ].join("\n");
}
