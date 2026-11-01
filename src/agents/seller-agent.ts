import type { Catalog, Product } from "../types";
import type { SellerResult } from "../types/palier2";
import { normalizeText, tokenize } from "./normalize";
import { SYNONYMS, hasTechTerm, parseBudget } from "./intent-terms";

/** Agent Vendeur : recommandations (pagnes et ordinateurs), budget et alternatives en rupture. */
export class SellerAgent {
  private readonly products: readonly Product[];

  constructor(catalog: Catalog) {
    this.products = catalog.products;
  }

  recommend(query: string, quantity: number): SellerResult {
    const budget = parseBudget(query);
    const tokens = expandTokens(tokenize(query));
    const tech = hasTechTerm(query);
    const pool = budget === null ? this.products : this.products.filter((p) => p.priceXof <= budget);
    const ranked = pool
      .map((product) => ({ product, score: scoreProduct(product, tokens, tech) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.product.stock - a.product.stock);
    const best = ranked[0];
    if (best === undefined) {
      return { kind: "not_found", query };
    }
    const product = best.product;
    if (product.stock >= quantity) {
      return { kind: "available", product, quantity, subtotalXof: product.priceXof * quantity };
    }
    return { kind: "out_of_stock", product, quantity, alternatives: this.findAlternatives(product, quantity) };
  }

  /** Liste les ordinateurs en stock, triés par prix croissant, sous un budget éventuel. */
  listComputers(budget: number | null): Product[] {
    return this.products
      .filter((p) => p.category === "ordinateur" && p.stock > 0)
      .filter((p) => budget === null || p.priceXof <= budget)
      .sort((a, b) => a.priceXof - b.priceXof);
  }

  private findAlternatives(product: Product, quantity: number): Product[] {
    return product.alternativeIds
      .map((id) => this.products.find((candidate) => candidate.id === id))
      .filter((candidate): candidate is Product => candidate !== undefined && candidate.stock >= quantity);
  }
}

function expandTokens(tokens: readonly string[]): string[] {
  const expanded = [...tokens];
  for (const token of tokens) {
    for (const synonym of SYNONYMS[token] ?? []) {
      expanded.push(normalizeText(synonym));
    }
  }
  return expanded;
}

/**
 * Score = nombre de termes du message présents dans la fiche produit.
 * Pour une demande informatique, les motifs et couleurs des pagnes ne comptent pas,
 * et les produits « ordinateur » ont la priorité sur les accessoires.
 */
function scoreProduct(product: Product, tokens: readonly string[], tech: boolean): number {
  if (tech && product.category !== "ordinateur") {
    return 0;
  }
  if (!tech && product.category === "ordinateur" && !tokens.includes("ordinateur") && !tokens.includes("laptop")) {
    // Une recherche de tissu ne doit pas remonter un ordinateur par hasard.
    return 0;
  }
  const parts = tech
    ? [product.id, product.name, product.description, ...product.tags]
    : [product.id, product.name, product.description, ...product.motifs, ...product.colors, ...product.tags];
  const haystack = normalizeText(parts.join(" "));
  return tokens.filter((token) => haystack.includes(token)).length;
}
