import type { Catalog, Product } from "../types";
import type { SellerResult } from "../types/palier2";
import { normalizeText, tokenize } from "./normalize";

/** Agent Vendeur : recommandations de pagnes (motifs, styles, couleurs) et alternatives en rupture. */
export class SellerAgent {
  private readonly products: readonly Product[];

  constructor(catalog: Catalog) {
    this.products = catalog.products;
  }

  recommend(query: string, quantity: number): SellerResult {
    const tokens = tokenize(query);
    const ranked = this.products
      .map((product) => ({ product, score: scoreProduct(product, tokens) }))
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

  private findAlternatives(product: Product, quantity: number): Product[] {
    return product.alternativeIds
      .map((id) => this.products.find((candidate) => candidate.id === id))
      .filter((candidate): candidate is Product => candidate !== undefined && candidate.stock >= quantity);
  }
}

function scoreProduct(product: Product, tokens: readonly string[]): number {
  const haystack = normalizeText(
    [product.id, product.name, product.description, ...product.motifs, ...product.colors, ...product.tags].join(" "),
  );
  return tokens.filter((token) => haystack.includes(token)).length;
}
