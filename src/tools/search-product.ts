import {
  PRODUCT_CATEGORIES,
  type Catalog,
  type Product,
  type ProductCategory,
  type SaleUnit,
  type ToolHandler,
  type ToolResult,
} from "../types";
import { normalizeText } from "./text";
import { optionalInteger, optionalString } from "./validation";

type Args = Readonly<Record<string, unknown>>;

export interface ProductSummary {
  readonly id: string;
  readonly name: string;
  readonly category: ProductCategory;
  readonly sellUnit: SaleUnit;
  readonly priceXof: number;
  readonly stock: number;
  readonly inStock: boolean;
  readonly colors: readonly string[];
  readonly motifs: readonly string[];
}

export interface SearchProductData {
  readonly matchType: "all_terms" | "partial" | "filters_only";
  readonly totalMatches: number;
  readonly products: readonly ProductSummary[];
}

function readStringList(args: Args, key: string): ToolResult<readonly string[]> {
  const value = args[key];
  if (value === undefined) {
    return { ok: true, data: [] };
  }
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) {
    return { ok: false, error: `Paramètre "${key}" : liste de textes attendue.` };
  }
  return { ok: true, data: value.map(normalizeText).filter((item) => item !== "") };
}

function searchableWords(product: Product): string[] {
  const text = normalizeText(
    [product.name, product.category, product.description, ...product.tags, ...product.motifs, ...product.colors].join(" "),
  );
  return text.split(" ");
}

function countTermHits(words: readonly string[], terms: readonly string[]): number {
  return terms.filter((term) => words.some((word) => word.startsWith(term))).length;
}

function summarize(product: Product): ProductSummary {
  return {
    id: product.id,
    name: product.name,
    category: product.category,
    sellUnit: product.sellUnit,
    priceXof: product.priceXof,
    stock: product.stock,
    inStock: product.stock > 0,
    colors: product.colors,
    motifs: product.motifs,
  };
}

/** Outil : recherche de produits par mots-clés, catégorie, couleurs et motifs. */
export function createSearchProductTool(catalog: Catalog): ToolHandler {
  return {
    definition: {
      name: "search_product",
      description:
        "Recherche des pagnes et accessoires dans le catalogue par mots-clés, catégorie, couleurs ou motifs. Renvoie les produits correspondants avec prix et stock.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Mots-clés libres, par exemple 'super wax vert'." },
          category: { type: "string", enum: [...PRODUCT_CATEGORIES] },
          colors: { type: "array", items: { type: "string" } },
          motifs: { type: "array", items: { type: "string" } },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
        additionalProperties: false,
      },
    },
    async run(args: Args): Promise<ToolResult<unknown>> {
      const query = optionalString(args, "query");
      const category = optionalString(args, "category");
      if (category !== undefined && !(PRODUCT_CATEGORIES as readonly string[]).includes(category)) {
        return { ok: false, error: `Catégorie inconnue : "${category}".` };
      }
      const colors = readStringList(args, "colors");
      if (!colors.ok) {
        return colors;
      }
      const motifs = readStringList(args, "motifs");
      if (!motifs.ok) {
        return motifs;
      }
      const limit = optionalInteger(args, "limit", 10, 1, 20);
      if (!limit.ok) {
        return limit;
      }

      const terms = query === undefined ? [] : normalizeText(query).split(" ").filter((term) => term !== "");
      const candidates = catalog.products.filter(
        (product) =>
          (category === undefined || product.category === category) &&
          colors.data.every((wanted) => product.colors.some((color) => normalizeText(color).includes(wanted))) &&
          motifs.data.every((wanted) => product.motifs.some((motif) => normalizeText(motif).includes(wanted))),
      );

      const ranked = candidates.map((product) => ({
        product,
        hits: countTermHits(searchableWords(product), terms),
      }));

      let matchType: SearchProductData["matchType"] = "filters_only";
      let matched = ranked;
      if (terms.length > 0) {
        const complete = ranked.filter((entry) => entry.hits === terms.length);
        if (complete.length > 0) {
          matched = complete;
          matchType = "all_terms";
        } else {
          matched = ranked.filter((entry) => entry.hits > 0);
          matchType = "partial";
        }
      }

      const sorted = [...matched].sort(
        (a, b) => b.hits - a.hits || Number(b.product.stock > 0) - Number(a.product.stock > 0),
      );
      const data: SearchProductData = {
        matchType,
        totalMatches: sorted.length,
        products: sorted.slice(0, limit.data).map((entry) => summarize(entry.product)),
      };
      return { ok: true, data };
    },
  };
}
