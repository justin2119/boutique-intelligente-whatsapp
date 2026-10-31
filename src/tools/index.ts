import type { Catalog, ToolDefinition, ToolHandler, ToolResult } from "../types";
import { createCalculateDeliveryTool } from "./calculate-delivery";
import { createCheckStockTool } from "./check-stock";
import { createConvertCurrencyTool } from "./convert-currency";
import { createCreateOrderTool } from "./create-order";
import { createSearchProductTool } from "./search-product";

export const TOOL_NAMES = [
  "search_product",
  "check_stock",
  "calculate_delivery",
  "convert_currency",
  "create_order",
] as const;

export interface ToolRegistry {
  readonly tools: readonly ToolHandler[];
  readonly definitions: readonly ToolDefinition[];
  run(name: string, args: Readonly<Record<string, unknown>>): Promise<ToolResult<unknown>>;
}

export interface ToolRegistryOptions {
  readonly fetchImpl?: typeof fetch;
  readonly clock?: () => Date;
}

/** Enregistre les 5 outils de Palier 1 avec leurs schémas. */
export function createToolRegistry(catalog: Catalog, options: ToolRegistryOptions = {}): ToolRegistry {
  const tools: ToolHandler[] = [
    createSearchProductTool(catalog),
    createCheckStockTool(catalog),
    createCalculateDeliveryTool(catalog.zones),
    createConvertCurrencyTool({ fetchImpl: options.fetchImpl }),
    createCreateOrderTool(catalog, options.clock),
  ];
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool] as const));

  return {
    tools,
    definitions: tools.map((tool) => tool.definition),
    async run(name, args) {
      const tool = byName.get(name);
      if (tool === undefined) {
        return { ok: false, error: `Outil inconnu : "${name}".` };
      }
      try {
        return await tool.run(args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: `Erreur interne de l'outil "${name}" : ${message}` };
      }
    },
  };
}
