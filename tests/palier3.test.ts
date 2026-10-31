/** Tests Palier 3 : parsing des webhooks, client Green API, déduplication, dispatch Manager, HITL et fiabilité. */
import { buildDeps, processWebhook, routeRequest, type OutboundSender, type WorkerDeps } from "../src/worker/index";
import {
  claimMessage,
  createCloudflareStorage,
  createD1OrderStore,
  createMemoryStorage,
  isMessageProcessed,
  markMessageProcessed,
  type AppStorage,
  type D1DatabaseLike,
  type D1PreparedLike,
} from "../src/data/storage";
import { loadCatalog } from "../src/data/catalog";
import { EXPRESS_ETA_REDUCTION_DAYS, LogisticsAgent, expressEtaDays } from "../src/agents/logistics-agent";
import { etaPhrase } from "../src/agents/formatter-agent";
import {
  GREEN_API_TIMEOUT_MS,
  GreenApiClient,
  GreenApiError,
  isValidWebhookSecret,
  parseIncomingNonText,
  parseIncomingWebhook,
  phoneFromChatId,
  type FetchLike,
} from "../src/lib/green-api";

// Déclaration locale : le test s'exécute avec tsx dans Node, sans types @types/node dans tsconfig.
declare const process: { exitCode: number | undefined };

