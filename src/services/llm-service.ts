/**
 * Service LLM hybride (RodiumAI, API compatible OpenAI).
 * - extraction structurée : temperature 0, réponse JSON uniquement.
 * - dialogue consultatif : temperature 0.2, réponse courte en français.
 * Ce service n'est appelé qu'en repli, après les règles déterministes du Manager.
 * Sans clé API, le service n'est pas créé et le comportement déterministe reste inchangé.
 */

export const RODIUM_DEFAULT_BASE_URL = "https://api.rodiumai.io/v1";
export const RODIUM_DEFAULT_MODEL = "openai/gpt-6-luna";

export interface LlmServiceConfig {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface LlmChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface RodiumLlmService {
  /** Extrait des champs structurés (JSON) du message client. Température 0. */
  extract(message: string, allowedFields: readonly string[]): Promise<Record<string, unknown> | null>;
  /** Répond en dialogue consultatif, à partir du message et de l'historique. Température 0.2. */
  advise(message: string, history: readonly LlmChatMessage[], systemPrompt: string): Promise<string | null>;
}

interface ChatCompletionResponse {
  readonly choices?: readonly { readonly message?: { readonly content?: string | null } }[];
}

export const EXTRACTION_TEMPERATURE = 0;
export const DIALOGUE_TEMPERATURE = 0.2;

/** Lit la configuration depuis l'environnement. Renvoie null si aucune clé n'est définie. */
export function readLlmConfig(env: {
  readonly RODIUM_API_KEY?: string;
  readonly RODIUM_BASE_URL?: string;
  readonly RODIUM_MODEL?: string;
}): LlmServiceConfig | null {
  if (env.RODIUM_API_KEY === undefined || env.RODIUM_API_KEY.trim() === "") {
    return null;
  }
  return {
    apiKey: env.RODIUM_API_KEY.trim(),
    baseUrl: env.RODIUM_BASE_URL && env.RODIUM_BASE_URL.trim() !== "" ? env.RODIUM_BASE_URL.trim() : RODIUM_DEFAULT_BASE_URL,
    model: env.RODIUM_MODEL && env.RODIUM_MODEL.trim() !== "" ? env.RODIUM_MODEL.trim() : RODIUM_DEFAULT_MODEL,
  };
}

/** Extrait le premier objet JSON d'un texte (tolère les blocs de code Markdown). */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function createRodiumLlmService(config: LlmServiceConfig): RodiumLlmService {
  const baseUrl = (config.baseUrl ?? RODIUM_DEFAULT_BASE_URL).replace(/\/$/, "");
  const model = config.model ?? RODIUM_DEFAULT_MODEL;
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 8000;

  async function chat(messages: readonly LlmChatMessage[], temperature: number): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model, messages, temperature }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Erreur LLM HTTP ${response.status}`);
      }
      const payload = (await response.json()) as ChatCompletionResponse;
      const content = payload.choices?.[0]?.message?.content;
      return typeof content === "string" && content.trim() !== "" ? content.trim() : null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async extract(message, allowedFields) {
      const content = await chat(
        [
          {
            role: "system",
            content: `Extrais les champs demandés du message client. Réponds uniquement par un objet JSON valide avec ces clés : ${allowedFields.join(", ")}. Mets null pour toute information absente. N'invente rien.`,
          },
          { role: "user", content: message },
        ],
        EXTRACTION_TEMPERATURE,
      );
      return content === null ? null : parseJsonObject(content);
    },
    async advise(message, history, systemPrompt) {
      const content = await chat(
        [{ role: "system", content: systemPrompt }, ...history, { role: "user", content: message }],
        DIALOGUE_TEMPERATURE,
      );
      return content;
    },
  };
}
