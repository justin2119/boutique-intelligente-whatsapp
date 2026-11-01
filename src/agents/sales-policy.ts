/**
 * Politique commerciale de JulieShop (Togo), reprise dans les messages client.
 * Valeurs par défaut Togo, à confirmer par la direction avant mise en production :
 * paiement à la livraison, vérification du matériel avant paiement, garantie de 6 mois.
 */
export interface SalesPolicy {
  readonly storeName: string;
  /** Paiement à la livraison accepté. */
  readonly paymentOnDeliveryAvailable: boolean;
  /** Moyens de paiement acceptés à la livraison. */
  readonly paymentMethods: readonly string[];
  /** Vérification du matériel devant le client avant paiement. */
  readonly inspectBeforePaymentAvailable: boolean;
  /** Durée de garantie affichée au client, ou null si aucune. */
  readonly warranty: string | null;
}

export const SALES_POLICY: SalesPolicy = {
  storeName: "JulieShop",
  paymentOnDeliveryAvailable: true,
  paymentMethods: ["espèces", "T-Money", "Flooz"],
  inspectBeforePaymentAvailable: true,
  warranty: "6 mois",
};

/** Énumération en français : « a, b ou c ». */
function enumerate(items: readonly string[]): string {
  if (items.length <= 1) {
    return items.join("");
  }
  return `${items.slice(0, -1).join(", ")} ou ${items[items.length - 1]}`;
}

/** Lignes de conditions (paiement, vérification, garantie) à afficher sur un récapitulatif. */
export function policyLines(policy: SalesPolicy = SALES_POLICY): string[] {
  const lines: string[] = [];
  if (policy.paymentOnDeliveryAvailable) {
    lines.push(`• Paiement à la livraison : ${enumerate(policy.paymentMethods)}.`);
  }
  if (policy.inspectBeforePaymentAvailable) {
    lines.push("• Vérification du matériel possible avant paiement.");
  }
  if (policy.warranty !== null) {
    lines.push(`• Garantie : ${policy.warranty}.`);
  }
  return lines.length > 0 ? ["*Conditions*", ...lines] : [];
}