const CLIENT_PHONE = "22997000001";
const MANAGER_PHONE = "22997999999";
const INSTANCE_ID = "1101000001";
const TOKEN = "TOKEN123";
const CLOCK_INSTANT = "2026-10-31T18:35:43.000Z";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${message} (attendu ${e}, obtenu ${a})`);
  }
}

function textPayload(messageId: string, phone: string, text: string): Record<string, unknown> {
  return {
    typeWebhook: "incomingMessageReceived",
    instanceData: { idInstance: Number(INSTANCE_ID), wid: `${INSTANCE_ID}@c.us`, typeInstance: "whatsapp" },
    timestamp: 1761935212,
    idMessage: messageId,
    senderData: { chatId: `${phone}@c.us`, sender: `${phone}@c.us`, chatName: "Client test" },
    messageData: { typeMessage: "textMessage", textMessageData: { textMessage: text } },
  };
}

function mediaPayload(messageId: string, phone: string, typeMessage: string): Record<string, unknown> {
  const payload = textPayload(messageId, phone, "x");
  payload.messageData = { typeMessage, fileMessageData: { mimeType: "audio/ogg" } };
  return payload;
}

class RecordingSender implements OutboundSender {
  readonly sent: { chatId: string; message: string }[] = [];
  failuresRemaining = 0;

  async sendText(chatId: string, message: string): Promise<unknown> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("Green API indisponible (simulé)");
    }
    this.sent.push({ chatId, message });
    return { idMessage: `OUT-${this.sent.length}` };
  }
}

function makeDeps(sender: OutboundSender, storage: AppStorage): WorkerDeps {
  return {
    storage,
    sender,
    catalog: loadCatalog(),
    clock: () => new Date(CLOCK_INSTANT),
    config: { expectedIdInstance: INSTANCE_ID, managerPhone: MANAGER_PHONE },
  };
}

/** Ligne simulée de la table `orders` (colonnes SQL, comme renvoyées par D1). */
type FakeOrderRow = Record<string, unknown> & { reference: string; status: string; validated_at: string | null };

/**
 * D1 simulé pour la table `orders` : INSERT stocke la ligne complète (colonnes de createD1OrderStore),
 * SELECT ... WHERE reference = ? la renvoie, et UPDATE conditionnel renvoie meta.changes comme en production.
 */
function fakeD1(): { db: D1DatabaseLike; rows: Map<string, FakeOrderRow> } {
  const rows = new Map<string, FakeOrderRow>();
  const db: D1DatabaseLike = {
    prepare(query: string): D1PreparedLike {
      let params: unknown[] = [];
      const prepared: D1PreparedLike = {
        bind(...values: readonly unknown[]) {
          params = [...values];
          return prepared;
        },
        async run() {
          if (query.startsWith("INSERT INTO orders")) {
            // Ordre des colonnes identique à createD1OrderStore.insert.
            const columns = [
              "reference",
              "customer_phone",
              "items",
              "subtotal",
              "delivery_fee",
              "total",
              "status",
              "zone_id",
              "delivery_option",
              "eta_days",
              "validation_id",
              "draft_json",
              "created_at",
              "validated_at",
            ];
            const row: Record<string, unknown> = {};
            columns.forEach((column, index) => {
              row[column] = params[index];
            });
            const reference = String(row.reference);
            if (rows.has(reference)) {
              throw new Error(`Commande déjà enregistrée : ${reference}`);
            }
            rows.set(reference, row as FakeOrderRow);
            return { meta: { changes: 1 } };
          }
          if (query.startsWith("UPDATE orders")) {
            assert(query.includes("AND status = 'PENDING_HUMAN_VALIDATION'"), "garde atomique attendue dans la requête");
            const [status, validatedAt, reference] = params as [string, string, string];
            const row = rows.get(reference);
            if (row !== undefined && row.status === "PENDING_HUMAN_VALIDATION") {
              rows.set(reference, { ...row, status, validated_at: validatedAt });
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          return { meta: { changes: 0 } };
        },
        async first<T>(): Promise<T | null> {
          const reference = params[0] as string;
          const row = rows.get(reference);
          return row === undefined ? null : (row as unknown as T);
        },
      };
      return prepared;
    },
  };
  return { db, rows };
}

interface FakeCall {
  url: string;
  body: string;
}

function fakeFetch(responses: readonly { status: number; body: string }[], calls: FakeCall[]): FetchLike {
  let index = 0;
  return async (url, init) => {
    calls.push({ url, body: init.body ?? "" });
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (response === undefined) {
      throw new Error("Aucune réponse simulée");
    }
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: async () => response.body,
    };
  };
}

async function firstOrderReference(sender: RecordingSender, storage: AppStorage, deps: WorkerDeps, id: string): Promise<string> {
  const order = await processWebhook(
    textPayload(id, CLIENT_PHONE, "Je prends la commande : 2 pagnes SW-002, livraison à Dantokpa en express."),
    deps,
  );
  const reference = order.status === "replied" ? order.orderReference : null;
  assert(reference !== null, "référence de commande attendue");
  assert(sender.sent.length > 0, "des messages doivent être envoyés");
  assert((await storage.orders.findByReference(reference)) !== null, "commande enregistrée");
  return reference;
}

const checks: { name: string; run: () => void | Promise<void> }[] = [];
function test(name: string, run: () => void | Promise<void>): void {
  checks.push({ name, run });
}

test("parse un message texte entrant", () => {
  const parsed = parseIncomingWebhook(textPayload("MSG-1", CLIENT_PHONE, "  Bonjour  "));
  assert(parsed !== null, "le message texte doit être reconnu");
  assertEqual(parsed.messageId, "MSG-1", "messageId");
  assertEqual(parsed.senderPhone, CLIENT_PHONE, "senderPhone");
  assertEqual(parsed.text, "Bonjour", "texte nettoyé");
  assertEqual(parsed.idInstance, INSTANCE_ID, "idInstance");
  assertEqual(parsed.timestamp, 1761935212, "timestamp");
});

test("parse un extendedTextMessage", () => {
  const payload = textPayload("MSG-2", CLIENT_PHONE, "x");
  payload.messageData = { typeMessage: "extendedTextMessage", extendedTextMessageData: { text: "Prix du wax ?" } };
  const parsed = parseIncomingWebhook(payload);
  assertEqual(parsed?.text ?? null, "Prix du wax ?", "texte étendu");
});

test("ignore médias, groupes, notifications sortantes et payloads invalides (parseur texte)", () => {
  const image = textPayload("MSG-3", CLIENT_PHONE, "x");
  image.messageData = { typeMessage: "imageMessage" };
  assertEqual(parseIncomingWebhook(image), null, "image");
  const group = textPayload("MSG-4", CLIENT_PHONE, "x");
  group.senderData = { chatId: "120363@g.us", sender: `${CLIENT_PHONE}@c.us` };
  assertEqual(parseIncomingWebhook(group), null, "groupe");
  const outgoing = textPayload("MSG-5", CLIENT_PHONE, "x");
  outgoing.typeWebhook = "outgoingMessageReceived";
  assertEqual(parseIncomingWebhook(outgoing), null, "sortant");
  assertEqual(parseIncomingWebhook(null), null, "null");
  assertEqual(parseIncomingWebhook("texte"), null, "chaîne");
});

test("non-texte : audio, image et document sont reconnus avec l'expéditeur", () => {
  const audio = parseIncomingNonText(mediaPayload("MSG-A1", CLIENT_PHONE, "audioMessage"));
  assertEqual(audio?.mediaType ?? null, "audio", "audio");
  assertEqual(audio?.senderPhone ?? null, CLIENT_PHONE, "expéditeur audio");
  assertEqual(parseIncomingNonText(mediaPayload("MSG-A2", CLIENT_PHONE, "imageMessage"))?.mediaType ?? null, "image", "image");
  assertEqual(parseIncomingNonText(mediaPayload("MSG-A3", CLIENT_PHONE, "documentMessage"))?.mediaType ?? null, "document", "document");
  assertEqual(parseIncomingNonText(textPayload("MSG-A4", CLIENT_PHONE, "bonjour")), null, "texte ignoré par le parseur non-texte");
});

test("non-texte : réponse polie au client pour un message vocal", async () => {
  const sender = new RecordingSender();
  const storage = createMemoryStorage();
  const outcome = await processWebhook(mediaPayload("MSG-VOICE", CLIENT_PHONE, "audioMessage"), makeDeps(sender, storage));
  assertEqual(outcome.status, "non_text_reply", "statut non-texte");
  assertEqual(sender.sent.length, 1, "une seule réponse");
  assertEqual(sender.sent[0]?.chatId ?? "", `${CLIENT_PHONE}@c.us`, "destinataire client");
  assert((sender.sent[0]?.message ?? "").includes("message vocal"), "message mentionnant le vocal");
  assert((sender.sent[0]?.message ?? "").includes("texte"), "demande de passer par le texte");
  const repeat = await processWebhook(mediaPayload("MSG-VOICE", CLIENT_PHONE, "audioMessage"), makeDeps(sender, storage));
  assertEqual(repeat.status, "duplicate", "doublon non-texte ignoré");
  assertEqual(sender.sent.length, 1, "pas de second envoi");
});

test("extrait le numéro depuis le chatId", () => {
  assertEqual(phoneFromChatId(`${CLIENT_PHONE}@c.us`), CLIENT_PHONE, "numéro");
});

test("secret webhook : fail-closed sans secret, vide ou absent", () => {
  assertEqual(isValidWebhookSecret(null, undefined), false, "sans secret configuré : refus");
  assertEqual(isValidWebhookSecret("", undefined), false, "secret non configuré et fourni vide : refus");
  assertEqual(isValidWebhookSecret("", ""), false, "secret configuré vide : refus");
  assertEqual(isValidWebhookSecret(null, ""), false, "secret configuré vide, rien fourni : refus");
  assertEqual(isValidWebhookSecret("abc", "abc"), true, "secret correct");
  assertEqual(isValidWebhookSecret("abd", "abc"), false, "secret incorrect");
  assertEqual(isValidWebhookSecret(null, "abc"), false, "secret absent");
});

test("routage : WEBHOOK_SECRET absent en production -> 500 configuration (pas de POST non authentifié)", async () => {
  const response = await routeRequest(
    new Request("https://worker.test/webhook/whatsapp", { method: "POST", body: "{}" }),
    { ENVIRONMENT: "production" },
  );
  assertEqual(response.status, 500, "statut 500");
});

test("routage : WEBHOOK_SECRET vide -> 500 configuration", async () => {
  const response = await routeRequest(
    new Request("https://worker.test/webhook/whatsapp", {
      method: "POST",
      body: "{}",
      headers: { "x-webhook-secret": "" },
    }),
    { WEBHOOK_SECRET: "" },
  );
  assertEqual(response.status, 500, "statut 500");
});

test("stockage : production sans liaisons -> erreur explicite Storage bindings missing", async () => {
  const sender = new RecordingSender();
  let message = "";
  try {
    buildDeps({ ENVIRONMENT: "production" }, sender, () => new Date(CLOCK_INSTANT));
  } catch (error) {
    message = error instanceof Error ? error.message : "";
  }
  assertEqual(message, "Storage bindings missing", "message d'erreur");
  const response = await routeRequest(
    new Request("https://worker.test/webhook/whatsapp", {
      method: "POST",
      body: JSON.stringify(textPayload("MSG-PROD", CLIENT_PHONE, "Bonjour")),
      headers: { "x-webhook-secret": "s3cret" },
    }),
    { WEBHOOK_SECRET: "s3cret", GREEN_API_ID_INSTANCE: INSTANCE_ID, GREEN_API_TOKEN_INSTANCE: TOKEN, ENVIRONMENT: "production" },
  );
  assertEqual(response.status, 500, "statut 500 sans stockage en production");
});

test("stockage : mémoire autorisée uniquement en développement explicite", () => {
  const deps = buildDeps({ ENVIRONMENT: "development" }, new RecordingSender(), () => new Date(CLOCK_INSTANT));
  assert(deps.storage.kv !== undefined, "stockage mémoire en développement");
  const testDeps = buildDeps({ NODE_ENV: "test" }, new RecordingSender(), () => new Date(CLOCK_INSTANT));
  assert(testDeps.storage.kv !== undefined, "stockage mémoire en test");
});

test("client Green API : URL et corps de sendMessage avec délai d'attente", async () => {
  const calls: FakeCall[] = [];
  const client = new GreenApiClient({
    idInstance: INSTANCE_ID,
    apiTokenInstance: TOKEN,
    fetchImpl: fakeFetch([{ status: 200, body: JSON.stringify({ idMessage: "OUT-9" }) }], calls),
    sleep: async () => {},
  });
  const result = await client.sendText(`${CLIENT_PHONE}@c.us`, "Bonjour");
  assertEqual(result.idMessage, "OUT-9", "idMessage");
  assertEqual(calls[0]?.url ?? "", `https://api.green-api.com/waInstance${INSTANCE_ID}/sendMessage/${TOKEN}`, "URL");
  assertEqual(JSON.parse(calls[0]?.body ?? "{}"), { chatId: `${CLIENT_PHONE}@c.us`, message: "Bonjour" }, "corps");
  assertEqual(GREEN_API_TIMEOUT_MS, 8000, "délai d'attente de 8 secondes");
});

