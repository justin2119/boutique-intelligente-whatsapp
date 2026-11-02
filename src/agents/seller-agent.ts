import type { Catalog, Product } from "../types";
import { PRODUCT_CATEGORIES } from "../types";
import type { CategorySummary, LaptopRecommendation, SellerResult, UseCase } from "../types/palier2";
import { normalizeText, tokenize } from "./normalize";
import { SYNONYMS, USE_CASE_KEYWORDS, USE_CASE_TERMS, hasTechTerm, parseBudget } from "./intent-terms";

/**
 * Tags de fiche produit jugés adaptés à chaque usage (choix éditorial, à relire par la boutique).
 * Un ordinateur est recommandé pour un usage si l'un de ses tags figure dans cette liste.
 */
const USE_CASE_TAGS: Readonly<Record<UseCase, readonly string[]>> = {
  etudes: ["ultrabook", "macbook", "air", "thinkpad", "zenbook", "envy", "2-en-1"],
  bureautique: ["thinkpad", "ultrabook", "core i7", "carbon", "t14"],
  programmation: ["macbook", "pro", "m4", "thinkpad", "core i7", "carbon"],
  creation: ["oled", "macbook", "pro", "m4", "xps", "tactile"],
  gaming: ["gaming", "rtx"],
};

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
    return this.resultFor(best.product, quantity);
  }

  /** Reprend un produit précis (suivi de conversation) et renvoie son statut de stock pour la quantité demandée. */
  byId(id: string, quantity: number): SellerResult {
    const product = this.getById(id);
    if (product === undefined) {
      return { kind: "not_found", query: id };
    }
    return this.resultFor(product, quantity);
  }

  /** Produit du catalogue par identifiant, ou undefined. */
  getById(id: string): Product | undefined {
    return this.products.find((product) => product.id === id);
  }

  /** Liste les ordinateurs en stock, triés par prix croissant, sous un budget éventuel. */
  listComputers(budget: number | null): Product[] {
    return this.products
      .filter((p) => p.category === "ordinateur" && p.stock > 0)
      .filter((p) => budget === null || p.priceXof <= budget)
      .sort((a, b) => a.priceXof - b.priceXof);
  }

  /**
   * Vue d'ensemble du catalogue en stock : une ligne par catégorie (dans l'ordre du catalogue),
   * avec le nombre d'articles et la fourchette de prix. Les catégories épuisées sont omises.
   */
  listCatalogSummary(): CategorySummary[] {
    const summaries: CategorySummary[] = [];
    for (const category of PRODUCT_CATEGORIES) {
      const prices = this.products
        .filter((p) => p.category === category && p.stock > 0)
        .map((p) => p.priceXof);
      if (prices.length === 0) {
        continue;
      }
      summaries.push({
        category,
        count: prices.length,
        minPriceXof: Math.min(...prices),
        maxPriceXof: Math.max(...prices),
      });
    }
    return summaries;
  }

  /**
   * Ordinateurs en stock recommandés pour un usage (études, bureautique, programmation, création, gaming),
   * sous un budget éventuel. Triés par pertinence (nombre de tags adaptés), puis par prix croissant.
   */
  recommendLaptops(useCase: UseCase, budget: number | null): LaptopRecommendation[] {
    const wanted = new Set(USE_CASE_TAGS[useCase].map((tag) => normalizeText(tag)));
    return this.listComputers(budget)
      .map((product) => ({
        product,
        useCase,
        score: product.tags.filter((tag) => wanted.has(normalizeText(tag))).length,
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.product.priceXof - b.product.priceXof);
  }

  private resultFor(product: Product, quantity: number): SellerResult {
    if (product.stock >= quantity) {
      return { kind: "available", product, quantity, subtotalXof: product.priceXof * quantity };
    }
    return { kind: "out_of_stock", product, quantity, alternatives: this.findAlternatives(product, quantity) };
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
 * Score = nombre de termes du message présents dans la fiche produit, plus les tags adaptés à l'usage
 * déclaré (« pour mes études »). Pour une demande informatique, les motifs et couleurs des pagnes ne comptent pas,
 * et les produits « ordinateur » ont la priorité sur les accessoires. Un ordinateur peut être trouvé
 * par son usage seul, sans mot informatique.
 */
function scoreProduct(product: Product, tokens: readonly string[], tech: boolean): number {
  if (tech && product.category !== "ordinateur") {
    return 0;
  }
  const useCaseMatch = tokens.some((token) => USE_CASE_KEYWORDS.has(token));
  if (!tech && product.category === "ordinateur" && !tokens.includes("ordinateur") && !tokens.includes("laptop") && !useCaseMatch) {
    return 0;
  }
  const parts = tech
    ? [product.id, product.name, product.description, ...product.tags]
    : [product.id, product.name, product.description, ...product.motifs, ...product.colors, ...product.tags];
  const haystack = normalizeText(parts.join(" "));
  const keywordScore = tokens.filter((token) => haystack.includes(token)).length;
  return keywordScore + useCaseScore(product, tokens);
}

/** Pour chaque usage annoncé dans le message, compte les tags de l'ordinateur adaptés à cet usage. */
function useCaseScore(product: Product, tokens: readonly string[]): number {
  if (product.category !== "ordinateur") {
    return 0;
  }
  const productTags = new Set(product.tags.map((tag) => normalizeText(tag)));
  let score = 0;
  for (const key of Object.keys(USE_CASE_TAGS)) {
    const useCase = key as UseCase;
    const announced = USE_CASE_TERMS[useCase].some((term) => tokens.includes(normalizeText(term)));
    if (!announced) {
      continue;
    }
    score += USE_CASE_TAGS[useCase].filter((tag) => productTags.has(normalizeText(tag))).length;
  }
  return score;
}
