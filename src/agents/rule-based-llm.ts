import type {
  AgentMessage,
  LLMClient,
  LLMResponse,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "../types";

export interface RuleBasedPlan {
  readonly searchQuery: string;
  readonly quantity: number;
  readonly location: string;
  readonly targetCurrency: "EUR" | "USD" | "NGN";
}

interface ToolOutcome {
  readonly name: string;
  readonly result: ToolResult<unknown>;
}

interface SearchData {
  readonly products: readonly { readonly id: string; readonly priceXof: number }[];
}
interface StockData {
  readonly status: "available" | "insufficient" | "out_of_stock";
  readonly productId: string;
  readonly name: string;
  readonly priceXof: number;
  readonly alternatives: readonly { readonly id: string }[];
}
interface DeliveryData {
  readonly status: "resolved" | "needs_zone";
  readonly feeXof?: number;
  readonly zone?: string;
  readonly etaLabel?: string;
}
interface CurrencyData {
  readonly convertedAmount: number;
  readonly target: string;
  readonly source: string;
}

function outcomes(messages: readonly AgentMessage[]): ToolOutcome[] {
  const found: ToolOutcome[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      found.push({ name: message.name, result: JSON.parse(message.content) as ToolResult<unknown> });
    }
  }
  return found;
}

function latest(list: readonly ToolOutcome[], name: string): ToolResult<unknown> | undefined {
  return [...list].reverse().find((entry) => entry.name === name)?.result;
}

function callFor(name: string, args: Record<string, unknown>, step: number): ToolCall {
  return { id: `rule_${step}_${name}`, name, arguments: args };
}

/**
 * Runner à règles déterministe : enchaîne les outils selon le plan et les résultats réels,
 * sans clé API. Il ne rédige la réponse finale qu'à partir des données renvoyées par les outils.
 * Le plan (requête, quantité, lieu) reste neutre : il ne suppose ni motif ni couleur de pagne.
 */
export function createRuleBasedLLM(plan: RuleBasedPlan): LLMClient {
  return {
    async complete(messages: readonly AgentMessage[], _tools: readonly ToolDefinition[]): Promise<LLMResponse> {
      const done = outcomes(messages);
      const step = done.length + 1;

      const search = latest(done, "search_product");
      if (search === undefined) {
        return {
          content: `Je cherche "${plan.searchQuery}" dans le catalogue.`,
          toolCalls: [callFor("search_product", { query: plan.searchQuery }, step)],
        };
      }
      if (!search.ok) {
        return { content: "La recherche a échoué.", toolCalls: [] };
      }
      const products = (search.data as SearchData).products;
      const first = products[0];
      if (first === undefined) {
        return {
          content: "Je n'ai trouvé aucun produit correspondant. Pouvez-vous préciser la demande (marque, modèle, usage, budget) ?",
          toolCalls: [],
        };
      }

      const stock = latest(done, "check_stock");
      if (stock === undefined) {
        return {
          content: `Je vérifie le stock de ${first.id}.`,
          toolCalls: [callFor("check_stock", { productId: first.id, quantity: plan.quantity }, step)],
        };
      }
      if (!stock.ok) {
        return { content: "La vérification du stock a échoué.", toolCalls: [] };
      }
      const stockData = stock.data as StockData;

      if (stockData.status !== "available") {
        const alternative = stockData.alternatives[0];
        const alreadyChecked = done.filter((entry) => entry.name === "check_stock").length;
        if (alternative !== undefined && alreadyChecked < 2) {
          return {
            content: `${stockData.productId} n'est pas disponible. Je vérifie l'alternative ${alternative.id}.`,
            toolCalls: [callFor("check_stock", { productId: alternative.id, quantity: plan.quantity }, step)],
          };
        }
        return {
          content: `Le produit ${stockData.productId} n'est pas disponible en quantité suffisante.`,
          toolCalls: [],
        };
      }

      const delivery = latest(done, "calculate_delivery");
      if (delivery === undefined) {
        return {
          content: `Je calcule la livraison pour ${plan.location}.`,
          toolCalls: [callFor("calculate_delivery", { location: plan.location }, step)],
        };
      }
      if (!delivery.ok) {
        return { content: "Je n'ai pas pu calculer la livraison.", toolCalls: [] };
      }
      const deliveryData = delivery.data as DeliveryData;
      if (deliveryData.status !== "resolved" || deliveryData.feeXof === undefined) {
        return {
          content: "Pouvez-vous me préciser votre quartier de livraison ?",
          toolCalls: [],
        };
      }

      const subtotal = stockData.priceXof * plan.quantity;
      const total = subtotal + deliveryData.feeXof;
      const currency = latest(done, "convert_currency");
      if (currency === undefined) {
        return {
          content: `Je convertis le total de ${total} FCFA en ${plan.targetCurrency}.`,
          toolCalls: [callFor("convert_currency", { amountXof: total, target: plan.targetCurrency }, step)],
        };
      }
      if (!currency.ok) {
        return {
          content: `Total : ${total} FCFA. Je n'ai pas pu obtenir la conversion en ${plan.targetCurrency}.`,
          toolCalls: [],
        };
      }
      const converted = currency.data as CurrencyData;
      const sourceLabel = converted.source === "live" ? "taux du jour" : "taux de secours";
      return {
        content: [
          `Bonjour, voici votre devis.`,
          `Article : ${stockData.name} (${stockData.productId}) x ${plan.quantity} = ${subtotal} FCFA.`,
          `Livraison ${deliveryData.zone} : ${deliveryData.feeXof} FCFA, ${deliveryData.etaLabel}.`,
          `Total : ${total} FCFA, soit environ ${converted.convertedAmount} ${converted.target} (${sourceLabel}).`,
          `Souhaitez-vous que je prépare la commande ? Je la finaliserai après votre accord.`,
        ].join("\n"),
        toolCalls: [],
      };
    },
  };
}
