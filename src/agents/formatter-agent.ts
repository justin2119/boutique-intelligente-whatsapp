import type { AggregatedResponse, LogisticsResult, SellerResult, ValidationRecord } from "../types/palier2";
import { formatFcfa } from "./normalize";
import { SALES_POLICY, policyLines, type SalesPolicy } from "./sales-policy";

/** Libellé du délai : « livraison le jour même » pour 0 jour, sinon « délai estimé N jour(s) ». */
export function etaPhrase(etaDays: number): string {
  return etaDays === 0 ? "livraison le jour même" : `délai estimé ${etaDays} jour(s)`;
}

/**
 * Agent Commercial / Formateur WhatsApp : conseiller de JulieShop 🇹🇬.
 * Ton chaleureux et persuasif, questions consultatives, mise en forme WhatsApp (*gras*, puces, emojis utiles).
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
        "Je serai ravi de vous conseiller 😊 Pour vous proposer le bon modèle, dites-moi : quel est votre besoin principal (bureautique, montage vidéo, développement, études, pagne pour une cérémonie) ?",
      );
    }
    return [`Bonjour et bienvenue chez *${this.policy.storeName}* 🇹🇬 !`, ...sections, closing(aggregated)].join("\n\n");
  }
}

function closing(aggregated: AggregatedResponse): string {
  if (aggregated.validation !== null) {
    return "Merci de votre confiance, c'est un plaisir de vous servir ! 🙏🏾";
  }
  if (aggregated.seller?.kind === "available" && aggregated.logistics === null) {
    return "Dites-moi juste votre quartier ou votre ville à Lomé, et je vous calcule la livraison tout de suite 🚚";
  }
  return "Je reste à votre disposition pour vous guider jusqu'à la commande 😊";
}

function sellerSection(result: SellerResult): string {
  switch (result.kind) {
    case "available": {
      const unit = result.product.sellUnit === "pagne" ? "pagne(s)" : "pièce(s)";
      const pitch = pitchFor(result.product.category, result.product.tags);
      return [
        `✅ Excellent choix : *${result.product.name}* (${result.product.id}) est disponible pour ${result.quantity} ${unit}.`,
        pitch,
        `💰 Prix : *${formatFcfa(result.subtotalXof)}* (${formatFcfa(result.product.priceXof)} l'unité).`,
      ]
        .filter((line) => line.length > 0)
        .join("\n");
    }
    case "out_of_stock": {
      const lines = [
        `😔 Désolé, *${result.product.name}* (${result.product.id}) n'est plus disponible en ${result.quantity} unité(s).`,
      ];
      if (result.alternatives.length > 0) {
        lines.push("✨ Mais je vous recommande aussi :");
        for (const alt of result.alternatives) {
          lines.push(`• *${alt.name}* (${alt.id}) : ${formatFcfa(alt.priceXof)}, ${alt.stock} disponible(s)`);
        }
        lines.push("Lequel vous attire le plus ? Je peux aussi vous comparer les deux.");
      } else {
        lines.push("Dites-moi votre budget ou votre usage, je vous trouve une autre option qui vous plaira.");
      }
      return lines.join("\n");
    }
    case "not_found":
      return "🤔 Je ne suis pas sûr de bien comprendre. Pour bien vous conseiller, dites-moi l'usage principal (bureautique, montage vidéo, développement, études, cérémonie), votre budget et, si vous les connaissez, la marque ou la taille d'écran souhaitées.";
  }
}

/** Argument de vente court selon la catégorie : ce qui convainc vraiment le client. */
function pitchFor(category: string, tags: readonly string[]): string {
  if (category === "ordinateur") {
    if (tags.includes("macbook") || tags.includes("apple")) {
      return "🚀 Puce Apple : autonomie exceptionnelle et fluidité au quotidien, idéal pour le travail, les études et la création.";
    }
    if (tags.includes("thinkpad") || tags.includes("ultrabook")) {
      return "🛡️ Robustesse et clavier de référence : parfait pour un usage intensif et les longues journées de travail.";
    }
    if (tags.includes("gaming")) {
      return "🎮 Carte graphique dédiée : jeux, montage et rendu 3D, vous êtes prêt pour la performance.";
    }
    if (tags.includes("oled")) {
      return "🖥️ Écran OLED : couleurs éclatantes, parfait pour le design et le visionnage.";
    }
    return "💻 Très bon rapport qualité-prix pour la bureautique, les études et la navigation.";
  }
  if (category === "vlisco" || category === "kente") {
    return "👑 Une pièce d'exception, qui fera sensation lors de votre événement.";
  }
  return "🌟 Un tissu de qualité, des motifs qui font le style.";
}

function logisticsSection(result: LogisticsResult): string {
  switch (result.kind) {
    case "quoted": {
      const label = result.option === "express" ? "express" : "standard";
      const lines = [
        `🚚 Super, on livre à *${result.zone.zone}* ! Livraison ${label} : *${formatFcfa(result.feeXof)}*, ${etaPhrase(result.etaDays)}.`,
      ];
      if (result.option === "standard") {
        lines.push("⚡ Vous voulez être livré plus vite ? Je peux vous proposer l'option express.");
      }
      lines.push("📅 Quel jour et quelle plage horaire vous arrangent le mieux ?");
      lines.push("🏠 Pouvez-vous me donner l'adresse précise (repère, rue ou point de rencontre) ?");
      return lines.join("\n");
    }
    case "ambiguous":
      return `📍 Pour vous donner le tarif exact, précisez le quartier parmi : ${result.candidates.join(", ")} 😊`;
    case "unknown_zone":
      return `📍 Je n'ai pas encore de tarif pour « ${result.query} ». Dites-moi la ville ou le quartier : nous livrons à Lomé (1 000 FCFA et plus), dans les régions du Togo, et à Cotonou, Calavi, Porto-Novo.`;
  }
}

function orderSection(validation: ValidationRecord, reassurance: string[]): string {
  const draft = validation.draft;
  const lines = draft.lines.map((line) => `• ${line.name} x${line.quantity} : ${formatFcfa(line.lineTotalXof)}`);
  const status =
    validation.status === "PENDING_HUMAN_VALIDATION"
      ? "⏳ Votre commande est en cours de validation par notre équipe. Nous vous confirmons très vite !"
      : validation.status === "CONFIRMED"
        ? "🎉 Votre commande est confirmée ! Merci pour votre achat, vous allez adorer."
        : "⚠️ Nous ne pouvons pas valider cette commande pour le moment. Notre équipe revient vers vous rapidement.";
  return [
    `🧾 *Récapitulatif ${draft.reference}*`,
    ...lines,
    `Articles : ${formatFcfa(draft.subtotalXof)}`,
    `Livraison : ${formatFcfa(draft.deliveryFeeXof)}`,
    `*Total : ${formatFcfa(draft.totalXof)}*`,
    `📦 Livraison à ${draft.zoneLabel}, ${etaPhrase(draft.etaDays)}.`,
    ...reassurance,
    status,
  ].join("\n");
}