test("client Green API : reprise sur erreur 500 puis succès", async () => {
  const calls: FakeCall[] = [];
  const client = new GreenApiClient({
    idInstance: INSTANCE_ID,
    apiTokenInstance: TOKEN,
    fetchImpl: fakeFetch(
      [
        { status: 500, body: "erreur" },
        { status: 200, body: JSON.stringify({ idMessage: "OUT-10" }) },
      ],
      calls,
    ),
    sleep: async () => {},
  });
  const result = await client.sendText(`${CLIENT_PHONE}@c.us`, "Bonjour");
  assertEqual(result.idMessage, "OUT-10", "idMessage après reprise");
  assertEqual(calls.length, 2, "deux tentatives");
});

test("client Green API : pas de reprise sur erreur 400", async () => {
  const calls: FakeCall[] = [];
  const client = new GreenApiClient({
    idInstance: INSTANCE_ID,
    apiTokenInstance: TOKEN,
    fetchImpl: fakeFetch([{ status: 400, body: "mauvaise requête" }], calls),
    sleep: async () => {},
  });
  let thrown: unknown = null;
  try {
    await client.sendText(`${CLIENT_PHONE}@c.us`, "Bonjour");
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof GreenApiError, "erreur GreenApiError attendue");
  assertEqual(thrown.status, 400, "statut");
  assertEqual(thrown.retryable, false, "non réessayable");
  assertEqual(calls.length, 1, "une seule tentative");
});

