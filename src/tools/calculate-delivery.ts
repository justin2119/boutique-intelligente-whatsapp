import type { DeliveryZone, ToolHandler, ToolResult } from "../types";
import { containsPhrase, normalizeText } from "./text";
import { optionalString, requireString } from "./validation";

type Args = Readonly<Record<string, unknown>>;

export interface DeliveryOption {
  readonly zoneId: string;
  readonly zone: string;
  readonly city: string;
  readonly feeXof: number;
  readonly etaDays: number;
}

export type DeliveryData =
  | {
      readonly status: "resolved";
      readonly zoneId: string;
      readonly zone: string;
      readonly city: string;
      readonly feeXof: number;
      readonly etaDays: number;
      readonly etaLabel: string;
    }
  | {
      readonly status: "needs_zone";
      readonly message: string;
      readonly options: readonly DeliveryOption[];
    };

export type ZoneResolution =
  | { readonly kind: "zone"; readonly zone: DeliveryZone }
  | { readonly kind: "ambiguous"; readonly zones: readonly DeliveryZone[] }
  | { readonly kind: "none" };

export function etaLabel(days: number): string {
  if (days === 0) {
    return "livraison le jour même";
  }
  return `livraison sous ${days} jour${days > 1 ? "s" : ""}`;
}

/**
 * Associe un texte libre (quartier, ville, alias) à une zone de livraison.
 * Une zone nommée prime sur la ville ; une ville desservie par plusieurs zones est ambiguë.
 */
export function resolveDeliveryZone(zones: readonly DeliveryZone[], input: string): ZoneResolution {
  const text = normalizeText(input);
  const named = zones.filter((zone) =>
    [zone.zone, ...zone.aliases].some((candidate) => containsPhrase(text, normalizeText(candidate))),
  );
  if (named.length === 1 && named[0] !== undefined) {
    return { kind: "zone", zone: named[0] };
  }
  if (named.length > 1) {
    return { kind: "ambiguous", zones: named };
  }

  const byCity = zones.filter((zone) => containsPhrase(text, normalizeText(zone.city)));
  if (byCity.length === 1 && byCity[0] !== undefined) {
    return { kind: "zone", zone: byCity[0] };
  }
  if (byCity.length > 1) {
    return { kind: "ambiguous", zones: byCity };
  }
  return { kind: "none" };
}

function toOption(zone: DeliveryZone): DeliveryOption {
  return { zoneId: zone.id, zone: zone.zone, city: zone.city, feeXof: zone.feeXof, etaDays: zone.etaDays };
}

function resolved(zone: DeliveryZone): DeliveryData {
  return {
    status: "resolved",
    zoneId: zone.id,
    zone: zone.zone,
    city: zone.city,
    feeXof: zone.feeXof,
    etaDays: zone.etaDays,
    etaLabel: etaLabel(zone.etaDays),
  };
}

/** Outil : calcule les frais (XOF) et le délai de livraison à partir d'un quartier ou d'une ville. */
export function createCalculateDeliveryTool(zones: readonly DeliveryZone[]): ToolHandler {
  return {
    definition: {
      name: "calculate_delivery",
      description:
        "Calcule les frais de livraison en FCFA (XOF) et le délai à partir du quartier ou de la ville (Dantokpa, Cadjehoun, Calavi, Porto-Novo, Lomé, etc.). Si la ville compte plusieurs zones, renvoie les options à proposer au client.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "Quartier, ville ou alias saisi par le client." },
          zoneId: { type: "string", description: "Identifiant exact de zone, si déjà choisi par le client." },
        },
        additionalProperties: false,
      },
    },
    async run(args: Args): Promise<ToolResult<unknown>> {
      const zoneId = optionalString(args, "zoneId");
      if (zoneId !== undefined) {
        const zone = zones.find((candidate) => candidate.id === zoneId);
        if (zone === undefined) {
          return { ok: false, error: `Zone de livraison inconnue : "${zoneId}".` };
        }
        return { ok: true, data: resolved(zone) };
      }

      const location = requireString(args, "location");
      if (!location.ok) {
        return location;
      }
      const result = resolveDeliveryZone(zones, location.data);
      if (result.kind === "zone") {
        return { ok: true, data: resolved(result.zone) };
      }
      if (result.kind === "ambiguous") {
        return {
          ok: true,
          data: {
            status: "needs_zone",
            message: "Plusieurs zones correspondent : demander au client son quartier précis.",
            options: result.zones.map(toOption),
          },
        };
      }
      const cities = [...new Set(zones.map((zone) => zone.city))].join(", ");
      return {
        ok: false,
        error: `Zone de livraison inconnue pour "${location.data}". Villes desservies : ${cities}.`,
      };
    },
  };
}
