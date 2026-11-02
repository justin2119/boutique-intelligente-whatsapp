/**
 * Service LLM hybride (RodiumAI, API compatible OpenAI).
 * Architecture : les faits (produit, stock, prix, frais, délai, catalogue) viennent des règles déterministes ;
 * le LLM rédige la conversation (converse) et ne voit que ces faits.
 * - converse() : conseiller commercial JulieShop, ton humain, sans liste ni gabarit, température 0.5.
 *   Garde-fou : tout montant FCFA cité doit figurer dans les faits, dans les prix du catalogue, ou être le budget
 *   donné par le client. Une référence produit inconnue ou une remise inventée est rejetée. Un rejet déclenche
 *   une seule nouvelle tentative, avec la correction indiquée au modèle.
 * - extract() : extraction structurée, température 0, JSON.
 * - advise()  : conseil de repli (ancien), conservé pour compatibilité.
 * - rephrase(): reformulation (ancienne), conservée pour compatibilité ; plus appelée par le Manager.
 * Chaque issue est journalisée avec le préfixe [LlmService].
 * Sans RODIUM_API_KEY, aucun service n'est créé : le comportement reste déterministe.
 */
import type { Product } from "../types";
import type { Intent } from "../types/palier2";

export const RODIUM_DEFAULT_BASE_URL = "https://api.rodiumai.io/v1";
export const RODIUM_DEFAULT_MODEL = "openai/gpt-6-luna";

export const EXTRACTION_TEMPERATURE = 0;
export const DIALOGUE_TEMPERATURE = 0.2;
export const REPHRASE_TEMPERATURE = 0.3;
export const CONVERSE_TEMPERATURE = 0.5;
export const EXTRACTION_MAX_TOKENS = 150;
export const ADVICE_MAX_TOKENS = 300;
export const REPHRASE_MAX_TOKENS = 200;
export const CONVERSE_MAX_TOKENS = 350;
/** Nombre maximal de produits injectés dans le prompt de conseil. */
export const ADVICE_MAX_PRODUCTS = 8;
/** Nombre maximal de messages d'historique injectés (les plus récents). */
export const ADVICE_MAX_HISTORY = 4;
/** Nombre maximal de messages d'historique injectés dans la conversation (les plus récents). */
export const CONVERSE_MAX_HISTORY = 8;

export interface LlmServiceConfig {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** Journal optionnel (par défaut console). Injectable pour les tests. */
  readonly logger?: (line: string) => void;
}

export interface LlmChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface RephraseContext {
  /** Dernier message du client, pour adapter le ton (facultatif). */
  readonly customerMessage?: string;
}

/**
 * Entrée de la conversation : message du client, historique récent, faits vérifiés (lignes en français),
 * et montants autorisés supplémentaires (budget du client, prix du catalogue), en entiers FCFA.
 */
export interface ConverseInput {
  readonly message: string;
  readonly history: readonly LlmChatMessage[];
  readonly facts: readonly string[];
  readonly allowedAmounts?: readonly number[];
}

export interface RodiumLlmService {
  extract(message: string, allowedFields: readonly string[]): Promise<Record<string, unknown> | null>;
  advise(message: string, history: readonly LlmChatMessage[], catalog: readonly Product[]): Promise<string | null>;
  rephrase(rawMessage: string, context?: RephraseContext): Promise<string>;
  converse(input: ConverseInput): Promise<string | null>;
}

interface ChatCompletionResponse {
  readonly choices?: readonly { readonly message?: { readonly content?: string | null } }[];
}

/** Résultat détaillé de la vérification des faits (utilisé pour les logs). */
export interface FactCheck {
  readonly ok: boolean;
  readonly reason: string;
}

/**
 * Repli LLM historique : ne s'active que si les règles déterministes n'ont pas reconnu l'intention.
 * Conservé pour compatibilité des tests ; le Manager utilise désormais converse().
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

/** Montants suivis de « FCFA » (avec ou sans espaces de milliers). */
export function extractAmounts(text: string): string[] {
  const matches = Array.from(text.matchAll(/(\d[\d\s\u00a0.,]*\d|\d)\s*FCFA/gi));
  return matches.map((m) => cleanNumber(m[1] ?? "")).filter((value) => value !== "").sort();
}

