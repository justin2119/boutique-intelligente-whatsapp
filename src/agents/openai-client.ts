import type { AgentMessage, LLMClient, LLMResponse, ToolCall, ToolDefinition } from "../types";

export interface OpenAICompatibleOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly fetchImpl?: typeof fetch;
}

interface OpenAIToolCall {
  readonly id: string;
  readonly function: { readonly name: string; readonly arguments: string };
}

interface OpenAIResponse {
  readonly choices: readonly {
    readonly message: { readonly content: string | null; readonly tool_calls?: readonly OpenAIToolCall[] };
  }[];
}

function toOpenAIMessage(message: AgentMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId, name: message.name, content: message.content };
  }
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content,
      tool_calls: message.toolCalls?.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

/** Client LLM compatible OpenAI (chat/completions avec outils), basé sur fetch. */
export function createOpenAICompatibleClient(options: OpenAICompatibleOptions): LLMClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.baseUrl.replace(/\/$/, "")}/chat/completions`;

  return {
    async complete(messages: readonly AgentMessage[], tools: readonly ToolDefinition[]): Promise<LLMResponse> {
      const body = {
        model: options.model,
        messages: messages.map(toOpenAIMessage),
        tools: tools.map((tool) => ({
          type: "function",
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        })),
        tool_choice: "auto",
        temperature: 0,
      };
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`Erreur LLM HTTP ${response.status}`);
      }
      const payload = (await response.json()) as OpenAIResponse;
      const message = payload.choices[0]?.message;
      if (message === undefined) {
        throw new Error("Réponse LLM vide");
      }
      const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: JSON.parse(call.function.arguments) as Record<string, unknown>,
      }));
      return { content: message.content, toolCalls };
    },
  };
}
