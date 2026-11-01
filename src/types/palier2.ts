import type { DeliveryZone, Product } from "./index";

export type AgentName = "manager" | "seller" | "logistics" | "formatter" | "hitl";
export type Intent = "product_inquiry" | "delivery_inquiry" | "order_request" | "unknown";
export type DeliveryOption = "standard" | "express";

export type SellerResult =
  | { readonly kind: "available"; readonly product: Product; readonly quantity: number; readonly subtotalXof: number }
  | { readonly kind: "out_of_stock"; readonly product: Product; readonly quantity: number; readonly alternatives: readonly Product[] }
  | { readonly kind: "not_found"; readonly query: string };

export type LogisticsResult =
  | { readonly kind: "quoted"; readonly zone: DeliveryZone; readonly option: DeliveryOption; readonly feeXof: number; readonly etaDays: number }
  | { readonly kind: "ambiguous"; readonly query: string; readonly candidates: readonly string[] }
  | { readonly kind: "unknown_zone"; readonly query: string };

export interface OrderLine {
  readonly productId: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceXof: number;
  readonly lineTotalXof: number;
}

export interface OrderDraft {
  readonly reference: string;
  readonly lines: readonly OrderLine[];
  readonly zoneId: string;
  readonly zoneLabel: string;
  readonly option: DeliveryOption;
  readonly subtotalXof: number;
  readonly deliveryFeeXof: number;
  readonly totalXof: number;
  readonly etaDays: number;
}

export type OrderStatus = "PENDING_HUMAN_VALIDATION" | "CONFIRMED" | "REJECTED";
export type Decider = "manager" | "customer";

export interface ValidationRecord {
  readonly id: string;
  readonly status: OrderStatus;
  readonly draft: OrderDraft;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly decidedBy: Decider | null;
  readonly note: string | null;
}

export interface ValidationDecision {
  readonly by: Decider;
  readonly approved: boolean;
  readonly note?: string;
}

export interface Delegation {
  readonly from: AgentName;
  readonly to: AgentName;
  readonly task: string;
  readonly output: string;
}

export interface AggregatedResponse {
  readonly intent: Intent;
  readonly seller: SellerResult | null;
  readonly logistics: LogisticsResult | null;
  readonly validation: ValidationRecord | null;
  readonly draft: OrderDraft | null;
}

/** Mémoire légère d'une conversation client, relue à chaque message (stockée dans le KV). */
export interface ConversationContext {
  readonly lastProductId?: string | null;
  readonly lastQuantity?: number | null;
  readonly lastZoneTerm?: string | null;
  readonly lastOption?: DeliveryOption | null;
}

export interface Palier2Trace {
  readonly message: string;
  readonly delegations: readonly Delegation[];
  readonly aggregated: AggregatedResponse;
  readonly customerMessage: string;
  readonly events: readonly string[];
  readonly context?: ConversationContext;
}
