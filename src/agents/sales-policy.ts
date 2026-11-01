/**
 * Politique commerciale de JulieShop, reprise dans les messages client.
 * Chaque option ci-dessous doit être confirmée par la boutique avant d'être activée :
 * tant qu'elle vaut false ou null, la ligne correspondante n'apparaît pas chez le client.
 */
export interface SalesPolicy {
  readonly storeName: string;
  /** Paiement à la livraison : à activer seulement si la boutique l'accepte réellement. */
  readonly paymentOnDeliveryAvailable: boolean;
  /** Vérification du matériel devant le client avant paiement. */
  readonly inspectBeforePaymentAvailable: boolean;
  /** Garantie affichée au client (ex. « 3 mois sur les ordinateurs »), ou null si non confirmée. */
  readonly warranty: string | null;
}

export const SALES_POLICY: SalesPolicy = {
  storeName: "JulieShop",
  paymentOnDeliveryAvailable: false,
  inspectBeforePaymentAvailable: false,
  warranty: null,
};

/** Lignes de réassurance à afficher sur un récapitulatif, selon la politique confirmée. */
export function policyLines(policy: SalesPolicy = SALES_POLICY): string[] {
  const lines: string[] = [];
  if (policy.paymentOnDeliveryAvailable) {
    lines.push("💵 Paiement à la livraison possible");
  }
  if (policy.inspectBeforePaymentAvailable) {
    lines.push("🔍 Vous vérifiez votre article avant de payer");
  }
  if (policy.warranty !== null) {
    lines.push(`🛡️ Garantie : ${policy.warranty}`);
  }
  return lines;
}
