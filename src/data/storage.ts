/** Persistance (Palier 3) : KV (sessions, déduplication), D1 (commandes) et mock mémoire pour les tests locaux. */
import type { DeliveryOption, OrderDraft, OrderStatus } from "../types/palier2";

export const DEDUP_TTL_SECONDS = 86_400;
export const HISTORY_TTL_SECONDS = 2_592_000;
export const HISTORY_MAX_ENTRIES = 20;

export interface KvPutOptions {
  readonly expirationTtl?: number;
}

/** Sous-ensemble de l'API Workers KV utilisé par l'application. */
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: KvPutOptions): Promise<void>;
}

/** Sous-ensemble de l'API D1 utilisé par l'application. */
export interface D1PreparedLike {
  bind(...values: readonly unknown[]): D1PreparedLike;
  run(): Promise<unknown>;
  first<T>(): Promise<T | null>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedLike;
}

export interface OrderRecord {
  readonly reference: string;
  readonly customerPhone: string;
  readonly status: OrderStatus;
  readonly subtotalXof: number;
  readonly deliveryFeeXof: number;
  readonly totalXof: number;
  readonly zoneId: string;
  readonly deliveryOption: DeliveryOption;
  readonly etaDays: number;
  readonly validationId: string;
  readonly draft: OrderDraft;
  readonly createdAt: string;
  readonly validatedAt: string | null;
}

export interface OrderStore {
  insert(order: OrderRecord): Promise<void>;
  findByReference(reference: string): Promise<OrderRecord | null>;
  /**
   * Transition atomique PENDING_HUMAN_VALIDATION -> status.
   * Retourne true seulement si la commande était encore en attente (une seule ligne modifiée).
   * Retourne false si la commande a déjà été traitée ou n'existe pas.
   */
  updateStatus(reference: string, status: OrderStatus, validatedAt: string): Promise<boolean>;
}

export interface AppStorage {
  readonly kv: KvLike;
  readonly orders: OrderStore;
}

/** Enregistre l'identifiant de message ; retourne false s'il a déjà été traité (doublon). */
export async function claimMessage(kv: KvLike, messageId: string): Promise<boolean> {
  if (await isMessageProcessed(kv, messageId)) {
    return false;
  }
  await markMessageProcessed(kv, messageId);
  return true;
}

/** Indique si le messageId a déjà été traité avec succès (sans le réserver). */
export async function isMessageProcessed(kv: KvLike, messageId: string): Promise<boolean> {
  return (await kv.get(`dedup:${messageId}`)) !== null;
}

/**
 * Marque le messageId comme traité. À n'appeler qu'après réussite complète du workflow
 * (traitement agent + envoi Green API), afin qu'une panne transitoire permette la reprise par Green API.
 */
export async function markMessageProcessed(kv: KvLike, messageId: string): Promise<void> {
  await kv.put(`dedup:${messageId}`, "1", { expirationTtl: DEDUP_TTL_SECONDS });
}

interface OrderRow {
  readonly reference: string;
  readonly customer_phone: string;
  readonly status: string;
  readonly subtotal: number;
  readonly delivery_fee: number;
  readonly total: number;
  readonly zone_id: string;
  readonly delivery_option: string;
  readonly eta_days: number;
  readonly validation_id: string;
  readonly draft_json: string;
  readonly created_at: string;
  readonly validated_at: string | null;
}

function rowToRecord(row: OrderRow): OrderRecord {
  return {
    reference: row.reference,
    customerPhone: row.customer_phone,
    status: row.status as OrderStatus,
    subtotalXof: row.subtotal,
    deliveryFeeXof: row.delivery_fee,
    totalXof: row.total,
    zoneId: row.zone_id,
    deliveryOption: row.delivery_option as DeliveryOption,
    etaDays: row.eta_days,
    validationId: row.validation_id,
    draft: JSON.parse(row.draft_json) as OrderDraft,
    createdAt: row.created_at,
    validatedAt: row.validated_at,
  };
}

/** Extrait meta.changes du résultat d'une requête D1 (nombre de lignes modifiées). */
function changesOf(result: unknown): number {
  if (typeof result === "object" && result !== null && "meta" in result) {
    const meta = (result as { meta?: { changes?: unknown } }).meta;
    if (meta !== undefined && typeof meta.changes === "number") {
      return meta.changes;
    }
  }
  return 0;
}

/** Table `orders` de D1 (voir migrations/0001_init_orders.sql). */
export function createD1OrderStore(db: D1DatabaseLike): OrderStore {
  return {
    async insert(order) {
      await db
        .prepare(
          "INSERT INTO orders (reference, customer_phone, items, subtotal, delivery_fee, total, status, zone_id, delivery_option, eta_days, validation_id, draft_json, created_at, validated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          order.reference,
          order.customerPhone,
          JSON.stringify(order.draft.lines),
          order.subtotalXof,
          order.deliveryFeeXof,
          order.totalXof,
          order.status,
          order.zoneId,
          order.deliveryOption,
          order.etaDays,
          order.validationId,
          JSON.stringify(order.draft),
          order.createdAt,
          order.validatedAt,
        )
        .run();
    },
    async findByReference(reference) {
      const row = await db.prepare("SELECT * FROM orders WHERE reference = ?").bind(reference).first<OrderRow>();
      return row === null ? null : rowToRecord(row);
    },
    async updateStatus(reference, status, validatedAt) {
      const result = await db
        .prepare("UPDATE orders SET status = ?, validated_at = ? WHERE reference = ? AND status = 'PENDING_HUMAN_VALIDATION'")
        .bind(status, validatedAt, reference)
        .run();
      return changesOf(result) === 1;
    },
  };
}

/** Stockage de production : KV pour l'état de session, D1 pour les commandes. */
export function createCloudflareStorage(kv: KvLike, db: D1DatabaseLike): AppStorage {
  return { kv, orders: createD1OrderStore(db) };
}

/** Mock mémoire pour les tests et l'exécution locale sans identifiants Cloudflare. */
export function createMemoryStorage(): AppStorage {
  const values = new Map<string, string>();
  const orders = new Map<string, OrderRecord>();
  const kv: KvLike = {
    async get(key) {
      return values.get(key) ?? null;
    },
    async put(key, value) {
      values.set(key, value);
    },
  };
  const store: OrderStore = {
    async insert(order) {
      if (orders.has(order.reference)) {
        throw new Error(`Commande déjà enregistrée : ${order.reference}`);
      }
      orders.set(order.reference, order);
    },
    async findByReference(reference) {
      return orders.get(reference) ?? null;
    },
    async updateStatus(reference, status, validatedAt) {
      const current = orders.get(reference);
      if (current === undefined || current.status !== "PENDING_HUMAN_VALIDATION") {
        return false;
      }
      orders.set(reference, { ...current, status, validatedAt });
      return true;
    },
  };
  return { kv, orders: store };
}
