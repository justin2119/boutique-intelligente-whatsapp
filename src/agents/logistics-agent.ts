import type { DeliveryZone } from "../types";
import type { DeliveryOption, LogisticsResult } from "../types/palier2";
import { normalizeText } from "./normalize";

/*
 * Hypothèses de Palier 2 à valider avec la boutique : majoration express et réduction de délai.
 * Les tarifs de base proviennent de data/catalog/delivery-zones.json.
 */
export const EXPRESS_FEE_MULTIPLIER = 1.5;
export const EXPRESS_ETA_REDUCTION_DAYS = 1;
export const MIN_EXPRESS_ETA_DAYS = 1;

/** Agent Logisticien : frais, délai et options de livraison (Cotonou, Calavi, Porto-Novo, Lomé). */
export class LogisticsAgent {
  private readonly zones: readonly DeliveryZone[];

  constructor(zones: readonly DeliveryZone[]) {
    this.zones = zones;
  }

  quote(zoneQuery: string, option: DeliveryOption): LogisticsResult {
    const query = normalizeText(zoneQuery);
    if (query.length === 0) {
      return { kind: "unknown_zone", query: zoneQuery };
    }
    const exact = this.zones.filter((zone) => labelsOf(zone).some((label) => label === query));
    const partial = this.zones.filter((zone) =>
      labelsOf(zone).some((label) => label.length >= 3 && (label.includes(query) || query.includes(label))),
    );
    const matches = exact.length > 0 ? exact : partial;
    if (matches.length === 0) {
      return { kind: "unknown_zone", query: zoneQuery };
    }
    const distinctZones = new Set(matches.map((zone) => zone.id));
    if (distinctZones.size > 1) {
      return { kind: "ambiguous", query: zoneQuery, candidates: matches.map((zone) => zone.zone) };
    }
    const zone = matches[0];
    if (zone === undefined) {
      return { kind: "unknown_zone", query: zoneQuery };
    }
    const express = option === "express";
    return {
      kind: "quoted",
      zone,
      option,
      feeXof: express ? Math.round(zone.feeXof * EXPRESS_FEE_MULTIPLIER) : zone.feeXof,
      etaDays: express ? Math.max(MIN_EXPRESS_ETA_DAYS, zone.etaDays - EXPRESS_ETA_REDUCTION_DAYS) : zone.etaDays,
    };
  }
}

/** Repère le lieu de livraison mentionné dans un message (le plus long terme trouvé). */
export function detectZoneTerm(message: string, zones: readonly DeliveryZone[]): string | null {
  const padded = ` ${normalizeText(message)} `;
  let best: string | null = null;
  for (const zone of zones) {
    for (const raw of [zone.zone, zone.city, ...zone.aliases]) {
      const label = normalizeText(raw);
      if (label.length >= 3 && padded.includes(` ${label} `)) {
        if (best === null || label.length > normalizeText(best).length) {
          best = raw;
        }
      }
    }
  }
  return best;
}

function labelsOf(zone: DeliveryZone): string[] {
  return [zone.zone, zone.city, ...zone.aliases].map(normalizeText).filter((label) => label.length > 0);
}