test("client Green API : délai dépassé traité comme erreur réessayable", async () => {
  const seenSignals: unknown[] = [];
  const client = new GreenApiClient({
    idInstance: INSTANCE_ID,
    apiTokenInstance: TOKEN,
    maxRetries: 0,
    fetchImpl: async (_url, init) => {
      seenSignals.push(init.signal);
      throw new Error("The operation was aborted due to timeout");
    },
    sleep: async () => {},
  });
  let thrown: unknown = null;
  try {
    await client.sendText(`${CLIENT_PHONE}@c.us`, "Bonjour");
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof GreenApiError, "erreur GreenApiError attendue");
  assertEqual(thrown.retryable, true, "réessayable");
  assert(seenSignals[0] instanceof AbortSignal, "un AbortSignal doit être transmis à fetch");
});

test("déduplication : un messageId n'est traité qu'une fois", async () => {
  const storage = createMemoryStorage();
  assertEqual(await claimMessage(storage.kv, "MSG-D"), true, "première réception");
  assertEqual(await claimMessage(storage.kv, "MSG-D"), false, "doublon");
  assertEqual(await claimMessage(storage.kv, "MSG-E"), true, "autre message");
});

test("déduplication : rien n'est marqué tant que le workflow n'a pas réussi", async () => {
  const storage = createMemoryStorage();
  assertEqual(await isMessageProcessed(storage.kv, "MSG-PEND"), false, "non traité au départ");
  await markMessageProcessed(storage.kv, "MSG-PEND");
  assertEqual(await isMessageProcessed(storage.kv, "MSG-PEND"), true, "traité après succès");
});

