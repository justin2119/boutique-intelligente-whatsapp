import type {
  AgentMessage,
  ExecutedToolCall,
  ExecutionStep,
  ExecutionTrace,
  LLMClient,
  ToolDefinition,
} from "../types";
import type { ToolRegistry } from "../tools";

export const MAX_STEPS = 6;

export const SYSTEM_PROMPT = `Tu es le vendeur WhatsApp de la boutique de pagnes du marché Dantokpa (Cotonou, Bénin).
Règles strictes :
- Sois poli, chaleureux et concis. Réponds en français, au format WhatsApp (phrases courtes, pas de tableau, pas de markdown).
- N'invente jamais de prix, de stock, de délai ou de taux : utilise uniquement les résultats des outils.
- Pour tout produit, vérifie d'abord le catalogue (search_product) puis le stock (check_stock).
- Si un produit est en rupture ou en stock insuffisant, annonce-le et propose les alternatives renvoyées par check_stock.
- Pour la livraison, utilise calculate_delivery (frais en FCFA et délai).
- Calcule le total = total des articles + frais de livraison, en FCFA.
- Pour une conversion, utilise convert_currency et indique la source du taux.
- Ne finalise jamais une commande : utilise create_order (statut PENDING_CONFIRMATION) et demande l'accord explicite du client.
- Tu disposes d'au plus ${MAX_STEPS} étapes ; quand tu as assez d'informations, réponds au client sans appeler d'outil.`;

export interface AgentInput {
  readonly query: string;
  readonly maxSteps?: number;
}

export interface SingleAgentOptions {
  readonly llm: LLMClient;
  readonly tools: ToolRegistry;
}

export const FALLBACK_RESPONSE =
  "Désolé, je n'ai pas pu finaliser la vérification dans le temps imparti. Pouvez-vous reformuler votre demande ou préciser le produit et la quantité ?";

/** Agent vendeur unique : boucle outils avec limite d'étapes et trace structurée. */
export class SingleAgent {
  private readonly llm: LLMClient;
  private readonly tools: ToolRegistry;

  constructor(options: SingleAgentOptions) {
    this.llm = options.llm;
    this.tools = options.tools;
  }

  async run(input: AgentInput): Promise<ExecutionTrace> {
    const maxSteps = Math.min(input.maxSteps ?? MAX_STEPS, MAX_STEPS);
    const messages: AgentMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: input.query },
    ];
    const steps: ExecutionStep[] = [];
    const definitions: readonly ToolDefinition[] = this.tools.definitions;

    for (let step = 1; step <= maxSteps; step += 1) {
      const response = await this.llm.complete(messages, definitions);
      const thought = response.content ?? "";

      if (response.toolCalls.length === 0) {
        const finalResponse = response.content?.trim() || FALLBACK_RESPONSE;
        steps.push({ step, thought, toolCalls: [], finalResponse });
        return { query: input.query, maxSteps, steps, finalResponse, stoppedBy: "final_answer" };
      }

      messages.push({ role: "assistant", content: response.content, toolCalls: response.toolCalls });
      const executed: ExecutedToolCall[] = [];
      for (const call of response.toolCalls) {
        const result = await this.tools.run(call.name, call.arguments);
        executed.push({ call, result });
        messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: JSON.stringify(result) });
      }
      steps.push({ step, thought, toolCalls: executed });
    }

    steps.push({
      step: maxSteps + 1,
      thought: "Limite d'étapes atteinte.",
      toolCalls: [],
      finalResponse: FALLBACK_RESPONSE,
    });
    return { query: input.query, maxSteps, steps, finalResponse: FALLBACK_RESPONSE, stoppedBy: "max_steps" };
  }
}
