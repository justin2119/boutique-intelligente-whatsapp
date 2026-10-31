/** Formate un entier avec des espaces comme séparateurs de milliers (ex. 9 000). */
export function formatThousands(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

export function formatFcfa(value: number): string {
  return `${formatThousands(value)} FCFA`;
}

/** Formate un montant dans une devise, avec virgule décimale (ex. 17,53 EUR). */
export function formatMoney(value: number, currency: string): string {
  if (currency === "XOF") {
    return formatFcfa(value);
  }
  const [integerPart, decimalPart] = value.toFixed(2).split(".");
  return `${formatThousands(Number(integerPart))},${decimalPart} ${currency}`;
}
