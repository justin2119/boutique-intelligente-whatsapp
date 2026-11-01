export const SUPPORTED_CURRENCIES = ["XOF", "EUR", "USD", "NGN", "CAD", "GBP"] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];
export type LiveCurrency = Exclude<Currency, "XOF">;

export const PRODUCT_CATEGORIES = [
  "wax_hollandais",
  "super_wax",
  "vlisco",
  "woodin",
  "kente",
  "accessoire",
  "ordinateur",
] as const;
export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

export type SaleUnit = "pagne" | "piece";

export interface Product {
  readonly id: string;
  readonly name: string;
  readonly category: ProductCategory;
  readonly sellUnit: SaleUnit;
  readonly priceXof: number;
  readonly stock: number;
  readonly motifs: readonly string[];
  readonly colors: readonly string[];
  readonly tags: readonly string[];
  readonly alternativeIds: readonly string[];
  readonly description: string;
}

export interface DeliveryZone {
  readonly id: string;
  readonly zone: string;
  readonly city: string;
  readonly aliases: readonly string[];
  readonly feeXof: number;
  readonly etaDays: number;
}

export interface Catalog {
  readonly products: readonly Product[];
  readonly zones: readonly DeliveryZone[];
}

export type ToolResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface ToolHandler {
  readonly definition: ToolDefinition;
  run(args: Readonly<Record<string, unknown>>): Promise<ToolResult<unknown>>;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface ExecutedToolCall {
  readonly call: ToolCall;
  readonly result: ToolResult<unknown>;
}

export type AgentMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: readonly ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface LLMResponse {
  readonly content: string | null;
  readonly toolCalls: readonly ToolCall[];
}

export interface LLMClient {
  complete(messages: readonly AgentMessage[], tools: readonly ToolDefinition[]): Promise<LLMResponse>;
}

export interface ExecutionStep {
  readonly step: number;
  readonly thought: string;
  readonly toolCalls: readonly ExecutedToolCall[];
  readonly finalResponse?: string;
}

export interface ExecutionTrace {
  readonly query: string;
  readonly maxSteps: number;
  readonly steps: readonly ExecutionStep[];
  readonly finalResponse: string;
  readonly stoppedBy: "final_answer" | "max_steps";
}

export interface LiveRate {
  readonly rate: number;
  readonly date: string;
}

export type RateFetcher = (target: LiveCurrency) => Promise<LiveRate>;

export interface OrderItem {
  readonly productId: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceXof: number;
  readonly lineTotalXof: number;
}

export interface Order {
  readonly reference: string;
  readonly status: "PENDING_CONFIRMATION";
  readonly items: readonly OrderItem[];
  readonly deliveryZoneId: string;
  readonly deliveryAddress: string;
  readonly customerName: string | null;
  readonly subtotalXof: number;
  readonly deliveryFeeXof: number;
  readonly totalXof: number;
  readonly createdAt: string;
}
