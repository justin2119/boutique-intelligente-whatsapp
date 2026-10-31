import type { AggregatedResponse, LogisticsResult, SellerResult, ValidationRecord } from "../types/palier2";
import { formatFcfa } from "./normalize";

/** Libellé du délai : « livraison le jour même » pour 0 jour, sinon « délai estimé N jour(s) ». */
export function etaPhrase(etaDays: number): string {
  return etaDays === 0 ? "livraison le jour même" : `délai estimé ${etaDays} jour(s)`;
}

/** Agent Éditeur / Formateur WhatsApp : ton de commerçant béninois, mise en forme WhatsApp (*gras*, emojis). */
export class FormatterAgent {
  compose(aggregated: AggregatedResponse): string {
    const sections: string[] = [];
    if (aggregated.seller !== null) {
      sections.push(sellerSection(aggregated.seller));
    }
    if (aggregated.logistics !== null) {
      sections.push(logisticsSection(aggregated.logistics));
    }
    if (aggregated.validation !== null) {
      sections.push(orderSection(aggregated.validation));
    }
    if (sections.length === 0) {
      sections.push("Dites-moi le modèle de pagne qui vous intéresse, la quantité et le lieu de livraison 😊");
    }
    return ["Bonjour 🙏🏾", ...sections, "Merci de votre confiance, à bientôt sur Dantokpa 🧵🇧🇯"].join("\n\n");
  }
}

function sellerSection(result: SellerResult): string {
  switch (result.kind) {
    case "available": {
      const unit = result.product.sellUnit === "pagne" ? "pagne(s)" : "pièce(s)";
      return `✅ *${result.product.name}* (${result.product.id}) est disponible pour ${result.quantity} ${unit}.\n💰 Prix : ${formatFcfa(result.product.priceXof)} l'unité, soit ${formatFcfa(result.subtotalXof)}.`;
    }
    case "out_of_stock": {
      const lines = [`😔 *${result.product.name}* (${result.product.id}) n'a pas assez de stock pour ${result.quantity} unité(s).`];
      if (result.alternatives.length > 0) {
        lines.push("✨ Je vous propose plutôt :");
        for (const alt of result.alternatives) {
          lines.push(`• *${alt.name}* (${alt.id}) : ${formatFcfa(alt.priceXof)} l'unité, ${alt.stock} disponible(s)`);
        }
      } else {
        lines.push("Je peux vérifier d'autres coloris pour vous.");
      }
      return lines.join("\n");
    }
    case "not_found":
      return "🤔 Je ne retrouve pas ce modèle dans la boutique. Pouvez-vous préciser la couleur ou le motif ?";
  }
}

function logisticsSection(result: LogisticsResult): string {
  switch (result.kind) {
    case "quoted": {
      const label = result.option === "express" ? "express" : "standard";
      return `🚚 Livraison ${label} à ${result.zone.zone} : ${formatFcfa(result.feeXof)}, ${etaPhrase(result.etaDays)}.`;
    }
    case "ambiguous":
      return `📍 Pour calculer les frais, précisez le quartier parmi : ${result.candidates.join(", ")}.`;
    case "unknown_zone":
      return `📍 Je n'ai pas encore de tarif pour « ${result.query} ». Précisez la ville ou le quartier (Cotonou, Calavi, Porto-Novo ou Lomé).`;
  }
}

function orderSection(validation: ValidationRecord): string {
  const draft = validation.draft;
  const lines = draft.lines.map((line) => `• ${line.name} x${line.quantity} : ${formatFcfa(line.lineTotalXof)}`);
  const status =
    validation.status === "PENDING_HUMAN_VALIDATION"
      ? "⏳ Votre commande est en attente de validation par notre équipe. Nous vous confirmons dès qu'elle est validée."
      : validation.status === "CONFIRMED"
        ? "🎉 Votre commande est confirmée. Merci pour votre achat !"
        : "⚠️ Nous ne pouvons pas valider cette commande pour le moment. Notre équipe revient vers vous rapidement.";
  return [
    `🧾 *Récapitulatif ${draft.reference}*`,
    ...lines,
    `Articles : ${formatFcfa(draft.subtotalXof)}`,
    `Livraison : ${formatFcfa(draft.deliveryFeeXof)}`,
    `*Total : ${formatFcfa(draft.totalXof)}*`,
    `📦 Livraison à ${draft.zoneLabel}, ${etaPhrase(draft.etaDays)}.`,
    status,
  ].join("\n");
}