test("dedup après échec : un envoi Green API en échec reste reprenable, puis le succès est enregistré", async () => {
  const sender = new RecordingSender();
  const storage = createMemoryStorage();
  const deps = makeDeps(sender, storage);
  const payload = textPayload("MSG-RETRY", CLIENT_PHONE, "Bonjour, je cherche du super wax vert, 2 pagnes.");
  sender.failuresRemaining = 1;
  let failed = false;
  try {
    await processWebhook(payload, deps);
  } catch {
    failed = true;
  }
  assertEqual(failed, true, "la première tentative échoue");
  assertEqual(await isMessageProcessed(storage.kv, "MSG-RETRY"), false, "non marqué après échec");
  const retry = await processWebhook(payload, deps);
  assertEqual(retry.status, "replied", "reprise traitée (pas un doublon)");
  assertEqual(sender.sent.length, 1, "une réponse envoyée");
  assertEqual(await isMessageProcessed(storage.kv, "MSG-RETRY"), true, "marqué après succès");
  const third = await processWebhook(payload, deps);
  assertEqual(third.status, "duplicate", "doublon après succès");
  assertEqual(sender.sent.length, 1, "aucun envoi supplémentaire");
});

test("dispatch : demande produit -> une réponse client, pas de commande", async () => {
  const sender = new RecordingSender();
  const storage = createMemoryStorage();
  const outcome = await processWebhook(
    textPayload("MSG-I1", CLIENT_PHONE, "Bonjour, je cherche du super wax vert, 2 pagnes. Combien ça coûte ?"),
    makeDeps(sender, storage),
  );
  assertEqual(outcome.status, "replied", "statut");
  assertEqual(sender.sent.length, 1, "un message sortant");
  assertEqual(sender.sent[0]?.chatId ?? "", `${CLIENT_PHONE}@c.us`, "destinataire client");
  const history = await storage.kv.get(`conversation:${CLIENT_PHONE}`);
  assert(history !== null, "historique de conversation enregistré");
});

