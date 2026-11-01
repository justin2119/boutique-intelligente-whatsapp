/**
 * Politique commerciale de JulieShop (Togo), reprise dans les messages client.
 * Valeurs par défaut Togo : paiement à la livraison, vérification du matériel avant paiement, garantie 6 mois.
 */
export interface SalesPolicy {
  readonly storeName: string;
  /** Paiement à la livraison accepté. */
  readonly paymentOnDeliveryAvailable: boolean;
  /** Moyens de paiement acceptés à la livraison. */
  readonly paymentMethods: readonly string[];
  /** Vérification du matériel devant le client avant paiement. */
  readonly inspectBeforePaymentAvailable: boolean;
  /** Garantie affichée au client, ou null si aucune. */
  readonly warranty: string | null;
}

export const SALES_POLICY: SalesPolicy = {
  storeName: "JulieShop",
  paymentOnDeliveryAvailable: true,
  paymentMethods: ["espèces", "T-Money", "Flooz"],
  inspectBeforePaymentAvailable: true,
  warranty: "6 mois incluse",
};

/** Lignes de garantie et de paiement à afficher sur un récapitulatif, selon la politique en vigueur. */
export function policyLines(policy: SalesPolicy = SALES_POLICY): string[] {
  const lines: string[] = [];
  lines.push("*Conditions*");
  if (policy.paymentOnDeliveryAvailable) {
    lines.push(`• Paiement à la livraison accepté : ${policy.paymentMethods.join(", ")}.`);
  }
  if (policy.inspectBeforePaymentAvailable) {
    lines.push("• Vous pouvez vérifier le matériel avant tout paiement.");
  }
  if (policy.warranty !== null) {
    lines.push(`• Garantie : ${policy.warranty}.`);
  }
  return lines.length > 1 ? lines : [];
}
