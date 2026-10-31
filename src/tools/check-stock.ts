import type { Catalog, Product, SaleUnit, ToolHandler, ToolResult } from "../types";
import { optionalInteger, requireString } from "./validation";

type Args = Readonly<Record<string, unknown>>;

export interface StockAlternative {
  readonly id: string;
  readonly name: string;
  readonly priceXof: number;
  readonly stock: number;
  readonly sellUnit: SaleUnit;
}

export interface StockData {
  readonly productId: string;
  readonly name: string;
  readonly sellUnit: SaleUnit;
  readonly priceXof: number;
  readonly stock: number;
  readonly requestedQuantity: number;
  readonly status: "available" | "insufficient" | "out_of_stock";
  readonly alternativeIds: readonly string[];
  readonly alternatives: readonly StockAlternative[];
}

function toAlternative(product: Product): StockAlternative {
  return {
    id: product.id,
    name: product.name,
    priceXof: product.priceXof,
    stock: product.stock,
    sellUnit: product.sellUnit,
  };
}

/** Outil : vérifie le stock d'un produit pour une quantité et renvoie les alternatives en cas de rupture. */
export function createCheckStockTool(catalog: Catalog): ToolHandler {
  const byId = new Map<string, Product>(catalog.products.map((product) => [product.id.toUpperCase(), product]));

  return {
    definition: {
      name: "check_stock",
      description:
        "Vérifie le stock d'un produit (identifiant ou référence, par exemple SW-001) pour une quantité donnée. En cas de rupture ou de stock insuffisant, renvoie les alternatives (alternativeIds) disponibles.",
      parameters: {
        type: "object",
        properties: {
          productId: { type: "string", description: "Identifiant ou référence du produit, par exemple SW-001." },
          quantity: { type: "integer", minimum: 1, maximum: 1000 },
        },
        required: ["productId"],
        additionalProperties: false,
      },
    },
    async run(args: Args): Promise<ToolResult<unknown>> {
      const id = requireString(args, "productId");
      if (!id.ok) {
        return id;
      }
      const quantity = optionalInteger(args, "quantity", 1, 1, 1000);
      if (!quantity.ok) {
        return quantity;
      }
      const product = byId.get(id.data.toUpperCase());
      if (product === undefined) {
        return { ok: false, error: `Produit introuvable : "${id.data}".` };
      }

      const status: StockData["status"] =
        product.stock === 0 ? "out_of_stock" : product.stock < quantity.data ? "insufficient" : "available";

      const alternatives: StockAlternative[] = [];
      if (status !== "available") {
        for (const altId of product.alternativeIds) {
          const alt = byId.get(altId.toUpperCase());
          if (alt !== undefined && alt.stock >= quantity.data) {
            alternatives.push(toAlternative(alt));
          }
        }
      }

      const data: StockData = {
        productId: product.id,
        name: product.name,
        sellUnit: product.sellUnit,
        priceXof: product.priceXof,
        stock: product.stock,
        requestedQuantity: quantity.data,
        status,
        alternativeIds: product.alternativeIds,
        alternatives,
      };
      return { ok: true, data };
    },
  };
}