test("dispatch : doublon ignoré sans second envoi", async () => {
  const sender = new RecordingSender();
  const deps = makeDeps(sender, createMemoryStorage());
  const payload = textPayload("MSG-DUP", CLIENT_PHONE, "Bonjour, je cherche du wax");
  await processWebhook(payload, deps);
  const second = await processWebhook(payload, deps);
  assertEqual(second.status, "duplicate", "doublon détecté");
  assertEqual(sender.sent.length, 1, "aucun envoi supplémentaire");
});

test("ETA express : Dantokpa (0 jour) reste 0 jour, jamais 1 jour", () => {
  const quote = new LogisticsAgent(loadCatalog().zones).quote("Dantokpa", "express");
  assertEqual(quote.kind, "quoted", "zone Dantokpa reconnue");
  if (quote.kind !== "quoted") {
    return;
  }
  assertEqual(quote.zone.etaDays, 0, "délai standard Dantokpa");
  assertEqual(quote.etaDays, 0, "délai express Dantokpa");
  assertEqual(etaPhrase(quote.etaDays), "livraison le jour même", "libellé jour même");
});

test("ETA express : formule jamais plus lente que le standard", () => {
  assertEqual(expressEtaDays(0), 0, "0 -> 0");
  assertEqual(expressEtaDays(1), 0, "1 -> 0");
  assertEqual(expressEtaDays(3), 2, "3 -> 2");
  assertEqual(EXPRESS_ETA_REDUCTION_DAYS, 1, "réduction de 1 jour");
  assertEqual(etaPhrase(2), "délai estimé 2 jour(s)", "libellé avec jours");
});

test("HITL : commande en PENDING_HUMAN_VALIDATION puis validée par le gérant", async () => {
  const sender = new RecordingSender();
  const storage = createMemoryStorage();
  const deps = makeDeps(sender, storage);
  const reference = await firstOrderReference(sender, storage, deps, "MSG-O1");
  const stored = await storage.orders.findByReference(reference);
  assertEqual(stored?.status ?? null, "PENDING_HUMAN_VALIDATION", "statut initial");
  const managerNotice = sender.sent.find((entry) => entry.chatId === `${MANAGER_PHONE}@c.us`);
  assert(managerNotice !== undefined, "le gérant doit être notifié");

  const decision = await processWebhook(textPayload("MSG-M1", MANAGER_PHONE, `VALIDER ${reference}`), deps);
  assertEqual(decision.status, "manager_decision", "décision gérant");
  const confirmed = await storage.orders.findByReference(reference);
  assertEqual(confirmed?.status ?? null, "CONFIRMED", "statut confirmé");
  const customerNotice = sender.sent.find((entry) => entry.chatId === `${CLIENT_PHONE}@c.us` && entry.message.includes("confirmée"));
  assert(customerNotice !== undefined, "le client doit recevoir la confirmation");
});

