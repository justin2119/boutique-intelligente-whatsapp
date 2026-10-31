/** Tests Palier 3 : parsing des webhooks, client Green API, déduplication, dispatch Manager et HITL. */
import { processWebhook, routeRequest, type OutboundSender, type WorkerDeps } from "../src/worker/index";
import { claimMessage, createMemoryStorage, type AppStorage } from "../src/data/storage";
import { loadCatalog } from "../src/data/catalog";
import {
  GreenApiClient,
  GreenApiError,
  isValidWebhookSecret,
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

class RecordingSender implements OutboundSender {
  readonly sent: { chatId: string; message: string }[] = [];

  async sendText(chatId: string, message: string): Promise<unknown> {
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

test("ignore médias, groupes, notifications sortantes et payloads invalides", () => {
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

test("extrait le numéro depuis le chatId", () => {
  assertEqual(phoneFromChatId(`${CLIENT_PHONE}@c.us`), CLIENT_PHONE, "numéro");
});

test("vérifie le secret du webhook", () => {
  assertEqual(isValidWebhookSecret(null, undefined), true, "sans secret configuré");
  assertEqual(isValidWebhookSecret("abc", "abc"), true, "secret correct");
  assertEqual(isValidWebhookSecret("abd", "abc"), false, "secret incorrect");
  assertEqual(isValidWebhookSecret(null, "abc"), false, "secret absent");
});

test("client Green API : URL et corps de sendMessage", async () => {
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

test("déduplication : un messageId n'est traité qu'une fois", async () => {
  const storage = createMemoryStorage();
  assertEqual(await claimMessage(storage.kv, "MSG-D"), true, "première réception");
  assertEqual(await claimMessage(storage.kv, "MSG-D"), false, "doublon");
  assertEqual(await claimMessage(storage.kv, "MSG-E"), true, "autre message");
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

test("HITL : commande en PENDING_HUMAN_VALIDATION puis validée par le gérant", async () => {
  const sender = new RecordingSender();
  const storage = createMemoryStorage();
  const deps = makeDeps(sender, storage);
  const order = await processWebhook(
    textPayload("MSG-O1", CLIENT_PHONE, "Je prends la commande : 2 pagnes SW-002, livraison à Dantokpa en express."),
    deps,
  );
  assertEqual(order.status, "replied", "commande traitée");
  const reference = order.status === "replied" ? order.orderReference : null;
  assert(reference !== null, "référence de commande attendue");
  const stored = await storage.orders.findByReference(reference);
  assertEqual(stored?.status ?? null, "PENDING_HUMAN_VALIDATION", "statut initial");
  const managerNotice = sender.sent.find((entry) => entry.chatId === `${MANAGER_PHONE}@c.us`);
  assert(managerNotice !== undefined, "le gérant doit être notifié");

  const decision = await processWebhook(
    textPayload("MSG-M1", MANAGER_PHONE, `VALIDER ${reference}`),
    deps,
  );
  assertEqual(decision.status, "manager_decision", "décision gérant");
  const confirmed = await storage.orders.findByReference(reference);
  assertEqual(confirmed?.status ?? null, "CONFIRMED", "statut confirmé");
  const customerNotice = sender.sent.find((entry) => entry.chatId === `${CLIENT_PHONE}@c.us` && entry.message.includes("confirmée"));
  assert(customerNotice !== undefined, "le client doit recevoir la confirmation");
});

test("HITL : une validation déjà traitée n'est pas rejouée", async () => {
  const sender = new RecordingSender();
  const storage = createMemoryStorage();
  const deps = makeDeps(sender, storage);
  const order = await processWebhook(
    textPayload("MSG-O2", CLIENT_PHONE, "Je prends la commande : 2 pagnes SW-002, livraison à Dantokpa en express."),
    deps,
  );
  const reference = order.status === "replied" ? order.orderReference : null;
  assert(reference !== null, "référence attendue");
  await processWebhook(textPayload("MSG-M2", MANAGER_PHONE, `REFUSER ${reference}`), deps);
  const again = await processWebhook(textPayload("MSG-M3", MANAGER_PHONE, `VALIDER ${reference}`), deps);
  assertEqual(again.status, "ignored", "second décision ignorée");
  const stored = await storage.orders.findByReference(reference);
  assertEqual(stored?.status ?? null, "REJECTED", "statut reste REJECTED");
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

test("routage : webhook refusé sans secret", async () => {
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
