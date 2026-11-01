import { normalizeText } from "./normalize";

/** Termes informatiques reconnus (mots entiers, texte normalisé sans accents). */
export const TECH_TERMS: readonly string[] = [
  "pc", "pcs", "ordinateur", "ordinateurs", "laptop", "laptops", "portable", "portables",
  "macbook", "macbooks", "mac", "apple", "lenovo", "thinkpad", "dell", "xps", "hp", "asus",
  "zenbook", "acer", "nitro", "envy", "victus", "spectre", "machine", "machines", "core",
  "intel", "ryzen", "amd", "gaming", "gamer", "bureau", "bureautique", "tactile", "ultrabook",
  "oled", "ssd", "ram", "rtx", "gtx", "gpu", "cpu", "ecran", "clavier", "batterie", "processeur",
  "windows", "linux", "pouce", "pouces", "config", "configuration", "specs", "memoire", "stockage",
  "i3", "i5", "i7", "i9", "m1", "m2", "m3", "m4", "2-en-1",
];

/** Termes de tissus et d'accessoires du catalogue existant. */
export const FABRIC_TERMS: readonly string[] = [
  "wax", "pagne", "pagnes", "super", "vlisco", "kente", "woodin", "tissu", "motif", "motifs",
  "hollandais", "foulard", "sac", "boucles", "ceinture",
];

/** Synonymes courants : un mot du client est ramené aux termes utilisés dans le catalogue. */
export const SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  portable: ["laptop"],
  portables: ["laptop"],
  machine: ["ordinateur"],
  machines: ["ordinateur"],
  pc: ["ordinateur"],
  pcs: ["ordinateur"],
  ordinateurs: ["ordinateur"],
  bureautique: ["ordinateur"],
  gamer: ["gaming"],
  mac: ["macbook"],
};

/** « budget 500 000 », « moins de 500000 », « jusqu'à 600 000 » (après normalisation). */
const BUDGET_CONTEXT =
  /(?:budget|moins de|max(?:imum)?|jusqu a|pas plus de|dans la limite de|environ|autour de|a moins de)\s*(?:de\s*)?(\d{1,3}(?: \d{3})+|\d{4,9})(?:\s*fcfa)?/;
/** « 500 000 FCFA », « 500000 francs ». */
const BUDGET_CURRENCY = /(\d{1,3}(?: \d{3})+|\d{4,9})\s*(?:fcfa|f cfa|cfa|francs?)\b/;

/**
 * Créneau de livraison (texte normalisé) : mot-clé de créneau, moment de la journée, « demain »,
 * ou heure (« 15h », « 7h00-12h00 »).
 */
const SLOT_PATTERN = /\b(creneau|matin|apres[- ]?midi|soir|midi|demain|aujourd hui|\d{1,2} ?h(?:\d{2})?)\b/;

function containsAnyWord(message: string, terms: readonly string[]): boolean {
  const text = ` ${normalizeText(message)} `;
  return terms.some((term) => text.includes(` ${normalizeText(term)} `));
}

/** Vrai si le message contient un terme informatique ou une spécification (16 Go, 1 To, 3 GHz). */
export function hasTechTerm(message: string): boolean {
  const text = normalizeText(message);
  return containsAnyWord(text, TECH_TERMS) || /\b\d+ ?(?:go|gb|to|tb|ghz|mhz)\b/.test(text);
}

/** Vrai si le message contient un tissu ou un accessoire du catalogue existant. */
export function hasFabricTerm(message: string): boolean {
  return containsAnyWord(message, FABRIC_TERMS);
}

/** Budget maximum en FCFA, ou null. Les montants inférieurs à 10 000 FCFA sont ignorés. */
export function parseBudget(message: string): number | null {
  const text = normalizeText(message);
  const match = BUDGET_CONTEXT.exec(text) ?? BUDGET_CURRENCY.exec(text);
  const raw = match?.[1];
  if (raw === undefined) {
    return null;
  }
  const amount = Number(raw.replace(/ /g, ""));
  return amount >= 10000 ? amount : null;
}

/** Retire l'expression de budget du message, pour que le montant ne soit pas lu comme produit ou quantité. */
export function stripBudget(message: string): string {
  return normalizeText(message)
    .replace(BUDGET_CONTEXT, " ")
    .replace(BUDGET_CURRENCY, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Vrai si le message donne un créneau (« Créneau vers 15h », « 7h00-12h00 », « demain matin »). */
export function parseSlot(message: string): string | null {
  if (!SLOT_PATTERN.test(normalizeText(message))) {
    return null;
  }
  return message.trim().slice(0, 120);
}
