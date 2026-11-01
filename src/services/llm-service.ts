/**
 * Service LLM hybride (RodiumAI, API compatible OpenAI).
 * Architecture : règles déterministes d'abord ; le LLM n'est appelé qu'en repli (intention « unknown »).
 * - extract()  : extraction structurée, température 0, max_tokens 150, réponse JSON.
 * - advise()   : conseil consultatif, température 0.2, max_tokens 300, catalogue compacté.
 * - rephrase() : reformule un message déterministe en ton humain, température 0.3, max_tokens 200.
 *   Les faits sont vérifiés (montants FCFA, références produit, aucun nombre ajouté) ; sinon le message d'origine est gardé.
 * Sans RODIUM_API_KEY, aucun service n'est créé : le comportement reste strictement déterministe.
 */
import type { Product } from "../types";
import type { Intent } from "../types/palier2";

export const RODIUM_DEFAULT_BASE_URL = "https://api.rodiumai.io/v1";
export const RODIUM_DEFAULT_MODEL = "openai/gpt-6-luna";

export const EXTRACTION_TEMPERATURE = 0;
export const DIALOGUE_TEMPERATURE = 0.2;
export const REPHRASE_TEMPERATURE = 0.3;
export const EXTRACTION_MAX_TOKENS = 150;
export const ADVICE_MAX_TOKENS = 300;
export const REPHRASE_MAX_TOKENS = 200;
/** Nombre maximal de produits injectés dans le prompt de conseil. */
export const ADVICE_MAX_PRODUCTS = 8;
/** Nombre maximal de messages d'historique injectés (les plus récents). */
export const ADVICE_MAX_HISTORY = 4;

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

export interface RephraseContext {
  /** Dernier message du client, pour adapter le ton (facultatif). */
  readonly customerMessage?: string;
}

export interface RodiumLlmService {
  extract(message: string, allowedFields: readonly string[]): Promise<Record<string, unknown> | null>;
  advise(message: string, history: readonly LlmChatMessage[], catalog: readonly Product[]): Promise<string | null>;
  rephrase(rawMessage: string, context?: RephraseContext): Promise<string>;
}

interface ChatCompletionResponse {
  readonly choices?: readonly { readonly message?: { readonly content?: string | null } }[];
}

/**
 * Repli LLM : ne s'active que si les règles déterministes n'ont pas reconnu l'intention.
 * Les intentions reconnues (produit, livraison, commande) ne consomment aucun token.
 */
export function shouldUseLlmFallback(intent: Intent): boolean {
  return intent === "unknown";
}

/** Lit la configuration depuis l'environnement. Renvoie null si aucune clé n'est définie. */
export function readLlmConfig(env: {
  readonly RODIUM_API_KEY?: string;
  readonly RODIUM_BASE_URL?: string;
  readonly RODIUM_MODEL?: string;
}): LlmServiceConfig | null {
  const key = env.RODIUM_API_KEY?.trim() ?? "";
  if (key === "") {
    return null;
  }
  const baseUrl = env.RODIUM_BASE_URL?.trim() ?? "";
  const model = env.RODIUM_MODEL?.trim() ?? "";
  return {
    apiKey: key,
    baseUrl: baseUrl === "" ? RODIUM_DEFAULT_BASE_URL : baseUrl,
    model: model === "" ? RODIUM_DEFAULT_MODEL : model,
  };
}

/**
 * Catalogue compacté : une ligne par produit (id, nom, prix, stock, catégorie).
 * Seuls les produits en stock sont proposés au conseil, pour limiter les tokens et éviter les promesses.
 */
