import type { AggregatedResponse, LogisticsResult, SellerResult, ValidationRecord } from "../types/palier2";
import { formatFcfa } from "./normalize";
import { SALES_POLICY, policyLines, type SalesPolicy } from "./sales-policy";

/** Libellé du délai : « livraison le jour même » pour 0 jour, sinon « délai estimé N jour(s) ». */
export function etaPhrase(etaDays: number): string {
  return etaDays === 0 ? "livraison le jour même" : `délai estimé de ${etaDays} jour(s)`;
}

/**
 * Agent Commercial : conseiller professionnel de JulieShop.
 * Ton formel et courtois (vouvoiement), questions consultatives, mise en forme WhatsApp sobre (*gras*, puces).
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
        "Pour vous orienter vers le modèle le plus adapté, merci de bien vouloir préciser votre besoin principal : bureautique, développement, graphisme ou montage, études ou gaming. Indiquez également votre budget si vous le souhaitez.",
      );
    }
    return [`*Bienvenue chez ${this.policy.storeName}.*`, ...sections, closing(aggregated, this.policy.storeName)].join("\n\n");
  }
}

function closing(aggregated: AggregatedResponse, storeName: string): string {
  if (aggregated.validation !== null) {
    return `Nous vous remercions de votre confiance.\n\nCordialement,\nL'équipe ${storeName}`;
  }
  if (aggregated.seller?.kind === "available" && aggregated.logistics === null) {
    return "Afin de calculer les frais de livraison, merci de nous indiquer votre quartier ou votre ville.";
  }
  return `Nous restons à votre disposition pour vous accompagner.\n\nCordialement,\nL'équipe ${storeName}`;
}

function sellerSection(result: SellerResult): string {
  switch (result.kind) {
    case "available": {
      const unit = result.product.sellUnit === "pagne" ? "unité(s)" : "unité(s)";
      const pitch = pitchFor(result.product.category, result.product.tags);
      return [
        `*Disponibilité confirmée*`,
        `• Modèle : ${result.product.name} (réf. ${result.product.id})`,
        `• Quantité : ${result.quantity} ${unit}`,
        `• Prix unitaire : ${formatFcfa(result.product.priceXof)}`,
        `• Sous-total : ${formatFcfa(result.subtotalXof)}`,
        pitch,
      ]
        .filter((line) => line.length > 0)
        .join("\n");
    }
    case "out_of_stock": {
      const lines = [
        `*Disponibilité*`,
        `Nous regrettons que *${result.product.name}* (réf. ${result.product.id}) ne soit pas disponible en ${result.quantity} unité(s) à ce jour.`,
      ];
      if (result.alternatives.length > 0) {
        lines.push("Nous pouvons vous proposer les alternatives suivantes :");
        for (const alt of result.alternatives) {
          lines.push(`• *${alt.name}* (réf. ${alt.id}) : ${formatFcfa(alt.priceXof)}, ${alt.stock} unité(s) disponible(s)`);
        }
        lines.push("Souhaitez-vous que nous comparions ces modèles selon vos besoins ?");
      } else {
        lines.push("Indiquez-nous votre budget et votre usage, afin que nous puissions identifier une option adaptée.");
      }
      return lines.join("\n");
    }
    case "not_found":
      return "Afin de vous recommander le modèle le plus adapté, pourriez-vous préciser votre usage principal (bureautique, développement, graphisme ou montage, études, gaming), votre budget et, si vous le souhaitez, la marque ou la taille d'écran privilégiée ?";
  }
}

/** Argument commercial sobre selon la catégorie. */
function pitchFor(category: string, tags: readonly string[]): string {
  if (category === "ordinateur") {
    if (tags.includes("macbook") || tags.includes("apple")) {
      return "*Atouts :* puce Apple, autonomie prolongée et fluidité pour le travail, les études et la création.";
    }
    if (tags.includes("thinkpad") || tags.includes("ultrabook")) {
      return "*Atouts :* robustesse, clavier de référence et mobilité, adaptés à un usage professionnel intensif.";
    }
    if (tags.includes("gaming")) {
      return "*Atouts :* carte graphique dédiée, adaptée au gaming, au montage vidéo et au rendu 3D.";
    }
    if (tags.includes("oled")) {
      return "*Atouts :* écran OLED offrant une restitution des couleurs précise, adapté au graphisme et au visionnage.";
    }
    return "*Atouts :* très bon rapport qualité-prix pour la bureautique, les études et la navigation.";
  }
  return "*Atouts :* produit de qualité, sélectionné par notre équipe.";
}

function logisticsSection(result: LogisticsResult): string {
  switch (result.kind) {
    case "quoted": {
      const label = result.option === "express" ? "express" : "standard";
      const lines = [
        `*Livraison*`,
        `• Zone : ${result.zone.zone}`,
        `• Option : ${label}`,
        `• Frais : ${formatFcfa(result.feeXof)}`,
        `• Délai : ${etaPhrase(result.etaDays)}`,
      ];
      if (result.option === "standard") {
        lines.push("Une livraison express est également disponible si vous souhaitez être livré plus rapidement.");
      }
      lines.push("Merci de nous indiquer le créneau souhaité ainsi que l'adresse précise (repère, rue ou point de rencontre).");
      return lines.join("\n");
    }
    case "ambiguous":
      return `*Livraison*\nAfin de vous communiquer le tarif exact, merci de préciser votre quartier parmi les zones suivantes : ${result.candidates.join(", ")}.`;
    case "unknown_zone":
      return `*Livraison*\nNous ne disposons pas encore de tarif pour « ${result.query} ». Nous livrons à Lomé, dans les principales villes du Togo, ainsi qu'à Cotonou, Calavi et Porto-Novo. Merci de nous préciser la ville ou le quartier.`;
  }
}

function orderSection(validation: ValidationRecord, reassurance: string[]): string {
  const draft = validation.draft;
  const lines = draft.lines.map((line) => `• ${line.name} x${line.quantity} : ${formatFcfa(line.lineTotalXof)}`);
  const status =
    validation.status === "PENDING_HUMAN_VALIDATION"
      ? "Votre commande est en cours de validation par notre équipe. Nous vous confirmerons sa prise en charge dans les meilleurs délais."
      : validation.status === "CONFIRMED"
        ? "Votre commande est confirmée. Nous vous remercions de votre achat."
        : "Nous ne sommes pas en mesure de valider cette commande pour le moment. Notre équipe reviendra vers vous rapidement.";
  return [
    `*Récapitulatif de commande ${draft.reference}*`,
    ...lines,
    `• Sous-total articles : ${formatFcfa(draft.subtotalXof)}`,
    `• Frais de livraison : ${formatFcfa(draft.deliveryFeeXof)}`,
    `*Total : ${formatFcfa(draft.totalXof)}*`,
    `• Livraison : ${draft.zoneLabel}, ${etaPhrase(draft.etaDays)}`,
    ...reassurance,
    status,
  ].join("\n");
}
