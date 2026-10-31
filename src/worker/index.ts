/**
 * Point d'entrée Cloudflare Worker (Palier 3) : webhooks Green API, idempotence KV, Manager (Palier 2),
 * validation humaine (HITL) et réponse sortante via Green API.
 */
import { FormatterAgent } from "../agents/formatter-agent";
import { HitlValidator } from "../agents/hitl";
import { LogisticsAgent } from "../agents/logistics-agent";
import { ManagerAgent } from "../agents/manager-agent";
import { formatFcfa } from "../agents/normalize";
import { SellerAgent } from "../agents/seller-agent";
import { loadCatalog } from "../data/catalog";
import {
  claimMessage,
  createCloudflareStorage,
  createMemoryStorage,
  HISTORY_MAX_ENTRIES,
  HISTORY_TTL_SECONDS,
  type AppStorage,
  type D1DatabaseLike,
  type KvLike,
  type OrderRecord,
} from "../data/storage";
import {
  GreenApiClient,
  isValidWebhookSecret,
  parseIncomingWebhook,
  type IncomingTextMessage,
} from "../lib/green-api";
import type { Catalog } from "../types";
import type { OrderDraft, OrderStatus, ValidationRecord } from "../types/palier2";

/** Liaisons et variables de l'environnement Worker. */
export interface WorkerEnv {
  readonly CONVERSATIONS_KV?: KvLike;
  readonly DB?: D1DatabaseLike;
  readonly GREEN_API_ID_INSTANCE?: string;
  readonly GREEN_API_TOKEN_INSTANCE?: string;
  readonly GREEN_API_BASE_URL?: string;
  readonly WEBHOOK_SECRET?: string;
  readonly MANAGER_PHONE?: string;
}

export interface OutboundSender {
  sendText(chatId: string, message: string): Promise<unknown>;
}

export interface WorkerConfig {
  readonly expectedIdInstance?: string;
  readonly webhookSecret?: string;
  readonly managerPhone?: string;
}

export interface WorkerDeps {
  readonly storage: AppStorage;
  readonly sender: OutboundSender;
  readonly catalog: Catalog;
  readonly clock: () => Date;
  readonly config: WorkerConfig;
}

export type WebhookOutcome =
  | { readonly status: "ignored"; readonly reason: string }
  | { readonly status: "duplicate"; readonly messageId: string }
  | { readonly status: "manager_decision"; readonly reference: string; readonly decision: "CONFIRMED" | "REJECTED" }
  | { readonly status: "replied"; readonly messageId: string; readonly orderReference: string | null };

const MANAGER_COMMAND = /^(VALIDER|REFUSER)\s+(CMD-[A-Z0-9]+)$/i;

interface HistoryEntry {
  readonly role: "customer" | "assistant";
  readonly text: string;
  readonly at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  return (
    isRecord(value) &&
    (value.role === "customer" || value.role === "assistant") &&
    typeof value.text === "string" &&
    typeof value.at === "string"
  );
}

function chatIdFor(phone: string): string {
  return `${phone}@c.us`;
}

function normalizePhone(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const digits = value.replace(/\D/g, "");
  return digits === "" ? undefined : digits;
}

function toOrderRecord(validation: ValidationRecord, customerPhone: string): OrderRecord {
  const draft = validation.draft;
  return {
    reference: draft.reference,
    customerPhone,
    status: validation.status,
    subtotalXof: draft.subtotalXof,
    deliveryFeeXof: draft.deliveryFeeXof,
    totalXof: draft.totalXof,
    zoneId: draft.zoneId,
    deliveryOption: draft.option,
    etaDays: draft.etaDays,
    validationId: validation.id,
    draft,
    createdAt: validation.createdAt,
    validatedAt: null,
  };
}