/** Tous les nombres d'un texte, nettoyés. */
export function extractAllNumbers(text: string): Set<string> {
  const matches = text.match(/\d[\d\s\u00a0.,]*\d|\d/g) ?? [];
  return new Set(matches.map(cleanNumber).filter((value) => value !== ""));
}

/** Références produit (ex. SW-002, PC-003, CMD-ABC) : extraites pour contrôler qu'aucune n'est altérée. */
export function extractCodes(text: string): string[] {
  return (text.match(/[A-Z]{2,}-[A-Z0-9]+/g) ?? []).sort();
}

/** Mots de remise, promotion ou cadeau : interdits dans une réponse conversationnelle sauf s'ils figurent dans les faits. */
const DISCOUNT_WORDS = /remise|réduction|reduction|promo|promotion|gratuit|offert|cadeau|soldes?|%/i;

/**
 * Garde-fou de la conversation. Vérifie la réponse contre les faits fournis et les montants autorisés :
 * - chaque montant FCFA de la réponse doit exister dans les faits, dans les montants autorisés
 *   (prix du catalogue, budget du client), ou être une somme de ces montants ;
 * - chaque référence produit de la réponse doit exister dans les faits (pas de code inventé) ;
 * - aucune remise, promotion ou cadeau si les faits n'en mentionnent pas.
 * Ne vérifie PAS les chiffres nus (« 24h », « deux jours ») ni l'absence de détails : une tournure naturelle est acceptée.
 */
export function checkAgainstFacts(facts: string, reply: string, allowedAmounts: readonly number[] = []): FactCheck {
  const allowed = new Set<string>(extractAmounts(facts));
  for (const amount of allowedAmounts) {
    allowed.add(String(Math.round(amount)));
  }
  for (const amount of extractAmounts(reply)) {
    if (!allowed.has(amount)) {
      return { ok: false, reason: `montant FCFA absent des faits : ${amount}` };
    }
  }
  const factCodes = new Set(extractCodes(facts));
  for (const code of extractCodes(reply)) {
    if (!factCodes.has(code)) {
      return { ok: false, reason: `référence absente des faits : ${code}` };
    }
  }
  if (DISCOUNT_WORDS.test(reply) && !DISCOUNT_WORDS.test(facts)) {
    return { ok: false, reason: "remise, promotion ou cadeau non présent dans les faits" };
  }
  return { ok: true, reason: "faits conservés" };
}

/**
 * Vérifie qu'une reformulation ne modifie pas les faits. Rejette seulement :
 * - un montant FCFA modifié, ajouté ou supprimé (le prix est ce que le client paie) ;
 * - un nombre qui n'existait pas dans l'original (remise ou prix inventé) ;
 * - une référence produit qui apparaît dans la reformulation mais pas dans l'original (code altéré ou inventé).
 * N'exige PAS que chaque référence de l'original soit répétée : une tournure naturelle peut omettre « réf. PC-003 ».
 */
export function checkFacts(original: string, rephrased: string): FactCheck {
  const amountsOriginal = extractAmounts(original);
  const amountsRephrased = extractAmounts(rephrased);
  if (amountsOriginal.length !== amountsRephrased.length) {
    return { ok: false, reason: `montants FCFA : ${amountsOriginal.length} dans l'original, ${amountsRephrased.length} dans la reformulation` };
  }
  if (amountsOriginal.some((value, index) => value !== amountsRephrased[index])) {
    return { ok: false, reason: "montant FCFA modifié" };
  }
  const numbersOriginal = extractAllNumbers(original);
  for (const value of extractAllNumbers(rephrased)) {
    if (!numbersOriginal.has(value)) {
      return { ok: false, reason: `nombre ajouté par la reformulation : ${value}` };
    }
  }
  const codesOriginal = new Set(extractCodes(original));
  for (const code of extractCodes(rephrased)) {
    if (!codesOriginal.has(code)) {
      return { ok: false, reason: `référence absente de l'original : ${code}` };
    }
  }
  return { ok: true, reason: "faits conservés" };
}

