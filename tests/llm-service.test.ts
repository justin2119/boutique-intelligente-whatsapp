/**
 * Tests du service LLM RodiumAI : max_tokens, température, gestion d'erreurs, extraction JSON,
 * et porte de repli (fallback). Aucun appel réseau : fetch est simulé. Exécution : pnpm run test:llm
 */
import {
  ADVICE_MAX_HISTORY,
  ADVICE_MAX_PRODUCTS,
  ADVICE_MAX_TOKENS,
  DIALOGUE_TEMPERATURE,
  EXTRACTION_MAX_TOKENS,
  EXTRACTION_TEMPERATURE,
  RODIUM_DEFAULT_BASE_URL,
  RODIUM_DEFAULT_MODEL,
  compactCatalog,
  createRodiumLlmService,
  parseJsonObject,
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

  console.log(`\n${passed} réussi(s), ${failed} échec(s)`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main();
