import { SUPPORTED_CURRENCIES, type LiveCurrency, type ToolHandler, type ToolResult } from "../types";
import { requireNumber, requireString } from "./validation";

type Args = Readonly<Record<string, unknown>>;

export const LIVE_RATES_URL = "https://open.er-api.com/v6/latest/XOF";

/** Taux de secours : unités de XOF pour 1 unité de devise (indicatifs, non vérifiés en direct). */
export const FALLBACK_XOF_PER_UNIT: Readonly<Partial<Record<LiveCurrency, number>>> = {
  EUR: 655.957,
  USD: 610,
  NGN: 0.4,
};

export interface ConvertCurrencyData {
  readonly amountXof: number;
  readonly target: LiveCurrency;
  readonly convertedAmount: number;
  readonly targetPerXof: number;
  readonly source: "live" | "fallback";
  readonly rateDate: string;
}

interface RatesPayload {
  readonly result?: string;
  readonly time_last_update_utc?: string;
  readonly rates?: Readonly<Record<string, number>>;
}

interface ResolvedRate {
  readonly rate: number;
  readonly date: string;
  readonly source: "live" | "fallback";
}

/** Récupère le taux en direct (unités de la devise pour 1 XOF). Lève une erreur si la réponse est invalide. */
export async function fetchLiveRate(target: LiveCurrency, fetchImpl: typeof fetch): Promise<ResolvedRate> {
  const response = await fetchImpl(LIVE_RATES_URL, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const payload = (await response.json()) as RatesPayload;
  const rate = payload.rates?.[target];
  if (payload.result !== "success" || typeof rate !== "number" || rate <= 0) {
    throw new Error("Réponse de taux invalide");
  }
  return { rate, date: payload.time_last_update_utc ?? "date inconnue", source: "live" };
}

async function resolveRate(target: LiveCurrency, fetchImpl: typeof fetch): Promise<ResolvedRate | undefined> {
  try {
    return await fetchLiveRate(target, fetchImpl);
  } catch {
    const xofPerUnit = FALLBACK_XOF_PER_UNIT[target];
    if (xofPerUnit === undefined) {
      return undefined;
    }
    return { rate: 1 / xofPerUnit, date: "taux de secours", source: "fallback" };
  }
}

export interface ConvertCurrencyOptions {
  readonly fetchImpl?: typeof fetch;
}

/** Outil : convertit un montant en FCFA (XOF) vers EUR, USD ou NGN (taux en direct, sinon taux de secours). */
export function createConvertCurrencyTool(options: ConvertCurrencyOptions = {}): ToolHandler {
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    definition: {
      name: "convert_currency",
      description:
        "Convertit un montant en FCFA (XOF) vers une devise (EUR, USD, NGN, CAD, GBP) avec le taux du jour. Indique la source du taux.",
      parameters: {
        type: "object",
        properties: {
          amountXof: { type: "number", minimum: 0, description: "Montant en FCFA." },
          target: { type: "string", enum: SUPPORTED_CURRENCIES.filter((c) => c !== "XOF") },
        },
        required: ["amountXof", "target"],
        additionalProperties: false,
      },
    },
    async run(args: Args): Promise<ToolResult<unknown>> {
      const amount = requireNumber(args, "amountXof");
      if (!amount.ok) {
        return amount;
      }
      const target = requireString(args, "target");
      if (!target.ok) {
        return target;
      }
      const code = target.data.toUpperCase();
      if (code === "XOF") {
        return { ok: false, error: "La devise cible doit être différente de XOF." };
      }
      if (!(SUPPORTED_CURRENCIES as readonly string[]).includes(code)) {
        return { ok: false, error: `Devise non prise en charge : "${code}".` };
      }
      const currency = code as LiveCurrency;

      const rate = await resolveRate(currency, fetchImpl);
      if (rate === undefined) {
        return { ok: false, error: `Taux indisponible pour ${currency} (ni taux en direct, ni taux de secours).` };
      }

      const data: ConvertCurrencyData = {
        amountXof: amount.data,
        target: currency,
        convertedAmount: Math.round(amount.data * rate.rate * 100) / 100,
        targetPerXof: rate.rate,
        source: rate.source,
        rateDate: rate.date,
      };
      return { ok: true, data };
    },
  };
}