/** Vrai si la reformulation conserve les faits (voir checkFacts). */
export function preservesFacts(original: string, rephrased: string): boolean {
  return checkFacts(original, rephrased).ok;
}

const EXTRACT_SYSTEM = (fields: readonly string[]): string =>
  `Extrais les champs du message. JSON seul, clés: ${fields.join(",")}. Absent = null. N'invente rien.`;

const ADVICE_SYSTEM = (catalog: string): string =>
  `Vendeur WhatsApp pagnes, marché Dantokpa. Français, 3 phrases max, pas de markdown. Ne cite que ces produits (id|nom|prix|stock|catégorie), jamais de prix ou stock inventé. Oriente vers une demande précise.\nCatalogue:\n${catalog}`;

/**
 * Consigne de conversation : conseiller commercial JulieShop à Lomé, ton humain et chaleureux.
 * Les faits fournis sont la seule source pour les produits, prix, stocks, frais et délais.
 * Le modèle ne doit jamais différer un calcul déjà fourni dans les faits : il donne le total, puis demande
 * ce qui manque pour finaliser.
 */
const CONVERSE_SYSTEM = (facts: string): string =>
  "Tu es le conseiller commercial de JulieShop, boutique d'informatique à Lomé (Togo). " +
  "Tu parles comme un vendeur expert, chaleureux, enthousiaste et direct, en français, avec le vouvoiement. " +
  "Écris des phrases naturelles et fluides, en paragraphes courts, comme dans une vraie conversation WhatsApp. " +
  "N'utilise jamais de liste à puces, de titre, de markdown ni de gras. " +
  "Réponds directement à ce que le client vient de demander, en tenant compte de l'historique. " +
  "Si le client demande une autre option, propose un autre modèle des faits, sans reprendre le précédent. " +
  "Si aucun produit ne correspond à son budget, dis-le franchement et propose le modèle le moins cher des faits. " +
  "Quand c'est utile, recommande la machine la plus adaptée à son usage et explique pourquoi en une phrase. " +
  "Si les faits donnent une vue d'ensemble du catalogue (catégories et nombre d'articles), présente-la en phrases, " +
  "sans citer de produit précis qui ne figure pas dans les faits, puis demande ce qui intéresse le client. " +
  "Si les faits listent des ordinateurs avec leur fiche (processeur, mémoire, stockage, carte graphique), " +
  "présente chacun en une phrase courte : nom, réf., prix en FCFA, puis processeur, mémoire et stockage, " +
  "et l'usage recommandé. Recopie les fiches exactement telles que fournies, sans en inventer. " +
  "Pose au plus une question engageante à la fois, pour avancer (usage, budget, quartier ou repère de livraison, créneau). " +
  "Utilise uniquement les faits ci-dessous pour les produits, prix, stocks, frais et délais. " +
  "Quand les faits donnent un détail de commande (sous-total, frais de livraison, total général), donne ce détail et le total général tels quels, sans attendre. " +
  "Ne répète jamais un prix unitaire, un sous-total, des frais de livraison ou un total déjà communiqués dans l'historique de la conversation, sauf si le client le demande ; passe directement à l'étape suivante (créneau, repère ou adresse, puis confirmation du total). " +
  "Ne dis jamais que tu vérifies un montant, que tu reviens vers le client, ni que l'équipe confirmera le total : tous les montants nécessaires sont dans les faits. " +
  "Si une information manque pour finaliser (repère ou adresse précise, créneau souhaité, quartier), demande-la clairement, sans la présenter comme une attente. " +
  "N'invente jamais de prix, de stock, de remise, de promotion, de cadeau ou de garantie absent des faits. " +
  "Ne confirme jamais une commande : elle est validée ensuite par notre équipe. " +
  "Réponds uniquement avec le message à envoyer au client.\n" +
  `Faits vérifiés :\n${facts}`;

/**
 * Consigne de reformulation (ancienne). Conservée pour compatibilité ; le Manager ne l'appelle plus.
 */