function managerSummary(draft: OrderDraft, customerPhone: string): string {
  return [
    `Nouvelle commande ${draft.reference} à valider.`,
    `Client : ${customerPhone}`,
    ...draft.lines.map((line) => `• ${line.name} x${line.quantity} : ${formatFcfa(line.lineTotalXof)}`),
    `Total : ${formatFcfa(draft.totalXof)} (livraison ${draft.zoneLabel}, ${draft.option}).`,
    `Répondez VALIDER ${draft.reference} ou REFUSER ${draft.reference}.`,
  ].join("\n");
}

async function appendHistory(kv: KvLike, phone: string, entries: readonly HistoryEntry[]): Promise<void> {
  const key = `conversation:${phone}`;
  const raw = await kv.get(key);
  let history: HistoryEntry[] = [];
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        history = parsed.filter(isHistoryEntry);
      }
    } catch {
      history = [];
    }
  }
  const next = [...history, ...entries].slice(-HISTORY_MAX_ENTRIES);
  await kv.put(key, JSON.stringify(next), { expirationTtl: HISTORY_TTL_SECONDS });
}

async function handleCustomerMessage(message: IncomingTextMessage, deps: WorkerDeps): Promise<WebhookOutcome> {
  const { catalog, clock, storage, sender, config } = deps;
  const hitl = new HitlValidator(clock);
  const manager = new ManagerAgent({
    catalog,
    seller: new SellerAgent(catalog),
    logistics: new LogisticsAgent(catalog.zones),
    formatter: new FormatterAgent(),
    hitl,
    clock,
  });
  const trace = await manager.handle(message.text);

  let orderReference: string | null = null;
  const validation = trace.aggregated.validation;
  if (validation !== null) {
    await storage.orders.insert(toOrderRecord(validation, message.senderPhone));
    orderReference = validation.draft.reference;
    if (config.managerPhone !== undefined) {
      await sender.sendText(chatIdFor(config.managerPhone), managerSummary(validation.draft, message.senderPhone));
    }
  }

  await sender.sendText(message.chatId, trace.customerMessage);
  const now = clock().toISOString();
  await appendHistory(storage.kv, message.senderPhone, [
    { role: "customer", text: message.text, at: now },
    { role: "assistant", text: trace.customerMessage, at: now },
  ]);
  return { status: "replied", messageId: message.messageId, orderReference };
}

async function handleManagerMessage(
  message: IncomingTextMessage,
  deps: WorkerDeps,
  managerPhone: string,
): Promise<WebhookOutcome> {
  const { storage, sender, clock } = deps;
  const command = MANAGER_COMMAND.exec(message.text);
  if (command === null) {
    await sender.sendText(
      chatIdFor(managerPhone),
      "Commande non reconnue. Répondez VALIDER CMD-XXXX ou REFUSER CMD-XXXX.",
    );
    return { status: "ignored", reason: "Commande gérant non reconnue." };
  }
  const action = (command[1] ?? "").toUpperCase();
  const reference = (command[2] ?? "").toUpperCase();
  const order = await storage.orders.findByReference(reference);
  if (order === null) {
    await sender.sendText(chatIdFor(managerPhone), `Commande introuvable : ${reference}.`);
    return { status: "ignored", reason: "Commande inconnue." };
  }
  if (order.status !== "PENDING_HUMAN_VALIDATION") {
    await sender.sendText(chatIdFor(managerPhone), `La commande ${reference} est déjà traitée (${order.status}).`);
    return { status: "ignored", reason: "Commande déjà traitée." };
  }

  const status: "CONFIRMED" | "REJECTED" = action === "VALIDER" ? "CONFIRMED" : "REJECTED";
  const validatedAt = clock().toISOString();
  await storage.orders.updateStatus(reference, status, validatedAt);
  const validation: ValidationRecord = {
    id: order.validationId,
    status,
    draft: order.draft,
    createdAt: order.createdAt,
    decidedAt: validatedAt,
    decidedBy: "manager",
    note: null,
  };
  const customerMessage = new FormatterAgent().compose({
    intent: "order_request",
    seller: null,
    logistics: null,
    validation,
    draft: order.draft,
  });
  await sender.sendText(chatIdFor(order.customerPhone), customerMessage);
  await sender.sendText(chatIdFor(managerPhone), `Commande ${reference} ${status}. Le client a été informé.`);
  return { status: "manager_decision", reference, decision: status };
}