test("HITL : une validation déjà traitée n'est pas rejouée (mémoire)", async () => {
  const sender = new RecordingSender();
  const storage = createMemoryStorage();
  const deps = makeDeps(sender, storage);
  const reference = await firstOrderReference(sender, storage, deps, "MSG-O2");
  await processWebhook(textPayload("MSG-M2", MANAGER_PHONE, `REFUSER ${reference}`), deps);
  const sentBefore = sender.sent.length;
  const again = await processWebhook(textPayload("MSG-M3", MANAGER_PHONE, `VALIDER ${reference}`), deps);
  assertEqual(again.status, "ignored", "second décision ignorée");
  assertEqual(sender.sent.length, sentBefore + 1, "seulement un avis gérant, aucune notification client");
  const stored = await storage.orders.findByReference(reference);
  assertEqual(stored?.status ?? null, "REJECTED", "statut reste REJECTED");
});

test("D1 atomique : UPDATE conditionnel changes=1 puis changes=0 (pas de double notification)", async () => {
  const { db, rows } = fakeD1();
  const store = createD1OrderStore(db);
  rows.set("CMD-ATOM", { reference: "CMD-ATOM", status: "PENDING_HUMAN_VALIDATION", validated_at: null });
  assertEqual(await store.updateStatus("CMD-ATOM", "CONFIRMED", CLOCK_INSTANT), true, "première transition");
  assertEqual(await store.updateStatus("CMD-ATOM", "REJECTED", CLOCK_INSTANT), false, "seconde transition refusée");
  assertEqual(rows.get("CMD-ATOM")?.status ?? null, "CONFIRMED", "statut final inchangé");
  assertEqual(await store.updateStatus("CMD-INCONNU", "CONFIRMED", CLOCK_INSTANT), false, "commande inexistante");
});

test("D1 atomique : deux VALIDER simultanés n'envoient qu'une notification client", async () => {
  const sender = new RecordingSender();
  const { db, rows } = fakeD1();
  const kvStorage = createMemoryStorage();
  const storage: AppStorage = createCloudflareStorage(kvStorage.kv, db);
  const deps = makeDeps(sender, storage);
  const reference = await firstOrderReference(sender, storage, deps, "MSG-O3");
  assertEqual(rows.get(reference)?.status ?? null, "PENDING_HUMAN_VALIDATION", "statut initial D1");
  const first = await processWebhook(textPayload("MSG-M4", MANAGER_PHONE, `VALIDER ${reference}`), deps);
  const second = await processWebhook(textPayload("MSG-M5", MANAGER_PHONE, `VALIDER ${reference}`), deps);
  assertEqual(first.status, "manager_decision", "première décision");
  assertEqual(second.status, "ignored", "seconde décision ignorée");
  const customerConfirmations = sender.sent.filter(
    (entry) => entry.chatId === `${CLIENT_PHONE}@c.us` && entry.message.includes("confirmée"),
  );
  assertEqual(customerConfirmations.length, 1, "une seule notification client");
});

test("dispatch : instance Green API inconnue ignorée", async () => {
  const sender = new RecordingSender();
  const payload = textPayload("MSG-X1", CLIENT_PHONE, "Bonjour");
  payload.instanceData = { idInstance: 999, wid: "x", typeInstance: "whatsapp" };
  const outcome = await processWebhook(payload, makeDeps(sender, createMemoryStorage()));
  assertEqual(outcome.status, "ignored", "instance rejetée");
  assertEqual(sender.sent.length, 0, "aucun envoi");
});

test("routage : healthcheck GET /", async () => {
  const response = await routeRequest(new Request("https://worker.test/"), {});
  assertEqual(response.status, 200, "statut 200");
});

test("routage : webhook refusé sans secret fourni", async () => {
  const response = await routeRequest(
    new Request("https://worker.test/webhook/whatsapp", { method: "POST", body: "{}" }),
    { WEBHOOK_SECRET: "s3cret" },
  );
  assertEqual(response.status, 401, "statut 401");
});

async function main(): Promise<void> {
  let failed = 0;
  for (const check of checks) {
    try {
      await check.run();
      console.log(`ok - ${check.name}`);
    } catch (error) {
      failed += 1;
      console.log(`not ok - ${check.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`\n${checks.length - failed}/${checks.length} vérifications réussies`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main();