const REPHRASE_SYSTEM =
  "Tu reformules un message de la boutique JulieShop (Togo) pour WhatsApp. " +
  "Français, vouvoiement, ton poli, professionnel et commercial. 4 phrases au plus, pas de markdown. " +
  "Conserve à l'identique chaque montant en FCFA, chaque nom de produit et chaque délai. " +
  "Si tu cites une référence produit (ex. PC-003, SW-002), recopie-la exactement, sans la modifier. " +
  "Une quantité ou un délai peut être écrit en lettres (ex. « une unité », « un jour »). " +
  "N'ajoute aucune remise, aucune promotion, aucun prix, aucun nombre nouveau et aucune promesse. Réponds uniquement avec le message reformulé.";

export function createRodiumLlmService(config: LlmServiceConfig): RodiumLlmService {
  const baseUrl = (config.baseUrl ?? RODIUM_DEFAULT_BASE_URL).replace(/\/$/, "");
  const model = config.model ?? RODIUM_DEFAULT_MODEL;
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 8000;
  const log = config.logger ?? ((line: string) => console.log(line));

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
     * Conversation commerciale. Ne lève jamais d'exception : renvoie null si la réponse est vide,
     * en erreur, ou rejetée par le garde-fou après une tentative corrective ; l'appelant garde alors son message déterministe.
     * Journal : [LlmService] converse ok | retry | rejected | empty | error.
     */
    async converse(input) {
      const factsText = input.facts.join("\n");
      const factsBlock = factsText.trim() === "" ? "(aucun fait particulier pour ce message)" : factsText;
      const allowed = input.allowedAmounts ?? [];
      const recent = input.history.slice(-CONVERSE_MAX_HISTORY);
      const messages: LlmChatMessage[] = [
        { role: "system", content: CONVERSE_SYSTEM(factsBlock) },
        ...recent,
        { role: "user", content: input.message },
      ];
      try {
        const first = await chat(messages, CONVERSE_TEMPERATURE, CONVERSE_MAX_TOKENS);
        if (first === null) {
          log("[LlmService] converse empty : réponse sans contenu");
          return null;
        }
        const firstCheck = checkAgainstFacts(factsText, first, allowed);
        if (firstCheck.ok) {
          log("[LlmService] converse ok");
          return first;
        }
        log(`[LlmService] converse retry : ${firstCheck.reason}`);
        const corrective: LlmChatMessage[] = [
          ...messages,
          { role: "assistant", content: first },
          {
            role: "user",
            content: `Ta réponse contient une information qui ne figure pas dans les faits (${firstCheck.reason}). Réécris-la sans cette information, en utilisant uniquement les faits et les prix du catalogue.`,
          },
        ];
        const second = await chat(corrective, CONVERSE_TEMPERATURE, CONVERSE_MAX_TOKENS);
        if (second === null) {
          log("[LlmService] converse empty après correction");
          return null;
        }
        const secondCheck = checkAgainstFacts(factsText, second, allowed);
        if (!secondCheck.ok) {
          log(`[LlmService] converse rejected après correction : ${secondCheck.reason}`);
          return null;
        }
        log("[LlmService] converse ok après correction");
        return second;
      } catch (error) {
        const reason = error instanceof Error ? error.message : "erreur inconnue";
        log(`[LlmService] converse error : ${reason}`);
        return null;
      }
    },
    /**
     * Reformule un message déterministe (ancienne voie, conservée pour compatibilité).
     * Ne lève jamais d'exception ; le message d'origine est renvoyé en cas de problème.
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
        if (content === null) {
          log("[LlmService] rephrase empty : réponse sans contenu, message d'origine conservé");
          return rawMessage;
        }
        const check = checkFacts(rawMessage, content);
        if (!check.ok) {
          log(`[LlmService] rephrase rejected : ${check.reason}, message d'origine conservé`);
          return rawMessage;
        }
        log("[LlmService] rephrase ok");
        return content;
      } catch (error) {
        const reason = error instanceof Error ? error.message : "erreur inconnue";
        log(`[LlmService] rephrase error : ${reason}, message d'origine conservé`);
        return rawMessage;
      }
    },
  };
}