/** Traite une notification Green API : filtre, idempotence, routage gérant ou client. */
export async function processWebhook(payload: unknown, deps: WorkerDeps): Promise<WebhookOutcome> {
  const message = parseIncomingWebhook(payload);
  if (message === null) {
    return { status: "ignored", reason: "Notification non traitée (message texte entrant attendu)." };
  }
  const expected = deps.config.expectedIdInstance;
  if (expected !== undefined && message.idInstance !== null && message.idInstance !== expected) {
    return { status: "ignored", reason: "Instance Green API inconnue." };
  }
  const fresh = await claimMessage(deps.storage.kv, message.messageId);
  if (!fresh) {
    return { status: "duplicate", messageId: message.messageId };
  }
  const managerPhone = deps.config.managerPhone;
  if (managerPhone !== undefined && message.senderPhone === managerPhone) {
    return handleManagerMessage(message, deps, managerPhone);
  }
  return handleCustomerMessage(message, deps);
}

export function buildDeps(env: WorkerEnv, sender: OutboundSender, clock: () => Date = () => new Date()): WorkerDeps {
  let storage: AppStorage;
  if (env.CONVERSATIONS_KV !== undefined && env.DB !== undefined) {
    storage = createCloudflareStorage(env.CONVERSATIONS_KV, env.DB);
  } else {
    console.warn("Liaisons KV/D1 absentes : stockage en mémoire (développement uniquement).");
    storage = createMemoryStorage();
  }
  return {
    storage,
    sender,
    catalog: loadCatalog(),
    clock,
    config: {
      expectedIdInstance: env.GREEN_API_ID_INSTANCE,
      webhookSecret: env.WEBHOOK_SECRET,
      managerPhone: normalizePhone(env.MANAGER_PHONE),
    },
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function readWebhookSecret(request: Request): string | null {
  const header = request.headers.get("x-webhook-secret");
  if (header !== null) {
    return header;
  }
  const authorization = request.headers.get("authorization");
  if (authorization !== null && authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length);
  }
  return null;
}

/** Routeur HTTP : GET / (healthcheck) et POST /webhook/whatsapp. */
export async function routeRequest(
  request: Request,
  env: WorkerEnv,
  clock: () => Date = () => new Date(),
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }
    return jsonResponse({ status: "ok", service: "boutique-intelligente-whatsapp", palier: 3 }, 200);
  }
  if (url.pathname === "/webhook/whatsapp") {
    if (request.method !== "POST") {
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }
    if (!isValidWebhookSecret(readWebhookSecret(request), env.WEBHOOK_SECRET)) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400);
    }
    const idInstance = env.GREEN_API_ID_INSTANCE;
    const apiTokenInstance = env.GREEN_API_TOKEN_INSTANCE;
    if (idInstance === undefined || idInstance === "" || apiTokenInstance === undefined || apiTokenInstance === "") {
      return jsonResponse({ error: "green_api_not_configured" }, 500);
    }
    try {
      const sender = new GreenApiClient({
        idInstance,
        apiTokenInstance,
        baseUrl: env.GREEN_API_BASE_URL,
      });
      const outcome = await processWebhook(payload, buildDeps(env, sender, clock));
      return jsonResponse({ ok: true, ...outcome }, 200);
    } catch (error) {
      console.error("webhook_failed", error instanceof Error ? error.message : "erreur inconnue");
      return jsonResponse({ ok: false, error: "internal_error" }, 500);
    }
  }
  return jsonResponse({ error: "not_found" }, 404);
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return routeRequest(request, env);
  },
};
