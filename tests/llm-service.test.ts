/**
 * Tests du service LLM RodiumAI : max_tokens, température, gestion d'erreurs, extraction JSON,
 * porte de repli (fallback) et reformulation (rephrase). Aucun appel réseau : fetch est simulé.
 * Exécution : pnpm run test:llm
 */
import {
  ADVICE_MAX_HISTORY,
  ADVICE_MAX_PRODUCTS,
  ADVICE_MAX_TOKENS,
  DIALOGUE_TEMPERATURE,
  EXTRACTION_MAX_TOKENS,
  EXTRACTION_TEMPERATURE,
  REPHRASE_MAX_TOKENS,
  REPHRASE_TEMPERATURE,
  RODIUM_DEFAULT_BASE_URL,
  RODIUM_DEFAULT_MODEL,
  compactCatalog,
  createRodiumLlmService,
  extractAmounts,
  extractCodes,
  parseJsonObject,
  preservesFacts,
  readLlmConfig,
  shouldUseLlmFallback,
  type LlmChatMessage,
} from "../src/services/llm-service";
import { loadCatalog } from "../src/data/catalog";

declare const process: { exitCode: number | undefined };

const assert = {
  equal(actual: unknown, expected: unknown, message?: string): void {
    if (!Object.is(actual, expected)) {
      throw new Error(message ?? `attendu ${String(expected)}, obtenu ${String(actual)}`);
    }
  },
  deepEqual(actual: unknown, expected: unknown, message?: string): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) {
      throw new Error(message ?? `attendu ${e}, obtenu ${a}`);
    }
  },
  ok(value: unknown, message: string): void {
    if (!value) {
      throw new Error(message);
    }
  },
};

interface CapturedCall {
  readonly url: string;
  readonly init: RequestInit;
  readonly body: Record<string, unknown>;
}

/** Faux fetch : enregistre l'appel et renvoie la réponse fournie. */
function fakeFetch(
  respond: () => Response | Promise<Response>,
  calls: CapturedCall[],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: String(input), init: init ?? {}, body });
    return respond();
  }) as typeof fetch;
}

function chatResponse(content: string | null): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`not ok - ${name}`);
    console.log(`  ${error instanceof Error ? error.message : String(error)}`);
  }
}

const RAW_QUOTE = "Le super wax vert coûte 12 500 FCFA. Livraison à Dantokpa : 1 000 FCFA, délai 2 jour(s). Total : 13 500 FCFA.";

/** Message déterministe réel (format du formateur) : quantité 1 et délai 1 jour, montants séparés par espaces. */
const RAW_ORDER_LIKE = "*Disponibilité confirmée*\n• Référence SW-002\n• Quantité : 1 unité(s)\n• Prix unitaire : 450 000 FCFA\n• Sous-total : 450 000 FCFA\n*Livraison*\n• Frais : 6 750 FCFA\n• Délai : délai estimé 1 jour(s)";

