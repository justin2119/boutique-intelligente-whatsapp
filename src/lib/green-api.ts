/** Client Green API (WhatsApp) : parsing des webhooks entrants et envoi de messages sortants avec reprises. */

export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<FetchResponseLike>;

export interface GreenApiOptions {
  readonly idInstance: string;
  readonly apiTokenInstance: string;
  readonly baseUrl?: string;
  readonly maxRetries?: number;
  readonly retryBaseDelayMs?: number;
  readonly fetchImpl?: FetchLike;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class GreenApiError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(message: string, status: number | null, retryable: boolean) {
    super(message);
    this.name = "GreenApiError";
    this.status = status;
    this.retryable = retryable;
  }
}

export interface SendMessageResult {
  readonly idMessage: string;
}

export interface ReplyButton {
  readonly id: string;
  readonly text: string;
}

export interface IncomingTextMessage {
  readonly messageId: string;
  readonly chatId: string;
  readonly senderPhone: string;
  readonly text: string;
  readonly timestamp: number;
  readonly idInstance: string | null;
  readonly chatName: string | null;
}

const DEFAULT_BASE_URL = "https://api.green-api.com";
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extrait le numéro (chiffres uniquement) d'un chatId Green API, ex. 22997000001@c.us. */
export function phoneFromChatId(chatId: string): string {
  return (chatId.split("@")[0] ?? "").replace(/\D/g, "");
}

function extractText(messageData: Record<string, unknown>): string | null {
  if (messageData.typeMessage === "textMessage") {
    const data = messageData.textMessageData;
    return isRecord(data) && typeof data.textMessage === "string" ? data.textMessage : null;
  }
  if (messageData.typeMessage === "extendedTextMessage") {
    const data = messageData.extendedTextMessageData;
    return isRecord(data) && typeof data.text === "string" ? data.text : null;
  }
  return null;
}

/**
 * Lit une notification Green API `incomingMessageReceived` contenant un message texte.
 * Retourne null pour tout autre type de notification, média, groupe ou payload invalide.
 */
export function parseIncomingWebhook(payload: unknown): IncomingTextMessage | null {
  if (!isRecord(payload) || payload.typeWebhook !== "incomingMessageReceived") {
    return null;
  }
  const messageId = payload.idMessage;
  if (typeof messageId !== "string" || messageId.trim() === "") {
    return null;
  }
  const senderData = payload.senderData;
  if (!isRecord(senderData) || typeof senderData.chatId !== "string") {
    return null;
  }
  if (senderData.chatId.endsWith("@g.us")) {
    return null;
  }
  const messageData = payload.messageData;
  if (!isRecord(messageData)) {
    return null;
  }
  const text = extractText(messageData);
  if (text === null || text.trim() === "") {
    return null;
  }
  const senderPhone = phoneFromChatId(senderData.chatId);
  if (senderPhone === "") {
    return null;
  }
  const instanceData = payload.instanceData;
  const instance = isRecord(instanceData) ? instanceData.idInstance : undefined;
  return {
    messageId,
    chatId: senderData.chatId,
    senderPhone,
    text: text.trim(),
    timestamp: typeof payload.timestamp === "number" ? payload.timestamp : 0,
    idInstance: typeof instance === "number" || typeof instance === "string" ? String(instance) : null,
    chatName: typeof senderData.chatName === "string" ? senderData.chatName : null,
  };
}

/** Vérifie le secret partagé du webhook. Sans secret configuré, toute requête est acceptée. */
export function isValidWebhookSecret(provided: string | null, expected: string | undefined): boolean {
  if (expected === undefined || expected === "") {
    return true;
  }
  if (provided === null || provided.length !== expected.length) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return mismatch === 0;
}

function defaultFetch(url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<FetchResponseLike> {
  return fetch(url, init);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** Client typé de l'API REST Green API (instance WhatsApp). */
export class GreenApiClient {
  private readonly idInstance: string;
  private readonly apiTokenInstance: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: GreenApiOptions) {
    this.idInstance = options.idInstance;
    this.apiTokenInstance = options.apiTokenInstance;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** URL d'un endpoint : /waInstance{idInstance}/{method}/{apiTokenInstance}. */
  endpoint(method: string): string {
    return `${this.baseUrl}/waInstance${this.idInstance}/${method}/${this.apiTokenInstance}`;
  }

  sendText(chatId: string, message: string): Promise<SendMessageResult> {
    return this.post("sendMessage", { chatId, message });
  }

  /** Boutons de réponse rapide (WhatsApp limite à 3 boutons, 20 caractères par libellé). */
  sendButtons(chatId: string, body: string, buttons: readonly ReplyButton[], footer?: string): Promise<SendMessageResult> {
    if (buttons.length < 1 || buttons.length > 3) {
      throw new RangeError("WhatsApp limite les boutons à 3 maximum.");
    }
    for (const button of buttons) {
      if (button.text.length > 20) {
        throw new RangeError(`Libellé de bouton trop long : ${button.text}`);
      }
    }
    return this.post("sendButtons", {
      chatId,
      message: body,
      buttons: buttons.map((button) => ({ buttonId: button.id, buttonText: button.text })),
      ...(footer !== undefined ? { footer } : {}),
    });
  }

  private async post(method: string, body: Record<string, unknown>): Promise<SendMessageResult> {
    const url = this.endpoint(method);
    let lastError = new GreenApiError(`Échec d'envoi Green API (${method})`, null, true);
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (attempt > 0) {
        await this.sleep(this.retryBaseDelayMs * 2 ** (attempt - 1));
      }
      let response: FetchResponseLike;
      try {
        response = await this.fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch {
        lastError = new GreenApiError(`Erreur réseau Green API (${method})`, null, true);
        continue;
      }
      const raw = await response.text();
      if (response.ok) {
        const parsed = safeJson(raw);
        if (isRecord(parsed) && typeof parsed.idMessage === "string") {
          return { idMessage: parsed.idMessage };
        }
        throw new GreenApiError(`Réponse Green API inattendue (${method})`, response.status, false);
      }
      const retryable = response.status === 429 || response.status >= 500;
      lastError = new GreenApiError(`Green API ${method} a répondu ${response.status}`, response.status, retryable);
      if (!retryable) {
        throw lastError;
      }
    }
    throw lastError;
  }
}
