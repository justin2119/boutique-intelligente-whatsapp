/** Utilitaires de texte du Palier 2 : normalisation (sans accents, minuscules) et formatage FCFA. */

const STOPWORDS: ReadonlySet<string> = new Set([
  "bonjour", "je", "cherche", "des", "les", "une", "pour", "livre", "livrer", "combien", "svp",
  "merci", "dans", "avec", "est", "pagne", "pagnes", "prends", "commande", "veux", "acheter",
  "express", "urgent", "confirme", "reserve", "moi", "vous", "nous", "tres", "bien", "comment",
  "quel", "quelle", "ca", "coute",
]);

export function normalizeText(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(input: string): string[] {
  return normalizeText(input)
    .split(" ")
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

export function formatFcfa(amount: number): string {
  const grouped = Math.round(amount).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${grouped} FCFA`;
}
