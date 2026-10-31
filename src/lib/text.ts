/** Normalise un texte : minuscules, sans accents, ponctuation remplacée par des espaces. */
export function normalizeText(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Vrai si la phrase normalisée apparaît en tant que suite de mots entiers. */
export function containsPhrase(normalizedText: string, normalizedPhrase: string): boolean {
  return ` ${normalizedText} `.includes(` ${normalizedPhrase} `);
}