async function main(): Promise<void> {
  // Budget de tokens et température
  await check("extraction : max_tokens = 150 et température 0", async () => {
    const calls: CapturedCall[] = [];
    const llm = createRodiumLlmService({
      apiKey: "k",
      fetchImpl: fakeFetch(() => chatResponse('{"zone":"Dantokpa"}'), calls),
    });
    await llm.extract("Je livre à Dantokpa", ["zone"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.body.max_tokens, EXTRACTION_MAX_TOKENS);
    assert.equal(EXTRACTION_MAX_TOKENS, 150);
    assert.equal(calls[0]?.body.temperature, EXTRACTION_TEMPERATURE);
    assert.equal(EXTRACTION_TEMPERATURE, 0);
  });

  await check("conseil : max_tokens = 300 et température 0.2", async () => {
    const calls: CapturedCall[] = [];
    const llm = createRodiumLlmService({
      apiKey: "k",
      fetchImpl: fakeFetch(() => chatResponse("Bonjour, voici une idée."), calls),
    });
    await llm.advise("Quel pagne pour un mariage ?", [], loadCatalog().products);
    assert.equal(calls[0]?.body.max_tokens, ADVICE_MAX_TOKENS);
    assert.equal(ADVICE_MAX_TOKENS, 300);
    assert.equal(calls[0]?.body.temperature, DIALOGUE_TEMPERATURE);
    assert.equal(DIALOGUE_TEMPERATURE, 0.2);
  });

  await check("URL et modèle par défaut (RodiumAI)", async () => {
    const calls: CapturedCall[] = [];
    const llm = createRodiumLlmService({
      apiKey: "secret",
      fetchImpl: fakeFetch(() => chatResponse("ok"), calls),
    });
    await llm.advise("Bonjour", [], []);
    assert.equal(calls[0]?.url, `${RODIUM_DEFAULT_BASE_URL}/chat/completions`);
    assert.equal(calls[0]?.body.model, RODIUM_DEFAULT_MODEL);
    assert.equal(RODIUM_DEFAULT_MODEL, "openai/gpt-6-luna");
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer secret");
  });

  await check("historique limité aux derniers messages", async () => {
    const calls: CapturedCall[] = [];
    const llm = createRodiumLlmService({
      apiKey: "k",
      fetchImpl: fakeFetch(() => chatResponse("ok"), calls),
    });
    const history: LlmChatMessage[] = Array.from({ length: 10 }, (_, i) => ({
      role: "user" as const,
      content: `m${i}`,
    }));
    await llm.advise("dernier", history, []);
    const messages = calls[0]?.body.messages as LlmChatMessage[];
    // système + historique limité + message courant
    assert.equal(messages.length, 1 + ADVICE_MAX_HISTORY + 1);
    assert.equal(messages[messages.length - 1]?.content, "dernier");
  });

  // Catalogue compact
  await check("catalogue compact : au plus 8 produits en stock, format ligne", () => {
    const compact = compactCatalog(loadCatalog().products);
    const lines = compact.split("\n").filter((line) => line !== "");
    assert.ok(lines.length <= ADVICE_MAX_PRODUCTS, "trop de produits");
    assert.ok(lines.every((line) => line.split("|").length === 5), "format id|nom|prix|stock|catégorie");
  });

  // Extraction JSON
  await check("JSON : objet simple", () => {
    assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 });
  });
  await check("JSON : bloc de code Markdown toléré", () => {
    assert.deepEqual(parseJsonObject('```json\n{"zone":"Akpakpa"}\n```'), { zone: "Akpakpa" });
  });
  await check("JSON : texte parasite autour de l'objet", () => {
    assert.deepEqual(parseJsonObject('Voici : {"q":2} merci'), { q: 2 });
  });
  await check("JSON : tableau refusé", () => {
    assert.equal(parseJsonObject("[1,2]"), null);
  });
  await check("JSON : texte invalide renvoie null", () => {
    assert.equal(parseJsonObject("pas de json"), null);
  });
  await check("extraction : renvoie l'objet parsé", async () => {
    const llm = createRodiumLlmService({
      apiKey: "k",
      fetchImpl: fakeFetch(() => chatResponse('{"quantity":3}'), []),
    });
    assert.deepEqual(await llm.extract("3 pagnes", ["quantity"]), { quantity: 3 });
  });
  await check("extraction : JSON invalide donne null (pas d'exception)", async () => {
    const llm = createRodiumLlmService({
      apiKey: "k",
      fetchImpl: fakeFetch(() => chatResponse("désolé"), []),
    });
    assert.equal(await llm.extract("x", ["quantity"]), null);
  });

  // Gestion d'erreurs
  await check("erreur HTTP : exception levée (le Manager la capture)", async () => {
    const llm = createRodiumLlmService({
      apiKey: "k",
      fetchImpl: fakeFetch(() => new Response("boom", { status: 500 }), []),
    });
    let thrown = false;
    try {
      await llm.advise("x", [], []);
    } catch (error) {
      thrown = error instanceof Error && error.message.includes("500");
    }
    assert.ok(thrown, "une erreur HTTP 500 doit être levée");
  });
  await check("réponse sans contenu : null", async () => {
    const llm = createRodiumLlmService({
      apiKey: "k",
      fetchImpl: fakeFetch(() => chatResponse(null), []),
    });
    assert.equal(await llm.advise("x", [], []), null);
  });
  await check("délai dépassé : la requête est annulée (AbortSignal)", async () => {
    const calls: CapturedCall[] = [];
    const llm = createRodiumLlmService({
      apiKey: "k",
      timeoutMs: 5,
      fetchImpl: fakeFetch(
        () =>
          new Promise<Response>((_resolve, reject) => {
            setTimeout(() => reject(new Error("aborted")), 50);
          }),
        calls,
      ),
    });
    assert.ok(calls.length === 0, "aucun appel avant envoi");
    let rejected = false;
    try {
      await llm.advise("x", [], []);
    } catch {
      rejected = true;
    }
    assert.ok(rejected, "le délai doit faire échouer l'appel");
    assert.ok(calls[0]?.init.signal !== undefined, "un signal d'annulation doit être transmis");
  });

  // Configuration
  await check("configuration : sans clé, aucun service (null)", () => {
    assert.equal(readLlmConfig({}), null);
    assert.equal(readLlmConfig({ RODIUM_API_KEY: "   " }), null);
  });
  await check("configuration : valeurs par défaut quand seule la clé est définie", () => {
    const config = readLlmConfig({ RODIUM_API_KEY: " abc " });
    assert.equal(config?.apiKey, "abc");
    assert.equal(config?.baseUrl, RODIUM_DEFAULT_BASE_URL);
    assert.equal(config?.model, RODIUM_DEFAULT_MODEL);
  });
  await check("configuration : RODIUM_BASE_URL et RODIUM_MODEL surchargent les défauts", () => {
    const config = readLlmConfig({
      RODIUM_API_KEY: "abc",
      RODIUM_BASE_URL: "https://example.test/v1",
      RODIUM_MODEL: "rodiumai/basic",
    });
    assert.equal(config?.baseUrl, "https://example.test/v1");
    assert.equal(config?.model, "rodiumai/basic");
  });

  // Porte de repli
  await check("repli : uniquement pour l'intention unknown", () => {
    assert.equal(shouldUseLlmFallback("unknown"), true);
    assert.equal(shouldUseLlmFallback("product_inquiry"), false);
    assert.equal(shouldUseLlmFallback("delivery_inquiry"), false);
    assert.equal(shouldUseLlmFallback("order_request"), false);
  });

  // Reformulation : budget, garde-fou des faits, repli
  await check("rephrase : max_tokens = 200 et température 0.3", async () => {
    const calls: CapturedCall[] = [];
    const llm = createRodiumLlmService({
      apiKey: "k",
      fetchImpl: fakeFetch(() => chatResponse("Votre total est de 13 500 FCFA."), calls),
    });
    await llm.rephrase(RAW_QUOTE);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.body.max_tokens, REPHRASE_MAX_TOKENS);
    assert.equal(REPHRASE_MAX_TOKENS, 200);
    assert.equal(calls[0]?.body.temperature, REPHRASE_TEMPERATURE);
    assert.equal(REPHRASE_TEMPERATURE, 0.3);
  });

  await check("rephrase : le prompt impose le vouvoiement et l'interdiction d'ajouter une remise", async () => {
    const calls: CapturedCall[] = [];
    const llm = createRodiumLlmService({
      apiKey: "k",
      fetchImpl: fakeFetch(() => chatResponse("Votre total est de 13 500 FCFA."), calls),
    });
    await llm.rephrase(RAW_QUOTE, { customerMessage: "Combien ça coûte ?" });
    const messages = calls[0]?.body.messages as LlmChatMessage[];
    const system = messages[0]?.content ?? "";
    assert.ok(system.includes("vouvoiement"), "vouvoiement absent du prompt");
    assert.ok(system.includes("aucune remise"), "interdiction de remise absente du prompt");
    assert.ok(system.includes("en lettres"), "les quantités en lettres doivent être permises");
    const user = messages[1]?.content ?? "";
    assert.ok(user.includes("Combien ça coûte ?"), "le message client doit être transmis en contexte");
  });

  await check("rephrase : reformulation avec mêmes montants acceptée", async () => {
    const rephrased = "Le super wax vert est à 12 500 FCFA. Livraison : 1 000 FCFA, délai 2 jour(s). Total : 13 500 FCFA.";
    const llm = createRodiumLlmService({
      apiKey: "k",
      fetchImpl: fakeFetch(() => chatResponse(rephrased), []),
    });
    assert.equal(await llm.rephrase(RAW_QUOTE), rephrased);
  });

  await check("rephrase : quantité et délai en lettres acceptés (cas réel de la commande)", async () => {
    const rephrased = "Référence SW-002 : une unité à 450 000 FCFA, sous-total 450 000 FCFA, frais 6 750 FCFA, livraison en un jour.";
    const llm = createRodiumLlmService({
      apiKey: "k",
      fetchImpl: fakeFetch(() => chatResponse(rephrased), []),
    });
    assert.equal(await llm.rephrase(RAW_ORDER_LIKE), rephrased);
  });

  await check("rephrase : montant modifié rejeté, message d'origine renvoyé", async () => {
    const llm = createRodiumLlmService({
      apiKey: "k",
      fetchImpl: fakeFetch(() => chatResponse("Le total est de 12 000 FCFA."), []),
    });
    assert.equal(await llm.rephrase(RAW_QUOTE), RAW_QUOTE);
  });

  await check("rephrase : remise inventée rejetée (chiffre ajouté)", async () => {
    const llm = createRodiumLlmService({
      apiKey: "k",
      fetchImpl: fakeFetch(() => chatResponse("Profitez de 10% de remise : total 13 500 FCFA."), []),
    });
    assert.equal(await llm.rephrase(RAW_QUOTE), RAW_QUOTE);
  });

  await check("rephrase : référence produit altérée rejetée", async () => {
    const llm = createRodiumLlmService({
      apiKey: "k",
      fetchImpl: fakeFetch(() => chatResponse("Référence SW-2 : 450 000 FCFA, frais 6 750 FCFA."), []),
    });
    assert.equal(await llm.rephrase(RAW_ORDER_LIKE), RAW_ORDER_LIKE);
  });

  await check("rephrase : erreur HTTP renvoie le message d'origine (pas d'exception)", async () => {
    const llm = createRodiumLlmService({
      apiKey: "k",
      fetchImpl: fakeFetch(() => new Response("boom", { status: 503 }), []),
    });
    assert.equal(await llm.rephrase(RAW_QUOTE), RAW_QUOTE);
  });

  await check("rephrase : réponse vide renvoie le message d'origine", async () => {
    const llm = createRodiumLlmService({
      apiKey: "k",
      fetchImpl: fakeFetch(() => chatResponse(null), []),
    });
    assert.equal(await llm.rephrase(RAW_QUOTE), RAW_QUOTE);
  });

  await check("rephrase : délai dépassé renvoie le message d'origine", async () => {
    const llm = createRodiumLlmService({
      apiKey: "k",
      timeoutMs: 5,
      fetchImpl: fakeFetch(
        () =>
          new Promise<Response>((_resolve, reject) => {
            setTimeout(() => reject(new Error("aborted")), 50);
          }),
        [],
      ),
    });
    assert.equal(await llm.rephrase(RAW_QUOTE), RAW_QUOTE);
  });

  await check("rephrase : message vide renvoyé sans appel réseau", async () => {
    const calls: CapturedCall[] = [];
    const llm = createRodiumLlmService({
      apiKey: "k",
      fetchImpl: fakeFetch(() => chatResponse("x"), calls),
    });
    assert.equal(await llm.rephrase("   "), "   ");
    assert.equal(calls.length, 0);
  });

  await check("faits : montants FCFA extraits (espaces de milliers)", () => {
    assert.deepEqual(extractAmounts("Total 13 500 FCFA et frais 750 FCFA"), ["13500", "750"]);
  });

  await check("faits : références produit extraites", () => {
    assert.deepEqual(extractCodes("SW-002 puis CMD-ABC12"), ["CMD-ABC12", "SW-002"]);
  });

  await check("faits : montants identiques écrits autrement acceptés", () => {
    assert.ok(preservesFacts("12 500 FCFA", "12500 FCFA"), "même montant doit passer");
  });

  await check("faits : montant changé rejeté", () => {
    assert.ok(!preservesFacts("12 500 FCFA", "12 000 FCFA"), "montant différent doit échouer");
  });

  await check("faits : montant supprimé rejeté", () => {
    assert.ok(!preservesFacts("450 000 FCFA et 6 750 FCFA", "450 000 FCFA"), "montant absent doit échouer");
  });

  await check("faits : nombre ajouté (remise) rejeté", () => {
    assert.ok(!preservesFacts("2 jours", "2 jours et 1 remise") === false, "ajout de chiffre doit échouer");
  });

  console.log(`\n${passed} réussi(s), ${failed} échec(s)`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main();
