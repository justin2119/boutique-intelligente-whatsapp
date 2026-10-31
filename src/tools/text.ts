/** Normalise un texte : minuscules, sans accents, ponctuation remplacée par des espaces. */
export function normalizeText(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Vrai si `phrase` apparaît en mots entiers dans `text` (les deux textes doivent être normalisés). */
export function containsPhrase(text: string, phrase: string): boolean {
  if (phrase === "") {
    return false;
  }
  return ` ${text} `.includes(` ${phrase} `);
}