export function compactCatalog(products: readonly Product[]): string {
  return products
    .filter((product) => product.stock > 0)
    .slice(0, ADVICE_MAX_PRODUCTS)
    .map((p) => `${p.id}|${p.name}|${p.priceXof} FCFA|stock ${p.stock}|${p.category}`)
    .join("\n");
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

/** Nombre brut (sans espaces insécables, points ni virgules de milliers, zéros de tête). */
function cleanNumber(raw: string): string {
  return raw.replace(/[\s\u00a0.,]/g, "").replace(/^0+(?=\d)/, "");
}

/** Montants suivis de « FCFA » (avec ou sans espaces de milliers). Les montants sont les faits critiques. */
export function extractAmounts(text: string): string[] {
  const matches = Array.from(text.matchAll(/(\d[\d\s\u00a0.,]*\d|\d)\s*FCFA/gi));
  return matches.map((m) => cleanNumber(m[1] ?? "")).filter((value) => value !== "").sort();
}

/** Tous les nombres d'un texte, nettoyés. Un nombre absent de l'original signale un ajout (remise, prix inventé). */
export function extractAllNumbers(text: string): Set<string> {
  const matches = text.match(/\d[\d\s\u00a0.,]*\d|\d/g) ?? [];
  return new Set(matches.map(cleanNumber).filter((value) => value !== ""));
}

/** Références produit (ex. SW-002, CMD-ABC) : elles doivent toutes survivre à la reformulation. */
export function extractCodes(text: string): string[] {
  return (text.match(/[A-Z]{2,}-[A-Z0-9]+/g) ?? []).sort();
}

/**
 * Vrai si la reformulation conserve les faits du message d'origine :
 * - même suite de montants FCFA (aucun montant modifié ou supprimé) ;
 * - aucun nombre nouveau (pas de remise ni de prix inventé) ;
 * - toutes les références produit présentes.
 * Les nombres écrits en lettres (« une unité », « un jour ») ou un compte retiré sont permis :
 * ce ne sont pas des faits modifiés.
 */
export function preservesFacts(original: string, rephrased: string): boolean {
  const amountsOriginal = extractAmounts(original);
  const amountsRephrased = extractAmounts(rephrased);
  if (amountsOriginal.length !== amountsRephrased.length) {
    return false;
  }
  if (amountsOriginal.some((value, index) => value !== amountsRephrased[index])) {
    return false;
  }
  const numbersOriginal = extractAllNumbers(original);
  for (const value of extractAllNumbers(rephrased)) {
    if (!numbersOriginal.has(value)) {
      return false;
    }
  }
  const rephrasedCodes = new Set(extractCodes(rephrased));
  return extractCodes(original).every((code) => rephrasedCodes.has(code));
}

const EXTRACT_SYSTEM = (fields: readonly string[]): string =>
  `Extrais les champs du message. JSON seul, clés: ${fields.join(",")}. Absent = null. N'invente rien.`;

const ADVICE_SYSTEM = (catalog: string): string =>
  `Vendeur WhatsApp pagnes, marché Dantokpa. Français, 3 phrases max, pas de markdown. Ne cite que ces produits (id|nom|prix|stock|catégorie), jamais de prix ou stock inventé. Oriente vers une demande précise.\nCatalogue:\n${catalog}`;

/**
 * Consigne de reformulation. Les montants en FCFA, les références produit et les délais doivent
 * garder leur valeur. Les quantités peuvent être écrites en lettres (« une unité »). Aucune remise ni promesse n'est ajoutée.
 */
const REPHRASE_SYSTEM =
  "Tu reformules un message de la boutique JulieShop (Togo) pour WhatsApp. " +
  "Français, vouvoiement, ton poli, professionnel et commercial. 4 phrases au plus, pas de markdown. " +
  "Conserve à l'identique chaque montant en FCFA, chaque référence produit (ex. SW-002, CMD-...), chaque nom de produit et chaque délai. " +
  "Une quantité ou un délai peut être écrit en lettres (ex. « une unité », « un jour »). " +
  "N'ajoute aucune remise, aucune promotion, aucun prix, aucun nombre nouveau et aucune promesse. Ne retire aucune information importante. Réponds uniquement avec le message reformulé.";

export function createRodiumLlmService(config: LlmServiceConfig): RodiumLlmService {
  const baseUrl = (config.baseUrl ?? RODIUM_DEFAULT_BASE_URL).replace(/\/$/, "");
  const model = config.model ?? RODIUM_DEFAULT_MODEL;
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 8000;

  async function chat(messages: readonly LlmChatMessage[], temperature: number, maxTokens: number): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
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
          { role: "system", content: EXTRACT_SYSTEM(allowedFields) },
          { role: "user", content: message },
        ],
        EXTRACTION_TEMPERATURE,
        EXTRACTION_MAX_TOKENS,
      );
      return content === null ? null : parseJsonObject(content);
    },
    async advise(message, history, catalog) {
      const recent = history.slice(-ADVICE_MAX_HISTORY);
      return chat(
        [{ role: "system", content: ADVICE_SYSTEM(compactCatalog(catalog)) }, ...recent, { role: "user", content: message }],
        DIALOGUE_TEMPERATURE,
        ADVICE_MAX_TOKENS,
      );
    },
    /**
     * Reformule un message déterministe. Ne lève jamais d'exception : en cas d'erreur, de délai,
     * de réponse vide ou de faits modifiés, le message d'origine est renvoyé tel quel.
     */
    async rephrase(rawMessage, context) {
      if (rawMessage.trim() === "") {
        return rawMessage;
      }
      const customerLine =
        context?.customerMessage !== undefined && context.customerMessage.trim() !== ""
          ? `\nMessage du client : ${context.customerMessage}`
          : "";
      try {
        const content = await chat(
          [
            { role: "system", content: REPHRASE_SYSTEM },
            { role: "user", content: `Message à reformuler :\n${rawMessage}${customerLine}` },
          ],
          REPHRASE_TEMPERATURE,
          REPHRASE_MAX_TOKENS,
        );
        if (content === null || !preservesFacts(rawMessage, content)) {
          return rawMessage;
        }
        return content;
      } catch {
        return rawMessage;
      }
    },
  };
}
