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
  updateStatus(reference: string, status: OrderStatus, validatedAt: string): Promise<void>;
}

export interface AppStorage {
  readonly kv: KvLike;
  readonly orders: OrderStore;
}

/** Enregistre l'identifiant de message ; retourne false s'il a déjà été traité (doublon). */
export async function claimMessage(kv: KvLike, messageId: string): Promise<boolean> {
  const key = `dedup:${messageId}`;
  if ((await kv.get(key)) !== null) {
    return false;
  }
  await kv.put(key, "1", { expirationTtl: DEDUP_TTL_SECONDS });
  return true;
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
      await db
        .prepare("UPDATE orders SET status = ?, validated_at = ? WHERE reference = ?")
        .bind(status, validatedAt, reference)
        .run();
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
      if (current === undefined) {
        throw new Error(`Commande inconnue : ${reference}`);
      }
      orders.set(reference, { ...current, status, validatedAt });
    },
  };
  return { kv, orders: store };
}
